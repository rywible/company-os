import { libraryFreshness, reviewTargets } from "../src/domain/freshness";
import { agentOutputSchema } from "../src/adapters/agents";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Store } from "../src/server/store";
import { SQLiteRepository } from "../src/adapters/sqlite";
import { Company } from "../src/application/company";
import { assembleContext } from "../src/application/context";
import { Library } from "../src/application/library";
import {
  agentResultSchema,
  defaultPolicy,
  type AgentResult,
  type Context,
} from "../src/domain/model";
import { documentRef, type LibraryUpdate } from "../src/domain/library";
import { renderBriefing } from "../src/domain/briefing";
let store: Store,
  repo: SQLiteRepository,
  company: Company,
  contexts: Context[],
  outputs: AgentResult[];
let execute: ((context: Context, id: string) => AgentResult) | undefined;
const now = "2026-09-20T12:00:00.000Z";
const vector = Array.from({ length: 768 }, (_, i) => (i ? 0 : 1));
const answer = (partial: Partial<AgentResult> = {}) =>
  agentResultSchema.parse({
    message: "Done",
    requests: [],
    proposals: [],
    work: [],
    observations: [],
    review: null,
    changes: [],
    outcome: "completed",
    ...partial,
  });
beforeEach(() => {
  store = new Store(":memory:");
  repo = new SQLiteRepository(store, now);
  contexts = [];
  outputs = [];
  execute = undefined;
  company = new Company(
    repo,
    {
      repository: async () => ({ ref: "github:test@123" }),
      execute: async (id, c) => {
        contexts.push(structuredClone(c));
        return execute?.(c, id) || outputs.shift() || answer();
      },
    },
    {
      model: "test",
      embed: async (_text, task) => {
        if (task === "RETRIEVAL_QUERY") throw Error("offline");
        return vector;
      },
    },
    {
      inspect: async () => {
        throw Error("not used");
      },
      artifact: async () => new Uint8Array(),
    },
    { now: () => new Date(now) },
  );
});
afterEach(() => store.close());
async function drain() {
  for (let i = 0; i < 100; i++) {
    const d = repo.claim();
    if (!d) return;
    await company.deliver(d);
    repo.acknowledge(d.id);
  }
  throw Error("did not settle");
}
function save(
  title: string,
  content: string,
  level: "knowledge" | "constitution" | "architecture" = "knowledge",
) {
  return company.execute({
    type: "SaveKnowledge",
    title,
    content,
    level,
    policy: {
      inclusion: level === "constitution" ? "always" : "relevant",
      scope: "company",
      status: "active",
      kind: "document",
    },
  }) as { id: string; version: number };
}
function update(
  title: string,
  content: string,
  source: string,
  documentId: string | null = null,
  version: number | null = null,
): LibraryUpdate {
  return {
    documentId,
    expectedVersion: version,
    title,
    content,
    collection: "Engineering",
    parentId: null,
    relatedIds: [],
    sources: [source],
    needsApproval: false,
    reason: "New evidence updates our understanding.",
  };
}
function runLibrary() {
  return company.execute({
    type: "ExploreDiscovery",
    lensId: "knowledge-library",
  }) as { runId?: string; skipped?: string };
}

