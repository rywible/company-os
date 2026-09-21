import { seedFixture } from "./fixtures/documents";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Store } from "../src/server/store";
import { SQLiteRepository } from "../src/adapters/sqlite";
import { Company } from "../src/application/company";
import { Runner } from "../src/application/runner";
import {
  defaultPolicy,
  type AgentResult,
  type Context,
} from "../src/domain/model";
import { workflows } from "../src/domain/workflows";
let store: Store,
  repo: SQLiteRepository,
  company: Company,
  outputs: AgentResult[],
  contexts: Context[],
  calls: number;
const now = new Date("2026-09-20T10:00:00Z");
const vector = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
const answer = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  message: "Grounded result",
  requests: [],
  proposals: [],
  work: [],
  discoveries: [],
  discoveryAssessment: null,
  discoveryOutcome: null,
  observations: [],
  review: null,
  changes: [],
  outcome: "completed",
  ...overrides,
});
beforeEach(() => {
  store = seedFixture(new Store(":memory:"));
  repo = new SQLiteRepository(store, now.toISOString());
  // These suites exercise their own automation clocks; milestone planning is covered separately.
 const planningState = repo.state();
  planningState.discovery.lenses.find(t => t.kind === "knowledge")!.enabled = false;
  planningState.discovery.lenses.find((t) => t.kind === "planning")!.enabled =
    false;
  repo.save(planningState);
  outputs = [];
  contexts = [];
  calls = 0;
  company = new Company(
    repo,
    {
      repository: async () => ({ ref: "github:test@123", head: "123" }),
      execute: async (id, c) => {
        calls++;
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
        steps: [
          {
            action: "Open Inbox",
            url: "https://test.example",
            title: "Inbox",
            text: "Inbox empty",
            overflow: false,
            screenshot: "test-0.png",
          },
        ],
        errors: [],
      }),
      artifact: async () => new Uint8Array(),
    },
    { now: () => now },
  );
});
afterEach(() => store.close());
async function drain() {
  for (let i = 0; i < 40; i++) {
    const job = repo.claim();
    if (!job) return;
    await company.deliver(job);
    repo.acknowledge(job.id);
  }
  throw Error("Workflow did not settle");
}
function create(content = "Question", subject = "Conversation") {
  return company.execute({ type: "StartConversation", subject, content }) as {
    threadId: string;
    runId: string;
  };
}
test("conversations are isolated; events schedule work atomically and deliveries are idempotent", async () => {
  const a = create("Only in A", "A");
  await drain();
  const b = create("Only in B", "B");
  await drain();
  expect(contexts[1]!.messages.map((m) => m.content)).toEqual(["Only in B"]);
  const count = repo.events().length;
  const event = repo
    .events()
    .find(
      (e) => e.type === "ConversationStarted" && e.payload.runId === a.runId,
    )!;
  await company.deliver({
    id: "duplicate",
    event,
    effect: { type: "RunAgent", runId: a.runId },
    attempts: 2,
  });
  expect(calls).toBe(2);
  expect(repo.events()).toHaveLength(count);
  expect(repo.state().threads).toHaveLength(2);
  expect(workflows(event)).toEqual([{ type: "RunAgent", runId: a.runId }]);
  expect(
    repo.events().every((e) => e.schemaVersion === 1 && e.correlationId),
  ).toBe(true);
});
test("Foreman and automation selections are snapshotted onto each run", () => {
  const foreman = {
    provider: "meta" as const,
    model: "llama-studio",
    reasoningEffort: "xhigh" as const,
  };
  company.execute({ type: "ConfigureForeman", agent: foreman });
  const conversation = create();
  expect(
    repo.state().runs.find((run) => run.id === conversation.runId)!.agent,
  ).toEqual(foreman);

  const lens = repo
    .state()
    .discovery.lenses.find((item) => item.id === "users")!;
  const automation = {
    provider: "anthropic" as const,
    model: "sonnet",
    reasoningEffort: "high" as const,
  };
  company.execute({
    type: "SaveDiscoveryLens",
    lens: { ...lens, agent: automation },
  });
  const scheduled = company.execute({
    type: "ExploreDiscovery",
    lensId: "users",
  }) as { runId: string };
  expect(
    repo.state().runs.find((run) => run.id === scheduled.runId)!.agent,
  ).toEqual(automation);

  company.execute({
    type: "ConfigureForeman",
    agent: { provider: "openai", model: "", reasoningEffort: "medium" },
  });
  expect(
    repo.state().runs.find((run) => run.id === conversation.runId)!.agent,
  ).toEqual(foreman);
});
test("the runner overlaps deliveries up to the configured pool capacity", async () => {
  let active = 0,
    peak = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  company.agent.execute = async () => {
    active++;
    peak = Math.max(peak, active);
    await gate;
    active--;
    return answer();
  };
  create("First", "First");
  create("Second", "Second");
  const third = create("Third", "Third");
  const runner = new Runner(company, () => true, 2);
  const running = runner.tick();
  await Bun.sleep(10);
  expect(peak).toBe(2);
  await runner.tick();
  expect(repo.state().runs.find((run) => run.id === third.runId)!.status).toBe(
    "queued",
  );
  release();
  await running;
  await runner.tick();
  expect(repo.state().runs.find((run) => run.id === third.runId)!.status).toBe(
    "completed",
  );
});
test("work discussion is deduplicated and does not resume or charge the assignment", async () => {
  const { workId } = company.execute({
    type: "CreateWork",
    track: "bug",
    mode: "analysis",
    title: "Investigate mobile editor",
    instruction: "Find the fault",
    criteria: "Repro and diagnosis",
  }) as { workId: string };
  outputs.push(
    answer({
      outcome: "needs_input",
      requests: [
        {
          subject: "Which mobile behavior?",
          reason: "Expected behavior is unclear",
          recommendation: "Keep drafts",
          evidence: [],
        },
      ],
    }),
  );
  await drain();
  let state = repo.state();
  const thread = state.threads[0]!;
  expect(thread.kind).toBe("inbox");
  expect(state.work[0]!.status).toBe("blocked");
  company.execute({
    type: "Reply",
    threadId: thread.id,
    content: "Keep drafts on navigation",
  });
  outputs.push(answer({ message: "The expected behavior is now explicit" }));
  await drain();
  state = repo.state();
  expect(state.threads).toHaveLength(1);
  expect(state.work[0]!.status).toBe("blocked");
  expect(state.work[0]!.attempts).toBe(1);
  expect(state.threads[0]!.messages.map((message) => message.content)).toEqual([
    "Grounded result",
    "Keep drafts on navigation",
    "The expected behavior is now explicit",
  ]);
  expect(state.runs.at(-1)!.trigger).toBe("discussion");
  company.execute({ type: "WorkStatus", workId, status: "queued" });
  outputs.push(answer({ message: "The expected behavior is now implemented" }));
  await drain();
  state = repo.state();
  expect(state.work[0]!.status).toBe("done");
  expect(state.work[0]!.attempts).toBe(2);
  expect(state.threads[0]!.status).toBe("resolved");
  expect(contexts.at(-1)!.work!.id).toBe(workId);
  expect(contexts.find((context) => context.discussion)!.messages.at(-1)!.content).toBe(
    "Keep drafts on navigation",
  );
});
test("knowledge edits invalidate embeddings immediately, preserve history, and reindex through events", async () => {
  await drain();
  const d = repo.document("architecture")!;
  expect(d.indexed_version).toBe(1);
  company.execute({
    type: "SaveKnowledge",
    id: d.id,
    title: d.title,
    level: d.level,
    content: "Revised infrastructure",
    expectedVersion: 1,
    policy: { ...defaultPolicy(d), inclusion: "reference" },
  });
  expect(repo.document(d.id)!.indexed_version).toBeNull();
  expect(repo.history(d.id)).toHaveLength(2);
  expect(repo.index(d.id, 1, "test", [{ text: "stale", vector }])).toBe(false);
  const preview = await company.preview("infrastructure");
  expect(preview.entries.find((e) => e.id === d.id)!.included).toBe(false);
  await drain();
  expect(repo.document(d.id)!.indexed_version).toBe(2);
  create("Read this");
  const before = repo.events().length;
  expect(() =>
    company.execute({
      type: "SaveKnowledge",
      id: d.id,
      title: d.title,
      level: d.level,
      content: "Stale edit",
      expectedVersion: 1,
      policy: defaultPolicy(d),
    }),
  ).toThrow("changed");
  expect(repo.events()).toHaveLength(before);
});
test("explicit revision attachment and context policies are visible and deterministic", async () => {
  const d = repo.document("architecture")!;
  company.execute({
    type: "SaveKnowledge",
    id: d.id,
    title: d.title,
    level: d.level,
    content: "New architecture",
    expectedVersion: 1,
    policy: { ...defaultPolicy(d), status: "draft" },
  });
  const r = company.execute({
    type: "StartConversation",
    subject: "Historical review",
    content: "Review the attached architecture",
    attachment: { id: d.id, version: 1 },
  }) as { threadId: string };
  const preview = await company.preview(
    "Review the attached architecture",
    undefined,
    r.threadId,
  );
  expect(preview.documents.find((x) => x.id === d.id)!.version).toBe(1);
  expect(preview.entries.find((e) => e.id === d.id)!.reason).toContain(
    "attachment",
  );
  expect(preview.entries.find((e) => e.id === "constitution")!.included).toBe(
    true,
  );
  await drain();
  expect(contexts[0]!.entries).toEqual(preview.entries);
});
test("unseen citations and constitution proposals roll back the entire result", async () => {
  const { runId } = create();
  const ctx = await company.preview("Question");
  repo.transaction(() => {
    const state = repo.state();
    state.runs[0]!.context = ctx;
    repo.save(state);
  });
  expect(() =>
    company.complete(
      runId,
      answer({
        observations: [
          {
            title: "Bad evidence",
            content: "Claim",
            kind: "observation",
            evidence: ["invented:1"],
          },
        ],
      }),
      "test",
    ),
  ).toThrow("evidence");
  expect(repo.documents()).toHaveLength(4);
  expect(() =>
    company.complete(
      runId,
      answer({
        proposals: [
          {
            documentId: "constitution",
            content: "Override",
            reason: "Test",
            evidence: [],
          },
        ],
      }),
      "test",
    ),
  ).toThrow("protected");
  expect(repo.state().threads).toHaveLength(1);
  expect(repo.state().runs[0]!.status).toBe("queued");
});
test("accepted proposals create knowledge revisions and reject stale bases", async () => {
  const r = create("architecture");
  outputs.push(
    answer({
      proposals: [
        {
          documentId: "architecture",
          content: "A reviewed change",
          reason: "Specific change",
          evidence: ["document:architecture@1"],
        },
      ],
    }),
  );
  await drain();
  const thread = repo.state().threads.find((t) => t.kind === "inbox")!;
  const p = thread.proposals[0]!;
  company.execute({
    type: "ResolveProposal",
    threadId: thread.id,
    proposalId: p.id,
    action: "accept",
  });
  expect(repo.document("architecture")!.version).toBe(2);
  expect(() =>
    company.execute({
      type: "ResolveProposal",
      threadId: thread.id,
      proposalId: p.id,
      action: "accept",
    }),
  ).toThrow();
  expect(
    repo.state().threads.find((t) => t.id === r.threadId)!.messages,
  ).toHaveLength(2);
});
test("heartbeat respects pause, active runs and daily budget; work generation is deduplicated", async () => {
  const s = repo.state();
  for (const lens of s.discovery.lenses) {
    lens.enabled = lens.id === "direction";
    lens.dailyRunLimit = 1;
  }
  s.settings.nextHeartbeatAt = now.toISOString();
  repo.save(s);
  outputs.push(
    answer({
      discoveries: [
        {
          title: "Context policy hypothesis",
          observation: "Inclusion needs investigation",
          hypothesis: "Clarifying inclusion may improve understanding",
          impact: "Fewer mistakes",
          uncertainty: "Unmeasured",
          evidence: ["github:test@123"],
          experiment: {
            track: "research",
            mode: "analysis",
            title: "Explore context policies",
            instruction: "Audit inclusion",
            criteria: "Evidence-based assessment",
          },
        },
      ],
    }),
  );
  company.heartbeat();
  company.heartbeat();
  expect(repo.state().runs).toHaveLength(1);
  // Complete heartbeat without processing the budget-deferred child work.
  let job;
  while ((job = repo.claim())) {
    if (job.effect.type === "ScheduleWork") {
      repo.reject(job.id, "budget", true);
      break;
    }
    await company.deliver(job);
    repo.acknowledge(job.id);
  }
  expect(repo.state().work).toHaveLength(1);
  expect((company.execute({ type: "Heartbeat" }) as any).skipped).toBe(
    "No task is due with available capacity.",
  );
  company.execute({
    type: "CreateWork",
    track: "research",
    mode: "analysis",
    title: repo.state().work[0]!.title,
    instruction: "duplicate",
    criteria: "same",
  });
  expect(repo.state().work).toHaveLength(2);
  company.execute({
    type: "SaveDiscoveryLens",
    lens: { ...repo.state().discovery.lenses[0]!, enabled: false },
  });
  const count = repo.state().runs.length;
  company.heartbeat();
  expect(repo.state().runs).toHaveLength(count);
});
test("browser work records real port evidence and observations remain attributed", async () => {
  outputs.push(
    answer({
      observations: [
        {
          title: "Narrow viewport observation",
          content: "Navigation fits",
          kind: "observation",
          evidence: [],
        },
      ],
    }),
  );
  company.execute({
    type: "CreateWork",
    track: "research",
    mode: "ui-inspection",
    title: "Inspect UI",
    instruction: "Inspect app",
    criteria: "Screenshots and findings",
  });
  await drain();
  expect(contexts[0]!.browser!.steps[0]!.action).toBe("Open Inbox");
  expect(contexts[0]!.evidenceRefs.some((r) => r.startsWith("browser:"))).toBe(
    true,
  );
  const observation = repo.documents().find((d) => d.level === "intake")!;
  expect(repo.state().policies[observation.id]).toEqual({
    inclusion: "reference",
    status: "active",
  });
  expect(observation.source).toBe("foreman");
});
test("failed agent runs stay out of Inbox and survive worker recovery", async () => {
  const r = create();
  const threads = repo.state().threads;
  company.agent.execute = async () => {
    throw Error("Subscription unavailable");
  };
  const runner = new Runner(company, () => true);
  for (let i = 0; i < 8; i++) await runner.tick();
  expect(repo.state().runs.find((x) => x.id === r.runId)!.status).toBe(
    "failed",
  );
  expect(repo.state().threads).toEqual(threads);
  expect(repo.deliveryErrors().some(d => d.error.includes("Subscription"))).toBe(true);
  company.agent.execute = async () => answer();
  company.execute({ type: "RetryRun", runId: r.runId });
  const job = repo.claim()!;
  repo.recover();
  expect(repo.claim()!.id).toBe(job.id);
});

