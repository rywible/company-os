import { taskUsage, taskCapacity } from "../domain/automation";
import { evidenceReferences } from "../domain/evidence";
import {
  duplicateIdea,
  selectLens,
  type Idea,
  type Lens,
  type Experiment,
} from "../domain/discovery";
import {
  DomainError,
  type AgentResult,
  type Command,
  type CompanyState,
  type Context,
  type Run,
  type Thread,
  type Work,
} from "../domain/model";
import type { DomainEvent, EventInput } from "../domain/events";
import type { Repository } from "./ports";

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
  work(
    state: CompanyState,
    input: Experiment,
    cause: string,
    key: string,
  ): Work;
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
const active = (i: Idea) =>
  ["candidate", "investigating", "ready", "pursued", "evaluating"].includes(
    i.status,
  );
export class Discovery {
  constructor(private h: Host) {}
  configure(state: CompanyState, cmd: Command): boolean {
    const d = state.discovery;
    if (cmd.type === "SaveDiscoveryLens") {
      const lens = d.lenses.find((l) => l.id === cmd.lens.id);
      if (lens) Object.assign(lens, { ...cmd.lens, kind: lens.kind });
      else {
        if (cmd.lens.kind === "knowledge")
          throw new DomainError("The library already has a maintenance task.");
        if (d.lenses.length >= 30)
          throw new DomainError("At most 30 perspectives are supported.");
        d.lenses.push(cmd.lens);
      }
      this.h.emit(
        { type: "DiscoveryConfigured", payload: { lensId: cmd.lens.id } },
        "human",
        "discovery",
      );
    } else if (cmd.type === "DeleteDiscoveryLens") {
      const index = d.lenses.findIndex((l) => l.id === cmd.lensId);
      if (index < 0) throw new DomainError("Automation not found.");
      if (d.lenses[index]!.kind === "knowledge")
        throw new DomainError("The library automation cannot be deleted.");
      d.lenses.splice(index, 1);
      for (const run of state.runs.filter(
        (r) => r.discoveryLensId === cmd.lensId && r.status === "queued",
      )) {
        run.status = "completed";
        run.finishedAt = this.h.now();
        run.error = "Automation deleted before execution.";
      }
      this.h.emit(
        { type: "DiscoveryDeleted", payload: { lensId: cmd.lensId } },
        "human",
        "discovery",
      );
    } else return false;
    return true;
  }
  signal(
    state: CompanyState,
    title: string,
    detail: string,
    lensIds: string[],
    key: string,
    sourceEventId?: string,
  ) {
    const d = state.discovery;
    const existing = d.signals.find((s) => s.key === key && !s.consumedBy);
    const signal = existing || {
      id: this.h.id(),
      key,
      title,
      detail,
      lensIds,
      at: this.h.now(),
      count: 0,
      sourceEventId,
    };
    Object.assign(signal, {
      title,
      detail,
      lensIds,
      at: this.h.now(),
      sourceEventId,
      count: signal.count + 1,
    });
    if (!existing) d.signals.push(signal);
    // Retain the newest 200 signals; consumed signal snapshots remain on their runs.
    d.signals = d.signals.slice(-200);
    this.h.emit(
      { type: "DiscoverySignalRecorded", payload: { signalId: signal.id } },
      sourceEventId ? "system" : "human",
      "discovery",
      sourceEventId,
    );
    return signal;
  }
  scout(state: CompanyState, requested?: string): Lens | undefined {
    const d = state.discovery;
    const eligible = (lens: Lens) =>
      (!lens.kind || lens.kind === "research") &&
      taskUsage(state, lens, this.h.now()) < lens.dailyRunLimit &&
      taskCapacity(state, lens);
    if (requested) {
      const lens = d.lenses.find((l) => l.id === requested);
      if (!lens) throw new DomainError("Task not found.");
      return eligible(lens) ? lens : undefined;
    }
    return selectLens(
      { ...d, lenses: d.lenses.filter(eligible) },
      this.h.now(),
    );
  }
  attach(state: CompanyState, run: Run, lens: Lens) {
    run.discoveryLensId = lens.id;
    run.discoverySignalIds = state.discovery.signals
      .filter((s) => !s.consumedBy && s.lensIds.includes(lens.id))
      .slice(-12)
      .map((s) => s.id);
    for (const s of state.discovery.signals)
      if (run.discoverySignalIds.includes(s.id)) s.consumedBy = run.id;
    lens.lastRunAt = this.h.now();
    lens.lastRunId = run.id;
  }
  context(state: CompanyState, run: Run, context: Context) {
    const work = state.work.find((w) => w.id === run.workId);
    const idea = state.discovery.ideas.find((i) => i.id === work?.discoveryId);
    const lens = state.discovery.lenses.find(
      (l) => l.id === (run.discoveryLensId || idea?.lensId),
    );
    if (!lens || (lens.kind && lens.kind !== "research")) return;
    const signals = state.discovery.signals.filter((s) =>
      (run.discoverySignalIds || idea?.signalIds || []).includes(s.id),
    );
    context.discovery = {
      lens: { ...lens },
      signals,
      idea,
      phase: work?.discoveryPhase || "scout",
      previousIdeas: state.discovery.ideas
        .slice(-100)
        .map(({ id, title, hypothesis, status, decisionReason }) => ({
          id,
          title,
          hypothesis,
          status,
          decisionReason,
        })),
    };
    context.evidenceRefs.push(...signals.map((s) => `signal:${s.id}`));
    if (idea) {
      context.evidenceRefs.push(`discovery:${idea.id}`);
      // Results are attributed observations, not proof that a delivery was deployed.
      for (const id of [
        ...idea.investigationWorkIds,
        idea.deliveryWorkId,
      ].filter(Boolean)) {
        const prior = state.work.find((w) => w.id === id);
        if (prior) {
          context.evidenceRefs.push(`work:${prior.id}`);
          context.messages.push({
            id: prior.id,
            role: "system",
            at: prior.updatedAt,
            content: `Prior ${prior.discoveryPhase} result (${prior.status}): ${prior.result}`,
          });
        }
      }
    }
  }
  private linkedWork(
    state: CompanyState,
    idea: Idea,
    phase: Work["discoveryPhase"],
    spec: Experiment,
  ): Work {
    // Unique identity prevents an old completed task from satisfying a new investigation.
    const work = this.h.work(
      state,
      spec,
      idea.id,
      `discovery:${idea.id}:${phase}:${idea.investigationWorkIds.length + 1}`,
    );
    work.discoveryId = idea.id;
    work.discoveryPhase = phase;
    return work;
  }
  investigate(state: CompanyState, id: string): boolean {
    const idea = state.discovery.ideas.find((i) => i.id === id);
    if (!idea || !["candidate", "pursued"].includes(idea.status)) return true;
    const lens = state.discovery.lenses.find((l) => l.id === idea.lensId)!;
    if (
      !lens.enabled ||
      state.work.filter(
        (w) =>
          !["done", "cancelled"].includes(w.status) &&
          state.discovery.ideas.some(
            (i) => i.id === w.discoveryId && i.lensId === lens.id,
          ),
      ).length >= lens.maxOpenWork
    )
      return false;
    if (idea.status === "pursued") {
      const delivered = state.work.find((w) => w.id === idea.deliveryWorkId);
      if (delivered?.status !== "done" || idea.outcomeWorkId) return true;
      const work = this.linkedWork(state, idea, "outcome", {
        track: "research",
        mode:
          idea.experiment.mode === "ui-inspection"
            ? "ui-inspection"
            : delivered.mode === "ui-inspection"
              ? "ui-inspection"
              : "analysis",
        title: `Check outcome: ${idea.title}`,
        instruction: `Evaluate the original hypothesis against the delivered work and current evidence. Expected benefit: ${idea.impact}. Compare before and after where possible. If deployment, user feedback or measurements are missing, report inconclusive and name the missing evidence. Completion alone does not prove improvement.`,
        criteria:
          "Return discoveryOutcome with measured improvement, no benefit, harm, or an explicit inconclusive result. Cite supplied evidence.",
      });
      idea.outcomeWorkId = work.id;
      idea.status = "evaluating";
    } else {
      if (
        idea.investigationWorkIds.length >=
        state.discovery.lenses.find((l) => l.id === idea.lensId)!
          .maxInvestigations
      ) {
        idea.status = "parked";
        return true;
      }
      const work = this.linkedWork(state, idea, "investigation", {
        ...idea.experiment,
        track: "research",
      });
      idea.investigationWorkIds.push(work.id);
      idea.status = "investigating";
    }
    idea.updatedAt = this.h.now();
    return true;
  }
  decide(
    state: CompanyState,
    id: string,
    action: "pursue" | "park" | "discard" | "revisit",
    reason: string,
  ) {
    const idea = state.discovery.ideas.find((i) => i.id === id);
    if (!idea) throw new DomainError("Idea not found.");
    if (action === "pursue") {
      if (idea.status !== "ready" || !idea.assessment?.proposedWork)
        throw new DomainError(
          "An investigated recommendation is required before pursuing it.",
        );
      if (
        state.work.filter(
          (w) =>
            !["done", "cancelled"].includes(w.status) &&
            state.discovery.ideas.some(
              (i) => i.id === w.discoveryId && i.lensId === idea.lensId,
            ),
        ).length >=
        state.discovery.lenses.find((l) => l.id === idea.lensId)!.maxOpenWork
      )
        throw new DomainError(
          "Finish or cancel open work before pursuing another idea.",
        );
      const work = this.linkedWork(
        state,
        idea,
        "delivery",
        idea.assessment.proposedWork,
      );
      idea.deliveryWorkId = work.id;
      idea.status = "pursued";
    } else if (action === "revisit") {
      if (!["parked", "discarded", "learned"].includes(idea.status))
        throw new DomainError("Only settled ideas can be revisited.");
      if (!reason.trim())
        throw new DomainError(
          "Describe what changed before revisiting this idea.",
        );
      if (
        !taskCapacity(
          state,
          state.discovery.lenses.find((l) => l.id === idea.lensId)!,
        )
      )
        throw new DomainError("Discovery is at capacity.");
      if (
        state.work.filter((w) => !["done", "cancelled"].includes(w.status))
          .length >= state.settings.maxOpenWork
      )
        throw new DomainError(
          "Finish or cancel open work before revisiting an idea.",
        );
      // Keep all history; explicit human reconsideration authorizes one additional investigation.
      const work = this.linkedWork(state, idea, "investigation", {
        ...idea.experiment,
        track: "research",
        instruction: `${idea.experiment.instruction}\nNew evidence or changed circumstances supplied by Ryan: ${reason}`,
      });
      idea.investigationWorkIds.push(work.id);
      idea.status = "investigating";
      idea.assessment = undefined;
      idea.outcome = undefined;
      idea.deliveryWorkId = undefined;
      idea.outcomeWorkId = undefined;
    } else {
      if (["pursued", "evaluating", "learned"].includes(idea.status))
        throw new DomainError(
          "Manage committed work from Work; this idea has already been pursued.",
        );
      idea.status = action === "park" ? "parked" : "discarded";
      for (const w of state.work.filter(
        (w) =>
          w.discoveryId === id &&
          w.discoveryPhase === "investigation" &&
          !["done", "cancelled"].includes(w.status),
      )) {
        w.status = "cancelled";
        w.updatedAt = this.h.now();
        this.h.emit(
          {
            type: "WorkStatusChanged",
            payload: { workId: w.id, status: "cancelled" },
          },
          "human",
          w.id,
          idea.id,
        );
      }
    }
    idea.decisionReason = reason;
    idea.updatedAt = this.h.now();
    const thread = state.threads.find((t) => t.id === idea.threadId);
    if (thread) {
      thread.status = "resolved";
      thread.unread = false;
      thread.updatedAt = this.h.now();
    }
    this.h.emit(
      { type: "DiscoveryDecided", payload: { ideaId: id, action, reason } },
      "human",
      id,
    );
    this.learn(
      state,
      idea,
      `Human decision: ${action}. ${reason}`,
      idea.evidence,
    );
  }
  private learn(
    state: CompanyState,
    idea: Idea,
    finding: string,
    evidence: string[],
  ) {
    const previous = idea.knowledgeId
      ? this.h.repo.document(idea.knowledgeId)
      : undefined;
    const d = this.h.repo.saveDocument(
      {
        id: previous?.id,
        expectedVersion: previous?.version,
        title: `Discovery: ${idea.title}`,
        level: "intake",
        content: `Hypothesis: ${idea.hypothesis}\n\nExpected benefit: ${idea.impact}\n\nStatus: ${idea.status}\n\nInvestigation: ${idea.assessment?.finding || "Not yet assessed"}\n\nLatest finding: ${finding}\n\nUncertainty: ${idea.uncertainty}\n\nHuman decision: ${idea.decisionReason || "None"}\n\nSources: ${evidence.join(", ")}\n\nDiscovery: ${idea.id}`,
      },
      "foreman",
    );
    idea.knowledgeId = d.id;
    state.library.intake[d.id] = { status: "ready", sources: evidence };
    state.library.pending[d.id] = d.version;
    state.policies[d.id] = {
      inclusion: "relevant",
      status: "active",
    };
    this.h.emit(
      {
        type: "IntakeReady",
        payload: { documentId: d.id, version: d.version },
      },
      "foreman",
      d.id,
      idea.id,
    );
  }
  complete(state: CompanyState, run: Run, output: AgentResult) {
    const context = run.context!;
    const phase = context.discovery?.phase;
    if (!phase) {
      if (
        output.discoveries?.length ||
        output.discoveryAssessment ||
        output.discoveryOutcome
      )
        throw new DomainError("Discovery output requires a discovery run.");
      return;
    }
    for (const refs of [
      ...(output.discoveries || []).map((i) => i.evidence),
      ...(output.discoveryAssessment
        ? [output.discoveryAssessment.evidence]
        : []),
      ...(output.discoveryOutcome ? [output.discoveryOutcome.evidence] : []),
    ]) {
      if (refs.some((ref) => !evidenceReferences(context).includes(ref)))
        throw new DomainError("Discovery cited evidence it did not receive.");
    }
    if (phase === "scout") {
      if (output.discoveryAssessment || output.discoveryOutcome)
        throw new DomainError("A scout cannot assess unperformed work.");
      for (const candidate of output.discoveries || []) {
        if (
          !taskCapacity(
            state,
            state.discovery.lenses.find((l) => l.id === run.discoveryLensId)!,
          )
        )
          break;
        if (duplicateIdea(state.discovery.ideas, candidate)) continue;
        const idea: Idea = {
          ...candidate,
          id: this.h.id(),
          lensId: run.discoveryLensId!,
          runId: run.id,
          signalIds: run.discoverySignalIds || [],
          status: "candidate",
          investigationWorkIds: [],
          decisionReason: "",
          createdAt: this.h.now(),
          updatedAt: this.h.now(),
        };
        state.discovery.ideas.push(idea);
        this.h.emit(
          { type: "DiscoveryIdentified", payload: { ideaId: idea.id } },
          "foreman",
          idea.id,
          run.id,
        );
      }
      return;
    }
    const work = state.work.find((w) => w.id === run.workId)!;
    const idea = state.discovery.ideas.find((i) => i.id === work.discoveryId)!;
    if (["parked", "discarded"].includes(idea.status)) return;
    if (phase === "investigation") {
      if (output.outcome !== "completed") return; // Existing input/failure handling retains the investigation.
      const assessment = output.discoveryAssessment;
      if (!assessment)
        throw new DomainError(
          "An investigation must return a discovery assessment.",
        );
      idea.assessment = assessment;
      this.h.emit(
        {
          type: "DiscoveryAssessed",
          payload: { ideaId: idea.id, verdict: assessment.verdict },
        },
        "foreman",
        idea.id,
        run.id,
      );
      if (assessment.verdict === "recommend") {
        if (!assessment.proposedWork)
          throw new DomainError(
            "A recommendation needs a concrete work proposal.",
          );
        idea.status = "ready";
        const thread = this.h.inbox(
          state,
          {
            subject: idea.title,
            reason: `${assessment.finding}\n\nExpected benefit: ${idea.impact}\n\nUncertainty: ${idea.uncertainty}`,
            recommendation: `${assessment.proposedWork.instruction}\n\nSuccess: ${assessment.proposedWork.criteria}`,
            evidence: assessment.evidence,
          },
          run.id,
        );
        thread.discoveryId = idea.id;
        idea.threadId = thread.id;
      } else if (assessment.verdict === "discard") idea.status = "discarded";
      else if (
        assessment.nextExperiment &&
        idea.investigationWorkIds.length <
          state.discovery.lenses.find((l) => l.id === idea.lensId)!
            .maxInvestigations
      ) {
        idea.experiment = assessment.nextExperiment;
        idea.status = "candidate";
        this.h.emit(
          { type: "DiscoveryIdentified", payload: { ideaId: idea.id } },
          "foreman",
          idea.id,
          run.id,
        );
      } else idea.status = "parked";
      this.learn(state, idea, assessment.finding, assessment.evidence);
    } else if (phase === "outcome" && output.outcome === "completed") {
      if (!output.discoveryOutcome)
        throw new DomainError("An outcome check must return its finding.");
      idea.outcome = output.discoveryOutcome;
      idea.status = "learned";
      this.learn(
        state,
        idea,
        output.discoveryOutcome.finding,
        output.discoveryOutcome.evidence,
      );
      this.h.emit(
        {
          type: "DiscoveryLearned",
          payload: {
            ideaId: idea.id,
            verdict: output.discoveryOutcome.verdict,
          },
        },
        "foreman",
        idea.id,
        run.id,
      );
      if (["harmful", "no_benefit"].includes(output.discoveryOutcome.verdict)) {
        const thread = this.h.inbox(
          state,
          {
            subject: `Reconsider: ${idea.title}`,
            reason: output.discoveryOutcome.finding,
            recommendation:
              "Review the evidence and decide whether to revise or reverse this work.",
            evidence: output.discoveryOutcome.evidence,
          },
          run.id,
        );
        thread.discoveryId = idea.id;
        idea.threadId = thread.id;
      }
    }
    idea.updatedAt = this.h.now();
  }
  observe(state: CompanyState, event: DomainEvent) {
    const d = state.discovery;
    if (d.observedEvents.includes(event.id)) return;
    d.observedEvents = [...d.observedEvents, event.id].slice(-2000);
    if (event.type === "WorkStatusChanged") {
      const work = state.work.find((w) => w.id === event.payload.workId);
      if (!work) return;
      if (work.discoveryId) {
        const idea = d.ideas.find((i) => i.id === work.discoveryId);
        if (
          idea &&
          active(idea) &&
          work.status === "cancelled" &&
          [
            idea.investigationWorkIds.at(-1),
            idea.deliveryWorkId,
            idea.outcomeWorkId,
          ].includes(work.id)
        ) {
          idea.status = "parked";
          idea.updatedAt = this.h.now();
          idea.decisionReason = `The ${work.discoveryPhase} work was cancelled.`;
          this.learn(state, idea, idea.decisionReason, idea.evidence);
          this.h.emit(
            {
              type: "DiscoveryDecided",
              payload: {
                ideaId: idea.id,
                action: "park",
                reason: idea.decisionReason,
              },
            },
            event.actor,
            idea.id,
            event.id,
          );
        }
        if (work.discoveryPhase === "delivery" && work.status === "done")
          this.h.emit(
            {
              type: "DiscoveryEvaluationRequested",
              payload: { ideaId: work.discoveryId },
            },
            "system",
            work.discoveryId,
            event.id,
          );
        return;
      }
      if (work.status === "done")
        this.signal(
          state,
          `Finished: ${work.title}`,
          work.result || "Marked complete by Ryan; verify the outcome.",
          ["learning", "users", "product"],
          `work:${work.id}`,
          event.id,
        );
    } else if (event.type === "ReviewCompleted" && !event.payload.approved) {
      const round = state.reviewRounds.find(
        (r) => r.id === event.payload.roundId,
      );
      this.signal(
        state,
        "Review requested changes",
        round?.reviews.map((r) => r.summary).join("\n") || event.payload.workId,
        ["engineering", "learning"],
        `review:${event.payload.workId}`,
        event.id,
      );
    } else if (event.type === "KnowledgeChanged" && event.actor === "human") {
      const doc = this.h.repo.document(
        event.payload.documentId,
        event.payload.version,
      );
      if (doc)
        this.signal(
          state,
          `Updated: ${doc.title}`,
          doc.content.slice(0, 6000),
          ["direction", "product"],
          `document:${doc.id}`,
          event.id,
        );
    }
  }
}