test("conversation intent retrieves subject pages, parent guidance and related subjects without raw observations", async () => {
  save("Constitution", "Build maintainable software", "constitution");
  const parent = save(
    "Interface principles",
    "Respect attention and preserve drafts",
  );
  const page = save(
    "Document editor",
    "The document editor supports Markdown and mobile editing",
  );
  const related = save("Draft persistence", "Store unfinished text locally");
  company.execute({
    type: "OrganizeKnowledge",
    documentId: page.id,
    location: {
      collection: "Product",
      parentId: parent.id,
      relatedIds: [related.id],
    },
  });
  const raw = repo.saveDocument(
    {
      title: "Document editor experiment",
      content: "Maybe add flashing toolbars",
      level: "knowledge",
    },
    "foreman",
  );
  await drain();
  const start = company.execute({
    type: "StartConversation",
    subject: "Improve document editor",
    content: "Make the document editor work better on mobile",
  }) as { threadId: string };
  await drain();
  company.execute({
    type: "Reply",
    threadId: start.threadId,
    content: "Yes, implement that.",
  });
  await drain();
  const c = contexts.at(-1)!;
  expect(c.documents.map((d) => d.id)).toContain(page.id);
  expect(c.documents.map((d) => d.id)).toContain(parent.id);
  expect(c.documents.map((d) => d.id)).toContain(related.id);
  expect(c.documents.map((d) => d.id)).not.toContain(raw.id);
  expect(c.query).toContain("Make the document editor work better");
  expect(c.entries.find((e) => e.id === parent.id)?.reason).toContain(
    "Parent subject",
  );
  const prompt = renderBriefing(c);
  expect(prompt.indexOf("# 1. Constitution")).toBeLessThan(
    prompt.indexOf("# 2. Relevant knowledge"),
  );
  expect(prompt.indexOf("# 3. Conversation")).toBeLessThan(
    prompt.indexOf("# 4. Assignment"),
  );
  expect(prompt).not.toContain("flashing toolbars");
  expect(prompt).toContain(
    "keyword retrieval was unavailable".replace(
      "keyword retrieval",
      "Semantic retrieval",
    ),
  );
});

test("opening intent survives long conversations and never leaks another thread", async () => {
  const page = save(
    "Device authentication",
    "Device authentication uses a short-lived code.",
  );
  const a = company.execute({
    type: "StartConversation",
    subject: "Device authentication",
    content: "Discuss device authentication",
  }) as { threadId: string };
  await drain();
  const s = repo.state(),
    thread = s.threads.find((t) => t.id === a.threadId)!;
  for (let i = 0; i < 40; i++)
    thread.messages.push({
      id: `m${i}`,
      role: "human",
      content: `Follow up ${i}`,
      at: now,
    });
  repo.save(s);
  const c = await company.preview("Yes, do that", undefined, a.threadId);
  expect(c.documents.map((d) => d.id)).toContain(page.id);
  expect(c.messages[0]!.content).toContain("device authentication");
  expect(c.messages.length).toBeLessThanOrEqual(20);
  const b = company.execute({
    type: "StartConversation",
    subject: "Other topic",
    content: "Private unrelated sentence",
  }) as { threadId: string };
  await drain();
  expect(
    (await company.preview("continue", undefined, a.threadId)).query,
  ).not.toContain("Private unrelated");
  expect(b.threadId).not.toBe(a.threadId);
});

test("related pages cannot bypass retired, scope or reference-only policies", async () => {
  const parent = save("Restricted subject", "Secret guidance"),
    child = save(
      "Mobile controls",
      "Mobile controls need accessible hit areas",
    );
  company.execute({
    type: "OrganizeKnowledge",
    documentId: child.id,
    location: { collection: "Product", parentId: parent.id, relatedIds: [] },
  });
  for (const policy of [
    { status: "retired" as const },
    { scope: "other-company" },
    { inclusion: "reference" as const },
  ]) {
    const s = repo.state();
    s.policies[parent.id] = {
      ...defaultPolicy(repo.document(parent.id)!),
      ...policy,
    };
    repo.save(s);
    const c = await company.preview("Mobile controls");
    expect(c.documents.map((d) => d.id)).not.toContain(parent.id);
  }
});

test("evidence queues maintenance; a pass creates indexed canonical pages without recursive jobs", async () => {
  const constitution = save("Constitution", "Serve musicians", "constitution");
  await drain();
  expect(repo.state().library.pending[constitution.id]).toBe(1);
  outputs.push(
    answer({
      libraryUpdates: [
        update(
          "Audience",
          "We serve musicians. Their rehearsal workflow is not yet measured.",
          documentRef(constitution),
        ),
      ],
    }),
  );
  const { runId } = runLibrary();
  expect(runId).toBeDefined();
  await drain();
  const state = repo.state(),
    id = Object.keys(state.library.pages)[0]!;
  expect(repo.document(id)?.indexed_version).toBe(1);
  expect(state.library.pages[id]?.sources).toEqual([documentRef(constitution)]);
  expect(state.library.pending).toEqual({});
  expect(state.library.processed[constitution.id]).toBe(1);
  expect(contexts[0]!.maintenance?.sources[0]?.id).toBe(constitution.id);
  expect(state.runs.find((r) => r.id === runId)?.contextHistory).toHaveLength(
    1,
  );
  expect(runLibrary().skipped).toContain("up to date");
});

