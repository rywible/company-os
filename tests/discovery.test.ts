import { seedFixture } from "./fixtures/documents";
import { evidenceReferences } from "../src/domain/evidence";
import { beforeEach, afterEach, test, expect } from "bun:test";
import {
  initialDiscovery,
  selectLens,
  duplicateIdea,
  type Idea,
} from "../src/domain/discovery";
import {
  agentResultSchema,
  type AgentResult,
  type Context,
} from "../src/domain/model";
import { Store } from "../src/server/store";
import { SQLiteRepository } from "../src/adapters/sqlite";
import { Company, Deferred } from "../src/application/company";
import { workflows } from "../src/domain/workflows";
let store: Store,
  repo: SQLiteRepository,
  company: Company,
  outputs: AgentResult[],
  contexts: Context[];
let now: Date;
const vector = Array.from({ length: 768 }, (_, i) => (i ? 0 : 1));
const answer = (overrides: Partial<AgentResult> = {}): AgentResult =>
  agentResultSchema.parse({
    message: "Finding with bounded evidence",
    requests: [],
    proposals: [],
    work: [],
    observations: [],
    review: null,
    changes: [],
    outcome: "completed",
    ...overrides,
  });
const experiment = {
  track: "research" as const,
  mode: "analysis" as const,
  title: "Check the navigation",
  instruction: "Compare the naming to the user's task",
  criteria: "Find evidence that supports or falsifies the hypothesis",
};
const candidate = {
  title: "Simplify navigation",
  observation: "Naming may be unclear",
  hypothesis: "Clear navigation names reduce confusion during work",
  impact: "Less friction",
  uncertainty: "No user measurement yet",
  evidence: ["github:test@123"],
  experiment,
};
const recommend = {
  verdict: "recommend" as const,
  finding:
    "Source inspection supports a bounded naming experiment; user benefit is unmeasured.",
  evidence: ["github:test@123"],
  proposedWork: { ...experiment, title: "Write a naming recommendation" },
  nextExperiment: null,
};
beforeEach(() => {
  now = new Date("2026-09-20T12:00:00Z");
  store = seedFixture(new Store(":memory:"));
  repo = new SQLiteRepository(store, now.toISOString());
  outputs = [];
  contexts = [];
  company = new Company(
    repo,
    {
      repository: async () => ({ ref: "github:test@123" }),
      execute: async (_, c) => {
        contexts.push(c);
        return outputs.shift() || answer();
      },
    },
    { model: "test", embed: async () => vector },
    {
      inspect: async () => ({
        at: now.toISOString(),
        url: "https://test.example",
        viewport: { width: 390, height: 844 },
        steps: [],
        errors: [],
      }),
      artifact: async () => new Uint8Array(),
    },
    { now: () => now },
  );
});
afterEach(() => store.close());
async function drain() {
  for (let n = 0; n < 100; n++) {
    const job = repo.claim();
    if (!job) return;
    await company.deliver(job);
    repo.acknowledge(job.id);
  }
  throw Error("Did not settle");
}
function explore() {
  return company.execute({ type: "ExploreDiscovery", lensId: "users" }) as {
    runId: string;
    skipped?: string;
  };
}
async function ready() {
  outputs.push(
    answer({ discoveries: [candidate] }),
    answer({ discoveryAssessment: recommend }),
  );
  explore();
  await drain();
  return repo.state().discovery.ideas[0]!;
}
test("rotates due tasks and reacts to signals after cooldown", () => {
  const d = initialDiscovery();
  d.signals.push({
    id: "a",
    key: "a",
    title: "failure",
    detail: "bad",
    lensIds: ["operations"],
    at: now.toISOString(),
    count: 1,
  });
  expect(selectLens(d, now.toISOString())!.id).toBe("operations");
  for (const l of d.lenses) l.lastRunAt = now.toISOString();
  expect(selectLens(d, now.toISOString())).toBeUndefined();
  now = new Date(now.getTime() + 16 * 60000);
  expect(selectLens(d, now.toISOString())!.id).toBe("operations");
  d.lenses.find((l) => l.id === "users")!.lastRunAt = new Date(
    now.getTime() - 49 * 3600000,
  ).toISOString();
  expect(selectLens(d, now.toISOString())!.id).toBe("users");
});
test("old state gets perspectives without losing documents or settings", () => {
  const old: any = repo.state();
  delete old.discovery;
  old.settings.dailyBudget = 3;
  repo.save(old);
  expect(repo.state().discovery.lenses).toHaveLength(10);
  expect(repo.state().settings.dailyBudget).toBe(3);
  expect(repo.documents().length).toBeGreaterThan(0);
  const legacy: any = answer();
  delete legacy.discoveries;
  delete legacy.discoveryOutcome;
  delete legacy.discoveryAssessment;
  expect(agentResultSchema.parse(legacy).discoveries).toEqual([]);
});
test("scout → investigation → inbox decision → delivery → outcome → indexed understanding", async () => {
  const idea = await ready();
  expect(idea.status).toBe("ready");
  expect(idea.investigationWorkIds).toHaveLength(1);
  expect(repo.state().threads.filter((t) => t.kind === "inbox")).toHaveLength(
    1,
  );
  expect(contexts[0]!.discovery?.phase).toBe("scout");
  expect(contexts[0]!.browser?.url).toBe("https://test.example");
  expect(contexts[0]!.evidenceRefs).toContain(`browser:${idea.runId}`);
  expect(contexts[1]!.discovery?.phase).toBe("investigation");
  expect(repo.document(idea.knowledgeId!)!.indexed_version).toBe(1);
  outputs.push(
    answer(),
    answer({
      discoveryOutcome: {
        verdict: "inconclusive",
        finding:
          "The recommendation is written; there is no deployment or user measurement to establish benefit.",
        evidence: ["github:test@123"],
      },
    }),
  );
  company.execute({
    type: "DecideDiscovery",
    ideaId: idea.id,
    action: "pursue",
    reason: "Cheap enough to test",
  });
  await drain();
  const final = repo.state().discovery.ideas[0]!;
  expect(final.status).toBe("learned");
  expect(final.outcome?.verdict).toBe("inconclusive");
  expect(repo.state().threads.find((t) => t.id === idea.threadId)!.status).toBe(
    "resolved",
  );
  expect(repo.document(final.knowledgeId!)!.version).toBe(3);
  expect(repo.document(final.knowledgeId!)!.indexed_version).toBe(3);
  expect(repo.state().policies[final.knowledgeId!]!.kind).toBe("hypothesis");
  const names: string[] = repo.events().map((e) => e.type);
  for (const n of [
    "DiscoveryScoutRequested",
    "DiscoveryIdentified",
    "DiscoveryAssessed",
    "DiscoveryDecided",
    "DiscoveryEvaluationRequested",
    "DiscoveryLearned",
  ])
    expect(names).toContain(n);
  expect(contexts[3]!.evidenceRefs).toContain(`work:${final.deliveryWorkId}`);
  const event = repo
    .events()
    .find((e) => e.type === "DiscoveryEvaluationRequested")!;
  await company.deliver({
    id: "replay",
    event,
    effect: workflows(event)[0]!,
    attempts: 2,
  });
  expect(repo.state().work).toHaveLength(3);
});
test("raw ideas never enter the inbox and generic scout work cannot bypass investigation", async () => {
  outputs.push(
    answer({
      discoveries: [candidate],
      work: [experiment],
      requests: [
        {
          subject: "Premature",
          reason: "hunch",
          recommendation: "build it",
          evidence: ["github:test@123"],
        },
      ],
    }),
    answer({
      discoveryAssessment: {
        ...recommend,
        verdict: "discard",
        proposedWork: null,
        finding: "The hypothesis did not survive inspection.",
      },
    }),
  );
  explore();
  await drain();
  expect(repo.state().threads).toHaveLength(0);
  expect(repo.state().work).toHaveLength(1);
  expect(repo.state().discovery.ideas[0]!.status).toBe("discarded");
  outputs.push(answer({ discoveries: [candidate] }));
  explore();
  await drain();
  expect(repo.state().discovery.ideas).toHaveLength(1);
  expect(
    duplicateIdea(repo.state().discovery.ideas, {
      ...candidate,
      title: "A different title",
    }),
  ).toBe(true);
});
test("inconclusive investigations stop at a bounded limit without manufacturing an inbox request", async () => {
  outputs.push(
    answer({ discoveries: [candidate] }),
    answer({
      discoveryAssessment: {
        ...recommend,
        verdict: "inconclusive",
        proposedWork: null,
        nextExperiment: experiment,
      },
    }),
    answer({
      discoveryAssessment: {
        ...recommend,
        verdict: "inconclusive",
        proposedWork: null,
        nextExperiment: experiment,
      },
    }),
  );
  explore();
  await drain();
  const i = repo.state().discovery.ideas[0]!;
  expect(i.status).toBe("parked");
  expect(i.investigationWorkIds).toHaveLength(2);
  expect(repo.state().threads).toHaveLength(0);
  expect(() =>
    company.execute({
      type: "DecideDiscovery",
      ideaId: i.id,
      action: "revisit",
      reason: "",
    }),
  ).toThrow("Describe what changed");
  outputs.push(
    answer({
      discoveryAssessment: {
        ...recommend,
        verdict: "discard",
        proposedWork: null,
      },
    }),
  );
  company.execute({
    type: "DecideDiscovery",
    ideaId: i.id,
    action: "revisit",
    reason: "New user feedback changes the hypothesis",
  });
  await drain();
  expect(repo.state().discovery.ideas[0]!.investigationWorkIds).toHaveLength(3);
});
test("invented discovery citations roll back state and events atomically", async () => {
  outputs.push(
    answer({ discoveries: [{ ...candidate, evidence: ["imaginary:fact"] }] }),
  );
  const { runId } = explore();
  await expect(drain()).rejects.toThrow("Discovery cited evidence");
  expect(repo.state().discovery.ideas).toHaveLength(0);
  expect(repo.events().some((e) => e.type === "DiscoveryIdentified")).toBe(
    false,
  );
  expect(repo.state().runs.find((r) => r.id === runId)!.status).toBe("running");
});
test("signals coalesce, replay is idempotent, and discovery does not react to its own learning", async () => {
  await drain();
  const r = company.execute({
    type: "StartConversation",
    subject: "Test",
    content: "test",
  }) as { runId: string };
  company.fail(r.runId, "network down");
  const event = repo.events().find((e) => e.type === "RunFailed")!;
  const job = {
    id: "signal",
    event,
    effect: { type: "ObserveDiscovery" as const },
    attempts: 1,
  };
  await company.deliver(job);
  await company.deliver(job);
  expect(repo.state().discovery.signals).toHaveLength(1);
  company.fail(r.runId, "network still down");
  const again = repo
    .events()
    .find((e) => e.type === "RunFailed" && e.id !== event.id)!;
  await company.deliver({ ...job, event: again });
  expect(repo.state().discovery.signals).toHaveLength(1);
  expect(repo.state().discovery.signals[0]!.count).toBe(2);
  const d = repo.documents()[0]!;
  const knowledge = {
    ...event,
    type: "KnowledgeChanged" as const,
    actor: "foreman" as const,
    payload: { documentId: d.id, version: d.version },
  };
  expect(workflows(knowledge).some((e) => e.type === "ObserveDiscovery")).toBe(
    false,
  );
});
test("manual scouts respect their own task budget; signals become explicit context", async () => {
  const s = repo.state();
  s.discovery.lenses.find((l) => l.id === "users")!.dailyRunLimit = 1;
  repo.save(s);
  company.execute({
    type: "RecordDiscoverySignal",
    lensId: "users",
    content:
      "The navigation is hard to interpret on a phone. Source: my own use today.",
  });
  explore();
  await drain();
  expect(repo.state().runs[0]!.automatic).toBe(true);
  expect(contexts[0]!.discovery!.signals).toHaveLength(1);
  expect(contexts[0]!.evidenceRefs.some((r) => r.startsWith("signal:"))).toBe(
    true,
  );
  expect(explore().skipped).toContain("daily run limit");
});
test("pending investigation defers at capacity and resumes without duplication", async () => {
  const s = repo.state();
  s.discovery.lenses.find((l) => l.id === "users")!.maxOpenWork = 1;
  repo.save(s);
  outputs.push(
    answer({
      discoveries: [
        candidate,
        {
          ...candidate,
          title: "Remove unused features",
          hypothesis:
            "Deleting unused features improves focus and lowers long term maintenance",
        },
      ],
    }),
    answer({ discoveryAssessment: recommend }),
  );
  explore();
  let deferred: any;
  for (let n = 0; n < 30; n++) {
    const job = repo.claim();
    if (!job) break;
    try {
      await company.deliver(job);
      repo.acknowledge(job.id);
    } catch (e) {
      expect(e).toBeInstanceOf(Deferred);
      deferred = job;
      break;
    }
  }
  expect(deferred).toBeTruthy();
  await drain();
  outputs.push(
    answer({
      discoveryAssessment: {
        ...recommend,
        verdict: "discard",
        proposedWork: null,
      },
    }),
  );
  await company.deliver(deferred);
  repo.acknowledge(deferred.id);
  await drain();
  expect(repo.state().work).toHaveLength(2);
});
test("parking a queued idea cancels its investigation and keeps the reasoning", async () => {
  outputs.push(answer({ discoveries: [candidate] }));
  explore();
  for (let n = 0; n < 20; n++) {
    const job = repo.claim();
    if (!job) break;
    await company.deliver(job);
    repo.acknowledge(job.id);
    if (repo.state().work.length) break;
  }
  const idea = repo.state().discovery.ideas[0]!;
  company.execute({
    type: "DecideDiscovery",
    ideaId: idea.id,
    action: "park",
    reason: "Wrong time; revisit after launch",
  });
  await drain();
  expect(repo.state().work[0]!.status).toBe("cancelled");
  expect(repo.state().discovery.ideas[0]!.decisionReason).toContain(
    "after launch",
  );
  expect(contexts).toHaveLength(1);
});