function reviews() {
  let head = "commit-a";
  const published: string[] = [],
    revised: string[] = [];
  const pr = () => ({
    repository: "rywible/company-os",
    number: 7,
    head,
    branch: "codex/example",
    base: "main",
    url: "https://github.com/rywible/company-os/pull/7",
  });
  const adapter = {
    candidate: async (pullRequest: ReturnType<typeof pr>) => ({
      pullRequest,
      base: "base",
      head: "merge-" + pullRequest.head,
    }),
    verify: async (_repo: string, head: string) => ({
      head,
      passed: true,
      checks: [{ name: "Checks", passed: true, output: "passed" }],
    }),
    merge: async (c: { head: string }) => c.head,
    head: async () => pr(),
    inspect: async () => ({
      pullRequest: pr(),
      files: [
        { path: "src/example.ts", patch: "+ example", content: "example" },
      ],
    }),
    publishReview: async (_p: unknown, id: string) => {
      if (!published.includes(id)) published.push(id);
    },
    revise: async () => {
      revised.push(head);
      head = "commit-" + revised.length;
      return pr();
    },
  };
  company = new Company(
    repo,
    company.agent,
    company.embeddings,
    company.browser,
    company.clock,
    company.ids,
    adapter,
  );
  return { adapter, published, revised, setHead: (v: string) => (head = v) };
}
const verdict = (v: "approve" | "changes_requested") =>
  answer({
    review: {
      verdict: v,
      summary: "Independent review",
      issues: [
        {
          id: "boundary",
          category: "correctness",
          severity: "blocker",
          problem: "Fix the failing boundary condition.",
          evidence: "Zero is rejected at src/example.ts:1",
          verification: "Test with zero.",
          status: v === "approve" ? "resolved" : "open",
        },
      ],
      findings: v === "approve" ? [] : ["Fix the failing boundary condition."],
    },
  });
