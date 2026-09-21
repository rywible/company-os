import { afterEach, beforeEach, expect, test } from "bun:test";
import { Store } from "../src/server/store";
import { SQLiteRepository } from "../src/adapters/sqlite";
import { Company } from "../src/application/company";
import {
  agentResultSchema,
  type AgentResult,
  type Context,
} from "../src/domain/model";
import { libraryFreshness } from "../src/domain/freshness";
import { structuredKnowledge } from "./fixtures/curation";

let store: Store, repo: SQLiteRepository, company: Company;
let handler: (context: Context) => AgentResult;
let contexts: Context[];
const now = "2026-09-21T12:00:00.000Z";
const result = (o: Partial<AgentResult> = {}) =>
  agentResultSchema.parse({
    message: "Done",
    outcome: "completed",
    requests: [],
    proposals: [],
    work: [],
    observations: [],
    changes: [],
    review: null,
    ...o,
  });
const intake = (
  content = "A measured finding. https://example.test/spec",
  ready = true,
) =>
  company.execute({
    type: "SaveIntake",
    title: "Rendering findings",
    content,
    ready,
  }) as { id: string; version: number };
const discard = (c: Context) =>
  result({
    intakeResolutions: Object.entries(c.maintenance?.intake || {}).map(
      ([id]) => ({
        documentId: id,
        version: c.maintenance!.sources.find((d) => d.id === id)!.version,
        action: "discard",
        reason: "Already represented in Knowledge",
        updateIndexes: [],
      }),
    ),
  });
function incorporate(c: Context, approval = false) {
  const source = c.maintenance!.sources.find(
    (d) => c.maintenance!.intake?.[d.id],
  )!;
  if (!source) return result();
  return result({
    libraryUpdates: [
      {
        documentId: null,
        expectedVersion: null,
        title: "Rendering constraints",
        content: structuredKnowledge(
          "A measured finding supported by [the specification](https://example.test/spec).",
        ),
        formatVersion: 1,
        scope: "Browser rendering",
        summary: "Rendering constraints",
        aliases: ["Browser renderer"],
        collection: "Wrela",
        parentId: null,
        relatedIds: [],
        sources: [`document:${source.id}@${source.version}`],
        needsApproval: approval,
        reason: "Incorporate the findings",
      },
    ],
    intakeResolutions: [
      {
        documentId: source.id,
        version: source.version,
        action: "incorporate",
        reason: "Preserved in the subject",
        updateIndexes: [0],
      },
    ],
  });
}
beforeEach(() => {
  store = new Store(":memory:");
  repo = new SQLiteRepository(store, now);
  contexts = [];
  handler = discard;
  const state = repo.state();
  state.discovery.lenses.forEach((t) => {
    t.enabled = t.kind === "knowledge";
    t.dailyRunLimit = 20;
  });
  repo.save(state);
  company = new Company(
    repo,
    {
      repository: async () => ({}),
      execute: async (_id, c) => {
        contexts.push(c);
        return handler(c);
      },
    },
    {
      model: "test",
      embed: async (_s, task) => {
        if (task === "RETRIEVAL_QUERY") throw Error("offline");
        return Array.from({ length: 768 }, (_, i) => (i ? 0 : 1));
      },
    },
    {
      inspect: async () => {
        throw Error("unused");
      },
      artifact: async () => new Uint8Array(),
    },
    { now: () => new Date(now) },
  );
  company.execute({
    type: "SaveKnowledge",
    title: "Constitution",
    content: "Build useful software",
    level: "constitution",
    policy: { inclusion: "always", status: "active" },
  });
});
afterEach(() => store.close());
async function drain() {
  for (let i = 0; i < 150; i++) {
    const job = repo.claim();
    if (!job) return;
    await company.deliver(job);
    repo.acknowledge(job.id);
  }
  throw Error("Workflow did not settle");
}