test("routine synthesis updates the same page and preserves revision history", async () => {
  const c = save("Constitution", "Mobile editor is central", "constitution");
  await drain();
  outputs.push(
    answer({
      libraryUpdates: [
        update(
          "Mobile editor",
          "Current editor supports Markdown",
          documentRef(c),
        ),
      ],
    }),
  );
  runLibrary();
  await drain();
  const id = Object.keys(repo.state().library.pages)[0]!;
  const evidence = save(
    "Mobile editor findings",
    "Mobile editor retains drafts",
    "architecture",
  );
  await drain();
  outputs.push(
    answer({
      libraryUpdates: [
        update(
          "Mobile editor",
          "Markdown editing now retains drafts",
          documentRef(evidence),
          id,
          1,
        ),
      ],
    }),
  );
  runLibrary();
  await drain();
  expect(Object.keys(repo.state().library.pages)).toEqual([id]);
  expect(repo.document(id)?.version).toBe(2);
  expect(repo.history(id)).toHaveLength(2);
  expect(repo.document(id)?.indexed_version).toBe(2);
});

test("human edits and changes of direction are inbox proposals; stale approval cannot overwrite", async () => {
  const c = save(
      "Constitution",
      "Keep the mobile editor simple",
      "constitution",
    ),
    page = save("Mobile editor", "Human-edited account of mobile editor");
  await drain();
  outputs.push(
    answer({
      libraryUpdates: [
        update(
          "Mobile editor",
          "Proposed synthesized account",
          documentRef(c),
          page.id,
          1,
        ),
      ],
    }),
  );
  runLibrary();
  await drain();
  let thread = repo.state().threads.find((t) => t.libraryProposals?.length)!;
  expect(repo.document(page.id)?.version).toBe(1);
  expect(thread.libraryProposals![0]!.status).toBe("pending");
  company.execute({
    type: "ResolveLibraryProposal",
    threadId: thread.id,
    proposalId: thread.libraryProposals![0]!.id,
    action: "accept",
  });
  await drain();
  expect(repo.document(page.id)?.version).toBe(2);
  expect(repo.state().library.pages[page.id]!.managed).toBe(false);
  const evidence = save(
    "Mobile editor findings",
    "Discuss mobile editor",
    "architecture",
  );
  await drain();
  outputs.push(
    answer({
      libraryUpdates: [
        update(
          "Mobile editor",
          "Second proposal",
          documentRef(evidence),
          page.id,
          2,
        ),
      ],
    }),
  );
  runLibrary();
  await drain();
  thread = repo
    .state()
    .threads.find((t) =>
      t.libraryProposals?.some((p) => p.status === "pending"),
    )!;
  company.execute({
    type: "SaveKnowledge",
    id: page.id,
    expectedVersion: 2,
    title: "Mobile editor",
    content: "More recent human correction",
    level: "knowledge",
    policy: defaultPolicy(repo.document(page.id)!),
  });
  expect(() =>
    company.execute({
      type: "ResolveLibraryProposal",
      threadId: thread.id,
      proposalId: thread.libraryProposals![0]!.id,
      action: "accept",
    }),
  ).toThrow("changed since");
  expect(repo.document(page.id)?.content).toBe("More recent human correction");
});