async function linked() {
  const { workId } = company.execute({
    type: "CreateWork",
    track: "bug",
    mode: "analysis",
    title: "Review a correction",
    instruction: "Inspect the boundary",
    criteria: "Works at the boundary",
  }) as { workId: string };
  await drain();
  const original = repo.state().runs.find((r) => r.workId === workId)!;
  await company.execute({
    type: "LinkPullRequest",
    workId,
    repository: "rywible/company-os",
    number: 7,
  });
  return { workId, original };
}
test("WorkCompleted starts N independent pinned reviews; all approvals merge without another worker run", async () => {
  const gh = reviews();
  company.execute({
    type: "ConfigureReviews",
    requiredReviews: 3,
    allowCodeChanges: true,
  });
  const { workId, original } = await linked();
  outputs.push(
    verdict("approve"),
    verdict("approve"),
    verdict("approve"),
    answer(),
  );
  await drain();
  const state = repo.state(),
    round = state.reviewRounds[0]!;
  expect(round.required).toBe(3);
  expect(round.status).toBe("approved");
  expect(gh.published).toHaveLength(3);
  expect(
    contexts
      .filter((c) => c.review?.reviewId)
      .every((c) => c.review?.findings === undefined),
  ).toBe(true);
  expect(contexts.some((c) => c.review && !c.review.reviewId)).toBe(false);
  expect(state.work[0]!.mergedHead).toBe("merge-commit-a");
  expect(state.work.find((w) => w.id === workId)?.status).toBe("done");
  expect(
    repo.events().filter((e) => e.type === "ReviewCompleted"),
  ).toHaveLength(1);
  expect(
    repo.events().filter((e) => e.type === "WorkerSignalled"),
  ).toHaveLength(0);
  await company.signalWorker(round.id, "duplicate");
  await company.startReview(workId, "duplicate");
  expect(repo.state().reviewRounds).toHaveLength(1);
  expect(repo.state().runs).toHaveLength(4);
});
test("a requested correction is verified and published, then receives a fresh full review round", async () => {
  const gh = reviews();
  company.execute({
    type: "ConfigureReviews",
    requiredReviews: 2,
    allowCodeChanges: true,
  });
  await linked();
  outputs.push(
    verdict("approve"),
    verdict("changes_requested"),
    answer({
      outcome: "needs_execution",
      changes: [{ path: "src/example.ts", content: "corrected" }],
    }),
    verdict("approve"),
    verdict("approve"),
    answer(),
  );
  await drain();
  expect(gh.revised).toEqual(["commit-a"]);
  expect(gh.published).toHaveLength(4);
  const state = repo.state();
  expect(state.reviewRounds).toHaveLength(2);
  expect(state.reviewRounds[0]!.status).toBe("superseded");
  expect(state.reviewRounds[1]!.status).toBe("approved");
  expect(state.work[0]!.status).toBe("done");
  expect(
    contexts.find((c) => c.review?.findings?.length)?.review?.findings,
  ).toEqual([
    "Fix the failing boundary condition. Evidence: Zero is rejected at src/example.ts:1 Verify: Test with zero.",
  ]);
});
test("review publication failure cannot count as an approval and retry cannot double-count it", async () => {
  const gh = reviews();
  company.execute({
    type: "ConfigureReviews",
    requiredReviews: 2,
    allowCodeChanges: true,
  });
  await linked();
  outputs.push(verdict("approve"), verdict("approve"));
  for (let i = 0; i < 3; i++) {
    const d = repo.claim()!;
    await company.deliver(d);
    repo.acknowledge(d.id);
  }
  const job = repo.claim()!;
  expect(job.effect.type).toBe("PublishReview");
  gh.adapter.publishReview = async () => {
    throw Error("GitHub unavailable");
  };
  await expect(company.deliver(job)).rejects.toThrow("GitHub unavailable");
  expect(repo.state().reviewRounds[0]!.status).toBe("collecting");
  expect(repo.events().some((e) => e.type === "ReviewCompleted")).toBe(false);
  gh.adapter.publishReview = async () => {};
  await company.deliver(job);
  await company.deliver(job);
  repo.acknowledge(job.id);
  expect(
    repo
      .state()
      .reviewRounds[0]!.reviews.filter((r) => r.status === "completed"),
  ).toHaveLength(1);
  await drain();
  expect(
    repo.events().filter((e) => e.type === "ReviewCompleted"),
  ).toHaveLength(1);
});
test("new PR commits invalidate old findings before delivery and require every reviewer again", async () => {
  const gh = reviews();
  company.execute({
    type: "ConfigureReviews",
    requiredReviews: 2,
    allowCodeChanges: true,
  });
  await linked();
  const start = repo.claim()!;
  await company.deliver(start);
  repo.acknowledge(start.id);
  gh.setHead("commit-new");
  outputs.push(verdict("approve"), verdict("approve"), answer());
  await drain();
  expect(repo.state().reviewRounds).toHaveLength(2);
  expect(repo.state().reviewRounds[0]!.status).toBe("superseded");
  expect(repo.state().reviewRounds[1]!.pullRequest.head).toBe("commit-new");
  expect(gh.published).toHaveLength(2);
  expect(repo.state().work[0]!.status).toBe("done");
});
test("corrections require authority, remain inspectable, and cannot bypass reviews by marking done", async () => {
  const gh = reviews();
  const { workId } = await linked();
  expect(() =>
    company.execute({ type: "WorkStatus", workId, status: "done" }),
  ).toThrow("required reviews");
  outputs.push(
    verdict("changes_requested"),
    verdict("approve"),
    answer({ changes: [{ path: "src/example.ts", content: "proposed" }] }),
  );
  await drain();
  expect(gh.revised).toHaveLength(0);
  expect(repo.state().work[0]!.status).toBe("blocked");
  expect(repo.state().threads.some((t) => t.kind === "inbox")).toBe(true);
  expect(repo.state().runs.at(-1)!.result?.changes[0]!.content).toBe(
    "proposed",
  );
});
test("two correction rounds lead to adjudication, one final correction and then stop", async () => {
  const gh = reviews();
  company.execute({
    type: "ConfigureReviews",
    requiredReviews: 1,
    allowCodeChanges: true,
  });
  await linked();
  const fix = () =>
    answer({ changes: [{ path: "src/example.ts", content: "correction" }] });
  outputs.push(
    verdict("changes_requested"),
    fix(),
    verdict("changes_requested"),
    fix(),
    verdict("changes_requested"),
    verdict("changes_requested"),
    fix(),
    verdict("changes_requested"),
  );
  await drain();
  expect(gh.revised).toHaveLength(3);
  expect(repo.state().work[0]!.status).toBe("blocked");
  expect(repo.state().threads[0]!.reason).toContain("final correction");
  expect(
    repo.state().runs.filter((r) => r.trigger === "adjudication"),
  ).toHaveLength(2);
  expect(repo.state().work[0]!.reviewProgress!.stopped).toBeTruthy();
});

