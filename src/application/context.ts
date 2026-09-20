import { evidenceReferences } from "../domain/evidence";
import { documentRef } from "../domain/library";
import {
  defaultPolicy,
  type CompanyState,
  type Context,
  type Run,
} from "../domain/model";
import type { EmbeddingPort, Repository } from "./ports";

/** The conversation's opening intent survives short follow-ups and long threads. */
export function conversationInput(
  state: CompanyState,
  run: Run | undefined,
  task: string,
) {
  const thread = state.threads.find((t) => t.id === run?.threadId);
  const notes = thread?.messages || [];
  const selected = [...notes.slice(0, 2), ...notes.slice(-18)].filter(
    (m, i, a) => a.findIndex((n) => n.id === m.id) === i,
  );
  const messages = selected.map((m) => ({
    ...m,
    content: m.content.slice(0, 4000),
  }));
  const human = messages.filter((m) => m.role === "human");
  const query = [
    task.slice(0, 3000),
    thread?.subject,
    thread?.summary?.content,
    human[0]?.content,
    ...messages.slice(-6).map((m) => `${m.role}: ${m.content}`),
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 12000);
  return {
    query,
    messages,
    subject: thread?.subject,
    conversationSummary: thread?.summary?.content,
    excerpted:
      notes.length > messages.length ||
      notes.some((m) => m.content.length > 4000),
  };
}
export async function assembleContext(
  repo: Repository,
  embedding: EmbeddingPort,
  state: CompanyState,
  task: string,
  scope: string,
  now: string,
  run?: Run,
  requested: { subject: string; reason: string }[] = [],
): Promise<Context> {
  const input = conversationInput(state, run, task);
  const queries = [...requested.map((r) => r.subject), input.query].filter(
    Boolean,
  );
  const hits = new Map<string, { rank: number; match: string }>();
  let searchMode = "hybrid";
  for (const query of queries) {
    let vector: number[] | undefined;
    try {
      vector = await embedding.embed(query, "RETRIEVAL_QUERY");
    } catch {
      searchMode = "keyword fallback";
    }
    repo.search(query, vector, embedding.model, 30).forEach((h, i) => {
      const old = hits.get(h.id);
      if (!old || i < old.rank) hits.set(h.id, { rank: i, match: h.match });
    });
  }
  const thread = state.threads.find((t) => t.id === run?.threadId),
    work = state.work.find((w) => w.id === run?.workId);
  const documents = repo.documents(),
    attachment = thread?.attachment;
  const eligible = (d: (typeof documents)[number]) => {
    const p = state.policies[d.id] || defaultPolicy(d);
    return (
      p.status === "active" &&
      (p.scope === "company" || p.scope === scope) &&
      p.inclusion !== "reference" &&
      (d.level !== "knowledge" ||
        !!state.library.pages[d.id] ||
        run?.trigger === "maintenance")
    );
  };
  const reasons = new Map<string, string>();
  // An explicit supplemental subject can select an exact page even before embeddings finish.
  for (const request of requested)
    for (const d of documents)
      if (
        eligible(d) &&
        (d.title.toLowerCase() === request.subject.toLowerCase() ||
          d.id === request.subject)
      )
        reasons.set(d.id, `Additional context: ${request.reason}`);
  for (const d of documents
    .filter(eligible)
    .filter((d) => hits.has(d.id))
    .sort((a, b) => hits.get(a.id)!.rank - hits.get(b.id)!.rank)
    .slice(0, 6)) {
    if (!reasons.has(d.id))
      reasons.set(
        d.id,
        `${hits.get(d.id)!.match} match to this conversation and assignment`,
      );
  }
  // Expand a bounded neighborhood: ancestors for guidance and one hop of explicit related subjects.
  for (const id of [...reasons.keys()]) {
    let parent = state.library.pages[id]?.parentId;
    const seen = new Set([id]);
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const d = documents.find((d) => d.id === parent);
      if (d && eligible(d) && !reasons.has(parent))
        reasons.set(
          parent,
          `Parent subject of ${documents.find((d) => d.id === id)?.title}`,
        );
      parent = state.library.pages[parent]?.parentId;
    }
    for (const related of state.library.pages[id]?.relatedIds || []) {
      const d = documents.find((d) => d.id === related);
      if (d && eligible(d) && !reasons.has(related))
        reasons.set(
          related,
          `Related to ${documents.find((d) => d.id === id)?.title}`,
        );
    }
  }
  const priority = (d: (typeof documents)[number]) =>
    d.level === "constitution"
      ? -100
      : d.id === attachment?.id
        ? -90
        : (state.policies[d.id] || defaultPolicy(d)).inclusion === "always"
          ? -80
          : reasons.get(d.id)?.startsWith("Additional")
            ? -70
            : (hits.get(d.id)?.rank ?? 50);
  const context: Context = {
    query: input.query,
    assignment: task,
    subject: input.subject,
    conversationSummary: input.conversationSummary,
    scope,
    assembledAt: now,
    documents: [],
    entries: [],
    libraryPages: {},
    evidenceRefs: [],
    gaps: [],
    additionalRequests: requested,
    messages: input.messages,
    work,
    searchMode,
    constitutionRef: null,
    portfolio: {
      work: state.work.slice(-30),
      pendingThreads: state.threads
        .filter((t) => t.kind === "inbox" && t.status !== "resolved")
        .map((t) => ({ id: t.id, subject: t.subject, reason: t.reason })),
    },
  };
  let remaining = 60000;
  for (const current of [...documents].sort(
    (a, b) => priority(a) - priority(b),
  )) {
    // The constitution is always current; attachments may pin other documents to earlier revisions.
    const d =
      current.id === attachment?.id && current.level !== "constitution"
        ? repo.document(current.id, attachment.version)
        : current;
    if (!d) {
      context.gaps!.push(
        `The attached revision of ${current.title} is unavailable.`,
      );
      continue;
    }
    const policy = state.policies[d.id] || defaultPolicy(d),
      pinned = d.id === attachment?.id;
    let included = false,
      reason = "No relevant subject match";
    if (d.level === "constitution") {
      included = true;
      reason = "Constitution: always included";
    } else if (pinned) {
      included = true;
      reason = `Explicit attachment at v${d.version}`;
    } else if (!eligible(d))
      reason =
        d.level === "knowledge" && !state.library.pages[d.id]
          ? "Source evidence: available to library maintenance"
          : "Outside this scope, inactive, or reference-only";
    else if (policy.inclusion === "always") {
      included = true;
      reason = "Always included in this scope";
    } else if (reasons.has(d.id)) {
      included = true;
      reason = reasons.get(d.id)!;
    }
    if (
      included &&
      d.content.length > remaining &&
      d.level !== "constitution"
    ) {
      included = false;
      reason = "Excluded by context size limit";
      context.gaps!.push(`${d.title} did not fit in this briefing.`);
    }
    if (included) {
      remaining -= d.content.length;
      context.documents.push(d);
      context.evidenceRefs.push(documentRef(d));
      if (d.level === "constitution") context.constitutionRef = documentRef(d);
      if (state.library.pages[d.id])
        context.libraryPages![d.id] = structuredClone(
          state.library.pages[d.id]!,
        );
    }
    context.entries.push({
      id: d.id,
      title: d.title,
      version: d.version,
      included,
      reason,
      characters: included ? d.content.length : 0,
      policy,
      indexedVersion: current.indexed_version,
    });
  }
  if (input.excerpted)
    context.gaps!.push(
      "Conversation excerpts include the opening and recent exchanges. Use the running summary for earlier decisions; excerpts may be shortened.",
    );
  if (!context.constitutionRef)
    context.gaps!.push(
      "No constitution has been supplied. Do not invent company direction.",
    );
  if (!context.documents.some((d) => state.library.pages[d.id]))
    context.gaps!.push(
      "No maintained library subject matched this conversation. State uncertainty where necessary.",
    );
  if (searchMode !== "hybrid")
    context.gaps!.push(
      "Semantic retrieval was unavailable; selection used keyword matches and subject relationships.",
    );
  for (const request of requested)
    if (
      !context.documents.some(
        (d) =>
          d.title.toLowerCase().includes(request.subject.toLowerCase()) ||
          d.id === request.subject,
      )
    )
      context.gaps!.push(
        `Additional context requested: ${request.subject}. No exact subject was found; assess the supplied matches before relying on them.`,
      );
  context.evidenceRefs = evidenceReferences(context);
  return context;
}
