import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Store } from "../src/server/store";
import { SQLiteRepository } from "../src/adapters/sqlite";
import { Company } from "../src/application/company";
import { initialDocuments, seedFixture } from "./fixtures/documents";
import { assembleContext } from "../src/application/context";
const embeddings = {
  model: "test",
  embed: async () => Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)),
};
test("new workspaces stay empty across restarts and do not contain an objective", () => {
  const dir = mkdtempSync(tmpdir() + "/company-empty-");
  try {
    for (let n = 0; n < 2; n++) {
      const store = new Store(dir + "/state.sqlite");
      const repo = new SQLiteRepository(store);
      expect(repo.documents()).toEqual([]);
      expect(repo.state().settings).not.toHaveProperty("objective");
      expect(repo.state().threads).toEqual([]);
      expect(repo.state().work).toEqual([]);
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("retire only untouched starter documents; preserve authored content and revision history", () => {
  const dir = mkdtempSync(tmpdir() + "/company-migrate-");
  try {
    let store = seedFixture(new Store(dir + "/state.sqlite"));
    store.saveDocument({
      id: "architecture",
      title: "My architecture",
      level: "architecture",
      content: "Actually written by the founder",
      expectedVersion: 1,
    });
    store.saveDocument(
      {
        id: "real-learning",
        title: "A real finding",
        level: "knowledge",
        content: "A result from actual work",
      },
      "foreman",
    );
    store.indexDocument("constitution", 1, "test", [
      {
        text: initialDocuments[0]!.content,
        vector: Array.from({ length: 768 }, (_, i) => (i ? 0 : 1)),
      },
    ]);
    store.close();
    store = new Store(dir + "/state.sqlite");
    expect(
      store
        .documents()
        .map((d) => d.id)
        .sort(),
    ).toEqual(["architecture", "real-learning"]);
    expect(store.document("architecture")!.version).toBe(2);
    expect(store.search("Purpose")).toEqual([]);
    expect(
      store.db
        .query("SELECT * FROM chunks WHERE document_id='constitution'")
        .all(),
    ).toHaveLength(0);
    expect(
      store.db
        .query("SELECT * FROM revisions WHERE document_id='constitution'")
        .all(),
    ).toHaveLength(1);
    const repo = new SQLiteRepository(store);
    expect(repo.document("constitution", 1)?.content).toBe(
      initialDocuments[0]!.content,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("direction comes from the current constitution, and exploration waits without one", async () => {
  const store = new Store(":memory:");
  try {
    const repo = new SQLiteRepository(store);
    const company = new Company(
      repo,
      {
        execute: async () => {
          throw Error("not called");
        },
        repository: async () => ({}),
      },
      embeddings,
      {
        inspect: async () => {
          throw Error("not called");
        },
        artifact: async () => new Uint8Array(),
      },
    );
    expect(
      (company.execute({ type: "ExploreDiscovery" }) as any).skipped,
    ).toContain("constitution");
    company.execute({
      type: "SaveKnowledge",
      id: "my-constitution",
      title: "Our purpose",
      level: "constitution",
      content: "Build useful tools for small orchestras.",
      policy: {
        inclusion: "always",
        status: "active",
        scope: "company",
        kind: "document",
      },
    });
    let context = await assembleContext(
      repo,
      embeddings,
      repo.state(),
      "direction",
      "company",
      new Date().toISOString(),
    );
    expect(context.constitutionRef).toBe("document:my-constitution@1");
    expect(context).not.toHaveProperty("objective");
    company.execute({
      type: "SaveKnowledge",
      id: "my-constitution",
      expectedVersion: 1,
      title: "Our purpose",
      level: "constitution",
      content: "Focus on conductors planning rehearsals.",
      policy: {
        inclusion: "always",
        status: "active",
        scope: "company",
        kind: "document",
      },
    });
    context = await assembleContext(
      repo,
      embeddings,
      repo.state(),
      "direction",
      "company",
      new Date().toISOString(),
    );
    expect(context.constitutionRef).toBe("document:my-constitution@2");
    expect(
      context.documents.find((d) => d.level === "constitution")!.content,
    ).toContain("conductors");
    const state: any = repo.state();
    state.settings.objective = "obsolete competing direction";
    repo.save(state);
    expect(repo.state().settings).not.toHaveProperty("objective");
    expect(
      (company.execute({ type: "ExploreDiscovery" }) as any).runId,
    ).toBeDefined();
  } finally {
    store.close();
  }
});