test("cancelling delivery parks its idea instead of holding discovery capacity forever", async () => {
  const idea = await ready();
  company.execute({
    type: "DecideDiscovery",
    ideaId: idea.id,
    action: "pursue",
    reason: "Test it",
  });
  const workId = repo.state().discovery.ideas[0]!.deliveryWorkId!;
  company.execute({ type: "WorkStatus", workId, status: "cancelled" });
  await drain();
  expect(repo.state().discovery.ideas[0]!.status).toBe("parked");
  expect(repo.state().discovery.ideas[0]!.outcomeWorkId).toBeUndefined();
});
test("negative outcome pushes back through the inbox with the finding", async () => {
  const idea = await ready();
  outputs.push(
    answer(),
    answer({
      discoveryOutcome: {
        verdict: "harmful",
        finding: "The experiment increased confusion in the observed workflow.",
        evidence: ["github:test@123"],
      },
    }),
  );
  company.execute({
    type: "DecideDiscovery",
    ideaId: idea.id,
    action: "pursue",
    reason: "Try it",
  });
  await drain();
  expect(
    repo
      .state()
      .threads.some(
        (t) => t.subject.startsWith("Reconsider:") && t.status === "open",
      ),
  ).toBe(true);
  expect(repo.state().discovery.ideas[0]!.outcome?.verdict).toBe("harmful");
});
test("pausing discovery keeps queued investigations deferred", async () => {
  outputs.push(answer({ discoveries: [candidate] }));
  explore();
  for (let n = 0; n < 20; n++) {
    const job = repo.claim();
    if (!job) break;
    await company.deliver(job);
    repo.acknowledge(job.id);
    if (repo.state().work.length) break;
  }
  const lens = repo.state().discovery.lenses.find((l) => l.id === "users")!;
  company.execute({
    type: "SaveDiscoveryLens",
    lens: { ...lens, enabled: false },
  });
  const job = repo.claim()!;
  await expect(company.deliver(job)).rejects.toThrow("Task paused");
  expect(contexts).toHaveLength(1);
});

