import { seedFixture } from "./fixtures/documents";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/server/store";
import { chunkDocument } from "../src/server/integrations";
import type { ForemanOutput } from "../src/contracts";
let store: Store;
beforeEach(() => (store = seedFixture(new Store(":memory:"))));
afterEach(() => store.close());
const vector = (axis: number) =>
  Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
function proposalRun(documentId = "product-direction") {
  const { runId } = store.direction(
    "Refine the product direction",
    "request-one",
  );
  const documents = store.documents();
  const output: ForemanOutput = {
    message: "A concrete refinement.",
    proposals: [
      {
        title: "Make the handoff measurable",
        kind: "product",
        rationale: "A visible outcome helps evaluation.",
        recommendation: "Evaluate two consecutive tasks.",
        documentId,
        content:
          "# Revised direction\nPreserve prior decisions across sessions.",
        evidenceRefs: [`document:${documentId}@1`],
      },
    ],
  };
  return {
    runId,
    output,
    context: {
      documents,
      evidenceRefs: documents.map((d) => `document:${d.id}@${d.version}`),
    },
  };
}
describe("durable company state", () => {
  test("direction submission is idempotent and has one durable job", () => {
    const first = store.direction("Build a useful first slice", "same-request");
    const second = store.direction(
      "Build a useful first slice",
      "same-request",
    );
    expect(first).toEqual(second);
    expect(store.snapshot().messages).toHaveLength(1);
    expect(
      store.db.query("SELECT count(*) n FROM jobs WHERE kind='foreman'").get(),
    ).toEqual({ n: 1 });
  });
  test("acceptance revises a document, records provenance, and cannot be applied twice", () => {
    const { runId, output, context } = proposalRun();
    store.completeRun(runId, output, context);
    const p = store.snapshot().proposals[0]!;
    store.resolveProposal(p.id, "accept");
    expect(store.document("product-direction")!.version).toBe(2);
    expect(store.document("product-direction")!.source).toBe(
      "accepted-proposal",
    );
    expect(
      store.snapshot().events.some((e) => e.type === "PROPOSAL_ACCEPTED"),
    ).toBe(true);
    expect(() => store.resolveProposal(p.id, "accept")).toThrow();
    expect(store.document("product-direction")!.version).toBe(2);
  });
  test("stale proposals cannot overwrite newer human decisions", () => {
    const { runId, output, context } = proposalRun();
    store.completeRun(runId, output, context);
    const d = store.document("product-direction")!;
    store.saveDocument({
      ...d,
      content: "Human changed direction",
      expectedVersion: 1,
    });
    expect(() =>
      store.resolveProposal(store.snapshot().proposals[0]!.id, "accept"),
    ).toThrow("changed");
    expect(store.document(d.id)!.content).toBe("Human changed direction");
    expect(store.snapshot().proposals[0]!.status).toBe("pending");
  });
  test("constitution edits and invented citations roll back the whole agent result", () => {
    const { runId, output, context } = proposalRun("constitution");
    expect(() => store.completeRun(runId, output, context)).toThrow(
      "protected",
    );
    expect(store.snapshot().proposals).toHaveLength(0);
    expect(store.snapshot().messages).toHaveLength(1);
    output.proposals[0]!.documentId = "product-direction";
    output.proposals[0]!.evidenceRefs = ["made-up:999"];
    expect(() => store.completeRun(runId, output, context)).toThrow("evidence");
    expect(store.document("constitution")!.version).toBe(1);
  });
  test("old embeddings disappear immediately and late embedding jobs cannot republish them", () => {
    const d = store.document("architecture")!;
    store.indexDocument(d.id, 1, "test-model", [
      { text: "Old infrastructure", vector: vector(0) },
    ]);
    expect(store.search("unrelatedword", vector(0), "test-model")[0]!.id).toBe(
      d.id,
    );
    store.saveDocument({
      ...d,
      content: "New infrastructure",
      expectedVersion: 1,
    });
    expect(store.search("unrelatedword", vector(0), "test-model")).toHaveLength(
      0,
    );
    expect(
      store.indexDocument(d.id, 1, "test-model", [
        { text: "Stale job", vector: vector(0) },
      ]),
    ).toBe(false);
    store.indexDocument(d.id, 2, "other-model", [
      { text: "New infrastructure", vector: vector(1) },
    ]);
    expect(store.search("unrelatedword", vector(0), "test-model")).toHaveLength(
      0,
    );
    expect(
      store.search("unrelatedword", vector(1), "other-model")[0]!.version,
    ).toBe(2);
  });
  test("invalid embeddings do not partially replace an index", () => {
    store.indexDocument("architecture", 1, "test-model", [
      { text: "Valid", vector: vector(0) },
    ]);
    expect(() =>
      store.indexDocument("architecture", 1, "test-model", [
        { text: "Invalid", vector: [0] },
      ]),
    ).toThrow();
    expect(
      store.search("unrelatedword", vector(0), "test-model")[0]!.excerpt,
    ).toBe("Valid");
  });
  test("chunking bounds long paragraphs and preserves content", () => {
    const content = "z".repeat(7000),
      chunks = chunkDocument("Topic", content);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length < 2300)).toBe(true);
    expect(chunks.join("").split("z").length - 1).toBe(7000);
  });
});

test("an interrupted job during sign-in becomes retryable instead of staying queued forever", async () => {
  const { Worker } = await import("../src/server/worker");
  const { Integrations } = await import("../src/server/integrations");
  const { runId } = store.direction(
    "Evaluate the next step",
    "interrupted-auth",
  );
  store.db.query("UPDATE jobs SET status='running' WHERE kind='foreman'").run();
  const token = process.env.SPRITES_TOKEN;
  process.env.SPRITES_TOKEN = "";
  const worker = new Worker(store, new Integrations());
  try {
    worker.start();
    expect(store.snapshot().runs[0]!.status).toBe("failed");
    expect(
      store
        .snapshot()
        .events.some(
          (e) => e.type === "RUN_INTERRUPTED" && e.entity_id === runId,
        ),
    ).toBe(true);
    expect(
      store.db.query("SELECT status FROM jobs WHERE kind='foreman'").get(),
    ).toEqual({ status: "failed" });
  } finally {
    worker.stop();
    if (token === undefined) delete process.env.SPRITES_TOKEN;
    else process.env.SPRITES_TOKEN = token;
  }
});
