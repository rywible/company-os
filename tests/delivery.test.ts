import { afterEach, expect, test } from "bun:test";
import { Store } from "../src/server/store";
import { SQLiteRepository } from "../src/adapters/sqlite";
import { Company } from "../src/application/company";
import { seedFixture } from "./fixtures/documents";
import {
  agentResultSchema,
  type AgentResult,
  type Context,
  type PullRequest,
} from "../src/domain/model";
import type { MilestonePlan } from "../src/domain/planning";
import {
  IntegrationChanged,
  type IntegrationCandidate,
} from "../src/domain/delivery";
import type { PullRequestPort } from "../src/application/ports";
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
const answer = (value: Partial<AgentResult> = {}) =>
  agentResultSchema.parse({
    message: "Verified behavior",
    outcome: "completed",
    review: null,
    changes: [],
    work: [],
    observations: [],
    proposals: [],
    requests: [],
    ...value,
  });
const approve = () =>
  answer({
    review: {
      verdict: "approve",
      summary: "Behavior meets criteria",
      findings: [],
      issues: [],
    },
  });
function fixture() {
  const store = seedFixture(new Store(":memory:"));
  stores.push(store);
  const repo = new SQLiteRepository(store, "2026-09-20T10:00:00.000Z");
  const branches = new Map([["main", "initial"]]);
  const prs: PullRequest[] = [],
    contexts: Context[] = [],
    actions: string[] = [];
  let counter = 0,
    acceptanceFails = 0,
    advanceTarget = 0,
    losePublication = false;
  const verificationResults = new Map<string, boolean>();
  const adapter: Required<PullRequestPort> = {
    branchHead: async (_repo, branch) => branches.get(branch)!,
    ensureBranch: async (_repo, branch, from) => {
      if (!branches.has(branch)) {
        branches.set(branch, branches.get(from) || from);
        actions.push(`branch:${branch}:${branches.get(branch)}`);
      }
      return branches.get(branch)!;
    },
    source: async (_repo, ref) => ({
      head: branches.get(ref) || ref,
      files: [{ path: "src/example.ts", content: "old" }],
    }),
    implement: async (_repo, branch, _head, runId) => {
      const head = `code-${runId}`;
      branches.set(branch, head);
      actions.push(`implement:${branch}`);
      return head;
    },
    open: async (repository, branch, base) => {
      let p = prs.find((p) => p.branch === branch && p.base === base);
      if (!p) {
        p = {
          repository,
          branch,
          base,
          head: branches.get(branch)!,
          number: ++counter,
          url: `https://github.com/example/repo/pull/${counter}`,
        };
        prs.push(p);
        actions.push(`pr:${branch}:${base}`);
      }
      p.head = branches.get(branch)!;
      if (losePublication) {
        losePublication = false;
        throw Error("Lost response after PR creation");
      }
      return structuredClone(p);
    },
    head: async (_repo, number) =>
      structuredClone(prs.find((p) => p.number === number)!),
    inspect: async (_repo, number) => ({
      pullRequest: structuredClone(prs.find((p) => p.number === number)!),
      files: [
        {
          path: "src/example.ts",
          content: "implemented",
          patch: "+implemented",
        },
      ],
    }),
    publishReview: async (_pr, id) => {
      actions.push(`review:${id}`);
    },
    revise: async (pr, runId) => {
      const current = prs.find((p) => p.number === pr.number)!;
      current.head = `fix-${runId}`;
      branches.set(pr.branch, current.head);
      return structuredClone(current);
    },
    candidate: async (pr) => ({
      pullRequest: pr,
      base: branches.get(pr.base!)!,
      head: `merge-${pr.head}-${branches.get(pr.base!)}`,
    }),
    verify: async (_repo, head, runId) => {
      const acceptance = !runId.startsWith("merge-");
      const failed =
        verificationResults.get(head) ?? (acceptance && acceptanceFails-- > 0);
      verificationResults.set(head, failed);
      actions.push(`verify:${acceptance ? "acceptance" : "assignment"}`);
      return {
        head,
        passed: !failed,
        checks: [
          {
            name: "Playtest",
            passed: !failed,
            output: failed
              ? "Level cannot be completed"
              : "Completed the playable level",
          },
        ],
      };
    },
    merge: async (candidate) => {
      if (advanceTarget-- > 0) throw new IntegrationChanged("Target advanced");
      branches.set(candidate.pullRequest.base!, candidate.head);
      prs.find((p) => p.number === candidate.pullRequest.number)!.merged = true;
      actions.push(`merge:${candidate.pullRequest.base}`);
      return candidate.head;
    },
  };
  let respond = (c: Context): AgentResult =>
    c.implementation && !c.review && !c.acceptance
      ? answer({
          changes: [{ path: "src/example.ts", content: "implemented" }],
        })
      : approve();
  const company = new Company(
    repo,
    {
      repository: async () => ({}),
      execute: async (_id, c) => {
        contexts.push(structuredClone(c));
        return respond(c);
      },
    },
    { model: "test", embed: async () => Array(768).fill(0) },
    {
      inspect: async () => {
        throw Error("Unexpected deployed-browser inspection");
      },
      artifact: async () => new Uint8Array(),
    },
    { now: () => new Date("2026-09-20T10:00:00.000Z") },
    { next: () => crypto.randomUUID() },
    adapter,
  );
  const state = repo.state();
  state.settings.allowCodeChanges = true;
  repo.save(state);
  const plan: MilestonePlan = {
    title: "Deliver a playable level",
    objective: "Complete the level",
    criteria: "The player can win",
    boundaries: "Source code and tests only",
    maxRuns: 30,
    maxParallel: 3,
    documentIds: [],
    assignments: [
      {
        key: "contract",
        title: "Implement shared interfaces",
        roleId: "architect",
        mode: "implementation",
        instruction: "Implement shared level interfaces",
        criteria: "Contract tests pass",
        outputs: ["Interfaces"],
        dependsOn: [],
      },
      {
        key: "vertical",
        title: "Implement level",
        roleId: "implementer",
        mode: "implementation",
        instruction: "Implement the playable level",
        criteria: "Level works",
        outputs: ["Playable level"],
        dependsOn: ["contract"],
      },
    ],
  };
  function start() {
    company.execute({ type: "ProposeMilestone", plan });
    const m = repo.state().planning.milestones[0]!;
    company.execute({
      type: "DecideMilestone",
      milestoneId: m.id,
      expectedVersion: m.version,
      action: "approve",
      reason: "Approved implementation",
    });
    return m.id;
  }
  async function drain() {
    for (let i = 0; i < 200; i++) {
      const job = repo.claim();
      if (!job) return;
      await company.deliver(job);
      repo.acknowledge(job.id);
    }
    throw Error(
      "Workflow failed to settle within a bounded number of deliveries",
    );
  }
  return {
    repo,
    company,
    adapter,
    plan,
    start,
    drain,
    contexts,
    actions,
    prs,
    branches,
    respond: (r: typeof respond) => {
      respond = r;
    },
    failAcceptance: (n: number) => {
      acceptanceFails = n;
    },
    advanceTarget: (n: number) => {
      advanceTarget = n;
    },
    losePublication: () => {
      losePublication = true;
    },
  };
}
test("autonomous checkout receipts enter the complete review and acceptance workflow without replacement files", async () => {
  const f = fixture();
  f.company.agent.engineer = async (id, context, _profile, assigned) => {
    assigned("worker");
    expect(context.implementation!.files).toEqual([]);
    return answer({ engineering: {
      runId: id, worker: "worker", repository: context.implementation!.repository,
      branch: context.implementation!.branch, base: context.implementation!.head, head: `native-${id}`,
    }});
  };
  f.company.agent.pushEngineering = async (receipt, authorize) => {
    expect(authorize()).toBe(true);
    f.branches.set(receipt.branch, receipt.head);
    f.actions.push("native-push");
    return receipt.head;
  };
  f.adapter.source = async () => { throw Error("A real checkout must not download a source snapshot."); };
  // Acceptance still reads integrated source; this check only covers workers.
  const source = f.adapter.source;
  f.adapter.source = async (repo, ref) => ref.startsWith("merge-") ? { head: ref, files: [] } : source(repo, ref);
  f.start(); await f.drain();
  expect(f.repo.state().planning.milestones[0]!.status).toBe("completed");
  expect(f.actions.filter(a => a === "native-push")).toHaveLength(2);
  expect(f.actions.some(a => a.startsWith("implement:"))).toBe(false);
  expect(f.repo.state().runs.filter(r => r.result?.engineering).every(r => r.context?.implementation?.worker === "worker")).toBe(true);
});
test("approved DAG creates assignment PRs, reviews and merges before dependencies, then accepts the exact integrated milestone", async () => {
  const f = fixture();
  f.start();
  await f.drain();
  const state = f.repo.state(),
    m = state.planning.milestones[0]!;
  expect(m.status).toBe("completed");
  expect(f.prs).toHaveLength(3);
  expect(
    f.prs.slice(0, 2).every((p) => p.base === m.delivery!.branch && p.merged),
  ).toBe(true);
  expect(f.prs[2]!.base).toBe("main");
  const assignments = state.work.filter((w) => !w.phase);
  expect(assignments[1]!.branchHead).toBeTruthy();
  const starts = f.contexts.filter((c) => c.implementation);
  expect(starts[1]!.implementation!.head).toBe(assignments[0]!.mergedHead!);
  expect(state.runs.filter((r) => r.trigger === "revision")).toHaveLength(0);
  expect(state.runs.filter((r) => r.trigger === "review")).toHaveLength(4);
  expect(state.runs.filter((r) => r.trigger === "acceptance")).toHaveLength(1);
  expect(f.branches.get("main")).toBe(m.delivery!.verification!.head);
  await f.company.signalWorker(state.reviewRounds[0]!.id, "duplicate");
  await f.drain();
  expect(f.prs).toHaveLength(3);
});
test("failed playtest blocks main even when the model approves, creates one bounded corrective assignment, and reruns acceptance", async () => {
  const f = fixture();
  const s = f.repo.state();
  s.settings.delivery.milestoneRequirements = "Actually play the level";
  f.repo.save(s);
  f.failAcceptance(1);
  f.start();
  await f.drain();
  const state = f.repo.state(),
    m = state.planning.milestones[0]!;
  expect(m.status).toBe("completed");
  expect(m.delivery!.attempts).toBe(2);
  expect(
    state.work.filter((w) => w.key.includes("acceptance-fix")),
  ).toHaveLength(1);
  expect(f.actions.filter((a) => a === "merge:main")).toHaveLength(1);
  expect(
    f.contexts.some(
      (c) => c.acceptance?.requirements === "Actually play the level",
    ),
  ).toBe(true);
});
test("acceptance exhaustion never merges main or manufactures unbounded replacement work", async () => {
  const f = fixture();
  f.failAcceptance(5);
  f.start();
  await f.drain();
  const state = f.repo.state(),
    m = state.planning.milestones[0]!;
  expect(m.status).toBe("paused");
  expect(m.delivery!.attempts).toBe(2);
  expect(f.branches.get("main")).toBe("initial");
  expect(
    state.work.filter((w) => w.key.includes("acceptance-fix")),
  ).toHaveLength(1);
  expect(
    state.threads.find((t) => t.id === m.threadId)!.recommendation,
  ).toContain("No manual PR review");
});
test("a PR publication response lost after creation replays the saved output and keeps one PR", async () => {
  const f = fixture();
  f.plan.assignments = [f.plan.assignments[0]!];
  f.start();
  f.losePublication();
  let failed: ReturnType<typeof f.repo.claim> = null;
  for (let i = 0; i < 30; i++) {
    const job = f.repo.claim();
    if (!job) break;
    try {
      await f.company.deliver(job);
      f.repo.acknowledge(job.id);
    } catch {
      failed = job;
      break;
    }
  }
  expect(failed?.effect.type).toBe("RunAgent");
  const count = f.contexts.length;
  await f.company.deliver(failed!);
  f.repo.acknowledge(failed!.id);
  await f.drain();
  expect(f.contexts.length).toBe(count + 3); // two reviewers and acceptance, no second implementation call
  expect(f.prs).toHaveLength(2);
  expect(f.repo.state().planning.milestones[0]!.status).toBe("completed");
});
test("review preferences are nonblocking but unsupported blockers cannot approve or trigger corrections", async () => {
  const f = fixture();
  f.plan.assignments = [f.plan.assignments[0]!];
  f.respond((c) =>
    c.review
      ? answer({
          review: {
            verdict: "changes_requested",
            summary: "Preference",
            findings: ["Rename it"],
            issues: [
              {
                id: "name",
                severity: "suggestion",
                category: "style",
                problem: "Prefer another name",
                evidence: "Current name is clear",
                verification: "Optional rename",
                status: "open",
              },
            ],
          },
        })
      : c.implementation
        ? answer({
            changes: [{ path: "src/example.ts", content: "implemented" }],
          })
        : approve(),
  );
  f.start();
  await f.drain();
  expect(f.repo.state().planning.milestones[0]!.status).toBe("completed");
  expect(f.repo.state().runs.some((r) => r.trigger === "revision")).toBe(false);
});
test("engineering requires authority and approval keeps a fixed policy while allowing later revocation", async () => {
  const f = fixture(),
    s = f.repo.state();
  s.settings.allowCodeChanges = false;
  f.repo.save(s);
  f.start();
  await expect(f.drain()).rejects.toThrow("Enable engineering");
  expect(f.prs).toHaveLength(0);
  const state = f.repo.state();
  expect(state.planning.milestones[0]!.delivery!.policy.correctionRounds).toBe(
    2,
  );
  state.settings.delivery.correctionRounds = 0;
  f.repo.save(state);
  expect(
    f.repo.state().planning.milestones[0]!.delivery!.policy.correctionRounds,
  ).toBe(2);
});

