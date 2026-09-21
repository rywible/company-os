import { afterEach, beforeEach, expect, test } from "bun:test";
import { Store } from "../src/server/store";
import { SQLiteRepository } from "../src/adapters/sqlite";
import { Company, Deferred } from "../src/application/company";
import { seedFixture } from "./fixtures/documents";
import {
  agentResultSchema,
  type AgentResult,
  type Context,
} from "../src/domain/model";
import {
  initialAvailability,
  initialRoles,
  validatePlan,
  triageAvailable,
  type MilestonePlan,
} from "../src/domain/planning";
import { renderBriefing } from "../src/domain/briefing";

let store: Store, repo: SQLiteRepository, company: Company;
let contexts: Context[], handler: (c: Context) => AgentResult, now: string;
const result = (o: Partial<AgentResult> = {}) =>
  agentResultSchema.parse({
    message: "Verified output",
    requests: [],
    proposals: [],
    work: [],
    observations: [],
    review: null,
    changes: [],
    outcome: "completed",
    ...o,
  });
export const plan = (): MilestonePlan => ({
  title: "Document the architecture",
  objective:
    "A verified architecture with contracts and independent vertical designs.",
  criteria: "Contracts and verticals agree and all expected documents exist.",
  boundaries:
    "Create architecture documents. Do not ship code or change company direction.",
  maxRuns: 12,
  maxParallel: 2,
  documentIds: [],
  assignments: [
    {
      key: "contracts",
      title: "Establish contracts",
      roleId: "architect",
      mode: "analysis",
      instruction:
        "Produce the shared service contract and Mermaid architecture.",
      criteria: "Interfaces are explicit.",
      outputs: ["Contract document"],
      dependsOn: [],
    },
    {
      key: "frontend",
      title: "Design the frontend vertical",
      roleId: "implementer",
      mode: "analysis",
      instruction: "Use accepted contracts to design the full frontend.",
      criteria: "Complete frontend architecture.",
      outputs: ["Frontend design"],
      dependsOn: ["contracts"],
    },
    {
      key: "backend",
      title: "Design the backend vertical",
      roleId: "implementer",
      mode: "analysis",
      instruction: "Use accepted contracts to design the full backend.",
      criteria: "Complete backend architecture.",
      outputs: ["Backend design"],
      dependsOn: ["contracts"],
    },
  ],
});
beforeEach(() => {
  now = "2026-09-20T10:00:00.000Z"; // Sunday outside triage
  store = seedFixture(new Store(":memory:"));
  repo = new SQLiteRepository(store, now);
  contexts = [];
  handler = (c) =>
    c.acceptance
      ? result({
          review: {
            verdict: "approve",
            summary: "The milestone meets its criteria.",
            findings: [],
          },
        })
      : c.assignmentReview
      ? result({
          review: {
            verdict: "approve",
            summary: "Evidence meets criteria",
            findings: [],
          },
        })
      : result();
  company = new Company(
    repo,
    {
      repository: async () => ({ ref: "github:test@123", head: "123" }),
      execute: async (_id, c) => {
        contexts.push(structuredClone(c));
        return handler(c);
      },
    },
    {
      model: "test",
      embed: async () => Array.from({ length: 768 }, (_, i) => (i ? 0 : 1)),
    },
    {
      inspect: async () => ({
        at: now,
        url: "https://example.test",
        viewport: { width: 390, height: 844 },
        steps: [],
        errors: [],
      }),
      artifact: async () => new Uint8Array(),
    },
    { now: () => new Date(now) },
  );
});
afterEach(() => store.close());
function propose(p = plan()) {
  company.execute({ type: "ProposeMilestone", plan: p });
  return repo.state().planning.milestones.at(-1)!;
}
function decide(
  id: string,
  action: "approve" | "pause" | "resume" | "defer" | "decline",
) {
  company.execute({
    type: "DecideMilestone",
    milestoneId: id,
    expectedVersion: repo.state().planning.milestones.find((m) => m.id === id)!
      .version,
    action,
    reason: "Human decision",
  });
}
async function drain(limit = 150) {
  for (let i = 0; i < limit; i++) {
    const job = repo.claim();
    if (!job) return;
    await company.deliver(job);
    repo.acknowledge(job.id);
  }
  throw Error("Workflow did not settle");
}
test("proposals require approval; contracts and review precede parallel verticals even on weekends", async () => {
  const m = propose();
  await drain();
  expect(repo.state().work).toHaveLength(0);
  decide(m.id, "defer");
  await drain();
  expect(repo.state().runs).toHaveLength(0);
  decide(m.id, "approve");
  await drain();
  const s = repo.state();
  expect(s.planning.milestones[0]!.status).toBe("completed");
  expect(s.work.every((w) => w.status === "done")).toBe(true);
  expect(
    contexts
      .filter((c) => !c.acceptance)
      .map((c) => [c.work?.assignmentKey, !!c.assignmentReview]),
  ).toEqual([
    ["contracts", false],
    ["contracts", true],
    ["frontend", false],
    ["backend", false],
    ["frontend", true],
    ["backend", true],
  ]);
  expect(contexts[0]!.coordination?.availableNow).toBe(false);
  expect(contexts[2]!.dependencies?.[0]?.result).toBe("Verified output");
  expect(s.runs.every((r) => r.role?.id)).toBe(true);
  expect(
    s.runs
      .filter((r) => r.trigger === "assessment")
      .every((r) => r.role?.id === "reviewer"),
  ).toBe(true);
  expect(() => decide(m.id, "approve")).toThrow("Only a proposal");
});
test("milestone document links normalize supplied versioned evidence references", () => {
  const document = repo.documents()[0]!;
  const m = propose({
    ...plan(),
    documentIds: [
      `document:${document.id}@${document.version}`,
      document.id,
    ],
  });

  expect(m.documentIds).toEqual([document.id]);
  expect(() =>
    propose({
      ...plan(),
      title: "Missing document",
      documentIds: ["document:missing@1"],
    }),
  ).toThrow("unavailable");
});
test("a blocked branch holds its descendants while independent approved work finishes", async () => {
  const p = plan();
  p.assignments[2]!.dependsOn = [];
  handler = (c) =>
    c.work?.assignmentKey === "contracts"
      ? result({ outcome: "needs_input", message: "Need a contract decision" })
      : c.assignmentReview
        ? result({
            review: { verdict: "approve", summary: "Accepted", findings: [] },
          })
        : result();
  const m = propose(p);
  decide(m.id, "approve");
  await drain();
  const s = repo.state();
  expect(s.work.map((w) => w.status)).toEqual(["blocked", "queued", "done"]);
  expect(contexts.some((c) => c.work?.assignmentKey === "frontend")).toBe(
    false,
  );
  expect(s.threads.some((t) => t.workId === s.work[0]!.id)).toBe(true);
});
test("reviews reject unsupported completion and stop after three attempts", async () => {
  const p = plan();
  p.assignments = p.assignments.slice(0, 1);
  p.maxRuns = 6;
  p.maxParallel = 1;
  handler = (c) =>
    c.assignmentReview
      ? result({
          review: {
            verdict: "changes_requested",
            summary: "Missing contract",
            findings: ["Supply the actual contract"],
          },
        })
      : result();
  const m = propose(p);
  decide(m.id, "approve");
  await drain();
  const s = repo.state();
  expect(s.work[0]!.status).toBe("blocked");
  expect(s.work[0]!.attempts).toBe(3);
  expect(s.work[0]!.reviews).toHaveLength(3);
  expect(s.runs).toHaveLength(6);
  expect(s.planning.milestones[0]!.status).toBe("paused");
  expect(() => decide(m.id, "resume")).toThrow("allowance");
  expect(() =>
    company.execute({
      type: "WorkStatus",
      workId: s.work[0]!.id,
      status: "done",
    }),
  ).toThrow();
});
test("DAG validation rejects cycles, missing dependencies, duplicate keys, unavailable roles and inadequate review allowance", () => {
  for (const mutate of [
    (p: MilestonePlan) => p.assignments[0]!.dependsOn.push("frontend"),
    (p: MilestonePlan) => p.assignments[0]!.dependsOn.push("missing"),
    (p: MilestonePlan) => (p.assignments[1]!.key = "contracts"),
    (p: MilestonePlan) => (p.assignments[1]!.roleId = "unknown"),
    (p: MilestonePlan) => (p.maxRuns = 3),
  ]) {
    const p = plan();
    mutate(p);
    expect(() => validatePlan(p, initialRoles())).toThrow();
  }
  const m = propose();
  company.execute({
    type: "ReviseMilestone",
    milestoneId: m.id,
    expectedVersion: 1,
    plan: { ...plan(), title: "Revised outcome" },
  });
  expect(() =>
    company.execute({
      type: "DecideMilestone",
      milestoneId: m.id,
      expectedVersion: 1,
      action: "approve",
      reason: "Stale",
    }),
  ).toThrow("changed");
  expect(repo.state().work).toHaveLength(0);
});
test("plans distinguish supplied-evidence analysis from provider-backed research", () => {
  const p = plan();
  p.assignments = [
    {
      ...p.assignments[0]!,
      roleId: "investigator",
      mode: "research",
    },
  ];
  p.maxRuns = 3;
  expect(() => validatePlan(p, initialRoles())).not.toThrow();
  const roles = initialRoles();
  roles.find((role) => role.id === "investigator")!.agent.provider =
    "anthropic";
  expect(() => validatePlan(p, roles)).toThrow("hosted web search");
});
test("research captures durable web evidence and capability failures pause without asking Ryan", async () => {
  const p = plan();
  p.assignments = [
    {
      ...p.assignments[0]!,
      key: "sources",
      title: "Inspect the primary specification",
      roleId: "investigator",
      mode: "research",
      outputs: ["Source-backed research note"],
    },
  ];
  p.maxRuns = 4;
  handler = () =>
    result({
      outcome: "capability_blocked",
      message: "Hosted web search is unavailable on this worker.",
    });
  const m = propose(p);
  decide(m.id, "approve");
  await drain();
  let state = repo.state();
  const workId = state.work[0]!.id;
  expect(state.work[0]!.blocker).toEqual({
    kind: "capability",
    capability: "web-research",
    message: "Hosted web search is unavailable on this worker.",
  });
  expect(state.planning.milestones[0]!.status).toBe("paused");
  expect(state.work[0]!.attempts).toBe(0);
  expect(state.threads.some((thread) => thread.workId === workId)).toBe(false);

  handler = (c) =>
    c.assignmentReview
      ? result({
          researchSources: [
            {
              url: "https://example.test/spec",
              title: "Primary specification",
              evidence: "The specification defines the required behavior.",
            },
          ],
          review: {
            verdict: "approve",
            summary: "The research note is source-backed.",
            findings: [],
          },
        })
      : result({
          researchSources: [
            {
              url: "https://example.test/spec",
              title: "Primary specification",
              evidence: "The specification defines the required behavior.",
            },
          ],
          libraryUpdates: [
            {
              documentId: null,
              expectedVersion: null,
              title: "Primary specification research",
              content: "The primary specification defines the required behavior.",
              collection: "Architecture",
              parentId: null,
              relatedIds: [],
              sources: ["web:https://example.test/spec"],
              needsApproval: false,
              reason: "Required milestone artifact",
            },
          ],
        });
  company.execute({ type: "RetryAsResearch", workId });
  await drain();
  state = repo.state();
  expect(state.work[0]!.status).toBe("done");
  expect(state.work[0]!.attempts).toBe(1);
  expect(state.work[0]!.evidence).toContain("web:https://example.test/spec");
  expect(state.work[0]!.outputDocumentIds).toHaveLength(1);
  expect(
    state.runs.find((run) => run.workId === workId && run.result?.researchSources)
      ?.result?.researchSources?.[0]?.evidence,
  ).toContain("defines the required behavior");
  expect(contexts.some((context) => context.research?.web)).toBe(true);
});
test("roles are snapshotted for queued runs and model selections stay out of the briefing", async () => {
  const p = plan();
  p.assignments = p.assignments.slice(0, 1);
  const m = propose(p);
  decide(m.id, "approve");
  for (let i = 0; i < 20 && !repo.state().runs.length; i++) {
    const job = repo.claim()!;
    await company.deliver(job);
    repo.acknowledge(job.id);
  }
  const original = repo.state().runs[0]!;
  const role = repo.state().settings.roles.find((r) => r.id === "architect")!;
  company.execute({
    type: "SaveRole",
    role: {
      ...role,
      name: "Renamed architect",
      agent: { ...role.agent, model: "private-model" },
    },
  });
  await drain();
  expect(repo.state().runs[0]!.agent).toEqual(original.agent);
  expect(contexts[0]!.role?.name).toBe("Architect");
  expect(renderBriefing(contexts[0]!)).not.toContain("private-model");
  expect(renderBriefing(contexts[0]!)).not.toContain('"reasoning"');
});
test("accepted document outputs reach dependent workers and independent reviewers", async () => {
  handler = (c) => {
    if (c.assignmentReview)
      return result({
        review: {
          verdict: "approve",
          summary: "Read the contract",
          findings: [],
        },
      });
    if (c.work?.assignmentKey !== "contracts") return result();
    return result({
      libraryUpdates: [
        {
          documentId: null,
          expectedVersion: null,
          title: "Service contract",
          content:
            "## Contract\n\nRequest: accountId. Response: account.\n\n\`\`\`mermaid\nflowchart LR\nClient-->Service\n\`\`\`",
          collection: "Architecture",
          parentId: null,
          relatedIds: [],
          sources: [`assignment:${c.work.id}`],
          needsApproval: false,
          reason: "Required milestone artifact",
        },
      ],
    });
  };
  const m = propose();
  decide(m.id, "approve");
  await drain();
  const docId = repo.state().work[0]!.outputDocumentIds![0]!;
  expect(docId).toBeTruthy();
  for (const c of [contexts[1]!, contexts[2]!, contexts[3]!])
    expect(c.documents.some((d) => d.id === docId)).toBe(true);
});
test("planning is bounded, deduplicated, paused independently, and replenishes after completion", async () => {
  const s = repo.state();
  s.settings.enabled = true;
  const automation = s.discovery.lenses.find((t) => t.kind === "planning")!;
  automation.targetMilestones = 1;
  automation.dailyRunLimit = 2;
  for (const l of s.discovery.lenses) l.enabled = l.kind === "planning";
  repo.save(s);
  handler = () => result({ milestones: [plan()] });
  company.heartbeat();
  company.heartbeat();
  await drain();
  expect(
    repo.state().runs.filter((r) => r.trigger === "planning"),
  ).toHaveLength(1);
  expect(repo.state().planning.milestones).toHaveLength(1);
  now = "2026-09-20T16:00:00.000Z";
  company.heartbeat();
  await drain();
  expect(repo.state().runs).toHaveLength(1); // pipeline full
  decide(repo.state().planning.milestones[0]!.id, "decline");
  company.heartbeat();
  await drain();
  expect(repo.state().runs).toHaveLength(2);
  now = "2026-09-20T22:00:00.000Z";
  company.heartbeat();
  await drain();
  expect(repo.state().runs).toHaveLength(2);
  const paused = repo.state();
  paused.discovery.lenses.find((t) => t.kind === "planning")!.enabled = false;
  repo.save(paused);
  now = "2026-09-21T10:00:00.000Z";
  company.heartbeat();
  await drain();
  expect(repo.state().runs).toHaveLength(2);
});
test("triage hours follow Mountain daylight saving time, weekdays and exclusive closing time", () => {
  const a = initialAvailability();
  expect(triageAvailable(a, "2026-09-21T15:00:00Z")).toBe(true);
  expect(triageAvailable(a, "2026-09-21T23:00:00Z")).toBe(false);
  expect(triageAvailable(a, "2026-01-05T15:00:00Z")).toBe(false);
  expect(triageAvailable(a, "2026-01-05T16:00:00Z")).toBe(true);
  expect(triageAvailable(a, "2026-09-20T18:00:00Z")).toBe(false);
});
test("pausing an approved milestone prevents new execution without discarding ready work", async () => {
  const m = propose();
  decide(m.id, "approve");
  decide(m.id, "pause");
  await drain();
  expect(repo.state().runs).toHaveLength(0);
  decide(m.id, "resume");
  await drain();
  expect(repo.state().planning.milestones[0]!.status).toBe("completed");
});
test("executor limitations remain explicit blockers and never unblock descendants", async () => {
  handler = () =>
    result({
      outcome: "needs_execution",
      message:
        "General implementation is not connected. The handoff describes the required code.",
    });
  const m = propose();
  decide(m.id, "approve");
  await drain();
  expect(repo.state().work.map((w) => w.status)).toEqual([
    "blocked",
    "queued",
    "queued",
  ]);
  expect(repo.state().runs).toHaveLength(1);
  expect(repo.state().work[0]!.reviews).toHaveLength(0);
});