test("maintenance validates citations and cannot edit a governing document", async () => {
  const c = save("Constitution", "Company direction", "constitution");
  await drain();
  outputs.push(
    answer({
      libraryUpdates: [
        update("Invented", "Unsupported claim", "document:missing@1"),
      ],
    }),
  );
  runLibrary();
  let job = repo.claim()!;
  await expect(company.deliver(job)).rejects.toThrow("supplied");
  repo.acknowledge(job.id);
  expect(Object.keys(repo.state().library.pages)).toHaveLength(0);
  const r = repo.state().runs[0]!;
  company.fail(r.id, "invalid output");
  outputs.push(
    answer({
      libraryUpdates: [
        update(
          "Constitution",
          "Replace company direction",
          documentRef(c),
          c.id,
          1,
        ),
      ],
    }),
  );
  runLibrary();
  job = repo.claim()!;
  // ObserveDiscovery from failure may precede the new run.
  while (job.effect.type !== "RunAgent") {
    await company.deliver(job);
    repo.acknowledge(job.id);
    job = repo.claim()!;
  }
  await expect(company.deliver(job)).rejects.toThrow("governing");
  expect(repo.document(c.id)?.content).toBe("Company direction");
});

test("library has its own pause and run allowance, and manual runs preserve pause", async () => {
  save("Constitution", "Direction", "constitution");
  await drain();
  const task = repo
    .state()
    .discovery.lenses.find((l) => l.kind === "knowledge")!;
  company.execute({
    type: "SaveDiscoveryLens",
    lens: { ...task, enabled: false, dailyRunLimit: 1 },
  });
  const s = repo.state();
  for (const l of s.discovery.lenses) l.enabled = false;
  repo.save(s);
  company.heartbeat();
  expect(repo.state().runs).toHaveLength(0);
  runLibrary();
  await drain();
  expect(
    repo.state().discovery.lenses.find((l) => l.kind === "knowledge")?.enabled,
  ).toBe(false);
  save("New source", "New evidence", "architecture");
  await drain();
  expect(runLibrary().skipped).toContain("daily run limit");
});

test("supplemental context is automatic, bounded, and keeps supplied revisions fixed", async () => {
  const constitution = save(
      "Constitution",
      "Original direction",
      "constitution",
    ),
    page = save(
      "Unusual substrate",
      "An unrelated subject with useful details",
    );
  await drain();
  execute = (c, id) => {
    if (!id.endsWith("-context-1")) {
      company.execute({
        type: "SaveKnowledge",
        id: constitution.id,
        expectedVersion: 1,
        title: "Constitution",
        content: "New direction for future runs",
        level: "constitution",
        policy: defaultPolicy(repo.document(constitution.id)!),
      });
      return answer({
        contextRequests: [
          {
            subject: "Unusual substrate",
            reason: "Needed to answer accurately",
          },
        ],
      });
    }
    return answer({ message: "Answer based on supplied context" });
  };
  const { runId } = company.execute({
    type: "StartConversation",
    subject: "Other question",
    content: "Which option?",
  }) as { runId: string };
  await drain();
  const run = repo.state().runs.find((r) => r.id === runId)!;
  expect(contexts).toHaveLength(2);
  expect(run.contextHistory).toHaveLength(2);
  expect(
    run.context!.documents.find((d) => d.id === constitution.id)?.version,
  ).toBe(1);
  expect(run.context!.documents.map((d) => d.id)).toContain(page.id);
  expect(run.context!.additionalRequests?.[0]?.subject).toBe(
    "Unusual substrate",
  );
  expect(repo.document(constitution.id)?.version).toBe(2);
});

test("migration retains legacy notes as evidence and human entries as editable subjects", () => {
  const note = repo.saveDocument(
      {
        title: "Experiment note",
        content: "Tentative finding",
        level: "knowledge",
      },
      "foreman",
    ),
    human = repo.saveDocument({
      title: "Human subject",
      content: "My understanding",
      level: "knowledge",
    });
  const s: any = repo.state();
  delete s.library;
  s.settings.enabled = false;
  repo.save(s);
  const migrated = repo.state();
  expect(migrated.library.pending[note.id]).toBe(1);
  expect(migrated.library.pages[human.id]?.managed).toBe(false);
  expect(migrated.library.pages[human.id]?.collection).toBe("Unfiled");
  expect(repo.document(note.id)?.content).toBe("Tentative finding");
  expect(
    repo.state().discovery.lenses.filter((l) => l.kind === "knowledge"),
  ).toHaveLength(1);
});

