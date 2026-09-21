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
  intakeReferences,
  type LibraryUpdate,
  type LibraryPage,
} from "../domain/library";
import type { EventInput, DomainEvent } from "../domain/events";
import {
  applyDocumentEdit,
  DOCUMENT_OUTPUT_LIMIT,
  selectDocumentSections,
  validateMarkdown,
} from "../domain/document-edit";

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
  expandEdits(state: CompanyState, context: Context, output: AgentResult) {
    const updates = [...(output.libraryUpdates || [])];
    const seen = new Set(updates.map((u) => u.documentId).filter(Boolean));
    for (const edit of output.documentEdits || []) {
      const d = this.h.repo.document(edit.documentId),
        page = state.library.pages[edit.documentId];
      const supplied = context.documents.find(
        (d) => d.id === edit.documentId && d.version === edit.expectedVersion,
      );
      if (
        !d ||
        !page ||
        !supplied ||
        d.version !== edit.expectedVersion ||
        seen.has(d.id)
      )
        throw new DomainError(
          "Document edits need one supplied, current Knowledge revision per page.",
        );
      if (edit.evidence.some((ref) => !context.evidenceRefs.includes(ref)))
        throw new DomainError("Document edit cites unseen evidence.");
      const content = applyDocumentEdit(d.content, edit, supplied.content);
      validateMarkdown(content, page.formatVersion === 1);
      updates.push({
        ...page,
        documentId: d.id,
        expectedVersion: d.version,
        title: d.title,
        content,
        sources: [
          ...new Set([
            ...page.sources.filter(
              (ref) => !edit.sourceChanges?.remove.includes(ref),
            ),
            ...(edit.sourceChanges?.add || []),
          ]),
        ],
        reason: edit.reason,
        needsApproval: edit.needsApproval,
        replaceWholeDocument: false,
      });
      seen.add(d.id);
    }
    return { ...output, libraryUpdates: updates };
  }
  addIntake(
    state: CompanyState,
    input: {
      title: string;
      content: string;
      sources: string[];
      workId?: string;
      runId?: string;
      suggestedSubjectId?: string;
      ready: boolean;
    },
  ) {
    const d = this.h.repo.saveDocument(
      { title: input.title, content: input.content, level: "intake" },
      "foreman",
    );
    state.library.intake[d.id] = {
      status: input.ready ? "ready" : "collecting",
      sources: [
        ...new Set([...input.sources, ...intakeReferences(input.content)]),
      ],
      workId: input.workId,
      runId: input.runId,
      suggestedSubjectId: input.suggestedSubjectId,
    };
    state.policies[d.id] = { inclusion: "reference", status: "active" };
    if (input.workId) {
      const work = state.work.find((w) => w.id === input.workId);
      if (work) (work.intakeIds ||= []).push(d.id);
    }
    if (input.ready) this.readyIntake(state, d.id, d.version);
    return d;
  }
  readyIntake(state: CompanyState, id: string, version: number) {
    const d = this.h.repo.document(id),
      intake = state.library.intake[id];
    if (!d || d.version !== version || !intake)
      throw new DomainError("Intake changed. Reload before submitting.");
    const work = state.work.find((w) => w.id === intake.workId);
    if (
      work?.milestoneId &&
      (work.reviews?.at(-1)?.verdict !== "approve" ||
        intake.reviewedVersion !== version)
    )
      throw new DomainError("This research is waiting for assignment review.");
    if (intake.batchId)
      throw new DomainError(
        "Resolve the pending Knowledge changes before resubmitting this intake.",
      );
    intake.status = "ready";
    state.library.pending[id] = version;
    this.h.emit(
      { type: "IntakeReady", payload: { documentId: id, version } },
      "system",
      id,
    );
  }
  durableSources(
    state: CompanyState,
    refs: string[],
    seen = new Set<string>(),
  ): string[] {
    return [
      ...new Set(
        refs.flatMap((ref) => {
          const id = parseDocumentRef(ref)?.id;
          if (!id || !state.library.intake[id]) return [ref];
          if (seen.has(id)) return [];
          const next = new Set(seen);
          next.add(id);
          return this.durableSources(
            state,
            state.library.intake[id]!.sources,
            next,
          );
        }),
      ),
    ];
  }
  deleteIntake(
    state: CompanyState,
    id: string,
    version: number,
    runId: string,
    action: "incorporate" | "discard" | "deleted",
    documentIds: string[] = [],
  ) {
    // Existing migrated pages may still cite an ephemeral finding. Retain its
    // useful external references before physically removing the source record.
    for (const [pageId, page] of Object.entries(state.library.pages)) {
      const refs = page.sources.filter(
        (ref) => parseDocumentRef(ref)?.id === id,
      );
      if (!refs.length) continue;
      const d = this.h.repo.document(pageId);
      if (!d) continue;
      const replacements = this.durableSources(state, refs);
      let content = d.content;
      for (const ref of refs)
        content = content.replaceAll(
          ref,
          replacements.join(", ") || "Curated finding",
        );
      const revised = this.h.repo.saveDocument(
        {
          id: d.id,
          expectedVersion: d.version,
          title: d.title,
          level: d.level,
          content,
        },
        "librarian",
      );
      page.sources = [
        ...new Set([
          ...page.sources.filter((ref) => !refs.includes(ref)),
          ...replacements,
        ]),
      ];
      // Detaching an old citation must not silently certify the old conclusion.
      page.reviewAfter = this.h.now();
      this.h.emit(
        {
          type: "KnowledgeChanged",
          payload: { documentId: d.id, version: revised.version },
        },
        "system",
        d.id,
      );
    }
    this.h.repo.deleteIntake(id, version);
    delete state.library.intake[id];
    delete state.library.pending[id];
    delete state.library.processed[id];
    delete state.policies[id];
    state.library.receipts.push({
      runId,
      at: this.h.now(),
      intakeId: id,
      action,
      documentIds,
    });
    state.library.receipts = state.library.receipts.slice(-500);
  }
  finishBatches(state: CompanyState) {
    for (const [runId, batch] of Object.entries(state.library.batches)) {
      const proposals = state.threads
        .flatMap((t) => t.libraryProposals || [])
        .filter((p) => batch.proposalIds.includes(p.id));
      if (proposals.some((p) => p.status === "pending")) continue;
      const rejected =
        proposals.some((p) => p.status === "dismissed") ||
        proposals.length !== batch.proposalIds.length;
      for (const source of batch.sources) {
        const d = this.h.repo.document(source.id),
          intake = state.library.intake[source.id];
        if (!d || !intake) continue;
        delete intake.batchId;
        if (rejected || d.version !== source.version) {
          intake.status = "collecting";
          delete state.library.pending[d.id];
          continue;
        }
        const documentIds = [
          ...new Set([
            ...source.documentIds,
            ...proposals
              .filter((p) => source.proposalIds.includes(p.id))
              .flatMap((p) => p.appliedDocumentId || []),
          ]),
        ];
        if (source.through < d.content.length) {
          intake.processedCharacters = source.through;
          intake.status = "ready";
          state.library.pending[d.id] = d.version;
        } else
          this.deleteIntake(
            state,
            d.id,
            d.version,
            runId,
            source.action,
            documentIds,
          );
        for (const work of state.work.filter((w) =>
          w.intakeIds?.includes(d.id),
        ))
          work.outputDocumentIds = [
            ...new Set([...(work.outputDocumentIds || []), ...documentIds]),
          ];
      }
      delete state.library.batches[runId];
    }
    for (const work of state.work.filter(
      (w) => w.awaitingCuration && w.status === "review",
    )) {
      if (work.intakeIds?.some((id) => state.library.intake[id])) continue;
      work.awaitingCuration = false;
      work.status = "done";
      work.updatedAt = this.h.now();
      this.h.emit(
        {
          type: "WorkStatusChanged",
          payload: { workId: work.id, status: work.status },
        },
        "system",
        work.id,
      );
    }
  }
  queue(state: CompanyState, id: string, version: number) {
    const d = this.h.repo.document(id);
    if (
      !d ||
      d.version !== version ||
      (state.library.processed[id] || 0) >= version
    )
      return;
    // A maintained page is already synthesized. Reprocessing it would create a feedback loop.
    if (
      state.library.pages[id] ||
      (state.library.intake[id] && state.library.intake[id]!.status !== "ready")
    )
      return;
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
      if (!d) return [];
      const selected = selectDocumentSections(d.content, context.query);
      (context.documentSections ||= {})[id] = {
        partial: selected.partial,
        outline: selected.outline,
      };
      return [{ ...d, content: selected.content }];
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
        ...Object.keys(state.library.pending)
          .filter(
            (id) =>
              !state.library.intake[id] ||
              state.library.intake[id]!.status === "ready",
          )
          .slice(0, 3),
      ]),
    ];
    let sourceRoom = 60000;
    const intakeSlices: NonNullable<Context["maintenance"]>["intakeSlices"] =
      {};
    const sources = sourceIds.flatMap((id) => {
      const d = this.h.repo.document(id);
      if (!d) return [];
      if (state.library.intake[id]) {
        const from = state.library.intake[id]!.processedCharacters || 0;
        const through = Math.min(
          d.content.length,
          from + Math.min(40000, sourceRoom),
        );
        if (through <= from) return [];
        intakeSlices[id] = { from, through, total: d.content.length };
        sourceRoom -= through - from;
        return [{ ...d, content: d.content.slice(from, through) }];
      }
      if (d.content.length > sourceRoom) return [];
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
                summary: meta.summary,
                scope: meta.scope,
                aliases: meta.aliases,
                sections: selectDocumentSections(d.content, "").outline.slice(
                  0,
                  60,
                ),
              },
            ]
          : [];
      })
      .slice(0, 200);
    context.maintenance = {
      intakeSlices,
      intake: Object.fromEntries(
        sources
          .filter((d) => state.library.intake[d.id])
          .map((d) => [d.id, structuredClone(state.library.intake[d.id]!)]),
      ),
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
    // Rank subjects against this intake, not just the generic maintenance task.
    // The bounded catalog still lets Foreman request a more specific section.
    const intakeQuery = sources
      .map((d) => d.title + "\n" + d.content.slice(0, 6000))
      .join("\n");
    const matches = this.h.repo.search(
      intakeQuery,
      undefined,
      undefined,
      12,
      "library",
    );
    const suggested = sources.flatMap(
      (d) => state.library.intake[d.id]?.suggestedSubjectId || [],
    );
    let room = Math.max(
      0,
      60000 - context.documents.reduce((n, d) => n + d.content.length, 0),
    );
    for (const id of [
      ...new Set([...suggested, ...matches.map((d) => d.id)]),
    ]) {
      const d = this.h.repo.document(id);
      if (
        !d ||
        !state.library.pages[id] ||
        context.documents.some((d) => d.id === id)
      )
        continue;
      const selected = selectDocumentSections(
        d.content,
        intakeQuery,
        Math.min(16000, room),
      );
      if (!selected.content || selected.content.length > room) continue;
      context.documents.push({ ...d, content: selected.content });
      (context.documentSections ||= {})[id] = {
        partial: selected.partial,
        outline: selected.outline,
      };
      (context.libraryPages ||= {})[id] = structuredClone(
        state.library.pages[id]!,
      );
      context.evidenceRefs.push(documentRef(d));
      room -= selected.content.length;
    }
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
      context.evidenceRefs.push(
        ...this.durableSources(state, [documentRef(source)]),
      );
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
  validate(
    state: CompanyState,
    update: LibraryUpdate,
    context?: Context,
    patched = false,
  ) {
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
    validateMarkdown(
      update.content,
      update.formatVersion === 1 ||
        state.library.pages[old?.id || ""]?.formatVersion === 1,
    );
    if (!patched && context && update.content.length >= DOCUMENT_OUTPUT_LIMIT)
      throw new DomainError(
        "Generated document reached its output boundary. Use targeted edits or split the subject.",
      );
    if (!patched && old && context && !update.replaceWholeDocument)
      throw new DomainError(
        "Use documentEdits for targeted changes, or explicitly set replaceWholeDocument for an intentional full rewrite.",
      );
    if (!patched && old && context?.documentSections?.[old.id]?.partial)
      throw new DomainError(
        "Only sections of this document were supplied. Use targeted documentEdits, or request the complete page before replacement.",
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
            !(old && state.library.pages[old.id]!.sources.includes(ref)),
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
      formatVersion: update.formatVersion,
      summary: update.summary,
      scope: update.scope,
      aliases: update.aliases,
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
    for (const proposed of output.libraryUpdates || []) {
      if (
        context.maintenance &&
        proposed.formatVersion !== 1 &&
        !output.documentEdits?.some((e) => e.documentId === proposed.documentId)
      )
        throw new DomainError(
          "Curated Knowledge must use formatVersion 1 and the standard Markdown sections.",
        );
      const existingSources = proposed.documentId
        ? state.library.pages[proposed.documentId]?.sources || []
        : [];
      // Relationships are optional organization hints. Agent briefings also contain
      // IDs for governing documents and raw evidence, which are valid sources but
      // cannot be library relationships. Do not discard a substantive page update
      // when the agent mistakes one of those IDs for a related subject.
      const update = {
        ...proposed,
        relatedIds: [
          ...new Set(
            proposed.relatedIds.filter(
              (ref) =>
                ref !== proposed.documentId && !!state.library.pages[ref],
            ),
          ),
        ],
        // The current page is supplied so the agent can revise it, but it is not
        // evidence for itself. Treat a self-reference as shorthand for retaining
        // the page's existing provenance instead of creating a freshness cycle.
        sources: [
          ...new Set(
            proposed.sources.flatMap((ref) =>
              parseDocumentRef(ref)?.id === proposed.documentId
                ? existingSources
                : [ref],
            ),
          ),
        ],
      };
      // Validate model citations before expanding ephemeral intake references.
      const patched = !!output.documentEdits?.some(
        (edit) => edit.documentId === update.documentId,
      );
      this.validate(state, update, context, patched);
      const ephemeral = update.sources.filter(
        (ref) => !!state.library.intake[parseDocumentRef(ref)?.id || ""],
      );
      update.sources = this.durableSources(state, update.sources);
      for (const ref of ephemeral)
        update.content = update.content.replaceAll(
          ref,
          this.durableSources(state, [ref]).join(", ") || "Curated finding",
        );
      if (
        [...update.content.matchAll(/document:([^\s@]+)@\d+/g)].some(
          (m) => state.library.intake[m[1]!],
        )
      )
        throw new DomainError(
          "Knowledge cannot link to temporary intake. Preserve the useful external citation in the page instead.",
        );
      const old = this.validate(state, update, context, patched);
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
    const resolutions = output.intakeResolutions || [];
    if (
      output.outcome === "completed" &&
      !output.contextRequests?.length &&
      Object.keys(context.maintenance.intake || {}).some(
        (id) => !resolutions.some((r) => r.documentId === id),
      )
    )
      throw new DomainError(
        "Account for every supplied intake entry: incorporate, discard with a reason, or defer.",
      );
    const seen = new Set<string>();
    for (const resolution of resolutions) {
      const source = context.maintenance.sources.find(
        (d) =>
          d.id === resolution.documentId && d.version === resolution.version,
      );
      const current = this.h.repo.document(resolution.documentId);
      if (
        !source ||
        !context.maintenance.intake?.[source.id] ||
        !current ||
        current.version !== source.version ||
        state.library.intake[source.id]?.status !== "ready" ||
        seen.has(source.id)
      )
        throw new DomainError(
          "Intake changed or was not supplied to this curation pass. Retry with the current intake.",
        );
      seen.add(source.id);
      if (
        resolution.action === "incorporate" &&
        (!resolution.updateIndexes.length ||
          resolution.updateIndexes.some(
            (i) =>
              !output.libraryUpdates?.[i]?.sources.includes(
                documentRef(source),
              ),
          ))
      )
        throw new DomainError(
          "Incorporated intake must cite the Knowledge updates that preserve its findings.",
        );
      if (
        resolution.action !== "incorporate" &&
        resolution.updateIndexes.length
      )
        throw new DomainError(
          "Only incorporated intake can name Knowledge updates.",
        );
    }
    const before = new Set(
      state.threads.flatMap((t) => t.libraryProposals || []).map((p) => p.id),
    );
    const ids = this.applyUpdates(state, run, output);
    const proposals = state.threads
      .flatMap((t) => t.libraryProposals || [])
      .filter((p) => !before.has(p.id));
    if (
      output.outcome !== "completed" ||
      output.contextRequests?.length ||
      output.requests.length
    ) {
      for (const id of Object.keys(context.maintenance.intake || {})) {
        if (!state.library.intake[id]) continue;
        state.library.intake[id]!.status = "pending_decision";
        delete state.library.pending[id];
      }
    }
    // Do not consume evidence when the model explicitly lacks context or reports a blocked pass.
    if (!output.contextRequests?.length && output.outcome === "completed") {
      const resolved = resolutions.filter((r) => r.action !== "defer");
      if (resolved.length && !output.requests.length) {
        state.library.batches[run.id] = {
          sources: resolved.map((r) => {
            const changes = r.updateIndexes.map(
              (i) => output.libraryUpdates![i]!,
            );
            const relatedProposals = proposals.filter((p) =>
              changes.some(
                (u) => u.documentId === p.documentId && u.title === p.title,
              ),
            );
            return {
              id: r.documentId,
              version: r.version,
              action: r.action as "incorporate" | "discard",
              through:
                context.maintenance!.intakeSlices?.[r.documentId]?.through ??
                this.h.repo.document(r.documentId)!.content.length,
              documentIds: ids.filter((id) =>
                changes.some(
                  (u) =>
                    u.documentId === id ||
                    (!u.documentId &&
                      this.h.repo.document(id)?.title === u.title),
                ),
              ),
              proposalIds: relatedProposals.map((p) => p.id),
            };
          }),
          proposalIds: proposals.map((p) => p.id),
          documentIds: ids,
        };
        for (const r of resolved) {
          const intake = state.library.intake[r.documentId]!;
          intake.batchId = run.id;
          intake.status = "pending_decision";
          delete state.library.pending[r.documentId];
        }
        this.finishBatches(state);
      }
      for (const source of context.maintenance.sources.filter(
        (d) => !state.library.intake[d.id] && d.level !== "intake",
      )) {
        state.library.processed[source.id] = source.version;
        delete state.library.pending[source.id];
      }
      for (const r of resolutions.filter((r) => r.action === "defer")) {
        state.library.intake[r.documentId]!.status = "pending_decision";
        delete state.library.pending[r.documentId];
        this.h.inbox(
          state,
          {
            subject: "Intake needs a decision",
            reason: r.reason,
            recommendation:
              "Discuss the intake with Foreman, then mark it ready when resolved.",
            evidence: [`document:${r.documentId}@${r.version}`],
          },
          run.id,
        );
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