test("a failed assignment retry charges the allowance and retains the queued role configuration", async () => {
  const p = plan();
  p.assignments = p.assignments.slice(0, 1);
  p.maxRuns = 3;
  const m = propose(p);
  decide(m.id, "approve");
  for (let i = 0; i < 20 && !repo.state().runs.length; i++) {
    const job = repo.claim()!;
    await company.deliver(job);
    repo.acknowledge(job.id);
  }
  const failed = repo.state().runs[0]!;
  const delivery = repo.claim()!;
  repo.acknowledge(delivery.id);
  company.fail(failed.id, "Temporary provider failure");
  const res = company.execute({ type: "RetryRun", runId: failed.id }) as {
    runId: string;
  };
  expect(res.runId).not.toBe(failed.id);
  await drain();
  expect(repo.state().runs).toHaveLength(3);
  expect(repo.state().runs[1]!.agent).toEqual(failed.agent);
  expect(repo.state().work[0]!.status).toBe("done");
  expect(repo.state().work[0]!.attempts).toBe(2);
  expect(
    repo
      .state()
      .threads.filter((t) => t.workId === repo.state().work[0]!.id)
      .every((t) => t.status === "resolved"),
  ).toBe(true);
});
test("planning has its own pause and a manual run can bypass only that pause", async () => {
  const s = repo.state();
  s.settings.enabled = false;
  s.planning.enabled = false;
  for (const l of s.discovery.lenses) l.enabled = false;
  repo.save(s);
  company.heartbeat();
  await drain();
  expect(repo.state().runs).toHaveLength(0);
  company.execute({ type: "RequestPlanning" });
  await drain();
  expect(repo.state().runs[0]!.status).toBe("completed");
  expect(repo.state().planning.enabled).toBe(false);
  company.execute({
    type: "ConfigurePlanning",
    settings: {
      enabled: true,
      intervalHours: 1,
      dailyRunLimit: 2,
      targetMilestones: 2,
    },
  });
  now = "2026-09-20T12:00:00.000Z";
  company.heartbeat();
  await drain();
  expect(repo.state().runs).toHaveLength(2);
});
test("legacy state receives empty milestones and role/availability defaults without rewriting run history", () => {
  const s = repo.state() as any;
  delete s.planning;
  delete s.settings.roles;
  delete s.settings.availability;
  const originalRuns = structuredClone(s.runs);
  store.db
    .query("UPDATE company_state SET json=? WHERE id=1")
    .run(JSON.stringify(s));
  const migrated = repo.state();
  expect(migrated.planning.milestones).toEqual([]);
  expect(migrated.settings.roles.map((r) => r.id)).toEqual([
    "architect",
    "implementer",
    "reviewer",
    "adjudicator",
    "acceptance",
    "investigator",
  ]);
  expect(migrated.settings.availability).toEqual(initialAvailability());
  expect(migrated.runs).toEqual(originalRuns);
});
test("Foreman cannot bypass milestone approval through the legacy work output", async () => {
  handler = () =>
    result({
      work: [
        {
          title: "Unapproved implementation",
          instruction: "Implement now",
          criteria: "Done",
          track: "feature",
          mode: "analysis",
        },
      ],
    });
  company.execute({
    type: "StartConversation",
    subject: "A new outcome",
    content: "Plan the work.",
  });
  await expect(drain()).rejects.toThrow("milestone");
  expect(repo.state().work).toHaveLength(0);
});