test("correction authority can be granted later and the original findings resume", async () => {
  const gh = reviews();
  const { workId } = await linked();
  outputs.push(
    verdict("changes_requested"),
    verdict("approve"),
    answer({ changes: [{ path: "src/example.ts", content: "proposed" }] }),
  );
  await drain();
  company.execute({
    type: "ConfigureReviews",
    requiredReviews: 2,
    allowCodeChanges: true,
  });
  company.execute({ type: "ResumeCorrections", workId });
  outputs.push(
    answer({ changes: [{ path: "src/example.ts", content: "verified" }] }),
    verdict("approve"),
    verdict("approve"),
    answer(),
  );
  await drain();
  expect(gh.revised).toHaveLength(1);
  expect(repo.state().work[0]!.status).toBe("done");
  expect(repo.state().threads[0]!.status).toBe("resolved");
});

test("failed durable effects stay out of Inbox and can be retried without duplicating state", async () => {
  reviews();
  await linked();
  const d = repo.claim()!;
  repo.reject(d.id, "Connector unavailable", false);
  const threads = repo.state().threads;
  company.deliveryFailed(d, "Connector unavailable");
  expect(repo.state().threads).toEqual(threads);
  expect(repo.deliveryErrors().some(d => d.error === "Connector unavailable")).toBe(true);
  company.execute({ type: "RetryDelivery", deliveryId: d.id });
  const retried = repo.claim()!;
  expect(retried.id).toBe(d.id);
  await company.deliver(retried);
  repo.acknowledge(retried.id);
  expect(repo.state().reviewRounds).toHaveLength(1);
});