test("organization rejects cycles without changing hierarchy", () => {
  const a = save("A", "A subject"),
    b = save("B", "B subject");
  company.execute({
    type: "OrganizeKnowledge",
    documentId: b.id,
    location: { collection: "Product", parentId: a.id, relatedIds: [] },
  });
  expect(() =>
    company.execute({
      type: "OrganizeKnowledge",
      documentId: a.id,
      location: { collection: "Product", parentId: b.id, relatedIds: [] },
    }),
  ).toThrow("themselves");
  expect(repo.state().library.pages[a.id]?.parentId).toBeNull();
});

test("a running conversation summary carries earlier agreements into later briefings", async () => {
  save("Constitution", "Build useful software", "constitution");
  await drain();
  outputs.push(
    answer({
      conversationSummary:
        "The agreed storage choice is SQLite with Tigris backups. The open question is retention.",
    }),
  );
  const { threadId } = company.execute({
    type: "StartConversation",
    subject: "Storage",
    content: "Let's decide on persistence",
  }) as { threadId: string };
  await drain();
  company.execute({
    type: "Reply",
    threadId,
    content: "What about retention?",
  });
  await drain();
  expect(contexts.at(-1)!.conversationSummary).toContain("SQLite with Tigris");
  expect(renderBriefing(contexts.at(-1)!)).toContain(
    "The open question is retention",
  );
});

test("an explicit decision change requires approval even for a new subject", async () => {
  const c = save("Constitution", "We serve musicians", "constitution");
  await drain();
  outputs.push(
    answer({
      libraryUpdates: [
        {
          ...update(
            "Audience",
            "Proposed audience change: orchestras",
            documentRef(c),
          ),
          needsApproval: true,
        },
      ],
    }),
  );
  runLibrary();
  await drain();
  expect(Object.keys(repo.state().library.pages)).toHaveLength(0);
  const t = repo.state().threads.find((t) => t.libraryProposals?.length)!;
  company.execute({
    type: "ResolveLibraryProposal",
    threadId: t.id,
    proposalId: t.libraryProposals![0]!.id,
    action: "accept",
  });
  await drain();
  const id = Object.keys(repo.state().library.pages)[0]!;
  expect(repo.document(id)?.title).toBe("Audience");
  expect(repo.state().library.pages[id]?.managed).toBe(false);
});

test("supplemental context cannot loop or authorize actions with unresolved gaps", async () => {
  execute = () =>
    answer({
      contextRequests: [
        { subject: "Unavailable evidence", reason: "Required measurement" },
      ],
      work: [
        {
          title: "Premature action",
          instruction: "Do something",
          criteria: "Done",
          mode: "analysis",
          track: "feature",
        },
      ],
    });
  company.execute({
    type: "StartConversation",
    subject: "A question",
    content: "Investigate",
  });
  await drain();
  expect(contexts).toHaveLength(2);
  expect(repo.state().work).toHaveLength(0);
  expect(repo.state().runs[0]?.result?.outcome).toBe("needs_input");
});

test("later replies refresh knowledge while previous reply snapshots remain readable", async () => {
  const page = save("Editor design", "Original account of editor behavior");
  await drain();
  const { threadId } = company.execute({
    type: "StartConversation",
    subject: "Editor design",
    content: "Explain editor design",
  }) as { threadId: string };
  await drain();
  company.execute({
    type: "SaveKnowledge",
    id: page.id,
    expectedVersion: 1,
    title: "Editor design",
    content: "Updated account of editor behavior",
    level: "knowledge",
    policy: defaultPolicy(repo.document(page.id)!),
  });
  await drain();
  company.execute({
    type: "Reply",
    threadId,
    content: "What is the current understanding?",
  });
  await drain();
  expect(contexts[0]!.documents.find((d) => d.id === page.id)?.content).toBe(
    "Original account of editor behavior",
  );
  expect(contexts[1]!.documents.find((d) => d.id === page.id)?.version).toBe(2);
  expect(repo.document(page.id)?.indexed_version).toBe(2);
});

test("the provider output schema requires all fields while old saved results remain readable", () => {
  function verify(node: any) {
    if (!node || typeof node !== "object") return;
    if (node.type === "object" && node.properties)
      expect([...node.required].sort()).toEqual(
        Object.keys(node.properties).sort(),
      );
    for (const value of Object.values(node))
      if (Array.isArray(value)) value.forEach(verify);
      else verify(value);
  }
  const schema = agentOutputSchema();
  verify(schema);
  expect((schema as any).required).toContain("conversationSummary");
  expect(answer().libraryUpdates).toBeUndefined();
});

