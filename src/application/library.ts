import { libraryFreshness, reviewTargets } from "../domain/freshness";
import type { Repository } from "./ports";
import {
  defaultPolicy,
  DomainError,
  type CompanyState,
  type Context,
  type Run,
  type AgentResult,
  type Thread,
} from "../domain/model";
import {
  documentRef,
  parseDocumentRef,
  subjectKey,
  type LibraryUpdate,
  type LibraryPage,
} from "../domain/library";
import type { EventInput, DomainEvent } from "../domain/events";

type Host = {
  repo: Repository;
  now(): string;
  id(): string;
  emit(
    input: EventInput,
    actor: DomainEvent["actor"],
    correlation: string,
    cause?: string | null,
  ): void;
  inbox(
    state: CompanyState,
    input: {
      subject: string;
      reason: string;
      recommendation: string;
      evidence: string[];
    },
    cause: string,
  ): Thread;
};
export class Library {
  constructor(private h: Host) {}
  queue(state: CompanyState, id: string, version: number) {
    const d = this.h.repo.document(id);
    if (
      !d ||
      d.version !== version ||
      (state.library.processed[id] || 0) >= version
    )
      return;
    // A maintained page is already synthesized. Reprocessing it would create a feedback loop.
    if (state.library.pages[id]) return;
    if ((state.policies[id]?.status || "active") !== "active") {
      delete state.library.pending[id];
      return;
    }
    state.library.pending[id] = version;
  }
  location(
    state: CompanyState,
    id: string,
    location: Pick<LibraryPage, "parentId" | "relatedIds" | "collection">,
  ) {
    if (location.parentId && !state.library.pages[location.parentId])
      throw new DomainError("Choose an existing subject as the parent.");
    if (
      location.relatedIds.some((ref) => ref === id || !state.library.pages[ref])
    )
      throw new DomainError(
        "Related subjects must be existing, different library pages.",
      );
    let parent = location.parentId;
    const seen = new Set([id]);
    while (parent) {
      if (seen.has(parent))
        throw new DomainError("Subjects cannot contain themselves.");
      seen.add(parent);
      parent = state.library.pages[parent]?.parentId || null;
    }
  }
  prepare(state: CompanyState, context: Context) {
    const documents = this.h.repo.documents();
    const freshness = libraryFreshness(state, documents, this.h.now());
    const targets = reviewTargets(state, documents, this.h.now()).slice(0, 2);
    // Target dependent subjects explicitly; relevance ranking must not decide which stale page is repaired.
    const targetDocs = targets.flatMap((id) => {
      const d = this.h.repo.document(id);
      return d ? [d] : [];
    });
    const ordered = [
      ...context.documents.filter((d) => d.level === "constitution"),
      ...targetDocs,
      ...context.documents.filter(
        (d) => d.level !== "constitution" && !targets.includes(d.id),
      ),
    ];
    let documentRoom = 60000;
    context.documents = ordered.filter((d) => {
      if (d.content.length > documentRoom && d.level !== "constitution")
        return false;
      documentRoom -= d.content.length;
      return true;
    });
    for (const d of targetDocs) {
      if (!context.documents.some((included) => included.id === d.id)) continue;
      context.entries = context.entries.filter((e) => e.id !== d.id);
      context.entries.push({
        id: d.id,
        title: d.title,
        version: d.version,
        included: true,
        reason:
          "Dependency or scheduled review: " +
          freshness[d.id]!.reasons.map((r) => r.message).join(" "),
        characters: d.content.length,
        policy: state.policies[d.id] || defaultPolicy(d),
        indexedVersion: d.indexed_version,
      });
      (context.libraryPages ||= {})[d.id] = structuredClone(
        state.library.pages[d.id]!,
      );
    }
    context.entries = context.entries.map((e) =>
      context.documents.some((d) => d.id === e.id)
        ? e
        : {
            ...e,
            included: false,
            characters: 0,
            reason: e.included
              ? "Replaced by required review context"
              : e.reason,
          },
    );
    context.evidenceRefs = context.evidenceRefs.filter(
      (ref) =>
        !parseDocumentRef(ref) ||
        context.documents.some((d) => documentRef(d) === ref),
    );
    for (const d of context.documents)
      if (!context.evidenceRefs.includes(documentRef(d)))
        context.evidenceRefs.push(documentRef(d));
    const sourceIds = [
      ...new Set([
        ...targets.flatMap((id) =>
          state.library.pages[id]!.sources.flatMap((ref) => {
            const d = parseDocumentRef(ref);
            return d ? [d.id] : [];
          }),
        ),
        ...Object.keys(state.library.pending).slice(0, 3),
      ]),
    ];
    let sourceRoom = 60000;
    const sources = sourceIds.flatMap((id) => {
      const d = this.h.repo.document(id);
      if (!d) return [];
      if (d.content.length > sourceRoom) {
        (context.gaps ||= []).push(
          `Source ${d.title} did not fit in the maintenance briefing.`,
        );
        return [];
      }
      sourceRoom -= d.content.length;
      return [d];
    });
    const catalog = Object.entries(state.library.pages)
      .flatMap(([id, meta]) => {
        const d = this.h.repo.document(id);
        return d
          ? [
              {
                id,
                title: d.title,
                version: d.version,
                collection: meta.collection,
                parentId: meta.parentId,
              },
            ]
          : [];
      })
      .slice(0, 200);
    context.maintenance = {
      sources,
      reviewTargets: targets
        .filter((id) => context.documents.some((d) => d.id === id))
        .map((documentId) => ({
          documentId,
          signature: freshness[documentId]!.signature,
          reasons: freshness[documentId]!.reasons.map((r) => r.message),
        })),
      catalog,
      sourcePolicies: Object.fromEntries(
        sources.map((d) => [d.id, state.policies[d.id] || defaultPolicy(d)]),
      ),
    };
    context.assignment =
      "Review the explicitly targeted subjects and maintain the subject library from the supplied evidence. Consolidate into existing pages when appropriate. No new finding is required.";
    // Sources are a separate, explicitly attributed evidence section. Avoid showing them twice.
    context.documents = context.documents.filter(
      (d) =>
        d.level === "constitution" ||
        targets.includes(d.id) ||
        !sources.some((s) => s.id === d.id),
    );
    context.entries = context.entries.filter(
      (e) =>
        context.documents.some(
          (d) =>
            d.id === e.id &&
            (d.level === "constitution" || targets.includes(d.id)),
        ) || !sources.some((s) => s.id === e.id),
    );
    for (const source of sources) {
      context.evidenceRefs.push(documentRef(source));
      if (!context.entries.some((e) => e.id === source.id && e.included))
        context.entries.push({
          id: source.id,
          title: source.title,
          version: source.version,
          included: true,
          reason: "New evidence for library maintenance",
          characters: source.content.length,
          policy: state.policies[source.id] || defaultPolicy(source),
          indexedVersion: source.indexed_version,
        });
    }
  }
  validate(state: CompanyState, update: LibraryUpdate, context?: Context) {
    const old = update.documentId
      ? this.h.repo.document(update.documentId)
      : undefined;
    if (update.documentId && (!old || !state.library.pages[old.id]))
      throw new DomainError(
        "Maintenance can only change library subjects, never governing documents.",
      );
    if (old && old.version !== update.expectedVersion)
      throw new DomainError(
        "This subject changed since the briefing. Re-run maintenance with its current revision.",
      );
    if (!old && update.expectedVersion !== null)
      throw new DomainError("A new subject cannot have a previous revision.");
    if (
      !old &&
      this.h.repo
        .documents()
        .some(
          (d) =>
            state.library.pages[d.id] &&
            subjectKey(d.title) === subjectKey(update.title),
        )
    )
      throw new DomainError(
        "This subject already exists. Update its current page instead.",
      );
    this.location(state, old?.id || "new-subject", update);
    if (context) {
      if (
        old &&
        !context.documents.some(
          (d) => d.id === old.id && d.version === old.version,
        )
      )
        throw new DomainError("Request the full subject before revising it.");
      if (
        update.sources.some(
          (ref) =>
            !context.evidenceRefs.includes(ref) &&
            !(
              update.disposition === "withdrawn" &&
              old &&
              state.library.pages[old.id]!.sources.includes(ref)
            ),
        )
      )
        throw new DomainError(
          "Library sources must be evidence supplied in this briefing.",
        );
    }
    if (update.disposition !== "withdrawn") {
      if (
        update.reviewAfter &&
        Date.parse(update.reviewAfter) <= Date.parse(this.h.now())
      )
        throw new DomainError(
          "Choose a future review date or clear it after review.",
        );
      const candidateId = old?.id || "new-subject";
      const proposedState = structuredClone(state);
      proposedState.library.pages[candidateId] = {
        ...update,
        managed: true,
        updatedAt: this.h.now(),
        withdrawn: false,
        reviewAfter: update.reviewAfter || null,
      };
      const status = libraryFreshness(
        proposedState,
        this.h.repo.documents(),
        this.h.now(),
      )[candidateId]!;
      if (status.status !== "current")
        throw new DomainError(
          "Review the current sources before confirming this subject: " +
            status.reasons.map((r) => r.message).join(" "),
        );
    }
    return old;
  }
  apply(state: CompanyState, update: LibraryUpdate, human = false) {
    const old = this.validate(state, update);
    const d = this.h.repo.saveDocument(
      {
        id: old?.id,
        expectedVersion: old?.version,
        level: "knowledge",
        title: update.title,
        content: update.content,
      },
      human ? "accepted-proposal" : "librarian",
    );
    state.library.pages[d.id] = {
      collection: update.collection,
      parentId: update.parentId,
      relatedIds: update.relatedIds,
      sources: [...new Set(update.sources)],
      managed: human
        ? false
        : old
          ? state.library.pages[old.id]!.managed
          : true,
      updatedAt: this.h.now(),
      reviewedAt: this.h.now(),
      reviewAfter: update.reviewAfter || null,
      withdrawn: update.disposition === "withdrawn",
    };
    state.policies[d.id] = old
      ? state.policies[d.id] || defaultPolicy(d)
      : defaultPolicy(d);
    delete state.library.pending[d.id];
    this.h.emit(
      {
        type: "KnowledgeChanged",
        payload: { documentId: d.id, version: d.version },
      },
      human ? "human" : "foreman",
      d.id,
    );
    return d.id;
  }
  applyUpdates(state: CompanyState, run: Run, output: AgentResult) {
    const context = run.context!;
    const ids: string[] = [];
    for (const update of output.libraryUpdates || []) {
      const old = this.validate(state, update, context);
      if (
        update.needsApproval ||
        (old && !state.library.pages[old.id]!.managed)
      ) {
        const thread = this.h.inbox(
          state,
          {
            subject: `Knowledge: ${update.title}`,
            reason: update.reason,
            recommendation: "Review the proposed change to this subject.",
            evidence: update.sources,
          },
          run.id,
        );
        thread.libraryProposals ||= [];
        thread.libraryProposals.push({
          ...update,
          reviewSignature: old
            ? libraryFreshness(state, this.h.repo.documents(), this.h.now())[
                old.id
              ]?.signature
            : undefined,
          id: this.h.id(),
          status: "pending",
        });
        thread.messages.push({
          id: this.h.id(),
          role: "foreman",
          content: update.reason,
          runId: run.id,
          at: this.h.now(),
        });
      } else ids.push(this.apply(state, update));
    }
    return ids;
  }
  complete(state: CompanyState, run: Run, output: AgentResult) {
    const context = run.context!;
    if (!context.maintenance)
      throw new DomainError("Missing library maintenance briefing.");
    if (
      output.work.length ||
      output.observations.length ||
      output.proposals.length ||
      output.changes.length ||
      output.discoveries.length
    )
      throw new DomainError(
        "Library maintenance may only synthesize subjects or request a decision.",
      );
    if (
      output.requests.some((r) =>
        r.evidence.some((ref) => !context.evidenceRefs.includes(ref)),
      )
    )
      throw new DomainError("Maintenance cited evidence outside its briefing.");
    const ids = this.applyUpdates(state, run, output);
    // Do not consume evidence when the model explicitly lacks context or reports a blocked pass.
    if (!output.contextRequests?.length && output.outcome === "completed") {
      for (const source of context.maintenance.sources) {
        state.library.processed[source.id] = source.version;
        if (state.library.pending[source.id] === source.version)
          delete state.library.pending[source.id];
      }
    }
    run.result = output;
    run.status = "completed";
    run.finishedAt = this.h.now();
    run.error = null;
    this.h.emit(
      {
        type: "LibraryMaintained",
        payload: { runId: run.id, documentIds: ids },
      },
      "foreman",
      run.id,
    );
    this.h.emit(
      { type: "RunCompleted", payload: { runId: run.id } },
      "foreman",
      run.id,
    );
  }
}