test("a pause can resume its final already-allocated review at the run limit", async () => {
  const p = plan();
  p.assignments = p.assignments.slice(0, 1);
  p.maxRuns = 3;
  const m = propose(p);
  decide(m.id, "approve");
  const legacy = repo.state(); legacy.planning.milestones[0]!.maxRuns=2; repo.save(legacy); // Historical approval
  for (let i = 0; i < 30 && repo.state().runs.length < 2; i++) {
    const job = repo.claim()!;
    await company.deliver(job);
    repo.acknowledge(job.id);
  }
  expect(repo.state().runs[1]!.status).toBe("queued");
  decide(m.id, "pause");
  decide(m.id, "resume");
  await drain();
  expect(repo.state().work[0]!.status).toBe("done");
  expect(repo.state().planning.milestones[0]!.status).toBe("paused");
  expect(repo.state().planning.milestones[0]!.decisionReason).toContain(
    "before acceptance",
  );
  expect(repo.state().runs).toHaveLength(2);
});

function scheduleTask(
  permissions: import("../src/domain/permissions").AutomationPermission[] = [
    "evidence",
  ],
) {
  const task: import("../src/domain/discovery").Lens = {
    id: "daily-research",
    name: "Daily research",
    question: "Record evidenced research findings.",
    kind: "task",
    enabled: true,
    intervalHours: 24,
    dailyRunLimit: 2,
    maxActiveIdeas: 2,
    maxInvestigations: 1,
    maxOpenWork: 1,
    inspectUI: false,
    sources: [],
    permissions,
    agent: {
      provider: "openai",
      model: "research-model",
      reasoningEffort: "low",
    },
  };
  company.execute({ type: "SaveDiscoveryLens", lens: task });
  return task;
}
test("a scheduled Foreman can add evidence without changing maintained knowledge or using the Inbox model", async () => {
  const task = scheduleTask();
  handler = (c) =>
    result({
      observations: [
        {
          kind: "observation",
          title: "Observed behavior",
          content: "A tentative research finding, not accepted direction.",
          evidence: [c.evidenceRefs[0]!],
        },
      ],
    });
  const queued = company.execute({
    type: "ExploreDiscovery",
    lensId: task.id,
  }) as { runId: string };
  expect(repo.state().runs.find((r) => r.id === queued.runId)!.agent).toEqual(
    task.agent,
  );
  await drain();
  expect(contexts[0]!.automation).toEqual({
    id: task.id,
    name: task.name,
    instruction: task.question,
    allowedChanges: ["evidence"],
  });
  expect(contexts[0]!.discovery).toBeUndefined();
  const doc = repo.documents().find((d) => d.title === "Observed behavior")!;
  expect(doc).toBeTruthy();
  expect(repo.state().library.pages[doc.id]).toBeUndefined();
  expect(repo.state().planning.milestones).toHaveLength(0);
  expect(repo.state().work).toHaveLength(0);
  company.execute({
    type: "StartConversation",
    subject: "Talk to Foreman",
    content: "Summarize the research.",
  });
  expect(repo.state().runs.at(-1)!.agent).toEqual(
    repo.state().settings.foremanAgent,
  );
});
test("automation permissions reject unauthorized output atomically, including mixed allowed evidence", async () => {
  const task = scheduleTask();
  handler = (c) =>
    result({
      observations: [
        {
          kind: "observation",
          title: "Should roll back",
          content: "Evidence",
          evidence: [c.evidenceRefs[0]!],
        },
      ],
      milestones: [plan()],
    });
  company.execute({ type: "ExploreDiscovery", lensId: task.id });
  await expect(drain()).rejects.toThrow("not allowed to propose milestones");
  expect(repo.documents().some((d) => d.title === "Should roll back")).toBe(
    false,
  );
  expect(repo.state().planning.milestones).toHaveLength(0);
});
test("knowledge-writing permission allows documents and is separate from evidence permission", async () => {
  const task = scheduleTask(["knowledge"]);
  handler = (c) =>
    result({
      libraryUpdates: [
        {
          documentId: null,
          expectedVersion: null,
          title: "Research overview",
          content: "Current understanding grounded in supplied context.",
          collection: "Research",
          parentId: null,
          relatedIds: [],
          sources: [c.evidenceRefs[0]!],
          needsApproval: false,
          reason: "Maintain the research overview",
        },
      ],
    });
  company.execute({ type: "ExploreDiscovery", lensId: task.id });
  await drain();
  const doc = repo.documents().find((d) => d.title === "Research overview")!;
  expect(repo.state().library.pages[doc.id]).toBeTruthy();
  expect(repo.state().runs[0]!.status).toBe("completed");
});
test("queued automation permissions cannot expand and in-flight revocations prevent writes", async () => {
  const task = scheduleTask(["evidence"]);
  company.execute({ type: "ExploreDiscovery", lensId: task.id });
  company.execute({
    type: "SaveDiscoveryLens",
    lens: { ...task, permissions: ["evidence", "milestones"] },
  });
  handler = () => result({ milestones: [plan()] });
  await expect(drain()).rejects.toThrow("not allowed to propose milestones");
  const s = repo.state();
  s.runs[0]!.status = "failed";
  repo.save(s);
  company.execute({ type: "ExploreDiscovery", lensId: task.id });
  handler = (c) => {
    company.execute({
      type: "SaveDiscoveryLens",
      lens: { ...task, permissions: [] },
    });
    return result({
      observations: [
        {
          kind: "observation",
          title: "Revoked result",
          content: "Do not persist this",
          evidence: [c.evidenceRefs[0]!],
        },
      ],
    });
  };
  await expect(drain()).rejects.toThrow("not allowed to add evidence");
  expect(repo.documents().some((d) => d.title === "Revoked result")).toBe(
    false,
  );
});
test("a normal automation can propose milestones but cannot approve or dispatch them", async () => {
  const task = scheduleTask(["milestones"]);
  handler = () => result({ milestones: [plan()] });
  company.execute({ type: "ExploreDiscovery", lensId: task.id });
  await drain();
  expect(repo.state().planning.milestones[0]!.status).toBe("proposed");
  expect(repo.state().work).toHaveLength(0);
  expect(repo.state().threads[0]!.milestoneId).toBe(
    repo.state().planning.milestones[0]!.id,
  );
});
test("milestone proposals are revised through their Foreman conversation with version and actor attribution", async () => {
  const m = propose();
  await drain();
  handler = (c) => {
    expect(c.milestone?.id).toBe(m.id);
    return result({
      milestoneRevisions: [
        {
          milestoneId: m.id,
          expectedVersion: 1,
          plan: { ...plan(), objective: "A narrower approved outcome." },
        },
      ],
    });
  };
  company.execute({
    type: "Reply",
    threadId: m.threadId,
    content: "Narrow the outcome before I approve it.",
  });
  await drain();
  expect(repo.state().planning.milestones[0]!.objective).toBe(
    "A narrower approved outcome.",
  );
  expect(
    repo.events(m.id).filter((e) => e.type === "MilestoneChanged")[0]!.actor,
  ).toBe("foreman");
  expect(repo.state().work).toHaveLength(0);
});
test("deleting the planning automation does not recreate it or keep a hidden schedule running", async () => {
  const s = repo.state();
  for (const task of s.discovery.lenses) task.enabled = false;
  repo.save(s);
  company.execute({
    type: "DeleteDiscoveryLens",
    lensId: "milestone-planning",
  });
  company.heartbeat();
  await drain();
  expect(repo.state().discovery.lenses.some((t) => t.kind === "planning")).toBe(
    false,
  );
  expect(repo.state().runs).toHaveLength(0);
  expect(
    (company.execute({ type: "RequestPlanning" }) as any).skipped,
  ).toContain("Schedule an automation");
});