test("a new finding about an existing subject still becomes maintenance evidence", async () => {
  save("Mobile editor", "The existing account");
  await drain();
  outputs.push(
    answer({
      observations: [
        {
          title: "Mobile editor",
          content: "A new uncertain behavior was observed",
          kind: "hypothesis",
          evidence: [],
        },
      ],
    }),
  );
  company.execute({
    type: "StartConversation",
    subject: "Mobile editor",
    content: "Investigate mobile editor",
  });
  await drain();
  const raw = repo.documents().find((d) => d.source === "foreman")!;
  expect(raw).toBeDefined();
  expect(repo.state().library.pending[raw.id]).toBe(1);
  expect(repo.state().policies[raw.id]?.kind).toBe("hypothesis");
});

test("import from the original document store preserves human knowledge organization", () => {
  const oldStore = new Store(":memory:");
  try {
    const d = oldStore.saveDocument({
      title: "Existing human knowledge",
      level: "knowledge",
      content: "Retain this entry",
    });
    const migrated = new SQLiteRepository(oldStore);
    expect(migrated.state().library.pages[d.id]?.managed).toBe(false);
    expect(migrated.document(d.id)?.version).toBe(1);
  } finally {
    oldStore.close();
  }
});

function linked(title: string, sources: string[], managed = true) {
  const d = save(title, `${title} current account`);
  const s = repo.state();
  s.library.pages[d.id] = { ...s.library.pages[d.id]!, sources, managed };
  repo.save(s);
  return d;
}
function editSource(id: string, content = "Changed findings") {
  const d = repo.document(id)!;
  return company.execute({
    type: "SaveKnowledge",
    ...d,
    expectedVersion: d.version,
    content,
    policy: defaultPolicy(d),
  }) as { id: string; version: number };
}
const freshness = () => libraryFreshness(repo.state(), repo.documents(), now);

test("source edits immediately withhold transitive subjects, including always-included pages", async () => {
  const source = save("Constitution", "Direction", "constitution");
  const a = linked("Operating model", [documentRef(source)]);
  const b = linked("Mobile decisions", [documentRef(a)]);
  const c = linked("Mobile controls", []);
  const state = repo.state();
  state.policies[a.id]!.inclusion = "always";
  state.library.pages[c.id]!.parentId = a.id;
  state.library.pages[c.id]!.relatedIds = [b.id];
  state.library.pending = {};
  state.discovery.lenses.forEach((l) => (l.enabled = false));
  repo.save(state);
  editSource(source.id);
  expect(freshness()[a.id]?.status).toBe("needs_review");
  expect(freshness()[b.id]?.status).toBe("needs_review");
  const context = await company.preview("Mobile controls Mobile decisions");
  expect(context.documents.map((d) => d.id)).not.toContain(a.id);
  expect(context.documents.map((d) => d.id)).not.toContain(b.id);
  expect(context.entries.find((e) => e.id === a.id)?.reason).toContain(
    "v1 to v2",
  );
  expect(reviewTargets(repo.state(), repo.documents(), now)).toEqual([a.id]);
});

test("maintenance targets stale subjects explicitly; reaffirmation refreshes indexing and downstream review", async () => {
  const source = save("Constitution", "Direction", "constitution");
  const a = linked("Unrelated substrate", [documentRef(source)]);
  const b = linked("Derived conclusion", [documentRef(a)]);
  await drain();
  const revised = editSource(source.id);
  await drain();
  outputs.push(
    answer({
      libraryUpdates: [
        update(
          "Unrelated substrate",
          "Still supported after checking",
          documentRef(revised),
          a.id,
          1,
        ),
      ],
    }),
  );
  runLibrary();
  await drain();
  expect(
    contexts.at(-1)!.maintenance?.reviewTargets?.map((t) => t.documentId),
  ).toEqual([a.id]);
  expect(contexts.at(-1)!.documents.some((d) => d.id === a.id)).toBe(true);
  expect(
    contexts
      .at(-1)!
      .maintenance?.sources.some((d) => d.id === source.id && d.version === 2),
  ).toBe(true);
  expect(freshness()[a.id]?.status).toBe("current");
  expect(repo.document(a.id)?.indexed_version).toBe(2);
  expect(repo.history(a.id)).toHaveLength(2);
  expect(reviewTargets(repo.state(), repo.documents(), now)).toEqual([b.id]);
});

