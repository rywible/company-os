import {
  defaultPolicy,
  type CompanyState,
  type Context,
  type Run,
} from "../domain/model";
import type { EmbeddingPort, Repository } from "./ports";
// The same assembler powers previews and execution. Selection is inspectable;
// an embedding score is not a claim about a model's reasoning or influence.
export async function assembleContext(
  repo: Repository,
  embedding: EmbeddingPort,
  state: CompanyState,
  query: string,
  scope: string,
  now: string,
  run?: Run,
): Promise<Context> {
  let vector: number[] | undefined,
    searchMode = "hybrid";
  try {
    vector = await embedding.embed(query, "RETRIEVAL_QUERY");
  } catch {
    searchMode = "keyword fallback";
  }
  const hits = repo.search(query, vector, embedding.model),
    ranks = new Map(hits.map((d, i) => [d.id, i]));
  const thread = state.threads.find((t) => t.id === run?.threadId),
    work = state.work.find((w) => w.id === run?.workId);
  const documents = repo.documents();
  const attachment = thread?.attachment;
  const ordered = [...documents].sort((a, b) => {
    const score = (d: typeof a) =>
      d.level === "constitution"
        ? -100
        : d.id === attachment?.id
          ? -90
          : (state.policies[d.id] || defaultPolicy(d)).inclusion === "always"
            ? -80
            : (ranks.get(d.id) ?? 100);
    return score(a) - score(b);
  });
  const context: Context = {
    query,
    scope,
    assembledAt: now,
    documents: [],
    entries: [],
    evidenceRefs: [],
    messages: thread?.messages.slice(-20) || [],
    work,
    searchMode,
    objective: state.settings.objective,
    portfolio: {
      work: state.work.slice(-30),
      pendingThreads: state.threads
        .filter((t) => t.kind === "inbox" && t.status !== "resolved")
        .map((t) => ({ id: t.id, subject: t.subject, reason: t.reason })),
    },
  };
  let remaining = 60000;
  for (const current of ordered) {
    const d =
      current.id === attachment?.id
        ? repo.document(current.id, attachment.version) || current
        : current;
    const policy = state.policies[d.id] || defaultPolicy(d),
      pinned = d.id === attachment?.id;
    let included = false,
      reason = "No retrieval match";
    if (d.level === "constitution") {
      included = true;
      reason = "Constitution: always included";
    } else if (pinned) {
      included = true;
      reason = `Explicit attachment at v${d.version}`;
    } else if (policy.status !== "active")
      reason = `${policy.status}: excluded`;
    else if (policy.scope !== "company" && policy.scope !== scope)
      reason = "Outside this task’s scope";
    else if (policy.inclusion === "reference")
      reason = "Reference-only: requires explicit attachment";
    else if (policy.inclusion === "always") {
      included = true;
      reason = "Always included in this scope";
    } else if (ranks.has(d.id)) {
      included = true;
      reason = `${hits.find((h) => h.id === d.id)!.match} retrieval match #${ranks.get(d.id)! + 1}`;
    }
    if (included && d.content.length > remaining) {
      included = false;
      reason = "Excluded by context size limit";
    }
    if (included) {
      remaining -= d.content.length;
      context.documents.push(d);
      context.evidenceRefs.push(`document:${d.id}@${d.version}`);
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
  return context;
}