test("an incomplete review quorum cannot spend past the milestone allowance", async () => {
  const f = fixture();
  f.plan.maxRuns = 4;
  f.start();
  await f.drain();
  const state = f.repo.state(),
    m = state.planning.milestones[0]!;
  expect(m.status).toBe("paused");
  expect(state.runs.length).toBeLessThanOrEqual(4);
  expect(f.branches.get("main")).toBe("initial");
});

test("policy changes after approval do not expand the correction budget", async () => {
  const f = fixture();
  f.plan.assignments = [f.plan.assignments[0]!];
  f.start();
  const s = f.repo.state();
  s.settings.delivery.correctionRounds = 3;
  f.repo.save(s);
  await f.drain();
  expect(f.repo.state().work[0]!.reviewProgress!.policy.correctionRounds).toBe(
    2,
  );
});

test("a verification failure returns concrete executor feedback to a bounded fresh implementation attempt", async () => {
  const { VerificationFailed } = await import("../src/domain/delivery");
  const f = fixture();
  f.plan.assignments = [f.plan.assignments[0]!];
  const implement = f.adapter.implement;
  let calls = 0;
  f.adapter.implement = async (...args) => {
    if (calls++ === 0) throw new VerificationFailed("Boundary test failed");
    return implement(...args);
  };
  f.start();
  await f.drain();
  expect(f.repo.state().planning.milestones[0]!.status).toBe("completed");
  expect(
    f.contexts.find((c) => c.executionFeedback)?.executionFeedback?.error,
  ).toContain("Boundary test failed");
  expect(f.repo.state().runs.filter((r) => r.trigger === "work")).toHaveLength(
    2,
  );
});