test("scheduled reviews run without pending evidence and a no-op cannot clear them", async () => {
  save("Constitution", "Direction", "constitution");
  const page = linked("Time sensitive behavior", []);
  await drain();
  let s = repo.state();
  s.library.pending = {};
  repo.save(s);
  company.execute({
    type: "ScheduleKnowledgeReview",
    documentId: page.id,
    expectedVersion: 1,
    reviewAfter: "2026-09-19T12:00:00.000Z",
  });
  expect(freshness()[page.id]?.status).toBe("needs_review");
  expect(runLibrary().runId).toBeDefined();
  await drain();
  expect(contexts.at(-1)!.maintenance?.reviewTargets?.[0]?.documentId).toBe(
    page.id,
  );
  expect(freshness()[page.id]?.status).toBe("needs_review");
  company.execute({
    type: "ReviewKnowledge",
    documentId: page.id,
    expectedVersion: 1,
    action: "confirm",
    sources: [],
    reviewAfter: null,
  });
  await drain();
  expect(freshness()[page.id]?.status).toBe("current");
  expect(repo.document(page.id)?.indexed_version).toBe(2);
  expect(runLibrary().skipped).toContain("up to date");
  expect(
    libraryFreshness(
      repo.state(),
      repo.documents(),
      "2036-01-01T00:00:00.000Z",
    )[page.id]?.status,
  ).toBe("current");
});

test("retired, missing, and explicitly withdrawn sources invalidate pages while history remains", async () => {
  const raw = repo.saveDocument(
    { title: "Experiment", content: "Observed behavior", level: "knowledge" },
    "foreman",
  );
  const page = linked("Conclusion", [documentRef(raw)]);
  company.execute({
    type: "SetEvidenceStatus",
    documentId: raw.id,
    expectedVersion: 1,
    status: "retired",
  });
  expect(freshness()[page.id]?.reasons.some((r) => r.code === "inactive")).toBe(
    true,
  );
  expect(() =>
    company.execute({
      type: "ReviewKnowledge",
      documentId: page.id,
      expectedVersion: 1,
      action: "confirm",
      sources: [documentRef(raw)],
      reviewAfter: null,
    }),
  ).toThrow("current sources");
  company.execute({
    type: "SetEvidenceStatus",
    documentId: raw.id,
    expectedVersion: 1,
    status: "active",
  });
  expect(freshness()[page.id]?.status).toBe("current");
  company.execute({
    type: "WithdrawEvidenceReference",
    reference: documentRef(raw),
    reason: "Measurement was flawed",
    withdrawn: true,
  });
  expect(freshness()[page.id]?.reasons[0]?.message).toContain(
    "Measurement was flawed",
  );
  expect(
    libraryFreshness(
      repo.state(),
      repo.documents().filter((d) => d.id !== raw.id),
      now,
    )[page.id]?.status,
  ).toBe("needs_review");
  company.execute({
    type: "ReviewKnowledge",
    documentId: page.id,
    expectedVersion: 1,
    action: "withdraw",
    sources: [documentRef(raw)],
    reviewAfter: null,
  });
  expect(freshness()[page.id]?.status).toBe("withdrawn");
  expect(repo.document(page.id, 1)?.content).toContain("current account");
  expect(
    (await company.preview("Conclusion")).documents.map((d) => d.id),
  ).not.toContain(page.id);
});

test("editing raw evidence keeps it as evidence and invalidates dependents", () => {
  const raw = repo.saveDocument(
    { title: "Experiment", content: "Observed behavior", level: "knowledge" },
    "foreman",
  );
  const page = linked("Conclusion", [documentRef(raw)]);
  editSource(raw.id);
  expect(repo.state().library.pages[raw.id]).toBeUndefined();
  expect(freshness()[page.id]?.status).toBe("needs_review");
});