test("ready intake immediately triggers one curator, publishes Knowledge and permanently deletes the input", async () => {
  handler = (c) => incorporate(c);
  const d = intake();
  await drain();
  const state = repo.state(),
    pageId = Object.keys(state.library.pages)[0]!;
  expect(state.runs.filter((r) => r.trigger === "maintenance")).toHaveLength(1);
  expect(repo.document(d.id)).toBeUndefined();
  expect(repo.document(d.id, 1)).toBeUndefined();
  expect(repo.history(d.id)).toEqual([]);
  expect(state.library.intake[d.id]).toBeUndefined();
  expect(state.library.pages[pageId]!.sources).toContain(
    "web:https://example.test/spec",
  );
  expect(
    state.library.pages[pageId]!.sources.some((r) => r.includes(d.id)),
  ).toBe(false);
  expect(libraryFreshness(state, repo.documents(), now)[pageId]!.status).toBe(
    "current",
  );
  expect(repo.document(pageId)?.indexed_version).toBe(1);
  expect(state.library.receipts).toEqual([
    expect.objectContaining({
      intakeId: d.id,
      action: "incorporate",
      documentIds: [pageId],
    }),
  ]);
  expect(JSON.stringify(state.library.receipts)).not.toContain(
    "measured finding",
  );
});

test("collecting intake stays outside normal retrieval and does not trigger curation", async () => {
  const d = intake("Rendering findings unfinished", false);
  await drain();
  expect(repo.state().runs).toHaveLength(0);
  const c = await company.preview("Rendering findings");
  expect(c.documents.some((p) => p.id === d.id)).toBe(false);
  expect(repo.search("Rendering findings").some((p) => p.id === d.id)).toBe(
    true,
  );
  company.execute({
    type: "ReadyIntake",
    documentId: d.id,
    expectedVersion: 1,
  });
  await drain();
  expect(repo.document(d.id)).toBeUndefined();
});

test("several ready events coalesce; a discarded item needs an explicit resolution", async () => {
  intake();
  intake("Duplicate finding");
  intake("Another duplicate");
  await drain();
  expect(
    repo.state().runs.filter((r) => r.trigger === "maintenance"),
  ).toHaveLength(1);
  expect(repo.state().library.receipts).toHaveLength(3);
  expect(repo.documents().some((d) => d.level === "intake")).toBe(false);
  handler = () => result();
  const d = intake();
  await expect(drain()).rejects.toThrow("Account for every supplied intake");
  expect(repo.document(d.id)).toBeDefined();
});

test("failed or stale curation leaves intake and Knowledge unchanged", async () => {
  const d = intake();
  handler = (c) => {
    const o = incorporate(c);
    o.libraryUpdates![0]!.sources.push("web:https://unseen.test");
    return o;
  };
  await expect(drain()).rejects.toThrow("supplied");
  expect(repo.document(d.id)?.version).toBe(1);
  expect(Object.keys(repo.state().library.pages)).toHaveLength(0);
});

test("an intake edit during curation rolls back the proposed update", async () => {
  const d = intake();
  handler = (c) => {
    const o = incorporate(c);
    company.execute({
      type: "SaveIntake",
      id: d.id,
      expectedVersion: 1,
      title: "Rendering findings",
      content: "Newer findings",
      ready: false,
    });
    return o;
  };
  await expect(drain()).rejects.toThrow("Intake changed");
  expect(repo.document(d.id)?.version).toBe(2);
  expect(Object.keys(repo.state().library.pages)).toHaveLength(0);
});

test("pending approval retains intake; acceptance publishes first then deletes", async () => {
  handler = (c) => incorporate(c, true);
  const d = intake();
  await drain();
  expect(repo.document(d.id)).toBeDefined();
  expect(Object.keys(repo.state().library.pages)).toHaveLength(0);
  const t = repo.state().threads.find((t) => t.libraryProposals?.length)!;
  company.execute({
    type: "ResolveLibraryProposal",
    threadId: t.id,
    proposalId: t.libraryProposals![0]!.id,
    action: "accept",
  });
  await drain();
  expect(repo.document(d.id)).toBeUndefined();
  expect(Object.keys(repo.state().library.pages)).toHaveLength(1);
});