test("repeated verification failure stops without inventing replacement assignments", async () => {
  const { VerificationFailed } = await import("../src/domain/delivery");
  const f = fixture();
  f.plan.assignments = [f.plan.assignments[0]!];
  f.adapter.implement = async () => {
    throw new VerificationFailed("Failing test");
  };
  f.start();
  await f.drain();
  expect(f.repo.state().work).toHaveLength(1);
  expect(f.repo.state().runs).toHaveLength(3);
  expect(f.repo.state().work[0]!.reviewProgress!.stopped).toContain(
    "Verification failed",
  );
  expect(f.prs).toHaveLength(0);
});

test("company requirements augment milestone acceptance, are frozen on approval, and do not block early interfaces", async () => {
  const f = fixture();
  const state = f.repo.state();
  state.settings.delivery.milestoneRequirements =
    "Record an end-to-end playtest";
  f.repo.save(state);
  f.start();
  const updated = f.repo.state();
  updated.settings.delivery.milestoneRequirements =
    "A later company requirement";
  f.repo.save(updated);
  await f.drain();
  const acceptance = f.contexts.find((c) => c.acceptance)!;
  expect(acceptance.acceptance!.criteria).toContain("The player can win");
  expect(acceptance.acceptance!.criteria).toContain(
    "Record an end-to-end playtest",
  );
  expect(acceptance.acceptance!.criteria).not.toContain(
    "A later company requirement",
  );
  expect(acceptance.assignmentReview!.criteria).toBe(
    acceptance.acceptance!.criteria,
  );
  const firstWork = f.repo
    .state()
    .work.find((w) => w.assignmentKey === "contract")!;
  expect(firstWork.criteria).toBe("Contract tests pass");
  expect(
    f.contexts.find((c) => c.work?.id === firstWork.id)!.milestoneRequirements,
  ).toBe("Record an end-to-end playtest");
  expect(
    f.repo.state().work.find((w) => w.phase === "acceptance")!.criteria,
  ).toBe(acceptance.acceptance!.criteria);
});

