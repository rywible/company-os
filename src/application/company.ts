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
} from "./ports";
import { assembleContext } from "./context";
import { reviewOutcome } from "../domain/reviews";
import { chunkDocument } from "../domain/knowledge";
export class Company {
  constructor(
    readonly repo: Repository,
    readonly agent: AgentPort,
    readonly embeddings: EmbeddingPort,
    readonly browser: BrowserPort,
    readonly clock: Clock = { now: () => new Date() },
    readonly ids: Ids = { next: () => crypto.randomUUID() },
    readonly pullRequests?: PullRequestPort,
  ) {}
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
    const run: Run = {
      id: this.ids.next(),
      automatic: input.trigger !== "message",
      ...input,
      status: "queued",
      context: null,
      error: null,
      createdAt: this.now(),
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
      switch (cmd.type) {
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
          t.unread = false;
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
              cmd.policy.status !== "active" ||
              cmd.policy.scope !== "company")
          )
            throw new DomainError(
              "The constitution must remain active and always included company-wide.",
            );
          const d = this.repo.saveDocument(cmd);
          state.policies[d.id] = cmd.policy;
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
          if (!work || work.status !== "blocked" || !round)
            throw new DomainError("No blocked review corrections to resume.");
          if (
            state.runs.some(
              (r) =>
                r.workId === work.id &&
                ["queued", "running"].includes(r.status),
            )
          )
            throw new DomainError("Work already has an active run.");
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
  ) {
    const key = workKey(input.title),
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
  private heartbeatIn(state: CompanyState, manual = false) {
    if (!manual && !state.settings.enabled) return { skipped: "paused" };
    if (
      !manual &&
      Date.parse(state.settings.nextHeartbeatAt) > this.clock.now().getTime()
    )
      return { skipped: "not due" };
    if (state.runs.some((r) => ["queued", "running"].includes(r.status)))
      return { skipped: "run active" };
    if (!this.budgetAvailable(state))
      return { skipped: "daily budget reached" };
    state.settings.nextHeartbeatAt = new Date(
      this.clock.now().getTime() + state.settings.intervalMinutes * 60000,
    ).toISOString();
    const run = this.run(state, { trigger: "heartbeat", automatic: !manual });
    this.emit(
      { type: "HeartbeatDue", payload: { runId: run.id } },
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
      scope || state.settings.scope,
      this.now(),
      threadId ? ({ threadId } as Run) : undefined,
    );
  }
  async deliver(delivery: Delivery) {
    const effect = delivery.effect;
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
    if (run.automatic && !state.settings.enabled)
      throw new Deferred("Autonomy paused.");
    const work = state.work.find((w) => w.id === run!.workId);
    if (work && ["done", "cancelled"].includes(work.status)) {
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
      thread?.messages.at(-1)?.content ||
      work?.instruction ||
      state.settings.objective;
    let context = run.context;
    if (!context) {
      context = await assembleContext(
        this.repo,
        this.embeddings,
        state,
        query,
        state.settings.scope,
        this.now(),
        run,
      );
      try {
        context.repository = await this.agent.repository();
        const ref = (context.repository as { ref?: string })?.ref;
        if (ref) context.evidenceRefs.push(ref);
      } catch (e) {
        context.repositoryError =
          e instanceof Error ? e.message : "Repository unavailable";
      }
    }
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
            ? "Independently review this exact commit. Return review verdict, summary, and concrete findings. Do not consider other reviewers."
            : "You are the original worker, resumed by ReviewCompleted. Address the combined findings with complete replacement source files in changes. Never claim a correction was tested; the adapter tests before publishing.",
        ...(run.trigger === "revision"
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
    this.repo.transaction(() => {
      state = this.repo.state();
      run = state.runs.find((r) => r.id === effect.runId)!;
      run.context = context;
      run.status = "running";
      run.error = null;
      const w = state.work.find((w) => w.id === run!.workId);
      if (w && run!.trigger !== "review" && w.status !== "running") {
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
      work?.mode === "ui-inspection" &&
      !run!.reviewRoundId &&
      !context.browser
    ) {
      context.browser = await this.browser.inspect(run!.id);
      context.evidenceRefs.push(`browser:${run!.id}`);
      this.repo.transaction(() => {
        const s = this.repo.state();
        s.runs.find((r) => r.id === run!.id)!.context = context;
        this.repo.save(s);
      });
    }
    const output = await this.agent.execute(
      run!.id,
      context,
      run!.trigger === "heartbeat",
    );
    if (run!.trigger === "review")
      return this.finishReview(run!.id, output, delivery.event.id);
    if (
      work &&
      this.repo.state().work.find((w) => w.id === work.id)?.status ===
        "cancelled"
    )
      return this.complete(run!.id, output, delivery.event.id);
    if (run!.trigger === "revision" && output.changes.length) {
      if (!this.repo.state().settings.allowCodeChanges) {
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
        const updated = await this.pullRequests.revise(
          context.review!.pullRequest,
          run!.id,
          output.changes,
        );
        this.repo.transaction(() => {
          const s = this.repo.state();
          s.work.find((w) => w.id === work.id)!.pullRequest = updated;
          this.repo.save(s);
        });
        output.outcome = "completed";
        output.message +=
          "\n\nCorrections passed type checking, unit tests, build and browser tests, and were pushed to " +
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
        if (refs.some((ref) => !context.evidenceRefs.includes(ref)))
          throw new DomainError("Agent cited evidence it did not receive.");
      run.result = output;
      const work = state.work.find((w) => w.id === run!.workId);
      if (work?.status === "cancelled") {
        run.status = "completed";
        run.finishedAt = this.now();
        this.repo.save(state);
        return;
      }
      let thread = state.threads.find((t) => t.id === run.threadId);
      if (thread) {
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
      for (const request of output.requests) {
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
      if (output.proposals.length) {
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
              ? "review"
              : "done";
        if (work.status !== "done" && !work.threadId) {
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
      for (const observation of output.observations) {
        const duplicate = this.repo
          .documents()
          .some((d) => workKey(d.title) === workKey(observation.title));
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
          scope: context.scope,
          kind: observation.kind,
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
        work.status = "blocked";
        const t = this.inbox(
          state,
          {
            subject: "Review findings need a decision: " + work.title,
            reason:
              "The worker did not publish a correction for the rejected commit.",
            recommendation: output.message,
            evidence: context.evidenceRefs,
            workId: work.id,
          },
          runId,
        );
        work.threadId = t.id;
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
      for (const next of output.work) {
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
    if (!work?.pullRequest || work.status === "cancelled") return;
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
      w.status = "review";
      const round: import("../domain/model").ReviewRound = {
        id: this.ids.next(),
        workId,
        pullRequest: snapshot.pullRequest,
        required: state.settings.requiredReviews,
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
    if (!output.review)
      throw new DomainError("Reviewer did not return a review.");
    this.repo.transaction(() => {
      const state = this.repo.state(),
        run = state.runs.find((r) => r.id === runId)!;
      if (run.status === "completed") return;
      const round = state.reviewRounds.find((r) => r.id === run.reviewRoundId)!;
      const review = round.reviews.find((r) => r.id === run.reviewId)!;
      if (round.status !== "superseded") {
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
  async signalWorker(roundId: string, cause: string) {
    const prior = this.repo.state().reviewRounds.find((r) => r.id === roundId);
    if (!prior || !["approved", "changes_requested"].includes(prior.status))
      return;
    if (!this.pullRequests)
      throw new DomainError("GitHub adapter unavailable.");
    const current = await this.pullRequests.inspect(
      prior.pullRequest.repository,
      prior.pullRequest.number,
    );
    if (current.pullRequest.head !== prior.pullRequest.head) {
      this.supersede(roundId, current.pullRequest.head);
      return;
    }
    this.repo.transaction(() => {
      const state = this.repo.state(),
        round = state.reviewRounds.find((r) => r.id === roundId)!;
      if (
        state.runs.some(
          (r) => r.trigger === "revision" && r.reviewRoundId === roundId,
        )
      )
        return;
      const work = state.work.find((w) => w.id === round.workId)!;
      if (work.status === "cancelled") return;
      if (
        state.reviewRounds.filter(
          (r) =>
            r.workId === work.id &&
            r.reviews.every((v) => v.status === "completed") &&
            r.reviews.some((v) => v.verdict === "changes_requested"),
        ).length >= 3 &&
        round.status !== "approved"
      ) {
        work.status = "blocked";
        const t = this.inbox(
          state,
          {
            subject: "Review loop needs input: " + work.title,
            reason: "Three review rounds have not converged.",
            recommendation: "Inspect the findings and revise the approach.",
            evidence: [],
            workId: work.id,
          },
          roundId,
        );
        work.threadId = t.id;
        this.repo.save(state);
        return;
      }
      const run = this.run(state, {
        trigger: "revision",
        workId: work.id,
        automatic: false,
      });
      run.reviewRoundId = roundId;
      work.status = "queued";
      this.emit(
        {
          type: "WorkerSignalled",
          payload: { runId: run.id, workId: work.id, roundId },
        },
        "system",
        work.id,
        cause,
      );
      this.repo.save(state);
    });
  }
  async pollPullRequests() {
    if (!this.pullRequests) return;
    for (const work of this.repo
      .state()
      .work.filter((w) => w.pullRequest && w.status !== "cancelled")) {
      try {
        const snapshot = await this.pullRequests.inspect(
          work.pullRequest!.repository,
          work.pullRequest!.number,
        );
        if (snapshot.pullRequest.head !== work.pullRequest!.head)
          this.repo.transaction(() => {
            const state = this.repo.state(),
              w = state.work.find((w) => w.id === work.id)!;
            w.pullRequest = snapshot.pullRequest;
            w.status = "review";
            this.emit(
              {
                type: "PullRequestUpdated",
                payload: { workId: w.id, head: snapshot.pullRequest.head },
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