test("evidence-only tasks cannot modify knowledge, governing documents or code", async () => {
  const task = scheduleTask();
  const candidates: Partial<AgentResult>[] = [
    {
      libraryUpdates: [
        {
          documentId: null,
          expectedVersion: null,
          title: "Unauthorized knowledge",
          content: "Do not persist",
          collection: "Research",
          parentId: null,
          relatedIds: [],
          sources: [],
          needsApproval: false,
          reason: "Attempted expansion",
        },
      ],
    },
    {
      changes: [
        { path: "src/server/index.ts", content: "Unauthorized source" },
      ],
    },
    {
      proposals: [
        {
          documentId: "sequence",
          content: "Unauthorized replacement",
          reason: "Attempted expansion",
          evidence: [],
        },
      ],
    },
    {
      work: [
        {
          track: "feature",
          mode: "analysis",
          title: "Unauthorized work",
          instruction: "Do it",
          criteria: "Done",
        },
      ],
    },
  ];
  for (const candidate of candidates) {
    const s = repo.state();
    for (const r of s.runs) r.status = "failed";
    s.discovery.lenses.find((t) => t.id === task.id)!.dailyRunLimit = 24;
    repo.save(s);
    handler = () => result(candidate);
    company.execute({ type: "ExploreDiscovery", lensId: task.id });
    await expect(drain()).rejects.toThrow();
  }
  expect(
    repo.documents().some((d) => d.title === "Unauthorized knowledge"),
  ).toBe(false);
  expect(repo.state().work).toHaveLength(0);
});
test("deleted automations do not execute queued work", async () => {
  const task = scheduleTask();
  company.execute({ type: "ExploreDiscovery", lensId: task.id });
  company.execute({ type: "DeleteDiscoveryLens", lensId: task.id });
  await drain();
  expect(contexts).toHaveLength(0);
  expect(repo.state().runs[0]!.error).toContain("deleted before execution");
});

