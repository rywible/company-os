import {
  IntegrationChanged,
  VerificationFailed,
  engineeringChecks,
} from "../domain/delivery";
import { DeliveryWorkflow } from "./delivery";
import {
  automationPermissions,
  assertAutomationOutput,
} from "../domain/permissions";
import { Planning } from "./planning";
import { Library } from "./library";
import { documentRef } from "../domain/library";
import {
  taskForRun,
  taskUsage,
  taskBlocker,
  taskDueAt,
  runCanProceed,
} from "../domain/automation";
import { evidenceReferences } from "../domain/evidence";
import { Discovery } from "./discovery";
import {
  commandSchema,
  defaultPolicy,
  DomainError,
  requireTransition,
  workKey,
  type AgentResult,
  type Command,
  type CompanyState,
  type Context,
  type Run,
  type Thread,
  type Work,
} from "../domain/model";
import type { EventInput, DomainEvent, Delivery } from "../domain/events";
import type {
  AgentPort,
  BrowserPort,
  Clock,
  EmbeddingPort,
  Ids,
  Repository,
  PullRequestPort,
  ResearchSourcesPort,
} from "./ports";
import { assembleContext } from "./context";
import { reviewOutcome } from "../domain/reviews";
import { chunkDocument } from "../domain/knowledge";
import { defaultAgentConfiguration } from "../domain/agents";
export class Company {
  private discovery: Discovery;
  private library: Library;
  private planning: Planning;
  private deliveryWorkflow: DeliveryWorkflow;
  constructor(
    readonly repo: Repository,
    readonly agent: AgentPort,
    readonly embeddings: EmbeddingPort,
    readonly browser: BrowserPort,
    readonly clock: Clock = { now: () => new Date() },
    readonly ids: Ids = { next: () => crypto.randomUUID() },
    readonly pullRequests?: PullRequestPort,
    readonly researchSources?: ResearchSourcesPort,
  ) {
    this.deliveryWorkflow = new DeliveryWorkflow({
      repo: this.repo,
      github: this.pullRequests,
      id: () => this.ids.next(),
      now: () => this.now(),
      emit: (...args) => this.emit(...args),
      run: (state, input) => this.run(state, input),
    });
    this.planning = new Planning({
      repo: this.repo,
      now: () => this.now(),
      id: () => this.ids.next(),
      emit: (...args) => this.emit(...args),
      run: (state, input) => this.run(state, input),
      inbox: (state, input, cause) => this.inbox(state, input, cause),
    });
    this.library = new Library({
      repo: this.repo,
      now: () => this.now(),
      id: () => this.ids.next(),
      emit: (...args) => this.emit(...args),
      inbox: (state, input, cause) => this.inbox(state, input, cause),
    });
    this.discovery = new Discovery({
      repo: this.repo,
      now: () => this.now(),
      id: () => this.ids.next(),
      emit: (...args) => this.emit(...args),
      work: (state, input, cause, key) =>
        this.createWork(state, input, "foreman", cause, key),
      inbox: (state, input, cause) => this.inbox(state, input, cause),
    });
  }
  now() {
    return this.clock.now().toISOString();
  }
  private emit(
    input: EventInput,
    actor: DomainEvent["actor"],
    correlationId: string,
    causationId: string | null = null,
  ) {
    this.repo.publish(input, {
      actor,
      correlationId,
      causationId,
      at: this.now(),
    });
  }
  private thread(state: CompanyState, id: string) {
    const t = state.threads.find((t) => t.id === id);
    if (!t) throw new DomainError("Thread not found.");
    return t;
  }
  private run(
    state: CompanyState,
    input: Pick<Run, "trigger" | "threadId" | "workId"> & {
      automatic?: boolean;
    },
  ) {
    if (
      input.threadId &&
      state.runs.some(
        (r) =>
          r.threadId === input.threadId &&
          ["queued", "running"].includes(r.status),
      )
    )
      throw new DomainError("This thread already has a pending response.");
    const assignedWork = state.work.find((w) => w.id === input.workId);
    const milestone = state.planning.milestones.find(
      (m) => m.id === assignedWork?.milestoneId,
    );
    if (
      milestone &&
      state.runs.filter((r) => r.workId && milestone.workIds.includes(r.workId))
        .length >= milestone.maxRuns
    )
      throw new DomainError(
        "This milestone has reached its approved run allowance.",
      );
    const role = state.settings.roles.find(
      (r) =>
        r.enabled &&
        r.id ===
          (input.trigger === "adjudication"
            ? "adjudicator"
            : input.trigger === "acceptance"
              ? "acceptance"
              : ["assessment", "review"].includes(input.trigger)
                ? "reviewer"
                : assignedWork?.roleId),
    );
    if (
      (assignedWork?.roleId ||
        ["review", "adjudication", "acceptance"].includes(input.trigger)) &&
      !role
    )
      throw new DomainError("The assigned role is paused or unavailable.");
    const automation = taskForRun(state, input);
    const run: Run = {
      id: this.ids.next(),
      automatic: input.trigger !== "message",
      ...input,
      ...(automation
        ? {
            discoveryLensId: automation.id,
            automationPermissions: automationPermissions(automation),
          }
        : {}),
      agent: structuredClone(
        role?.agent ||
          taskForRun(state, input)?.agent ||
          state.settings.foremanAgent ||
          defaultAgentConfiguration(),
      ),
      role: role
        ? { id: role.id, name: role.name, purpose: role.purpose }
        : undefined,
      status: "queued",
      context: null,
      error: null,
      createdAt: this.now(),
      budgetDay: this.now().slice(0, 10),
    };
    state.runs.push(run);
    return run;
  }
  private inbox(
    state: CompanyState,
    input: {
      subject: string;
      reason: string;
      recommendation: string;
      evidence: string[];
      workId?: string;
    },
    runId: string,
  ) {
    let thread = state.threads.find(
      (t) =>
        t.kind === "inbox" &&
        t.status !== "resolved" &&
        ((input.workId && t.workId === input.workId) ||
          (!input.workId && workKey(t.subject) === workKey(input.subject))),
    );
    if (!thread) {
      thread = {
        id: this.ids.next(),
        kind: "inbox",
        status: "open",
        unread: true,
        messages: [],
        proposals: [],
        createdAt: this.now(),
        updatedAt: this.now(),
        ...input,
      };
      state.threads.push(thread);
    } else
      Object.assign(thread, input, {
        status: "open",
        unread: true,
        updatedAt: this.now(),
      });
    this.emit(
      {
        type: "InputRequested",
        payload: { threadId: thread.id, workId: input.workId },
      },
      "foreman",
      thread.id,
      runId,
    );
    return thread;
  }
  execute(raw: Command) {
    const cmd = commandSchema.parse(raw);
    if (cmd.type === "LinkPullRequest")
      return this.linkPullRequest(cmd.workId, cmd.repository, cmd.number);
    return this.repo.transaction(() => {
      const state = this.repo.state();
      let result: unknown = { ok: true };
      if (
        this.planning.configure(state, cmd) ||
        this.discovery.configure(state, cmd)
      ) {
        this.repo.save(state);
        return result;
      }
      switch (cmd.type) {
        case "RequestPlanning":
          result = this.planning.request(state, true);
          break;
        case "ProposeMilestone":
          result = this.planning.propose(
            state,
            cmd.plan,
            this.ids.next(),
            "human",
          );
          break;
        case "ReviseMilestone":
          this.planning.revise(
            state,
            cmd.milestoneId,
            cmd.expectedVersion,
            cmd.plan,
          );
          break;
        case "DecideMilestone":
          this.planning.decide(state, cmd);
          break;
        case "ExploreDiscovery":
          result = this.heartbeatIn(state, true, cmd.lensId);
          break;
        case "RecordDiscoverySignal":
          if (!state.discovery.lenses.some((l) => l.id === cmd.lensId))
            throw new DomainError("Perspective not found.");
          result = this.discovery.signal(
            state,
            "Feedback from Ryan",
            cmd.content,
            [cmd.lensId],
            this.ids.next(),
          );
          break;
        case "DecideDiscovery":
          this.discovery.decide(state, cmd.ideaId, cmd.action, cmd.reason);
          break;
        case "StartConversation": {
          if (
            cmd.attachment &&
            !this.repo.document(cmd.attachment.id, cmd.attachment.version)
          )
            throw new DomainError("Attached revision does not exist.");
          const thread: Thread = {
            id: this.ids.next(),
            kind: "conversation",
            subject: cmd.subject,
            status: "open",
            unread: false,
            reason: "",
            recommendation: "",
            evidence: [],
            messages: [
              {
                id: this.ids.next(),
                role: "human",
                content: cmd.content,
                at: this.now(),
              },
            ],
            proposals: [],
            createdAt: this.now(),
            updatedAt: this.now(),
            attachment: cmd.attachment,
          };
          state.threads.push(thread);
          const run = this.run(state, {
            trigger: "message",
            threadId: thread.id,
          });
          this.emit(
            {
              type: "ConversationStarted",
              payload: { threadId: thread.id, runId: run.id },
            },
            "human",
            thread.id,
          );
          result = { threadId: thread.id, runId: run.id };
          break;
        }
        case "Reply": {
          const thread = this.thread(state, cmd.threadId);
          const run = this.run(state, {
            trigger: "message",
            threadId: thread.id,
            workId: thread.workId,
          });
          thread.messages.push({
            id: this.ids.next(),
            role: "human",
            content: cmd.content,
            at: this.now(),
          });
          thread.status = "waiting";
          thread.unread = false;
          thread.updatedAt = this.now();
          this.emit(
            {
              type: "ReplyReceived",
              payload: {
                threadId: thread.id,
                runId: run.id,
                workId: thread.workId,
              },
            },
            "human",
            thread.id,
          );
          result = { threadId: thread.id, runId: run.id };
          break;
        }
        case "RetryDelivery":
          this.repo.retryDelivery(cmd.deliveryId);
          break;
        case "ReadThread":
          this.thread(state, cmd.threadId).unread = false;
          break;
        case "ThreadStatus": {
          const t = this.thread(state, cmd.threadId);
          t.status = cmd.status;
          t.updatedAt = this.now();
          t.unread = cmd.status === "open";
          this.emit(
            {
              type: "ThreadStatusChanged",
              payload: { threadId: t.id, status: t.status },
            },
            "human",
            t.id,
          );
          break;
        }
        case "CreateWork": {
          const work = this.createWork(state, cmd, "human");
          result = { workId: work.id };
          break;
        }
        case "WorkStatus": {
          const work = state.work.find((w) => w.id === cmd.workId);
          if (!work) throw new DomainError("Work not found.");
          requireTransition(work.status, cmd.status);
          if (work.milestoneId && cmd.status === "done")
            throw new DomainError(
              "Milestone assignments must pass independent review before completion.",
            );
          if (
            cmd.status === "done" &&
            work.pullRequest &&
            !state.reviewRounds.some(
              (r) =>
                r.workId === work.id &&
                r.pullRequest.head === work.pullRequest!.head &&
                r.status === "approved",
            )
          )
            throw new DomainError(
              "The current PR commit has not passed the required reviews.",
            );
          if (cmd.status === "queued" && work.attempts >= 3)
            throw new DomainError(
              "Three attempts reached. Create a new work item with revised scope.",
            );
          work.status = cmd.status;
          work.updatedAt = this.now();
          this.emit(
            cmd.status === "queued"
              ? { type: "WorkQueued", payload: { workId: work.id } }
              : {
                  type: "WorkStatusChanged",
                  payload: { workId: work.id, status: work.status },
                },
            "human",
            work.id,
          );
          break;
        }
        case "SaveKnowledge": {
          const existing = cmd.id ? this.repo.document(cmd.id) : undefined;
          if (existing && cmd.expectedVersion !== existing.version)
            throw new DomainError("This record changed. Reload before saving.");
          if (
            cmd.level === "constitution" &&
            (cmd.policy.inclusion !== "always" ||
              cmd.policy.status !== "active")
          )
            throw new DomainError(
              "The constitution must remain active and always included company-wide.",
            );
          const d = this.repo.saveDocument(cmd);
          state.policies[d.id] = cmd.policy;
          if (
            d.level === "knowledge" &&
            (!existing || state.library.pages[d.id] || cmd.library)
          ) {
            const old = state.library.pages[d.id];
            const location = cmd.library ||
              old || { collection: "Unfiled", parentId: null, relatedIds: [] };
            this.library.location(state, d.id, location);
            state.library.pages[d.id] = {
              ...old,
              ...location,
              sources: old?.sources || [],
              managed: false,
              updatedAt: this.now(),
            };
            delete state.library.pending[d.id];
          }
          this.emit(
            {
              type: "KnowledgeChanged",
              payload: { documentId: d.id, version: d.version },
            },
            "human",
            d.id,
          );
          result = d;
          break;
        }
        case "ResolveProposal": {
          const thread = this.thread(state, cmd.threadId),
            p = thread.proposals.find((p) => p.id === cmd.proposalId);
          if (!p || p.status !== "pending")
            throw new DomainError("Proposal is already resolved or missing.");
          if (cmd.action === "accept") {
            const d = this.repo.document(p.documentId);
            if (!d || d.level === "constitution")
              throw new DomainError("Protected or missing document.");
            if (d.version !== p.version)
              throw new DomainError(
                "This document changed. Ask for an updated proposal.",
              );
            const changed = this.repo.saveDocument(
              { ...d, content: p.content, expectedVersion: p.version },
              "accepted-proposal",
            );
            this.emit(
              {
                type: "KnowledgeChanged",
                payload: { documentId: d.id, version: changed.version },
              },
              "human",
              d.id,
            );
          }
          p.status = cmd.action === "accept" ? "accepted" : "dismissed";
          thread.updatedAt = this.now();
          this.emit(
            {
              type: "ProposalResolved",
              payload: {
                threadId: thread.id,
                proposalId: p.id,
                action: cmd.action,
              },
            },
            "human",
            thread.id,
          );
          break;
        }
        case "ResumeCorrections": {
          const work = state.work.find((w) => w.id === cmd.workId),
            round = state.reviewRounds.findLast(
              (r) =>
                r.workId === cmd.workId && r.status === "changes_requested",
            );
          if (
            !work ||
            work.status !== "blocked" ||
            !round ||
            work.reviewProgress?.stopped
          )
            throw new DomainError("No blocked review corrections to resume.");
          if (
            state.runs.some(
              (r) =>
                r.workId === work.id &&
                ["queued", "running"].includes(r.status),
            )
          )
            throw new DomainError("Work already has an active run.");
          const previous = state.runs.findLast(
            (r) => r.workId === work.id && r.trigger === "revision",
          );
          if (
            work.reviewProgress?.finalCorrectionRunId ||
            previous?.result?.outcome !== "needs_input"
          )
            throw new DomainError(
              "Correction limits cannot be reset. Discuss changed scope with Foreman.",
            );
          const run = this.run(state, {
            trigger: "revision",
            workId: work.id,
            automatic: false,
          });
          run.reviewRoundId = round.id;
          work.status = "queued";
          this.emit(
            {
              type: "WorkerSignalled",
              payload: { runId: run.id, workId: work.id, roundId: round.id },
            },
            "human",
            work.id,
          );
          break;
        }
        case "ConfigureDelivery": {
          state.settings.delivery = cmd.policy;
          if (cmd.requiredReviews !== undefined)
            state.settings.requiredReviews = cmd.requiredReviews;
          if (cmd.allowCodeChanges !== undefined)
            state.settings.allowCodeChanges = cmd.allowCodeChanges;
          this.emit(
            { type: "DeliveryConfigured", payload: {} },
            "human",
            "delivery",
          );
          break;
        }
        case "ConfigureReviews": {
          state.settings.requiredReviews = cmd.requiredReviews;
          state.settings.allowCodeChanges = cmd.allowCodeChanges;
          this.emit(
            {
              type: "ReviewPolicyConfigured",
              payload: {
                requiredReviews: cmd.requiredReviews,
                allowCodeChanges: cmd.allowCodeChanges,
              },
            },
            "human",
            "reviews",
          );
          break;
        }
        case "SetEvidenceStatus": {
          const d = this.repo.document(cmd.documentId);
          if (!d || d.level !== "knowledge" || state.library.pages[d.id])
            throw new DomainError("Choose a source evidence record.");
          if (d.version !== cmd.expectedVersion)
            throw new DomainError("This record changed. Reload before saving.");
          state.policies[d.id] = {
            ...(state.policies[d.id] || defaultPolicy(d)),
            status: cmd.status,
          };
          this.emit(
            {
              type: "KnowledgeChanged",
              payload: { documentId: d.id, version: d.version },
            },
            "human",
            d.id,
          );
          break;
        }
        case "DeleteEvidence": {
          const d = this.repo.document(cmd.documentId);
          if (!d || d.level !== "knowledge" || state.library.pages[d.id])
            throw new DomainError("Choose a source evidence record.");
          this.repo.archiveDocument(d.id, cmd.expectedVersion);
          delete state.library.pending[d.id];
          delete state.library.processed[d.id];
          delete state.policies[d.id];
          break;
        }
        case "WithdrawEvidenceReference": {
          if (
            !Object.values(state.library.pages).some((p) =>
              p.sources.includes(cmd.reference),
            )
          )
            throw new DomainError("Source reference not found.");
          state.library.withdrawnSources ||= {};
          if (cmd.withdrawn)
            state.library.withdrawnSources[cmd.reference] = {
              reason: cmd.reason,
              at: this.now(),
            };
          else delete state.library.withdrawnSources[cmd.reference];
          this.emit(
            {
              type: "EvidenceReferenceChanged",
              payload: { reference: cmd.reference, withdrawn: cmd.withdrawn },
            },
            "human",
            cmd.reference,
          );
          break;
        }
        case "ScheduleKnowledgeReview":
        case "ReviewKnowledge": {
          const d = this.repo.document(cmd.documentId),
            page = state.library.pages[cmd.documentId];
          if (!d || !page) throw new DomainError("Subject not found.");
          if (d.version !== cmd.expectedVersion)
            throw new DomainError(
              "This subject changed. Reload before reviewing.",
            );
          if (cmd.type === "ScheduleKnowledgeReview") {
            page.reviewAfter = cmd.reviewAfter;
            this.emit(
              {
                type: "KnowledgeReviewScheduled",
                payload: { documentId: d.id },
              },
              "human",
              d.id,
            );
          } else {
            this.library.apply(
              state,
              {
                ...page,
                documentId: d.id,
                expectedVersion: d.version,
                title: d.title,
                content: d.content,
                sources: cmd.action === "withdraw" ? page.sources : cmd.sources,
                disposition:
                  cmd.action === "withdraw" ? "withdrawn" : "current",
                reviewAfter: cmd.reviewAfter,
                needsApproval: false,
                reason: "Reviewed by the owner.",
              },
              true,
            );
          }
          break;
        }
        case "OrganizeKnowledge": {
          if (!state.library.pages[cmd.documentId])
            throw new DomainError("Subject not found.");
          this.library.location(state, cmd.documentId, cmd.location);
          Object.assign(state.library.pages[cmd.documentId]!, cmd.location, {
            updatedAt: this.now(),
          });
          this.emit(
            {
              type: "LibraryOrganized",
              payload: { documentId: cmd.documentId },
            },
            "human",
            cmd.documentId,
          );
          break;
        }
        case "ResolveLibraryProposal": {
          const thread = this.thread(state, cmd.threadId);
          const proposal = thread.libraryProposals?.find(
            (p) => p.id === cmd.proposalId,
          );
          if (!proposal || proposal.status !== "pending")
            throw new DomainError("Proposal is already resolved or missing.");
          if (cmd.action === "accept")
            this.library.apply(state, proposal, true);
          proposal.status = cmd.action === "accept" ? "accepted" : "dismissed";
          thread.updatedAt = this.now();
          if (
            !thread.libraryProposals!.some((p) => p.status === "pending") &&
            !thread.proposals.some((p) => p.status === "pending")
          )
            thread.status = "resolved";
          this.emit(
            {
              type: "LibraryProposalResolved",
              payload: {
                threadId: thread.id,
                proposalId: proposal.id,
                action: cmd.action,
              },
            },
            "human",
            thread.id,
          );
          break;
        }
        case "ConfigureForeman": {
          state.settings.foremanAgent = cmd.agent;
          this.emit(
            {
              type: "ForemanConfigured",
              payload: {
                provider: cmd.agent.provider,
                model: cmd.agent.model,
                reasoningEffort: cmd.agent.reasoningEffort,
              },
            },
            "human",
            "foreman",
          );
          break;
        }
        case "ConfigureAutonomy": {
          state.settings = {
            ...state.settings,
            ...cmd,
            nextHeartbeatAt: new Date(
              this.clock.now().getTime() + cmd.intervalMinutes * 60000,
            ).toISOString(),
          };
          this.emit(
            { type: "AutonomyConfigured", payload: { enabled: cmd.enabled } },
            "human",
            "autonomy",
          );
          break;
        }
        case "Heartbeat": {
          result = this.heartbeatIn(state, true);
          break;
        }
        case "RetryRun": {
          const run = state.runs.find((r) => r.id === cmd.runId);
          if (!run || run.status !== "failed")
            throw new DomainError("Only failed runs can be retried.");
          if (
            state.runs.some(
              (r) =>
                r.id !== run.id &&
                !!run.threadId &&
                r.threadId === run.threadId &&
                ["queued", "running"].includes(r.status),
            )
          )
            throw new DomainError("A response is already pending.");
          const retryWork = state.work.find((w) => w.id === run.workId);
          if (retryWork?.reviewProgress?.stopped)
            throw new DomainError(
              "This attempt is stopped; retry cannot reset its review allowance.",
            );
          if (retryWork?.milestoneId) {
            if (
              !this.planning.ready(state, retryWork) ||
              !this.planning.canQueue(state, retryWork)
            )
              throw new DomainError(
                "This milestone is paused, waiting on dependencies, or has reached its run allowance.",
              );
            const retry = this.run(state, {
              trigger: run.trigger,
              workId: run.workId,
              threadId: run.threadId,
            });
            retry.agent = structuredClone(run.agent);
            retry.automationPermissions = structuredClone(
              run.automationPermissions,
            );
            retry.role = structuredClone(run.role);
            retry.context = structuredClone(run.context);
            retry.executionId = run.executionId || run.id;
            retry.pendingOutput = run.pendingOutput;
            retry.reviewRoundId = run.reviewRoundId;
            retry.reviewId = run.reviewId;
            this.emit(
              { type: "RunRequested", payload: { runId: retry.id } },
              "human",
              retryWork.id,
            );
            result = { runId: retry.id };
            break;
          }
          run.status = "queued";
          run.error = null;
          this.emit(
            { type: "RunRequested", payload: { runId: run.id } },
            "human",
            run.threadId || run.id,
          );
          break;
        }
      }
      this.repo.save(state);
      return result;
    });
  }
  private createWork(
    state: CompanyState,
    input: {
      track: Work["track"];
      mode: Work["mode"];
      title: string;
      instruction: string;
      criteria: string;
    },
    origin: Work["origin"],
    cause: string | null = null,
    identity?: string,
  ) {
    const key = identity || workKey(input.title),
      duplicate = state.work.find(
        (w) => w.key === key && w.status !== "cancelled",
      );
    if (duplicate) return duplicate;
    const work: Work = {
      id: this.ids.next(),
      ...input,
      key,
      origin,
      status: "queued",
      result: "",
      attempts: 0,
      createdAt: this.now(),
      updatedAt: this.now(),
      evidence: [],
    };
    state.work.push(work);
    this.emit(
      { type: "WorkCreated", payload: { workId: work.id } },
      origin === "human" ? "human" : "foreman",
      work.id,
      cause,
    );
    return work;
  }
  private budgetAvailable(state: CompanyState) {
    return (
      state.runs.filter(
        (r) =>
          r.automatic && r.createdAt.slice(0, 10) === this.now().slice(0, 10),
      ).length < state.settings.dailyBudget
    );
  }
  private heartbeatIn(state: CompanyState, manual = false, lensId?: string) {
    const hasConstitution = this.repo
      .documents()
      .some((d) => d.level === "constitution" && d.content.trim());
    if (!hasConstitution)
      return {
        skipped:
          "Waiting for company direction before starting autonomous exploration.",
      };
    const requested = lensId
      ? state.discovery.lenses.find((l) => l.id === lensId)
      : undefined;
    if (lensId && !requested) throw new DomainError("Task not found.");
    if (requested) {
      const blocked = taskBlocker(
        state,
        requested,
        this.now(),
        hasConstitution,
        true,
        this.repo.documents(),
      );
      if (blocked) return { skipped: blocked };
    }
    for (const id of Object.keys(state.library.pending))
      if (
        !this.repo.document(id) ||
        (state.policies[id]?.status || "active") !== "active"
      )
        delete state.library.pending[id];
    const maintenance = state.discovery.lenses.find(
      (l) => l.kind === "knowledge",
    );
    if (
      maintenance &&
      (requested?.id === maintenance.id ||
        (!requested &&
          maintenance.enabled &&
          (!maintenance.lastRunAt ||
            Date.parse(taskDueAt(state, maintenance) || "") <=
              Date.parse(this.now())) &&
          !taskBlocker(
            state,
            maintenance,
            this.now(),
            hasConstitution,
            true,
            this.repo.documents(),
          )))
    ) {
      const run = this.run(state, { trigger: "maintenance", automatic: true });
      run.discoveryLensId = maintenance.id;
      run.agent = structuredClone(maintenance.agent);
      run.automationPermissions = automationPermissions(maintenance);
      run.manual = manual && !!lensId;
      maintenance.lastRunAt = this.now();
      maintenance.lastRunId = run.id;
      this.emit(
        { type: "LibraryMaintenanceRequested", payload: { runId: run.id } },
        manual ? "human" : "system",
        run.id,
      );
      return { runId: run.id };
    }
    const scheduled =
      requested && ["planning", "task"].includes(requested.kind || "")
        ? requested
        : !requested
          ? state.discovery.lenses
              .filter(
                (t) =>
                  ["planning", "task"].includes(t.kind || "") &&
                  t.enabled &&
                  (!taskDueAt(state, t) ||
                    taskDueAt(state, t)! <= this.now()) &&
                  !taskBlocker(
                    state,
                    t,
                    this.now(),
                    hasConstitution,
                    true,
                    this.repo.documents(),
                  ),
              )
              .sort((a, b) =>
                (a.lastRunAt || "").localeCompare(b.lastRunAt || ""),
              )[0]
          : undefined;
    if (scheduled?.kind === "planning")
      return this.planning.request(state, manual, scheduled.id);
    if (scheduled) {
      const run = this.run(state, { trigger: "automation", automatic: true });
      run.discoveryLensId = scheduled.id;
      run.agent = structuredClone(scheduled.agent);
      run.automationPermissions = automationPermissions(scheduled);
      run.manual = manual && !!lensId;
      scheduled.lastRunAt = this.now();
      scheduled.lastRunId = run.id;
      this.emit(
        { type: "RunRequested", payload: { runId: run.id } },
        manual ? "human" : "system",
        run.id,
      );
      return { runId: run.id };
    }
    const lens = this.discovery.scout(state, lensId);
    if (!lens) return { skipped: "No task is due with available capacity." };
    const run = this.run(state, { trigger: "heartbeat", automatic: true });
    run.manual = manual && !!lensId;
    this.discovery.attach(state, run, lens);
    run.agent = structuredClone(lens.agent);
    run.automationPermissions = automationPermissions(lens);
    this.emit(
      {
        type: "DiscoveryScoutRequested",
        payload: { runId: run.id, lensId: lens.id },
      },
      manual ? "human" : "system",
      run.id,
    );
    return { runId: run.id };
  }
  heartbeat() {
    this.repo.transaction(() => {
      const state = this.repo.state();
      this.heartbeatIn(state);
      this.repo.save(state);
    });
  }
  async preview(query: string, scope?: string, threadId?: string) {
    const state = this.repo.state();
    return assembleContext(
      this.repo,
      this.embeddings,
      state,
      query,
      scope || "company",
      this.now(),
      threadId ? ({ threadId } as Run) : undefined,
    );
  }
  async deliver(delivery: Delivery) {
    const effect = delivery.effect;
    if (
      effect.type === "ObserveDiscovery" ||
      effect.type === "InvestigateDiscovery"
    ) {
      return this.repo.transaction(() => {
        const state = this.repo.state();
        if (effect.type === "ObserveDiscovery")
          this.discovery.observe(state, delivery.event);
        else if (!this.discovery.investigate(state, effect.ideaId))
          throw new Deferred("Discovery paused or work capacity reached.");
        this.repo.save(state);
      });
    }
    if (effect.type === "IntegrateMilestone")
      return this.deliveryWorkflow.integrate(effect.milestoneId);
    if (effect.type === "ReconcileMilestones") {
      this.repo.transaction(() => {
        const state = this.repo.state();
        this.planning.reconcile(state);
        this.repo.save(state);
      });
      return;
    }
    if (effect.type === "StartReview")
      return this.startReview(effect.workId, delivery.event.id);
    if (effect.type === "SignalWorker")
      return this.signalWorker(effect.roundId, delivery.event.id);
    if (effect.type === "PublishReview")
      return this.publishReview(
        effect.roundId,
        effect.reviewId,
        delivery.event.id,
      );
    if (effect.type === "ScheduleWork") {
      await this.deliveryWorkflow.prepare(effect.workId);
      return this.repo.transaction(() => {
        const state = this.repo.state(),
          work = state.work.find((w) => w.id === effect.workId);
        if (
          !work ||
          work.status !== "queued" ||
          state.runs.some(
            (r) =>
              r.workId === work.id && ["queued", "running"].includes(r.status),
          )
        )
          return;
        if (
          !this.planning.ready(state, work) ||
          !this.planning.canQueue(state, work)
        )
          return;
        if (
          work.roleId &&
          !state.settings.roles.some((r) => r.id === work.roleId && r.enabled)
        )
          throw new Deferred("The assigned role is paused.");
        const task = taskForRun(state, { workId: work.id });
        if (
          task &&
          (!task.enabled ||
            taskUsage(state, task, this.now()) >= task.dailyRunLimit)
        )
          throw new Deferred("Task paused or daily run limit reached.");
        if (
          !task &&
          !work.milestoneId &&
          work.origin === "foreman" &&
          (!state.settings.enabled || !this.budgetAvailable(state))
        )
          throw new Deferred("Autonomy paused or daily budget reached.");
        const run = this.run(state, {
          trigger: "work",
          workId: work.id,
          automatic: work.origin === "foreman",
        });
        this.emit(
          { type: "RunRequested", payload: { runId: run.id } },
          "system",
          work.id,
          delivery.event.id,
        );
        this.repo.save(state);
      });
    }
    if (effect.type === "QueueLibrarySource") {
      this.repo.transaction(() => {
        const state = this.repo.state();
        this.library.queue(state, effect.documentId, effect.version);
        this.repo.save(state);
      });
      return;
    }
    if (effect.type === "IndexKnowledge") {
      const d = this.repo.document(effect.documentId);
      if (!d || d.version !== effect.version) return;
      const chunks: { text: string; vector: number[] }[] = [];
      for (const text of chunkDocument(d.title, d.content))
        chunks.push({
          text,
          vector: await this.embeddings.embed(text, "RETRIEVAL_DOCUMENT"),
        });
      this.repo.transaction(() => {
        if (this.repo.index(d.id, d.version, this.embeddings.model, chunks))
          this.emit(
            {
              type: "KnowledgeIndexed",
              payload: { documentId: d.id, version: d.version },
            },
            "system",
            d.id,
            delivery.event.id,
          );
      });
      return;
    }
    let state = this.repo.state(),
      run = state.runs.find((r) => r.id === effect.runId);
    if (!run || run.status === "completed") return;
    if (!runCanProceed(state, run)) throw new Deferred("Task paused.");
    const owner = taskForRun(state, run);
    if (
      owner &&
      run.automatic &&
      (run.budgetDay || run.createdAt.slice(0, 10)) !== this.now().slice(0, 10)
    ) {
      if (taskUsage(state, owner, this.now()) >= owner.dailyRunLimit)
        throw new Deferred("Task daily run limit reached.");
      run.budgetDay = this.now().slice(0, 10);
      this.repo.save(state);
    }
    const work = state.work.find((w) => w.id === run!.workId);
    if (work?.milestoneId && !this.planning.ready(state, work))
      throw new Deferred(
        "Waiting for milestone approval or accepted dependencies.",
      );
    if (
      work &&
      (["done", "cancelled"].includes(work.status) ||
        work.reviewProgress?.stopped)
    ) {
      this.repo.transaction(() => {
        const s = this.repo.state(),
          r = s.runs.find((r) => r.id === run!.id)!;
        r.status = "completed";
        r.finishedAt = this.now();
        this.repo.save(s);
      });
      return;
    }
    const thread = state.threads.find((t) => t.id === run!.threadId);
    const query =
      (run.trigger === "maintenance"
        ? Object.keys(state.library.pending)
            .slice(0, 3)
            .map((id) => {
              const d = this.repo.document(id);
              return d ? d.title + "\n" + d.content.slice(0, 1600) : "";
            })
            .join("\n")
        : undefined) ||
      thread?.messages.at(-1)?.content ||
      work?.instruction ||
      owner?.question ||
      (run.discoveryLensId
        ? state.discovery.lenses.find((l) => l.id === run!.discoveryLensId)
            ?.question
        : undefined) ||
      this.repo.documents().find((d) => d.level === "constitution")?.content ||
      "Help define the company constitution.";
    let context = run.context;
    if (!context) {
      context = await assembleContext(
        this.repo,
        this.embeddings,
        state,
        query,
        "company",
        this.now(),
        run,
      );
      if (run.trigger === "maintenance") this.library.prepare(state, context);
      else this.discovery.context(state, run, context);
      this.planning.context(state, run, context);
      if (owner && run.automationPermissions) {
        context.automation = {
          id: owner.id,
          name: owner.name,
          instruction: owner.question,
          allowedChanges: run.automationPermissions,
          ...(run.automationPermissions.includes("milestones")
            ? {
                milestoneSlots: Math.max(
                  0,
                  (owner.targetMilestones || 2) -
                    state.planning.milestones.filter(
                      (m) => !["completed", "declined"].includes(m.status),
                    ).length,
                ),
              }
            : {}),
        };
        context.evidenceRefs.push("automation:" + owner.id);
      }
      if (
        run.trigger === "automation" &&
        owner?.sources.length &&
        this.researchSources
      ) {
        context.externalSources = await this.researchSources.read(
          owner.sources,
        );
        context.evidenceRefs.push(
          ...context.externalSources.flatMap((s) =>
            s.releases.map((r) => r.ref),
          ),
        );
      }
      if (context.discovery?.lens.sources?.length && this.researchSources) {
        context.externalSources = await this.researchSources.read(
          context.discovery.lens.sources,
        );
        context.evidenceRefs.push(
          ...context.externalSources.flatMap((s) =>
            s.releases.map((r) => r.ref),
          ),
        );
      }
      try {
        context.repository = await this.agent.repository();
        const ref = (context.repository as { ref?: string })?.ref;
        if (ref) context.evidenceRefs.push(ref);
      } catch (e) {
        context.repositoryError =
          e instanceof Error ? e.message : "Repository unavailable";
      }
    }
    if (
      work?.mode === "implementation" &&
      run.trigger === "work" &&
      !context.implementation
    )
      await this.deliveryWorkflow.implementationContext(work, context);
    if (work && run.trigger === "acceptance" && !context.acceptance)
      await this.deliveryWorkflow.acceptanceContext(work, run, context);
    if (run.reviewRoundId && this.pullRequests) {
      const round = state.reviewRounds.find(
        (r) => r.id === run!.reviewRoundId,
      )!;
      if (round.status === "superseded") {
        this.repo.transaction(() => {
          const s = this.repo.state();
          s.runs.find((r) => r.id === run!.id)!.status = "completed";
          this.repo.save(s);
        });
        return;
      }
      const snapshot = await this.pullRequests.inspect(
        round.pullRequest.repository,
        round.pullRequest.number,
      );
      if (snapshot.pullRequest.head !== round.pullRequest.head) {
        this.supersede(round.id, snapshot.pullRequest.head);
        this.repo.transaction(() => {
          const s = this.repo.state();
          const r = s.runs.find((r) => r.id === run!.id)!;
          r.status = "completed";
          r.finishedAt = this.now();
          this.repo.save(s);
        });
        return;
      }
      context.evidenceRefs.push(
        `github:${round.pullRequest.repository}#${round.pullRequest.number}@${round.pullRequest.head}`,
      );
      context.review = {
        roundId: round.id,
        reviewId: run.reviewId,
        pullRequest: round.pullRequest,
        files: snapshot.files,
        instructions:
          run.trigger === "review"
            ? "Review this exact commit. Block only concrete correctness, security, failing-check or unmet-acceptance defects. Return structured review.issues with stable IDs, evidence, verification and status. Style and optional improvements are suggestions. In later rounds explicitly resolve or retain prior blockers, focus on fixes and regressions, and justify any newly discovered material blocker."
            : "You are the original worker, resumed by ReviewCompleted. Address the combined findings with complete replacement source files in changes. Never claim a correction was tested; the adapter tests before publishing.",
        ...(run.trigger !== "review"
          ? {
              findings: round.reviews.flatMap((r) => r.findings),
              approved: round.status === "approved",
              workerRunId: round.workerRunId,
              previousResult: state.runs.find((r) => r.id === round.workerRunId)
                ?.result,
            }
          : {}),
      };
    }
    if (work) {
      const failed = state.runs.findLast(
        (r) => r.workId === work.id && r.error && r.result,
      );
      if (failed)
        context.executionFeedback = {
          error: failed.error!,
          proposal: failed.result!,
        };
    }
    if (work?.reviewProgress && context.review) {
      context.review.priorFindings = work.reviewProgress.findings;
      if (run.trigger === "adjudication")
        context.adjudication = {
          finalVerification: !!work.reviewProgress.finalCorrectionRunId,
          history: state.reviewRounds.filter((r) => r.workId === work.id),
          findings: work.reviewProgress.findings,
        };
    }
    this.repo.transaction(() => {
      state = this.repo.state();
      run = state.runs.find((r) => r.id === effect.runId)!;
      const activeMilestone = state.planning.milestones.find((m) =>
        m.workIds.includes(run!.workId || ""),
      );
      if (
        activeMilestone &&
        state.runs.filter(
          (r) =>
            r.id !== run!.id &&
            r.status === "running" &&
            activeMilestone.workIds.includes(r.workId || ""),
        ).length >= activeMilestone.maxParallel
      )
        throw new Deferred(
          "This milestone is using its parallel run allowance.",
        );
      run.context = context;
      run.status = "running";
      run.error = null;
      const w = state.work.find((w) => w.id === run!.workId);
      if (
        w &&
        !["review", "assessment", "adjudication", "acceptance"].includes(
          run!.trigger,
        ) &&
        w.status !== "running"
      ) {
        w.status = "running";
        w.attempts++;
        w.updatedAt = this.now();
      }
      this.emit(
        { type: "RunStarted", payload: { runId: run.id } },
        "system",
        run.workId || run.threadId || run.id,
        delivery.event.id,
      );
      this.repo.save(state);
    });
    if (
      (work?.mode === "ui-inspection" ||
        (run!.discoveryLensId && owner?.inspectUI)) &&
      !run!.reviewRoundId &&
      run!.trigger !== "assessment" &&
      !context.browser
    ) {
      context.browser = await this.browser.inspect(run!.id, run!.agent);
      context.evidenceRefs.push(`browser:${run!.id}`);
      this.repo.transaction(() => {
        const s = this.repo.state();
        s.runs.find((r) => r.id === run!.id)!.context = context;
        this.repo.save(s);
      });
    }
    // Each attempt records exactly what was supplied. Expansion is bounded and is performed by the application.
    this.repo.transaction(() => {
      const s = this.repo.state(),
        r = s.runs.find((r) => r.id === run!.id)!;
      r.contextHistory ||= [structuredClone(context!)];
      this.repo.save(s);
    });
    let output =
      run!.pendingOutput ||
      (await this.agent.execute(
        run!.id,
        context,
        run!.trigger === "heartbeat",
        run!.agent ||
          state.settings.foremanAgent ||
          defaultAgentConfiguration(),
      ));
    if (output.contextRequests?.length) {
      const requests = output.contextRequests.slice(0, 3);
      const savedExpansion = this.repo
        .state()
        .runs.find((r) => r.id === run!.id)?.contextHistory?.[1];
      if (savedExpansion) context = savedExpansion;
      else {
        const extra = await assembleContext(
          this.repo,
          this.embeddings,
          this.repo.state(),
          query,
          context.scope,
          this.now(),
          run,
          requests,
        );
        // Existing supplied revisions remain fixed, including the constitution and pinned attachments.
        const combined = structuredClone(context);
        let remaining = Math.max(
          0,
          60000 - combined.documents.reduce((n, d) => n + d.content.length, 0),
        );
        for (const d of extra.documents) {
          if (
            combined.documents.some((old) => old.id === d.id) ||
            d.content.length > remaining
          )
            continue;
          combined.documents.push(d);
          remaining -= d.content.length;
          combined.entries = combined.entries.filter((e) => e.id !== d.id);
          combined.entries.push(extra.entries.find((e) => e.id === d.id)!);
          if (extra.libraryPages?.[d.id])
            (combined.libraryPages ||= {})[d.id] = extra.libraryPages[d.id]!;
          combined.evidenceRefs.push(documentRef(d));
        }
        combined.additionalRequests = requests;
        combined.gaps = [
          ...new Set([...(combined.gaps || []), ...(extra.gaps || [])]),
        ];
        context = combined;
        this.repo.transaction(() => {
          const s = this.repo.state(),
            r = s.runs.find((r) => r.id === run!.id)!;
          r.context = combined;
          r.contextHistory!.push(structuredClone(combined));
          this.repo.save(s);
        });
      }
      output = await this.agent.execute(
        run!.id + "-context-1",
        context,
        run!.trigger === "heartbeat",
        run!.agent ||
          state.settings.foremanAgent ||
          defaultAgentConfiguration(),
      );
      if (output.contextRequests?.length) {
        if (run!.trigger === "review")
          throw new DomainError(
            "Review still needs context after the supplemental briefing.",
          );
        output.work = [];
        output.changes = [];
        output.proposals = [];
        output.libraryUpdates = [];
        output.milestones = [];
        output.milestoneRevisions = [];
        output.discoveries = [];
        output.discoveryAssessment = null;
        output.discoveryOutcome = null;
        output.outcome = "needs_input";
        output.message +=
          "\n\nThe supplied context is still incomplete: " +
          output.contextRequests.map((r) => r.subject).join(", ") +
          ".";
      }
    }
    assertAutomationOutput(this.repo.state(), run!, output);
    if (run!.trigger === "maintenance") {
      this.repo.transaction(() => {
        const s = this.repo.state(),
          r = s.runs.find((r) => r.id === run!.id)!;
        assertAutomationOutput(s, r, output);
        this.library.complete(s, r, output);
        for (const request of output.requests) this.inbox(s, request, r.id);
        if (output.outcome !== "completed" && !output.requests.length)
          this.inbox(
            s,
            {
              subject: "Knowledge library needs context",
              reason: output.message,
              recommendation:
                "Supply the missing evidence and run the Knowledge library task again.",
              evidence: context.evidenceRefs,
            },
            r.id,
          );
        this.repo.save(s);
      });
      return;
    }
    if (
      output.libraryUpdates?.length &&
      run!.trigger !== "message" &&
      run!.trigger !== "automation" &&
      !(work?.milestoneId && run!.trigger === "work")
    )
      throw new DomainError(
        "Only conversations and library maintenance can write knowledge documents.",
      );
    if (
      ["review", "adjudication", "acceptance"].includes(run!.trigger) &&
      (output.changes.length ||
        output.work.length ||
        output.proposals.length ||
        output.observations.length ||
        output.libraryUpdates?.length ||
        output.milestones?.length ||
        output.milestoneRevisions?.length)
    )
      throw new DomainError(
        "Review and acceptance runs cannot mutate implementation or scope.",
      );
    if (
      ["revision", "adjudication", "acceptance"].includes(run!.trigger) ||
      work?.mode === "implementation"
    ) {
      if (
        output.work.length ||
        output.proposals.length ||
        output.observations.length ||
        output.libraryUpdates?.length ||
        output.milestones?.length ||
        output.milestoneRevisions?.length
      )
        throw new DomainError(
          "Engineering delivery cannot mix code publication with unrelated mutations.",
        );
      this.repo.transaction(() => {
        const s = this.repo.state();
        const r = s.runs.find((r) => r.id === run!.id)!;
        r.pendingOutput = output;
        r.executionId ||= r.id;
        this.repo.save(s);
      });
    }
    if (run!.trigger === "acceptance")
      return this.deliveryWorkflow.finishAcceptance(run!.id, output);
    if (run!.trigger === "adjudication")
      return this.finishAdjudication(run!.id, output, delivery.event.id);
    if (
      work?.mode === "implementation" &&
      run!.trigger === "work" &&
      output.outcome === "completed"
    ) {
      try {
        await this.deliveryWorkflow.publish(work, { ...run!, context }, output);
      } catch (error) {
        if (!(error instanceof VerificationFailed)) throw error;
        this.technicalFailure(
          run!.id,
          output,
          error.message,
          delivery.event.id,
        );
        return;
      }
    }
    if (run!.trigger === "review")
      return this.finishReview(run!.id, output, delivery.event.id);
    if (
      work &&
      this.repo.state().work.find((w) => w.id === work.id)?.status ===
        "cancelled"
    )
      return this.complete(run!.id, output, delivery.event.id);
    if (run!.trigger === "revision" && output.changes.length) {
      const latestState = this.repo.state();
      const milestone = latestState.planning.milestones.find(
        (m) => m.id === work?.milestoneId,
      );
      if (milestone && milestone.status !== "active")
        throw new Deferred("Milestone paused before publication.");
      if (!latestState.settings.allowCodeChanges) {
        output.outcome = "needs_input";
        output.requests.push({
          subject: "Approve correction authority",
          reason:
            "The worker has proposed code corrections. Automatic branch updates are disabled.",
          recommendation:
            "Review the findings and enable automatic corrections in Settings if appropriate. Then choose Resume corrections on the work item.",
          evidence: context.evidenceRefs,
        });
      } else {
        if (!this.pullRequests || !work?.pullRequest)
          throw new DomainError("PR publishing is unavailable.");
        let updated: import("../domain/model").PullRequest;
        try {
          updated = await this.pullRequests.revise(
            context.review!.pullRequest,
            run!.executionId || run!.id,
            output.changes,
            engineeringChecks(
              milestone?.delivery?.policy || latestState.settings.delivery,
            ),
            () => {
              const s = this.repo.state();
              return (
                s.settings.allowCodeChanges &&
                (!milestone ||
                  s.planning.milestones.find((m) => m.id === milestone.id)
                    ?.status === "active") &&
                s.work.find((w) => w.id === work!.id)?.status !== "cancelled"
              );
            },
          );
        } catch (error) {
          if (!(error instanceof VerificationFailed)) throw error;
          this.technicalFailure(
            run!.id,
            output,
            error.message,
            delivery.event.id,
          );
          return;
        }
        this.repo.transaction(() => {
          const s = this.repo.state();
          s.work.find((w) => w.id === work.id)!.pullRequest = updated;
          this.repo.save(s);
        });
        output.outcome = "completed";
        output.message +=
          "\n\nCorrections passed the configured engineering checks and were pushed to " +
          updated.head;
      }
    }
    this.complete(run!.id, output, delivery.event.id);
  }
  complete(runId: string, output: AgentResult, cause: string) {
    this.repo.transaction(() => {
      const state = this.repo.state(),
        run = state.runs.find((r) => r.id === runId);
      if (!run || run.status === "completed") return;
      const context = run.context;
      if (!context) throw new DomainError("Run has no context.");
      for (const refs of [
        ...output.requests.map((r) => r.evidence),
        ...output.proposals.map((p) => p.evidence),
        ...output.observations.map((o) => o.evidence),
      ])
        if (refs.some((ref) => !evidenceReferences(context).includes(ref)))
          throw new DomainError("Agent cited evidence it did not receive.");
      assertAutomationOutput(state, run, output);
      run.result = output;
      const work = state.work.find((w) => w.id === run!.workId);
      if (work?.status === "cancelled") {
        run.status = "completed";
        run.finishedAt = this.now();
        this.repo.save(state);
        return;
      }
      if (
        output.work.length &&
        (run.trigger === "planning" ||
          run.trigger === "message" ||
          work?.milestoneId)
      )
        throw new DomainError(
          "Propose delegated work as a milestone with approval boundaries.",
        );
      if (output.milestoneRevisions?.length) {
        for (const revision of output.milestoneRevisions) {
          const milestone = state.planning.milestones.find(
            (m) => m.id === revision.milestoneId,
          );
          if (
            run.trigger !== "message" ||
            work ||
            milestone?.threadId !== run.threadId
          )
            throw new DomainError(
              "Revise a milestone from its own decision thread.",
            );
          this.planning.revise(
            state,
            revision.milestoneId,
            revision.expectedVersion,
            revision.plan,
            "foreman",
            run.id,
          );
        }
      }
      if (output.milestones?.length) {
        if (
          !["planning", "message", "automation"].includes(run.trigger) ||
          context.discovery ||
          context.review ||
          work
        )
          throw new DomainError(
            "Only Foreman planning and conversations may propose milestones.",
          );
        for (const plan of output.milestones)
          this.planning.propose(state, plan, run.id);
      }
      if (output.libraryUpdates?.length) {
        if (
          (run.trigger !== "message" &&
            run.trigger !== "automation" &&
            !(run.trigger === "work" && work?.milestoneId)) ||
          context.discovery ||
          context.review
        )
          throw new DomainError("This run cannot write knowledge documents.");
        const ids = this.library.applyUpdates(state, run, output);
        if (work)
          work.outputDocumentIds = [
            ...new Set([...(work.outputDocumentIds || []), ...ids]),
          ];
      }
      if (run.trigger === "assessment" && work?.milestoneId) {
        if (!output.review || output.outcome !== "completed")
          throw new DomainError(
            "An assignment review must return a completed verdict.",
          );
        if (
          work.pullRequest &&
          !state.reviewRounds.some(
            (r) =>
              r.workId === work.id &&
              r.pullRequest.head === work.pullRequest!.head &&
              r.status === "approved",
          )
        )
          throw new DomainError(
            "The current PR commit must pass its required reviews first.",
          );
        work.reviews ||= [];
        work.reviews.push({ ...output.review, runId, at: this.now() });
        work.status =
          output.review.verdict === "approve"
            ? "done"
            : work.attempts < 3
              ? "queued"
              : "blocked";
        if (work.status === "blocked") {
          const t = this.inbox(
            state,
            {
              subject: `Review needs a decision: ${work.title}`,
              reason: output.review.summary,
              recommendation:
                "Review the findings and revise the assignment before retrying.",
              evidence: work.evidence,
              workId: work.id,
            },
            run.id,
          );
          work.threadId = t.id;
        }
        if (work.status === "done")
          for (const thread of state.threads.filter(
            (t) => t.workId === work.id,
          )) {
            if (
              !thread.proposals.some((p) => p.status === "pending") &&
              !thread.libraryProposals?.some((p) => p.status === "pending")
            )
              thread.status = "resolved";
          }
        work.updatedAt = this.now();
        run.status = "completed";
        run.result = output;
        run.finishedAt = this.now();
        run.error = null;
        this.emit(
          {
            type: "WorkStatusChanged",
            payload: { workId: work.id, status: work.status },
          },
          "foreman",
          work.id,
          run.id,
        );
        this.emit(
          { type: "RunCompleted", payload: { runId, workId: work.id } },
          "foreman",
          work.id,
          cause,
        );
        this.repo.save(state);
        return;
      }
      let thread = state.threads.find((t) => t.id === run.threadId);
      if (thread) {
        if (output.conversationSummary?.trim())
          thread.summary = {
            content: output.conversationSummary,
            runId,
            updatedAt: this.now(),
          };
        thread.messages.push({
          id: this.ids.next(),
          role: "foreman",
          content: output.message,
          at: this.now(),
          runId,
        });
        thread.unread = true;
        thread.updatedAt = this.now();
        if (thread.status !== "resolved") thread.status = "open";
      }
      for (const request of context.discovery?.phase === "scout"
        ? []
        : output.requests) {
        const inbox = this.inbox(
          state,
          { ...request, workId: work?.id },
          runId,
        );
        inbox.messages.push({
          id: this.ids.next(),
          role: "foreman",
          content: output.message,
          at: this.now(),
          runId,
        });
        if (work) work.threadId = inbox.id;
      }
      if (output.proposals.length && context.discovery?.phase !== "scout") {
        const inbox =
          thread?.kind === "inbox"
            ? thread
            : this.inbox(
                state,
                {
                  subject: `Review: ${work?.title || thread?.subject || "Document revisions"}`,
                  reason: "Review proposed changes to company understanding.",
                  recommendation: output.message,
                  evidence: output.proposals.flatMap((p) => p.evidence),
                  workId: work?.id,
                },
                runId,
              );
        for (const p of output.proposals) {
          const d = context.documents.find((d) => d.id === p.documentId);
          if (!d || d.level === "constitution")
            throw new DomainError(
              "Agent proposed a protected or unseen document.",
            );
          inbox.proposals.push({
            id: this.ids.next(),
            documentId: d.id,
            version: d.version,
            content: p.content,
            reason: p.reason,
            evidence: p.evidence,
            status: "pending",
          });
        }
        if (work) work.threadId = inbox.id;
      }
      if (work) {
        work.result = output.message;
        work.evidence = context.evidenceRefs;
        work.updatedAt = this.now();
        work.status =
          output.outcome === "needs_input"
            ? "blocked"
            : output.outcome === "needs_execution"
              ? work.milestoneId
                ? "blocked"
                : "review"
              : work.milestoneId
                ? "review"
                : "done";
        if (
          work.status !== "done" &&
          !(work.milestoneId && output.outcome === "completed") &&
          !work.threadId
        ) {
          const inbox = this.inbox(
            state,
            {
              subject: work.title,
              reason:
                output.outcome === "needs_execution"
                  ? "Engineering execution is needed."
                  : "Your input is needed.",
              recommendation: output.message,
              evidence: context.evidenceRefs,
              workId: work.id,
            },
            runId,
          );
          work.threadId = inbox.id;
        }
      }
      for (const observation of context.discovery ? [] : output.observations) {
        const duplicate = this.repo
          .documents()
          .some(
            (d) =>
              d.level === "knowledge" &&
              !state.library.pages[d.id] &&
              workKey(d.title) === workKey(observation.title) &&
              d.content.startsWith(observation.content + "\n\nSources:"),
          );
        if (duplicate) continue;
        const d = this.repo.saveDocument(
          {
            title: observation.title,
            level: "knowledge",
            content:
              observation.content +
              `\n\nSources: ${observation.evidence.join(", ")}\n\nRun: ${runId}`,
          },
          "foreman",
        );
        state.policies[d.id] = {
          inclusion: "relevant",
          status: "active",
        };
        this.emit(
          {
            type: "KnowledgeChanged",
            payload: { documentId: d.id, version: d.version },
          },
          "foreman",
          d.id,
          runId,
        );
      }
      if (work?.pullRequest && output.outcome === "completed") {
        const approved = state.reviewRounds.some(
          (r) =>
            r.workId === work.id &&
            r.pullRequest.head === work.pullRequest!.head &&
            r.status === "approved",
        );
        if (!approved) {
          work.status = "review";
          this.emit(
            {
              type: "WorkCompleted",
              payload: {
                workId: work.id,
                repository: work.pullRequest.repository,
                number: work.pullRequest.number,
                head: work.pullRequest.head,
              },
            },
            "foreman",
            work.id,
            runId,
          );
        }
      }
      if (
        work?.pullRequest &&
        run.trigger === "revision" &&
        output.outcome === "completed" &&
        state.reviewRounds.some(
          (r) =>
            r.id === run.reviewRoundId &&
            r.status === "changes_requested" &&
            r.pullRequest.head === work.pullRequest!.head,
        )
      ) {
        if (
          work.reviewProgress?.finalCorrectionRunId ||
          work.reviewProgress?.adjudicationRunId
        ) {
          this.stopReview(
            state,
            work,
            "The worker did not publish the required final correction.",
          );
        } else {
          const adjudication = this.run(state, {
            trigger: "adjudication",
            workId: work.id,
          });
          adjudication.reviewRoundId = run.reviewRoundId;
          work.reviewProgress!.adjudicationRunId = adjudication.id;
          work.status = "queued";
          this.emit(
            { type: "RunRequested", payload: { runId: adjudication.id } },
            "system",
            work.id,
            runId,
          );
        }
      }
      if (work) {
        const linked = state.threads.find((t) => t.id === work.threadId);
        if (
          work.status === "done" &&
          linked &&
          !linked.proposals.some((p) => p.status === "pending")
        )
          linked.status = "resolved";
        this.emit(
          {
            type: "WorkStatusChanged",
            payload: { workId: work.id, status: work.status },
          },
          "foreman",
          work.id,
          runId,
        );
      }
      this.discovery.complete(state, run, output);
      for (const next of context.discovery ||
      run.trigger === "planning" ||
      work?.milestoneId
        ? []
        : output.work) {
        if (
          state.work.filter((w) => !["done", "cancelled"].includes(w.status))
            .length >= state.settings.maxOpenWork
        )
          break;
        this.createWork(state, next, "foreman", runId);
      }
      run.status = "completed";
      run.finishedAt = this.now();
      run.error = null;
      this.emit(
        {
          type: "RunCompleted",
          payload: { runId, threadId: thread?.id, workId: work?.id },
        },
        "foreman",
        work?.id || thread?.id || runId,
        cause,
      );
      this.repo.save(state);
    });
  }
  async linkPullRequest(workId: string, repository: string, number: number) {
    if (!this.pullRequests)
      throw new DomainError("GitHub review adapter is unavailable.");
    const snapshot = await this.pullRequests.inspect(repository, number);
    return this.repo.transaction(() => {
      const state = this.repo.state(),
        work = state.work.find((w) => w.id === workId);
      if (!work) throw new DomainError("Work not found.");
      if (work.status === "cancelled")
        throw new DomainError("Cancelled work cannot enter review.");
      if (
        state.runs.some(
          (r) =>
            r.workId === workId && ["running", "queued"].includes(r.status),
        )
      )
        throw new DomainError(
          "Wait for the current work run to finish before linking a PR.",
        );
      const milestone = state.planning.milestones.find(
        (m) => m.id === work.milestoneId,
      );
      if (
        milestone?.delivery &&
        (snapshot.pullRequest.base !== milestone.delivery.branch ||
          snapshot.pullRequest.branch !== work.branch)
      )
        throw new DomainError(
          "Assignment PR must use its managed branch and target the milestone branch.",
        );
      work.pullRequest = snapshot.pullRequest;
      work.status = "review";
      work.updatedAt = this.now();
      this.emit(
        {
          type: "WorkCompleted",
          payload: {
            workId,
            repository,
            number,
            head: snapshot.pullRequest.head,
          },
        },
        "human",
        workId,
      );
      this.repo.save(state);
      return snapshot.pullRequest;
    });
  }
  async startReview(workId: string, cause: string) {
    if (!this.pullRequests)
      throw new DomainError("GitHub review adapter unavailable.");
    const before = this.repo.state(),
      work = before.work.find((w) => w.id === workId);
    if (
      !work?.pullRequest ||
      ["cancelled", "done"].includes(work.status) ||
      work.reviewProgress?.stopped
    )
      return;
    const snapshot = await this.pullRequests.inspect(
      work.pullRequest.repository,
      work.pullRequest.number,
    );
    this.repo.transaction(() => {
      const state = this.repo.state();
      if (
        state.reviewRounds.some(
          (r) =>
            r.workId === workId &&
            r.pullRequest.head === snapshot.pullRequest.head &&
            r.status !== "superseded",
        )
      )
        return;
      for (const old of state.reviewRounds.filter(
        (r) => r.workId === workId && r.status !== "superseded",
      ))
        old.status = "superseded";
      const w = state.work.find((w) => w.id === workId)!;
      w.pullRequest = snapshot.pullRequest;
      w.reviewProgress ||= {
        policy: {
          correctionRounds:
            state.planning.milestones.find((m) => m.id === w.milestoneId)
              ?.delivery?.policy.correctionRounds ??
            state.settings.delivery.correctionRounds,
        },
        corrections: 0,
        findings: [],
      };
      w.status = "review";
      const m = state.planning.milestones.find((m) => m.id === w.milestoneId);
      const needed = w.reviewProgress.finalCorrectionRunId
        ? 1
        : m?.delivery?.requiredReviews || state.settings.requiredReviews;
      if (
        m &&
        state.runs.filter((r) => r.workId && m.workIds.includes(r.workId))
          .length +
          needed >
          m.maxRuns
      ) {
        this.deliveryWorkflow.stop(
          state,
          m,
          "The approved run allowance cannot fund the next complete review round.",
        );
        return;
      }
      const round: import("../domain/model").ReviewRound = {
        id: this.ids.next(),
        workId,
        pullRequest: snapshot.pullRequest,
        required:
          state.planning.milestones.find((m) => m.id === w.milestoneId)
            ?.delivery?.requiredReviews || state.settings.requiredReviews,
        workerRunId: state.runs.findLast(
          (r) =>
            r.workId === workId &&
            r.trigger !== "review" &&
            r.trigger !== "revision",
        )?.id,
        status: "collecting",
        reviews: [],
        createdAt: this.now(),
      };
      state.reviewRounds.push(round);
      if (
        w.reviewProgress.finalCorrectionRunId ||
        state.reviewRounds.filter((r) => r.workId === w.id).length >
          w.reviewProgress.policy.correctionRounds + 1
      ) {
        if (
          w.reviewProgress.adjudicationRunId &&
          !w.reviewProgress.finalCorrectionRunId
        ) {
          this.stopReview(
            state,
            w,
            "The PR changed after its adjudication allowance was used.",
          );
          this.repo.save(state);
          return;
        }
        round.required = 0;
        const verification = this.run(state, {
          trigger: "adjudication",
          workId,
        });
        verification.reviewRoundId = round.id;
        w.reviewProgress.adjudicationRunId ||= verification.id;
        this.emit(
          { type: "RunRequested", payload: { runId: verification.id } },
          "system",
          workId,
          cause,
        );
        this.repo.save(state);
        return;
      }
      for (let i = 0; i < round.required; i++) {
        const reviewId = this.ids.next();
        const run = this.run(state, {
          trigger: "review",
          workId,
          automatic: false,
        });
        run.reviewRoundId = round.id;
        run.reviewId = reviewId;
        round.reviews.push({
          id: reviewId,
          runId: run.id,
          status: "queued",
          verdict: null,
          summary: "",
          findings: [],
        });
      }
      this.emit(
        {
          type: "ReviewRoundStarted",
          payload: {
            roundId: round.id,
            runIds: round.reviews.map((r) => r.runId),
          },
        },
        "system",
        workId,
        cause,
      );
      this.repo.save(state);
    });
  }
  supersede(roundId: string, head: string) {
    this.repo.transaction(() => {
      const state = this.repo.state(),
        round = state.reviewRounds.find((r) => r.id === roundId);
      if (!round || round.status === "superseded") return;
      round.status = "superseded";
      this.emit(
        {
          type: "ReviewSuperseded",
          payload: { roundId, workId: round.workId, head },
        },
        "system",
        round.workId,
      );
      this.repo.save(state);
    });
  }
  async finishReview(runId: string, output: AgentResult, cause: string) {
    if (!output.review || output.outcome !== "completed")
      throw new DomainError("Reviewer did not return a completed review.");
    this.validateReview(output);
    this.repo.transaction(() => {
      const state = this.repo.state(),
        run = state.runs.find((r) => r.id === runId)!;
      if (run.status === "completed") return;
      const round = state.reviewRounds.find((r) => r.id === run.reviewRoundId)!;
      const review = round.reviews.find((r) => r.id === run.reviewId)!;
      if (round.status !== "superseded") {
        const w = state.work.find((w) => w.id === round.workId)!;
        const prior =
          w.reviewProgress?.findings.filter(
            (f) =>
              f.head !== round.pullRequest.head &&
              f.severity === "blocker" &&
              f.status === "open",
          ) || [];
        if (
          prior.some((f) => !output.review!.issues?.some((i) => i.id === f.id))
        )
          throw new DomainError(
            "Review must explicitly resolve or retain prior blockers.",
          );
        Object.assign(review, output.review, { status: "publishing" });
        this.emit(
          {
            type: "ReviewSubmitted",
            payload: {
              roundId: round.id,
              reviewId: review.id,
              head: round.pullRequest.head,
            },
          },
          "foreman",
          round.workId,
          cause,
        );
      }
      run.result = output;
      run.status = "completed";
      run.finishedAt = this.now();
      this.emit(
        { type: "RunCompleted", payload: { runId, workId: round.workId } },
        "foreman",
        round.workId,
        cause,
      );
      this.repo.save(state);
    });
  }
  async publishReview(roundId: string, reviewId: string, cause: string) {
    const before = this.repo.state(),
      round = before.reviewRounds.find((r) => r.id === roundId)!;
    if (
      round.status === "superseded" ||
      before.work.find((w) => w.id === round.workId)?.status === "cancelled"
    )
      return;
    const review = round.reviews.find((r) => r.id === reviewId)!;
    if (review.status === "completed") return;
    if (!this.pullRequests)
      throw new DomainError("GitHub adapter unavailable.");
    const snapshot = await this.pullRequests.inspect(
      round.pullRequest.repository,
      round.pullRequest.number,
    );
    if (snapshot.pullRequest.head !== round.pullRequest.head) {
      this.supersede(roundId, snapshot.pullRequest.head);
      return;
    }
    await this.pullRequests.publishReview(
      round.pullRequest,
      review.id,
      review.summary,
      review.findings,
      review.verdict!,
    );
    this.repo.transaction(() => {
      const state = this.repo.state(),
        r = state.reviewRounds.find((r) => r.id === roundId)!;
      r.reviews.find((r) => r.id === reviewId)!.status = "completed";
      const outcome = reviewOutcome(r, snapshot.pullRequest.head);
      if (
        r.status === "collecting" &&
        (outcome === "approved" || outcome === "changes_requested")
      ) {
        const work = state.work.find((w) => w.id === r.workId)!;
        if (work.reviewProgress) {
          // Replace the prior-round ledger only when the complete quorum arrives.
          work.reviewProgress.findings = r.reviews.flatMap((v) =>
            (v.issues || []).map((f) => ({
              ...f,
              head: r.pullRequest.head,
              reviewerId: v.id,
            })),
          );
        }
        r.status = outcome;
        r.completedAt = this.now();
        this.emit(
          {
            type: "ReviewCompleted",
            payload: {
              roundId,
              workId: r.workId,
              approved: outcome === "approved",
            },
          },
          "system",
          r.workId,
          cause,
        );
      }
      this.repo.save(state);
    });
  }
  private technicalFailure(
    runId: string,
    output: AgentResult,
    error: string,
    cause: string,
  ) {
    this.repo.transaction(() => {
      const state = this.repo.state(),
        run = state.runs.find((r) => r.id === runId)!,
        work = state.work.find((w) => w.id === run.workId)!;
      run.status = "completed";
      run.result = output;
      run.error = error;
      run.finishedAt = this.now();
      work.result = error;
      work.reviewProgress ||= {
        policy: { correctionRounds: state.settings.delivery.correctionRounds },
        corrections: 0,
        findings: [],
      };
      const p = work.reviewProgress;
      const m = state.planning.milestones.find(
        (m) => m.id === work.milestoneId,
      );
      const exhausted =
        m &&
        state.runs.filter((r) => r.workId && m.workIds.includes(r.workId))
          .length >= m.maxRuns;
      if (
        exhausted ||
        p.finalCorrectionRunId ||
        (!work.pullRequest && work.attempts >= 3)
      ) {
        this.stopReview(
          state,
          work,
          "Verification failed within the bounded execution allowance. Foreman deferred this attempt. " +
            error,
        );
      } else {
        const adjudicate =
          work.pullRequest && p.corrections >= p.policy.correctionRounds;
        const next = this.run(state, {
          trigger: adjudicate
            ? "adjudication"
            : work.pullRequest
              ? "revision"
              : "work",
          workId: work.id,
        });
        next.reviewRoundId = run.reviewRoundId;
        if (adjudicate) p.adjudicationRunId = next.id;
        else if (work.pullRequest) p.corrections++;
        work.status = "queued";
        this.emit(
          { type: "RunRequested", payload: { runId: next.id } },
          "system",
          work.id,
          cause,
        );
      }
      this.emit(
        { type: "RunCompleted", payload: { runId, workId: work.id } },
        "system",
        work.id,
        cause,
      );
      this.repo.save(state);
    });
  }
  private validateReview(output: AgentResult) {
    const review = output.review!;
    if (review.verdict === "changes_requested" && !review.issues?.length)
      throw new DomainError(
        "Blocking review requires structured findings with evidence and verification.",
      );
    for (const issue of review.issues || [])
      if (issue.severity === "blocker" && issue.category === "style")
        throw new DomainError("Style preferences cannot block merging.");
    if (
      new Set(review.issues?.map((f) => f.id)).size !==
      (review.issues || []).length
    )
      throw new DomainError("Review finding IDs must be unique.");
    if (review.issues) {
      const blockers = review.issues.filter(
        (f) => f.severity === "blocker" && f.status === "open",
      );
      review.verdict = blockers.length ? "changes_requested" : "approve";
      review.findings = blockers.map(
        (f) => `${f.problem} Evidence: ${f.evidence} Verify: ${f.verification}`,
      );
    }
  }
  private stopReview(state: CompanyState, work: Work, reason: string) {
    work.reviewProgress!.stopped = reason;
    work.status = "blocked";
    const m = state.planning.milestones.find((m) => m.id === work.milestoneId);
    if (m) {
      // Independent streams remain runnable; no replacement assignment resets this budget.
      m.decisionReason = reason;
      const thread = state.threads.find((t) => t.id === m.threadId)!;
      thread.status = "open";
      thread.unread = true;
      thread.reason = `Foreman deferred an assignment after bounded technical adjudication: ${work.title}. ${reason}`;
      thread.recommendation =
        "Discuss changing the outcome or authorizing a bounded follow-up. Technical PR review remains automated; independent streams continue.";
    } else
      this.inbox(
        state,
        {
          subject: `Work deferred: ${work.title}`,
          reason,
          recommendation:
            "Foreman stopped this attempt. Decide whether the outcome warrants changed scope or additional authority; no PR review is needed.",
          evidence: [],
          workId: work.id,
        },
        work.id,
      );
  }
  async finishAdjudication(runId: string, output: AgentResult, cause: string) {
    if (!output.review || output.outcome !== "completed")
      throw new DomainError("Adjudication requires a completed verdict.");
    this.validateReview(output);
    const before = this.repo.state(),
      run = before.runs.find((r) => r.id === runId)!;
    const round = before.reviewRounds.find((r) => r.id === run.reviewRoundId)!;
    const current = await this.pullRequests!.head(
      round.pullRequest.repository,
      round.pullRequest.number,
    );
    if (current.head !== round.pullRequest.head) {
      this.repo.transaction(() => {
        const s = this.repo.state();
        const r = s.runs.find((r) => r.id === runId)!;
        r.status = "completed";
        r.finishedAt = this.now();
        this.repo.save(s);
      });
      this.supersede(round.id, current.head);
      return;
    }
    const unresolved =
      before.work
        .find((w) => w.id === round.workId)
        ?.reviewProgress?.findings.filter(
          (f) => f.severity === "blocker" && f.status === "open",
        ) || [];
    if (
      unresolved.some((f) => !output.review!.issues?.some((i) => i.id === f.id))
    )
      throw new DomainError(
        "Adjudication must explicitly resolve every disputed blocker.",
      );
    await this.pullRequests!.publishReview(
      round.pullRequest,
      runId,
      output.review.summary,
      output.review.findings,
      output.review.verdict,
    );
    this.repo.transaction(() => {
      const state = this.repo.state(),
        r = state.runs.find((r) => r.id === runId)!;
      if (r.status === "completed") return;
      const rd = state.reviewRounds.find((n) => n.id === round.id)!,
        work = state.work.find((w) => w.id === rd.workId)!;
      const progress = work.reviewProgress!;
      r.result = output;
      r.status = "completed";
      r.finishedAt = this.now();
      progress.findings = (output.review!.issues || []).map((f) => ({
        ...f,
        head: rd.pullRequest.head,
        reviewerId: r.id,
      }));
      if (output.review!.verdict === "approve") {
        rd.status = "approved";
        this.emit(
          {
            type: "ReviewCompleted",
            payload: { roundId: rd.id, workId: work.id, approved: true },
          },
          "system",
          work.id,
          cause,
        );
      } else if (progress.finalCorrectionRunId) {
        this.stopReview(
          state,
          work,
          "The final correction did not pass independent verification. This attempt is stopped.",
        );
      } else {
        rd.status = "changes_requested";
        rd.reviews = [
          { id: r.id, runId: r.id, status: "completed", ...output.review! },
        ];
        const fix = this.run(state, { trigger: "revision", workId: work.id });
        progress.finalCorrectionRunId = fix.id;
        fix.reviewRoundId = rd.id;
        work.status = "queued";
        this.emit(
          { type: "RunRequested", payload: { runId: fix.id } },
          "system",
          work.id,
          cause,
        );
      }
      this.emit(
        { type: "RunCompleted", payload: { runId, workId: work.id } },
        "system",
        work.id,
        cause,
      );
      this.repo.save(state);
    });
  }
  async signalWorker(roundId: string, cause: string) {
    const state = this.repo.state(),
      prior = state.reviewRounds.find((r) => r.id === roundId);
    if (!prior || !["approved", "changes_requested"].includes(prior.status))
      return;
    const work = state.work.find((w) => w.id === prior.workId)!;
    if (
      ["done", "cancelled"].includes(work.status) ||
      work.reviewProgress?.stopped
    )
      return;
    const milestone = state.planning.milestones.find(
      (m) => m.id === work.milestoneId,
    );
    if (milestone && milestone.status !== "active")
      throw new Deferred("Milestone is paused.");
    if (!this.pullRequests)
      throw new DomainError("GitHub adapter unavailable.");
    if (prior.status === "approved") {
      if (
        !state.settings.delivery.autoMerge ||
        (milestone?.delivery && !milestone.delivery.policy.autoMerge)
      )
        throw new Deferred("Automatic merging is paused in Settings.");
      if (
        !this.pullRequests.candidate ||
        !this.pullRequests.verify ||
        !this.pullRequests.merge
      )
        throw new DomainError("Automatic merge connector unavailable.");
      let candidate = work.mergeCandidate;
      if (!candidate || candidate.pullRequest.head !== prior.pullRequest.head) {
        const snapshot = await this.pullRequests.head(
          prior.pullRequest.repository,
          prior.pullRequest.number,
        );
        if (snapshot.head !== prior.pullRequest.head) {
          this.supersede(roundId, snapshot.head);
          return;
        }
        candidate = await this.pullRequests.candidate(prior.pullRequest);
        const policy = milestone?.delivery?.policy || state.settings.delivery;
        const check = await this.pullRequests.verify(
          prior.pullRequest.repository,
          candidate.head,
          `merge-${roundId}`,
          engineeringChecks(policy),
        );
        if (!check.passed) {
          this.repo.transaction(() => {
            const s = this.repo.state(),
              rd = s.reviewRounds.find((r) => r.id === roundId)!,
              w = s.work.find((w) => w.id === work.id)!;
            rd.status = "changes_requested";
            rd.reviews.push({
              id: `checks-${roundId}`,
              runId: "",
              status: "completed",
              verdict: "changes_requested",
              summary: "Integration checks failed",
              findings: check.checks
                .filter((c) => !c.passed)
                .map((c) => `${c.name}: ${c.output}`),
            });
            this.emit(
              {
                type: "ReviewCompleted",
                payload: { roundId, workId: w.id, approved: false },
              },
              "system",
              w.id,
              cause,
            );
            this.repo.save(s);
          });
          return;
        }
        this.repo.transaction(() => {
          const s = this.repo.state();
          s.work.find((w) => w.id === work.id)!.mergeCandidate = candidate;
          this.repo.save(s);
        });
      }
      const latest = this.repo.state();
      if (
        !latest.settings.delivery.autoMerge ||
        (milestone &&
          latest.planning.milestones.find((m) => m.id === milestone.id)
            ?.status !== "active")
      )
        throw new Deferred("Merge authority paused.");
      let head: string;
      try {
        head = await this.pullRequests.merge(candidate);
      } catch (error) {
        if (!(error instanceof IntegrationChanged)) throw error;
        let stopped = false;
        this.repo.transaction(() => {
          const s = this.repo.state(),
            w = s.work.find((w) => w.id === work.id)!;
          w.mergeCandidate = undefined;
          w.integrationAttempts = (w.integrationAttempts || 0) + 1;
          if (w.integrationAttempts >= 3) {
            this.stopReview(
              s,
              w,
              "The integration target kept changing. Foreman deferred this attempt after three tested candidates.",
            );
            stopped = true;
          }
          this.repo.save(s);
        });
        if (!stopped)
          throw new Deferred("Target advanced; re-testing integration.");
        return;
      }
      this.repo.transaction(() => {
        const s = this.repo.state(),
          w = s.work.find((w) => w.id === work.id)!;
        w.status = "done";
        w.mergedHead = head;
        w.updatedAt = this.now();
        const thread = s.threads.find((t) => t.id === w.threadId);
        if (thread) thread.status = "resolved";
        this.emit(
          {
            type: "WorkStatusChanged",
            payload: { workId: w.id, status: "done" },
          },
          "system",
          w.id,
          cause,
        );
        this.repo.save(s);
      });
      return;
    }
    const current = await this.pullRequests.head(
      prior.pullRequest.repository,
      prior.pullRequest.number,
    );
    if (current.head !== prior.pullRequest.head) {
      this.supersede(roundId, current.head);
      return;
    }
    this.repo.transaction(() => {
      const s = this.repo.state(),
        w = s.work.find((w) => w.id === work.id)!;
      const progress = w.reviewProgress!;
      const m = s.planning.milestones.find((m) => m.id === w.milestoneId);
      if (
        m &&
        s.runs.filter((r) => r.workId && m.workIds.includes(r.workId)).length >=
          m.maxRuns
      ) {
        this.deliveryWorkflow.stop(
          s,
          m,
          "The approved milestone run allowance is exhausted. No review or replacement run was started.",
        );
        return;
      }
      const adjudicatedApproval = s.runs.some(
        (r) =>
          r.trigger === "adjudication" &&
          r.reviewRoundId === roundId &&
          r.status === "completed" &&
          r.result?.review?.verdict === "approve",
      );
      if (adjudicatedApproval && progress.finalCorrectionRunId) {
        this.stopReview(s, w, "Final correction failed integration checks.");
        this.repo.save(s);
        return;
      }
      if (adjudicatedApproval && !progress.finalCorrectionRunId) {
        const fix = this.run(s, { trigger: "revision", workId: w.id });
        fix.reviewRoundId = roundId;
        progress.finalCorrectionRunId = fix.id;
        w.status = "queued";
        this.emit(
          { type: "RunRequested", payload: { runId: fix.id } },
          "system",
          w.id,
          cause,
        );
        this.repo.save(s);
        return;
      }
      if (
        s.runs.some(
          (r) =>
            ["revision", "adjudication"].includes(r.trigger) &&
            r.reviewRoundId === roundId,
        )
      )
        return;
      if (progress.finalCorrectionRunId) {
        this.stopReview(s, w, "Final correction failed integration checks.");
        this.repo.save(s);
        return;
      }
      const adjudicate =
        progress.corrections >= progress.policy.correctionRounds;
      if (adjudicate && progress.adjudicationRunId) {
        this.stopReview(s, w, "Adjudication allowance exhausted.");
        this.repo.save(s);
        return;
      }
      const run = this.run(s, {
        trigger: adjudicate ? "adjudication" : "revision",
        workId: w.id,
        automatic: false,
      });
      if (adjudicate) progress.adjudicationRunId = run.id;
      else progress.corrections++;
      run.reviewRoundId = roundId;
      w.status = "queued";
      this.emit(
        {
          type: "WorkerSignalled",
          payload: { runId: run.id, workId: w.id, roundId },
        },
        "system",
        w.id,
        cause,
      );
      this.repo.save(s);
    });
  }
  async pollPullRequests() {
    if (!this.pullRequests) return;
    for (const work of this.repo
      .state()
      .work.filter(
        (w) =>
          w.pullRequest &&
          !["cancelled", "done"].includes(w.status) &&
          !w.reviewProgress?.stopped,
      )) {
      try {
        const current = await this.pullRequests.head(
          work.pullRequest!.repository,
          work.pullRequest!.number,
        );
        if (current.head !== work.pullRequest!.head)
          this.repo.transaction(() => {
            const state = this.repo.state(),
              w = state.work.find((w) => w.id === work.id)!;
            w.pullRequest = current;
            w.mergeCandidate = undefined;
            w.status = "review";
            for (const round of state.reviewRounds.filter(
              (r) => r.workId === w.id && r.pullRequest.head !== current.head,
            ))
              round.status = "superseded";
            this.emit(
              {
                type: "PullRequestUpdated",
                payload: { workId: w.id, head: current.head },
              },
              "system",
              w.id,
            );
            this.repo.save(state);
          });
      } catch {
        /* A closed PR is retained for audit. Explicit actions surface adapter errors. */
      }
    }
  }
  deliveryFailed(delivery: Delivery, error: string) {
    this.repo.transaction(() => {
      const state = this.repo.state(),
        effect = delivery.effect;
      const round =
        "roundId" in effect
          ? state.reviewRounds.find((r) => r.id === effect.roundId)
          : undefined;
      const workId = "workId" in effect ? effect.workId : round?.workId;
      const work = state.work.find((w) => w.id === workId);
      if (work && work.status !== "cancelled") work.status = "blocked";
      const t = this.inbox(
        state,
        {
          subject: "Workflow delivery failed: " + (work?.title || effect.type),
          reason: error,
          recommendation:
            "Inspect delivery failures in Work and retry after correcting the connection or configuration.",
          evidence: [],
          workId,
        },
        delivery.event.id,
      );
      if (work) work.threadId = t.id;
      this.repo.save(state);
    });
  }
  fail(runId: string, error: string) {
    this.repo.transaction(() => {
      const state = this.repo.state(),
        run = state.runs.find((r) => r.id === runId);
      if (!run || run.status === "completed") return;
      run.status = "failed";
      run.error = error;
      const work = state.work.find((w) => w.id === run.workId);
      if (work && !["done", "cancelled"].includes(work.status)) {
        work.status = "blocked";
        work.updatedAt = this.now();
      }
      const inbox = this.inbox(
        state,
        {
          subject: work ? `Run failed: ${work.title}` : "Foreman run failed",
          reason: error,
          recommendation:
            "Inspect the run and retry after correcting the problem.",
          evidence: [],
          workId: work?.id,
        },
        runId,
      );
      inbox.messages.push({
        id: this.ids.next(),
        role: "system",
        content: error,
        at: this.now(),
        runId,
      });
      if (work) work.threadId = inbox.id;
      this.emit(
        { type: "RunFailed", payload: { runId, error } },
        "system",
        run.threadId || work?.id || runId,
      );
      this.repo.save(state);
    });
  }
}
export class Deferred extends Error {}