test("recovered runs leave the active delivery-failure list while retaining the event history", async () => {
  const { runId } = create();
  const d = repo.claim()!;
  repo.reject(d.id, "Interrupted transport", false);
  const threads = repo.state().threads;
  company.fail(runId, "Interrupted transport");
  expect(repo.state().threads).toEqual(threads);
  expect(repo.state().runs.find(r => r.id === runId)?.error).toBe("Interrupted transport");
  expect(workflows(repo.events().find(e => e.type === "RunFailed")!)).not.toContainEqual({ type: "ObserveDiscovery" });
  expect(repo.deliveryErrors()).toHaveLength(1);
  company.execute({ type: "RetryRun", runId });
  await drain();
  expect(repo.deliveryErrors()).toHaveLength(0);
  expect(repo.events().some((e) => e.type === "RunFailed")).toBe(true);
});

test("head polling invalidates the old round even if the new diff cannot be assembled", async () => {
  const gh = reviews();
  await linked();
  const d = repo.claim()!;
  await company.deliver(d);
  repo.acknowledge(d.id);
  gh.setHead("oversized-new-head");
  gh.adapter.inspect = async () => {
    throw Error("Review context too large");
  };
  await company.pollPullRequests();
  expect(repo.state().reviewRounds[0]!.status).toBe("superseded");
  expect(repo.state().work[0]!.pullRequest!.head).toBe("oversized-new-head");
  expect(repo.events().some((e) => e.type === "PullRequestUpdated")).toBe(true);
});