test("human review proposals remain withheld and source changes invalidate pending acceptance", async () => {
  const source = save("Constitution", "Direction", "constitution");
  const page = linked("Manual account", [documentRef(source)], false);
  await drain();
  const revised = editSource(source.id);
  await drain();
  outputs.push(
    answer({
      libraryUpdates: [
        update(
          "Manual account",
          "Updated understanding",
          documentRef(revised),
          page.id,
          1,
        ),
      ],
    }),
  );
  runLibrary();
  await drain();
  const t = repo.state().threads.find((t) => t.libraryProposals?.length)!;
  expect(freshness()[page.id]?.status).toBe("needs_review");
  expect(reviewTargets(repo.state(), repo.documents(), now)).toEqual([]);
  editSource(source.id, "Newer findings");
  expect(reviewTargets(repo.state(), repo.documents(), now)).toEqual([page.id]);
  expect(() =>
    company.execute({
      type: "ResolveLibraryProposal",
      threadId: t.id,
      proposalId: t.libraryProposals![0]!.id,
      action: "accept",
    }),
  ).toThrow("current sources");
  expect(repo.document(page.id)?.version).toBe(1);
});

test("a source change during execution rejects a stale synthesized result", async () => {
  const source = save("Constitution", "Direction", "constitution");
  await drain();
  execute = () => {
    editSource(source.id);
    return answer({
      libraryUpdates: [
        update("Premature conclusion", "Old evidence", documentRef(source)),
      ],
    });
  };
  runLibrary();
  const job = repo.claim()!;
  await expect(company.deliver(job)).rejects.toThrow("current sources");
  expect(Object.keys(repo.state().library.pages)).toHaveLength(0);
});

test("explicit attachment of a stale subject carries a historical warning", async () => {
  const source = save("Constitution", "Direction", "constitution");
  const page = linked("Operating model", [documentRef(source)]);
  editSource(source.id);
  company.execute({
    type: "StartConversation",
    subject: "Explain the old account",
    content: "What changed?",
    attachment: { id: page.id, version: 1 },
  });
  await drain();
  const c = contexts.at(-1)!;
  expect(c.documents.some((d) => d.id === page.id)).toBe(true);
  expect(c.gaps?.join(" ")).toContain("explicitly attached");
  expect(renderBriefing(c)).toContain("Do not treat it as current guidance");
});

test("missing support and circular citations never become current guidance", () => {
  const a = linked("First subject", ["document:missing@1"]);
  expect(freshness()[a.id]?.reasons[0]?.code).toBe("missing");
  const b = linked("Second subject", [documentRef(a)]);
  const s = repo.state();
  s.library.pages[a.id]!.sources = [documentRef(b)];
  repo.save(s);
  expect(freshness()[a.id]?.status).toBe("needs_review");
  expect(freshness()[b.id]?.status).toBe("needs_review");
  expect(
    reviewTargets(repo.state(), repo.documents(), now).length,
  ).toBeGreaterThan(0);
});

test("a withdrawn source subject is actionable for downstream maintenance", () => {
  const a = linked("Former guidance", []);
  const b = linked("Dependent guidance", [documentRef(a)]);
  company.execute({
    type: "ReviewKnowledge",
    documentId: a.id,
    expectedVersion: 1,
    action: "withdraw",
    sources: [],
    reviewAfter: null,
  });
  expect(reviewTargets(repo.state(), repo.documents(), now)).toEqual([b.id]);
});

test("external source withdrawal is explicit and reversible", () => {
  const ref = "github:example/project@abc123",
    page = linked("External finding", [ref]);
  company.execute({
    type: "WithdrawEvidenceReference",
    reference: ref,
    reason: "Superseded release",
    withdrawn: true,
  });
  expect(freshness()[page.id]?.status).toBe("needs_review");
  company.execute({
    type: "WithdrawEvidenceReference",
    reference: ref,
    reason: "Verified release",
    withdrawn: false,
  });
  expect(freshness()[page.id]?.status).toBe("current");
});