test("custom automations can be deleted while library automation stays protected", () => {
  expect(repo.state().discovery.lenses.some((l) => l.id === "users")).toBe(true);
  company.execute({ type: "DeleteDiscoveryLens", lensId: "users" });
  expect(repo.state().discovery.lenses.some((l) => l.id === "users")).toBe(false);
  expect(
    repo.events().some(
      (event) =>
        event.type === "DiscoveryDeleted" && event.payload.lensId === "users",
    ),
  ).toBe(true);
  expect(
    () =>
      company.execute({
        type: "DeleteDiscoveryLens",
        lensId: "knowledge-library",
      }),
  ).toThrow("library automation");
});

test("supplied portfolio metadata has stable citations, including older saved contexts", async () => {
  const idea = await ready();
  const context = structuredClone(contexts[1]!);
  const work = context.work!;
  work.pullRequest = {
    repository: "test/repo",
    number: 2,
    head: "known-head",
    branch: "codex/test",
    url: "https://github.com/test/repo/pull/2",
    description: "A recorded implementation proposal",
  };
  context.evidenceRefs = ["github:test@123"];
  const refs = evidenceReferences(context);
  expect(refs).toContain(`work:${work.id}`);
  expect(refs).toContain("github:test/repo#2@known-head");
  expect(refs).not.toContain("github:test/repo#2@invented-head");
  expect(refs).not.toContain("github:test/other#2@known-head");
  // Derivation never fetches extra material or mutates the historical prompt.
  expect(context.evidenceRefs).toEqual(["github:test@123"]);
});