test("saved policies retire commands and project overrides while preserving company requirements", () => {
  const f = fixture();
  f.start();
  const s = f.repo.state();
  const legacy = {
    autoMerge: true,
    correctionRounds: 1,
    acceptanceAttempts: 2,
    verificationChecks: [{ name: "Old check", command: ["echo", "old"] }],
    companyAcceptance: { instructions: "Keep company acceptance", checks: [] },
    projectAcceptance: { instructions: "Remove project override", checks: [] },
  };
  s.settings.delivery = legacy as any;
  s.planning.milestones[0]!.delivery!.policy = legacy as any;
  f.repo.save(s);
  const migrated = f.repo.state();
  expect(migrated.settings.delivery).toEqual({
    autoMerge: true,
    correctionRounds: 1,
    acceptanceAttempts: 2,
    milestoneRequirements: "Keep company acceptance",
  });
  expect(migrated.planning.milestones[0]!.delivery!.policy).toEqual(
    migrated.settings.delivery,
  );
});

test.each(["assignment", "acceptance"])(
  "waiting for %s CI retries durable work without consuming agent runs or acceptance attempts",
  async (phase) => {
    const { ChecksPending } = await import("../src/domain/delivery");
    const { Runner } = await import("../src/application/runner");
    const f = fixture();
    const verify = f.adapter.verify;
    let pending = true;
    f.adapter.verify = async (...args) => {
      if (
        pending &&
        (phase === "acceptance"
          ? !args[2].startsWith("merge-")
          : args[2].startsWith("merge-"))
      )
        throw new ChecksPending("Waiting for CI");
      return verify(...args);
    };
    f.start();
    const isolated = f.repo.state();
    for (const task of isolated.discovery.lenses) task.enabled = false;
    f.repo.save(isolated);
    const runner = new Runner(f.company, () => true);
    for (let i = 0; i < 40; i++) {
      f.repo.store.db.exec(
        "UPDATE deliveries SET available_at=0 WHERE status='pending'",
      );
      await runner.tick();
      if (
        f.repo.store.db
          .query("SELECT 1 FROM deliveries WHERE error='Waiting for CI'")
          .get()
      )
        break;
    }
    expect(
      f.repo.store.db
        .query("SELECT 1 FROM deliveries WHERE error='Waiting for CI'")
        .get(),
    ).toBeTruthy();
    const waiting = f.repo.state();
    const count = waiting.runs.length;
    const contexts = f.contexts.length;
    const attempts = waiting.planning.milestones[0]!.delivery!.attempts;
    for (let i = 0; i < 4; i++) {
      f.repo.store.db.exec(
        "UPDATE deliveries SET available_at=0 WHERE status='pending'",
      );
      await runner.tick();
    }
    expect(f.repo.state().runs).toHaveLength(count);
    expect(f.contexts).toHaveLength(contexts);
    expect(f.actions.some((a) => a === "merge:main")).toBe(false);
    expect(f.repo.state().planning.milestones[0]!.delivery!.attempts).toBe(
      attempts,
    );
    expect(f.repo.deliveryErrors()).toEqual([]);
    pending = false;
    f.repo.store.db.exec(
      "UPDATE deliveries SET available_at=0 WHERE status='pending'",
    );
    await f.drain();
    expect(f.repo.state().planning.milestones[0]!.status).toBe("completed");
  },
);

test("failed assignment CI feeds correction evidence and persistent failure reaches the existing stop limit", async () => {
  const f = fixture();
  f.plan.assignments = [f.plan.assignments[0]!];
  f.adapter.verify = async (_repo, head) => ({
    head,
    passed: false,
    checks: [
      {
        name: "Contract tests",
        passed: false,
        output: "Missing required interface member",
      },
    ],
  });
  f.respond((c) =>
    c.review && !c.review.reviewId && !c.adjudication
      ? answer({ changes: [{ path: "src/example.ts", content: "corrected" }] })
      : c.implementation && !c.review
        ? answer({
            changes: [{ path: "src/example.ts", content: "implemented" }],
          })
        : approve(),
  );
  f.start();
  await f.drain();
  const state = f.repo.state(),
    work = state.work.find((w) => !w.phase)!;
  expect(work.reviewProgress!.stopped).toBeTruthy();
  expect(state.runs.filter((r) => r.trigger === "revision")).toHaveLength(3);
  expect(
    f.contexts.some((c) =>
      c.review?.findings?.some((finding) =>
        finding.includes("Missing required interface member"),
      ),
    ),
  ).toBe(true);
  expect(f.actions.some((a) => a.startsWith("merge:"))).toBe(false);
});