test("dismissed approval retains intake for revision instead of deleting or repeatedly proposing it", async () => {
  handler = (c) => incorporate(c, true);
  const d = intake();
  await drain();
  const t = repo.state().threads.find((t) => t.libraryProposals?.length)!;
  company.execute({
    type: "ResolveLibraryProposal",
    threadId: t.id,
    proposalId: t.libraryProposals![0]!.id,
    action: "dismiss",
  });
  await drain();
  expect(repo.document(d.id)).toBeDefined();
  expect(repo.state().library.intake[d.id]?.status).toBe("collecting");
  expect(repo.state().runs).toHaveLength(1);
});

test("large intake is consumed in bounded slices and survives until its last slice", async () => {
  const d = intake("Finding. ".repeat(16000));
  const offsets: number[] = [];
  handler = (c) => {
    const slice = c.maintenance!.intakeSlices![d.id]!;
    offsets.push(slice.from);
    expect(repo.document(d.id)).toBeDefined();
    expect(
      c.maintenance!.sources.find((s) => s.id === d.id)!.content.length,
    ).toBeLessThanOrEqual(40000);
    return discard(c);
  };
  await drain();
  expect(offsets).toEqual([0, 40000, 80000, 120000]);
  expect(repo.document(d.id)).toBeUndefined();
});

test("paused curation preserves intake, and scheduler recovery processes it once resumed", async () => {
  const s = repo.state();
  s.discovery.lenses.find((t) => t.kind === "knowledge")!.enabled = false;
  repo.save(s);
  const d = intake();
  await drain();
  expect(repo.document(d.id)).toBeDefined();
  expect(repo.state().runs).toHaveLength(0);
  const resumed = repo.state();
  resumed.discovery.lenses.find((t) => t.kind === "knowledge")!.enabled = true;
  repo.save(resumed);
  company.heartbeat();
  await drain();
  expect(repo.document(d.id)).toBeUndefined();
});

test("migration separates raw notes from Knowledge and preserves IDs and external references", () => {
  const raw = repo.saveDocument(
    {
      title: "Legacy finding",
      content: "Useful claim\n\nSources: web:https://example.test/spec",
      level: "knowledge",
    },
    "foreman",
  );
  const s = repo.state();
  delete s.library.intakeVersion;
  repo.save(s);
  const migrated = repo.state();
  expect(repo.document(raw.id)?.level).toBe("intake");
  expect(migrated.library.intake[raw.id]?.sources).toContain(
    "web:https://example.test/spec",
  );
  expect(migrated.library.pending[raw.id]).toBe(1);
  expect(repo.history(raw.id)).toHaveLength(1);
});

test("reviewed research waits for curation, and a pending Knowledge decision keeps the assignment unfinished", async () => {
  handler = (c) => {
    if (c.maintenance) return incorporate(c, true);
    if (c.assignmentReview) {
      const notes = c.documents.filter((d) => d.level === "intake");
      expect(notes).toHaveLength(1);
      expect(repo.state().library.intake[notes[0]!.id]?.status).toBe(
        "collecting",
      );
      expect(Object.keys(repo.state().library.pages)).toHaveLength(0);
      return result({
        review: {
          verdict: "approve",
          summary: "Research checked",
          findings: [],
        },
      });
    }
    return result({ message: "A measured finding. https://example.test/spec" });
  };
  company.execute({
    type: "ProposeMilestone",
    plan: {
      title: "Research rendering",
      objective: "Understand browser constraints",
      criteria: "Reviewed findings are preserved in Knowledge",
      boundaries: "Research only",
      maxRuns: 6,
      maxParallel: 1,
      documentIds: [],
      assignments: [
        {
          key: "research",
          title: "Rendering research",
          roleId: "investigator",
          mode: "analysis",
          instruction: "Research the supplied browser constraints",
          criteria: "Record conclusions and uncertainties",
          outputs: ["Rendering knowledge"],
          dependsOn: [],
        },
      ],
    },
  });
  const milestone = repo.state().planning.milestones[0]!;
  company.execute({
    type: "DecideMilestone",
    milestoneId: milestone.id,
    expectedVersion: milestone.version,
    action: "approve",
    reason: "Proceed",
  });
  await drain();
  const state = repo.state(),
    work = state.work[0]!;
  expect(work.status).toBe("review");
  expect(work.awaitingCuration).toBe(true);
  expect(work.outputDocumentIds || []).toHaveLength(0);
  const t = state.threads.find((t) => t.libraryProposals?.length)!;
  company.execute({
    type: "ResolveLibraryProposal",
    threadId: t.id,
    proposalId: t.libraryProposals![0]!.id,
    action: "accept",
  });
  expect(repo.state().work[0]!.status).toBe("done");
  expect(repo.state().work[0]!.outputDocumentIds).toHaveLength(1);
});