test("tasks schedule independently of the retired master clock and budget", async () => {
  const s = repo.state();
  s.settings.enabled = false;
  s.settings.dailyBudget = 1;
  s.settings.nextHeartbeatAt = "2099-01-01T00:00:00Z";
  for (const task of s.discovery.lenses)
    task.enabled = ["users", "engineering"].includes(task.id);
  s.discovery.lenses.find((l) => l.id === "users")!.dailyRunLimit = 1;
  repo.save(s);
  company.heartbeat();
  await drain();
  expect(repo.state().runs[0]!.discoveryLensId).toBe("users");
  company.heartbeat();
  await drain();
  expect(repo.state().runs[1]!.discoveryLensId).toBe("engineering");
  company.heartbeat();
  expect(repo.state().runs).toHaveLength(2);
});

test("Run now can run a paused task once without enabling its schedule", async () => {
  const s = repo.state();
  for (const lens of s.discovery.lenses) lens.enabled = false;
  repo.save(s);
  company.heartbeat();
  expect(repo.state().runs).toHaveLength(0);
  expect(explore().runId).toBeTruthy();
  await drain();
  expect(contexts).toHaveLength(1);
  expect(
    repo.state().discovery.lenses.find((l) => l.id === "users")!.enabled,
  ).toBe(false);
  company.heartbeat();
  expect(repo.state().runs).toHaveLength(1);
});