test("adjudicator can resolve disagreement and merge without a final correction or human PR review", async () => {
  const gh = reviews();
  company.execute({
    type: "ConfigureReviews",
    requiredReviews: 1,
    allowCodeChanges: true,
  });
  await linked();
  const fix = () =>
    answer({ changes: [{ path: "src/example.ts", content: "fixed" }] });
  outputs.push(
    verdict("changes_requested"),
    fix(),
    verdict("changes_requested"),
    fix(),
    verdict("changes_requested"),
    verdict("approve"),
  );
  await drain();
  const s = repo.state();
  expect(s.work[0]!.status).toBe("done");
  expect(gh.revised).toHaveLength(2);
  expect(s.runs.filter((r) => r.trigger === "adjudication")).toHaveLength(1);
  expect(s.runs.find((r) => r.trigger === "adjudication")?.role?.id).toBe(
    "adjudicator",
  );
  expect(
    contexts.find((c) => c.adjudication)?.adjudication?.history,
  ).toHaveLength(3);
  expect(s.threads.filter((t) => t.status === "open")).toHaveLength(0);
});

test("a final correction is checked by the adjudicator and can merge without reopening general review", async () => {
  const gh = reviews();
  company.execute({
    type: "ConfigureReviews",
    requiredReviews: 1,
    allowCodeChanges: true,
  });
  await linked();
  const fix = () =>
    answer({ changes: [{ path: "src/example.ts", content: "fixed" }] });
  outputs.push(
    verdict("changes_requested"),
    fix(),
    verdict("changes_requested"),
    fix(),
    verdict("changes_requested"),
    verdict("changes_requested"),
    fix(),
    verdict("approve"),
  );
  await drain();
  const s = repo.state();
  expect(s.work[0]!.status).toBe("done");
  expect(gh.revised).toHaveLength(3);
  expect(s.runs.filter((r) => r.trigger === "review")).toHaveLength(3);
  expect(s.runs.filter((r) => r.trigger === "adjudication")).toHaveLength(2);
  expect(contexts.find((c) => c.adjudication?.finalVerification)).toBeTruthy();
});