test("deferred intake remains pending without repeatedly consuming curator runs", async () => {
  const d = intake();
  handler = (c) =>
    !c.maintenance?.intake?.[d.id]
      ? result()
      : result({
          intakeResolutions: [
            {
              documentId: d.id,
              version: 1,
              action: "defer",
              reason: "Need a decision about the conflicting targets",
              updateIndexes: [],
            },
          ],
        });
  await drain();
  expect(repo.state().library.intake[d.id]?.status).toBe("pending_decision");
  expect(
    repo.state().threads.some((t) => t.reason.includes("conflicting targets")),
  ).toBe(true);
  company.heartbeat();
  await drain();
  expect(contexts.filter((c) => c.maintenance?.intake?.[d.id])).toHaveLength(1);
});

test("a curation edit preserves the rest of a large page and survives human approval", async () => {
  const content = structuredKnowledge(
    "### Browser targets\n\nChrome, Firefox, Safari.\n\n### Other findings\n\n" +
      "Keep this material. ".repeat(9000),
  );
  const doc = company.execute({
    type: "SaveKnowledge",
    title: "Renderer",
    content,
    level: "knowledge",
    policy: { inclusion: "relevant", status: "active" },
  }) as { id: string };
  const d = intake("Browser targets now use Chromium on Sprite Linux CPUs.");
  handler = (c) =>
    !c.maintenance?.intake?.[d.id]
      ? discard(c)
      : result({
          documentEdits: [
            {
              documentId: doc.id,
              expectedVersion: 1,
              reason: "Refine targets",
              needsApproval: false,
              evidence: [`document:${d.id}@1`],
              sourceChanges: { add: [`document:${d.id}@1`], remove: [] },
              operations: [
                {
                  type: "replace_text",
                  oldText: "Chrome, Firefox, Safari.",
                  newText:
                    "Chromium on Sprite Linux CPUs; GPU availability is not assumed.",
                  expectedOccurrences: 1,
                },
              ],
            },
          ],
          intakeResolutions: [
            {
              documentId: d.id,
              version: 1,
              action: "incorporate",
              reason: "Updated browser targets",
              updateIndexes: [0],
            },
          ],
        });
  await drain();
  const t = repo.state().threads.find((t) => t.libraryProposals?.length)!;
  expect(t).toBeDefined();
  expect(repo.document(d.id)).toBeDefined();
  company.execute({
    type: "ResolveLibraryProposal",
    threadId: t.id,
    proposalId: t.libraryProposals![0]!.id,
    action: "accept",
  });
  await drain();
  expect(repo.document(doc.id)?.content).toBe(
    content.replace(
      "Chrome, Firefox, Safari.",
      "Chromium on Sprite Linux CPUs; GPU availability is not assumed.",
    ),
  );
  expect(repo.document(d.id)).toBeUndefined();
  expect(repo.document(doc.id)?.version).toBe(2);
});