test("a paused queued task cannot stop another task from scheduling", async () => {
  const result = explore();
  const s = repo.state();
  s.runs.find((r) => r.id === result.runId)!.manual = false;
  s.discovery.lenses.find((l) => l.id === "users")!.enabled = false;
  repo.save(s);
  company.heartbeat();
  expect(repo.state().runs).toHaveLength(2);
  expect(repo.state().runs[1]!.discoveryLensId).not.toBe("users");
});

test("task budgets reset by UTC day, and follow-up work uses the same task allowance", async () => {
  const s = repo.state();
  s.discovery.lenses.find((l) => l.id === "users")!.dailyRunLimit = 1;
  repo.save(s);
  outputs.push(answer({ discoveries: [candidate] }));
  explore();
  let deferred: any;
  for (let n = 0; n < 30; n++) {
    const job = repo.claim();
    if (!job) break;
    try {
      await company.deliver(job);
      repo.acknowledge(job.id);
    } catch (e) {
      expect(e).toBeInstanceOf(Deferred);
      deferred = job;
      break;
    }
  }
  expect(deferred?.effect.type).toBe("ScheduleWork");
  expect(explore().skipped).toContain("daily run limit");
  now = new Date("2026-09-21T00:01:00Z");
  outputs.push(answer({ discoveryAssessment: recommend }));
  await company.deliver(deferred);
  repo.acknowledge(deferred.id);
  await drain();
  expect(repo.state().runs).toHaveLength(2);
  expect(explore().skipped).toContain("daily run limit");
});

test("legacy pause and limits migrate once into independent tasks", () => {
  const s: any = repo.state();
  delete s.discovery.taskSettingsVersion;
  s.settings.enabled = false;
  s.settings.dailyBudget = 3;
  s.discovery.enabled = true;
  s.discovery.maxActiveIdeas = 4;
  s.discovery.maxInvestigations = 1;
  s.discovery.explorationEvery = 4;
  for (const lens of s.discovery.lenses) {
    delete lens.dailyRunLimit;
    delete lens.maxActiveIdeas;
    delete lens.maxInvestigations;
    delete lens.maxOpenWork;
    lens.exploratory = true;
  }
  repo.save(s);
  const migrated = repo.state();
  expect(
    migrated.discovery.lenses.every(
      (l) =>
        !l.enabled &&
        l.dailyRunLimit === 3 &&
        l.maxActiveIdeas === 4 &&
        l.maxInvestigations === 1,
    ),
  ).toBe(true);
  expect("explorationEvery" in migrated.discovery).toBe(false);
  expect("exploratory" in migrated.discovery.lenses[0]!).toBe(false);
  company.execute({
    type: "SaveDiscoveryLens",
    lens: { ...migrated.discovery.lenses[0]!, enabled: true },
  });
  expect(repo.state().discovery.lenses[0]!.enabled).toBe(true);
  expect(repo.state().discovery.lenses[1]!.enabled).toBe(false);
});

test("a run queued yesterday charges the day it actually starts", async () => {
  const s = repo.state();
  s.discovery.lenses.find((l) => l.id === "users")!.dailyRunLimit = 1;
  repo.save(s);
  explore();
  now = new Date("2026-09-21T00:01:00Z");
  await drain();
  expect(repo.state().runs[0]!.budgetDay).toBe("2026-09-21");
  expect(explore().skipped).toContain("daily run limit");
});

test("a full task's idea capacity does not occupy another task's capacity", async () => {
  const s = repo.state();
  s.discovery.lenses.find((l) => l.id === "users")!.maxActiveIdeas = 1;
  repo.save(s);
  await ready();
  expect(explore().skipped).toContain("active idea limit");
  const other = company.execute({
    type: "ExploreDiscovery",
    lensId: "engineering",
  }) as { runId?: string };
  expect(other.runId).toBeTruthy();
  await drain();
});