test("existing PR state migrates its correction count and historical findings instead of resetting the loop", async () => {
  reviews();
  const { workId } = await linked();
  await company.startReview(workId, "migration");
  const s = repo.state(),
    round = s.reviewRounds[0]!;
  round.reviews[0]!.verdict = "changes_requested";
  round.reviews[0]!.findings = ["Historical boundary defect"];
  delete s.work[0]!.reviewProgress;
  s.runs.push({
    ...s.runs[0]!,
    id: "legacy-correction",
    trigger: "revision",
    reviewRoundId: round.id,
    status: "completed",
  });
  repo.save(s);
  const migrated = repo.state().work[0]!.reviewProgress!;
  expect(migrated.corrections).toBe(1);
  expect(migrated.findings[0]!.problem).toBe("Historical boundary defect");
  expect(migrated.findings[0]!.status).toBe("open");
  expect(migrated.findings[0]!.evidence).toContain("not recorded");
});

test("disabling engineering authority still allows reviews but pauses automatic merging", async () => {
  const gh = reviews();
  await linked();
  outputs.push(verdict("approve"), verdict("approve"));
  await expect(drain()).rejects.toThrow("Automatic merging is paused");
  expect(gh.published).toHaveLength(2);
  expect(repo.state().reviewRounds[0]!.status).toBe("approved");
  expect(repo.state().work[0]!.mergedHead).toBeUndefined();
});
test("the runner refills a freed worker slot while another job is still running", async () => {
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => {release=resolve;});
  company.agent.execute = async () => {if(++calls===1) await gate;return answer();};
  const slow=create("Slow", "Slow");create("Fast", "Fast");
  const third=create("Third", "Third");
  const runner=new Runner(company,()=>true,2);
  const first=runner.tick();
  try {
    for(let i=0;i<50&&calls<2;i++)await Bun.sleep(5);
    await runner.tick();
    expect(repo.state().runs.find(r=>r.id===third.runId)!.status).toBe("completed");
    expect(repo.state().runs.find(r=>r.id===slow.runId)!.status).toBe("running");
  } finally {release();await first;}
});