test("unfinished legacy runs acquire bounded authority before later permission grants", async () => {
  const task = scheduleTask(["evidence"]);
  company.execute({ type: "ExploreDiscovery", lensId: task.id });
  const stored = repo.state();
  delete stored.runs[0]!.automationPermissions;
  store.db
    .query("UPDATE company_state SET json=? WHERE id=1")
    .run(JSON.stringify(stored));
  company.execute({
    type: "SaveDiscoveryLens",
    lens: { ...task, permissions: ["evidence", "milestones"] },
  });
  expect(repo.state().runs[0]!.automationPermissions).toEqual(["evidence"]);
  handler = () => result({ milestones: [plan()] });
  await expect(drain()).rejects.toThrow("not allowed to propose milestones");
});

test("automation milestone capacity is enforced on the whole result without partial proposals", async () => {
  const task = scheduleTask(["milestones"]);
  company.execute({
    type: "SaveDiscoveryLens",
    lens: { ...task, targetMilestones: 1 },
  });
  handler = (c) => {
    expect(c.automation?.milestoneSlots).toBe(1);
    return result({
      milestones: [plan(), { ...plan(), title: "A second outcome" }],
    });
  };
  company.execute({ type: "ExploreDiscovery", lensId: task.id });
  await expect(drain()).rejects.toThrow("upcoming milestone limit");
  expect(repo.state().planning.milestones).toHaveLength(0);
});

test("planning includes the configured review quorum and milestone acceptance in the minimum allowance", () => {
  const p=plan();p.assignments=[{...p.assignments[0]!,mode:"implementation"}];p.maxRuns=2;
  expect(()=>validatePlan(p,initialRoles())).toThrow("at least 4 runs");
  p.maxRuns=4;expect(()=>validatePlan(p,initialRoles())).not.toThrow();
  expect(()=>validatePlan(p,initialRoles(),3)).toThrow("at least 5 runs");
  const m=propose(p), state=repo.state();state.settings.requiredReviews=3;repo.save(state);
  expect(()=>decide(m.id,"approve")).toThrow("at least 5 runs");
});
