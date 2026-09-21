import type {
  AgentResult,
  CompanyState,
  Context,
  Run,
  Work,
} from "../domain/model";
import { DomainError } from "../domain/model";
import type { Milestone } from "../domain/planning";
import {
  ChecksPending,
  IntegrationChanged,
  VerificationFailed,
  assignmentBranch,
  milestoneCriteria,
} from "../domain/delivery";
import type { DomainEvent, EventInput } from "../domain/events";
import type { AgentPort, PullRequestPort, Repository } from "./ports";
type Hooks = {
  repo: Repository;
  github?: PullRequestPort;
  agent?: AgentPort;
  id(): string;
  now(): string;
  run(state: CompanyState, input: Pick<Run, "trigger" | "workId">): Run;
  emit(
    input: EventInput,
    actor: DomainEvent["actor"],
    correlation: string,
    cause?: string,
  ): void;
};
export class DeliveryWorkflow {
  constructor(private h: Hooks) {}
  private milestone(state: CompanyState, work: Work) {
    return state.planning.milestones.find((m) => m.id === work.milestoneId);
  }
  async prepare(workId: string) {
    const state = this.h.repo.state(),
      work = state.work.find((w) => w.id === workId);
    if (
      !work ||
      work.mode !== "implementation" ||
      work.branch ||
      work.status !== "queued"
    )
      return;
    const m = this.milestone(state, work);
    if (
      !m?.delivery ||
      m.status !== "active" ||
      !work.dependsOn?.every(
        (id) => state.work.find((w) => w.id === id)?.status === "done",
      )
    )
      return;
    if (!state.settings.allowCodeChanges)
      throw new DomainError(
        "Enable engineering changes in Settings before starting implementation.",
      );
    const github = this.h.github;
    if (!github?.ensureBranch)
      throw new DomainError("Engineering connector unavailable.");
    await github.ensureBranch(m.delivery.repository, m.delivery.branch, "main");
    const branch = assignmentBranch(m.id, work.id);
    const head = await github.ensureBranch(
      m.delivery.repository,
      branch,
      m.delivery.branch,
    );
    this.h.repo.transaction(() => {
      const s = this.h.repo.state(),
        w = s.work.find((w) => w.id === workId)!;
      w.branch = branch;
      w.branchHead = head;
      this.h.repo.save(s);
    });
  }
  async implementationContext(work: Work, context: Context) {
    const m = this.milestone(this.h.repo.state(), work);
    if (!m?.delivery || !work.branch)
      throw new DomainError("Assignment checkout is unavailable.");
    if (this.h.agent?.engineer) {
      context.implementation = {
        repository: m.delivery.repository, branch: work.branch, head: work.branchHead!, files: [],
      };
      context.repository = context.implementation;
      return;
    }
    if (!this.h.github?.source) throw new DomainError("Assignment checkout is unavailable.");
    const source = await this.h.github.source(
      m.delivery.repository,
      work.branchHead!,
    );
    context.implementation = {
      repository: m.delivery.repository,
      branch: work.branch,
      ...source,
    };
    context.repository = context.implementation;
  }
  async publish(work: Work, run: Run, output: AgentResult) {
    const state = this.h.repo.state(),
      current = state.work.find((w) => w.id === work.id)!;
    const m = this.milestone(state, current),
      github = this.h.github;
    if (m?.status !== "active" || !state.settings.allowCodeChanges)
      throw new DomainError("Engineering authority is paused.");
    if (!m.delivery || !current.branch || !github?.open)
      throw new DomainError("Engineering publisher unavailable.");
    if (!output.engineering && !output.changes.length)
      throw new DomainError(
        "Implementation completion requires actual changes and a GitHub PR.",
      );
    const authorize = () => {
      const s = this.h.repo.state();
      return s.settings.allowCodeChanges &&
        s.planning.milestones.find((n) => n.id === m.id)?.status === "active" &&
        s.work.find((w) => w.id === work.id)?.status !== "cancelled";
    };
    let head: string;
    if (output.engineering) {
      const receipt = output.engineering;
      if (!this.h.agent?.pushEngineering || receipt.repository !== m.delivery.repository ||
          receipt.branch !== current.branch || receipt.base !== run.context!.implementation!.head)
        throw new DomainError("Engineering receipt does not match the delegated assignment.");
      head = await this.h.agent.pushEngineering(receipt, authorize);
      if (!github.branchHead || await github.branchHead(receipt.repository, receipt.branch) !== head)
        throw new DomainError("GitHub does not match the published engineering commit.");
    } else {
      // Compatibility for already-saved replacement-file outputs.
      if (!github.implement) throw new DomainError("Legacy engineering publisher unavailable.");
      head = await github.implement(
      m.delivery.repository,
      current.branch,
      run.context!.implementation!.head,
      run.executionId || run.id,
      output.changes,
      authorize,
    );
    }
    const pr = await github.open(
      m.delivery.repository,
      current.branch,
      m.delivery.branch,
      current.title,
      `${current.instruction}\n\nAcceptance criteria\n${current.criteria}\n\n${output.message}\n\nCompany OS assignment ${work.id}`,
    );
    if (pr.head !== head || pr.base !== m.delivery.branch)
      throw new DomainError(
        "Published PR does not match the assignment branch and target.",
      );
    this.h.repo.transaction(() => {
      const s = this.h.repo.state(),
        w = s.work.find((w) => w.id === work.id)!;
      w.pullRequest = pr;
      w.branchHead = head;
      this.h.repo.save(s);
    });
  }
  async integrate(milestoneId: string) {
    this.h.repo.transaction(() => {
      const state = this.h.repo.state(),
        m = state.planning.milestones.find((m) => m.id === milestoneId);
      if (!m?.delivery || !["active", "acceptance"].includes(m.status)) return;
      const work = state.work.filter((w) => w.milestoneId === m.id && !w.phase);
      if (!work.length || work.some((w) => w.status !== "done")) return;
      if (m.delivery.acceptanceWorkId) return;
      if (m.delivery.attempts >= m.delivery.policy.acceptanceAttempts)
        return this.stop(state, m, "Acceptance attempt allowance exhausted.");
      if (
        state.runs.filter(
          (r) =>
            r.trigger !== "discussion" &&
            r.workId &&
            m.workIds.includes(r.workId),
        )
          .length >= m.maxRuns
      )
        return this.stop(
          state,
          m,
          "Approved milestone run allowance exhausted before acceptance.",
        );
      const id = this.h.id();
      const acceptance: Work = {
        id,
        milestoneId: m.id,
        phase: "acceptance",
        roleId: "acceptance",
        mode: "analysis",
        track: "feature",
        title: `Accept ${m.title}`,
        instruction: m.objective,
        criteria: milestoneCriteria(
          m.criteria,
          m.delivery.policy.milestoneRequirements,
        ),
        status: "queued",
        result: "",
        key: `${m.id}:acceptance:${m.delivery.attempts + 1}`,
        origin: "foreman",
        evidence: [],
        attempts: 0,
        dependsOn: work.map((w) => w.id),
        createdAt: this.h.now(),
        updatedAt: this.h.now(),
      };
      state.work.push(acceptance);
      m.workIds.push(id);
      m.delivery.acceptanceWorkId = id;
      m.delivery.attempts++;
      m.status = "acceptance";
      m.version++;
      m.updatedAt = this.h.now();
      const run = this.h.run(state, { trigger: "acceptance", workId: id });
      this.h.emit(
        { type: "RunRequested", payload: { runId: run.id } },
        "system",
        m.id,
      );
      this.h.repo.save(state);
    });
  }
  async acceptanceContext(work: Work, run: Run, context: Context) {
    const m = this.milestone(this.h.repo.state(), work)!;
    const delivery = m.delivery!,
      github = this.h.github;
    const requirements = delivery.policy.milestoneRequirements;
    const criteria = milestoneCriteria(m.criteria, requirements);
    context.acceptance = { criteria, requirements, attempt: delivery.attempts };
    context.assignmentReview = {
      result:
        context.dependencies
          ?.map((w) => `${w.title}\n${w.result}`)
          .join("\n\n") || "",
      criteria,
      expectedOutputs: m.assignments.flatMap((a) => a.outputs),
      evidence: context.dependencies?.flatMap((w) => w.evidence) || [],
    };
    const code = this.h.repo
      .state()
      .work.some((w) => w.milestoneId === m.id && w.mode === "implementation");
    if (!code) return;
    if (!github?.open || !github.candidate || !github.verify)
      throw new DomainError("Acceptance executor unavailable.");
    const pr = await github.open(
      delivery.repository,
      delivery.branch,
      "main",
      m.title,
      `${m.objective}\n\n${criteria}\n\nCompany OS milestone ${m.id}`,
    );
    const saved = delivery.candidate;
    const candidate =
      saved?.pullRequest.head === pr.head && saved.pullRequest.base === pr.base
        ? saved
        : await github.candidate(pr);
    this.h.repo.transaction(() => {
      const s = this.h.repo.state();
      Object.assign(
        s.planning.milestones.find((n) => n.id === m.id)!.delivery!,
        { candidate, pullRequest: pr },
      );
      this.h.repo.save(s);
    });
    const verification = await github.verify(
      delivery.repository,
      candidate.head,
      run.id,
    );
    context.acceptance.verification = verification;
    if (this.h.agent?.reviewCheckout) context.checkout = {
      repository: delivery.repository, branch: delivery.branch, head: candidate.head, base: candidate.base,
    };
    else if (github.source)
      context.repository = await github.source(
        delivery.repository,
        candidate.head,
      );
    context.evidenceRefs.push(
      `github:${delivery.repository}@${candidate.head}`,
      `verification:${run.id}@${candidate.head}`,
    );
    this.h.repo.transaction(() => {
      const s = this.h.repo.state(),
        current = s.planning.milestones.find((n) => n.id === m.id)!;
      Object.assign(current.delivery!, {
        pullRequest: pr,
        candidate,
        verification,
      });
      this.h.repo.save(s);
    });
  }
  async finishAcceptance(runId: string, output: AgentResult) {
    let state = this.h.repo.state();
    const run = state.runs.find((r) => r.id === runId)!,
      work = state.work.find((w) => w.id === run.workId)!;
    const m = this.milestone(state, work)!;
    if (run.status === "completed") return;
    if (m.status !== "acceptance")
      throw new DomainError("Milestone acceptance is paused.");
    if (!output.review || output.outcome !== "completed")
      throw new DomainError("Acceptance requires an evidence-based verdict.");
    let checks = run.context!.acceptance!.verification;
    if (m.delivery!.candidate && this.h.github?.verify) {
      checks = await this.h.github.verify(
        m.delivery!.repository,
        m.delivery!.candidate.head,
        run.id,
      );
      this.h.repo.transaction(() => {
        const s = this.h.repo.state();
        s.runs.find((r) => r.id === run.id)!.context!.acceptance!.verification =
          checks;
        s.planning.milestones.find(
          (n) => n.id === m.id,
        )!.delivery!.verification = checks;
        this.h.repo.save(s);
      });
    }
    const passed =
      output.review.verdict === "approve" && (!checks || checks.passed);
    let mergedHead: string | undefined;
    state = this.h.repo.state();
    if (
      state.planning.milestones.find((n) => n.id === m.id)?.status !==
      "acceptance"
    )
      throw new DomainError("Milestone acceptance is paused.");
    if (passed && m.delivery!.candidate) {
      if (
        !state.settings.delivery.autoMerge ||
        !m.delivery!.policy.autoMerge ||
        !state.settings.allowCodeChanges
      )
        throw new DomainError(
          "Automatic integration authority is paused in Settings.",
        );
      if (checks?.head !== m.delivery!.candidate.head)
        throw new DomainError(
          "Acceptance evidence does not match integration candidate.",
        );
      if (!this.h.github?.merge)
        throw new DomainError("Merge connector unavailable.");
      try {
        mergedHead = await this.h.github.merge(m.delivery!.candidate);
      } catch (error) {
        if (error instanceof VerificationFailed)
          throw new ChecksPending(
            "CI results changed before merge; checking the current result.",
          );
        if (!(error instanceof IntegrationChanged)) throw error;
        this.h.repo.transaction(() => {
          const s = this.h.repo.state(),
            current = s.planning.milestones.find((n) => n.id === m.id)!;
          const r = s.runs.find((n) => n.id === runId)!,
            w = s.work.find((n) => n.id === work.id)!;
          r.status = "completed";
          r.result = output;
          r.finishedAt = this.h.now();
          w.status = "cancelled";
          w.result =
            "Acceptance passed, but main advanced; a fresh candidate must be tested.";
          current.delivery!.acceptanceWorkId = undefined;
          current.delivery!.candidate = undefined;
          current.status = "active";
          if (
            current.delivery!.attempts >=
            current.delivery!.policy.acceptanceAttempts
          )
            this.stop(
              s,
              current,
              "Main changed during acceptance and the attempt allowance is exhausted.",
            );
          this.h.emit(
            { type: "MilestoneChanged", payload: { milestoneId: current.id } },
            "system",
            current.id,
          );
          this.h.repo.save(s);
        });
        return;
      }
    }
    this.h.repo.transaction(() => {
      state = this.h.repo.state();
      const r = state.runs.find((r) => r.id === runId)!,
        w = state.work.find((w) => w.id === work.id)!,
        current = this.milestone(state, w)!;
      r.result = output;
      r.status = "completed";
      r.finishedAt = this.h.now();
      w.result = output.message;
      w.evidence = r.context!.evidenceRefs;
      w.status = passed ? "done" : "cancelled";
      if (passed) {
        current.status = "completed";
        current.delivery!.mergedHead = mergedHead;
        current.updatedAt = this.h.now();
        current.version++;
      } else if (
        current.delivery!.attempts >=
        current.delivery!.policy.acceptanceAttempts
      ) {
        this.stop(
          state,
          current,
          "Milestone acceptance did not converge within its approved allowance. Foreman must defer this outcome or propose a changed approach within new authority.",
        );
      } else {
        const id = this.h.id();
        const fix: Work = {
          id,
          milestoneId: current.id,
          roleId: "implementer",
          mode: current.delivery!.candidate ? "implementation" : "analysis",
          track: "feature",
          title: `Resolve acceptance findings: ${current.title}`,
          instruction: `${current.objective}\n\nResolve these acceptance failures without expanding scope:\n${output.review!.summary}\n${output.review!.findings.join("\n")}\n${JSON.stringify(checks || {})}`,
          criteria: milestoneCriteria(
            current.criteria,
            current.delivery!.policy.milestoneRequirements,
          ),
          dependsOn: state.work
            .filter((w) => w.milestoneId === current.id && !w.phase)
            .map((w) => w.id),
          status: "queued",
          result: "",
          key: `${current.id}:acceptance-fix:${current.delivery!.attempts}`,
          origin: "foreman",
          evidence: [],
          attempts: 0,
          createdAt: this.h.now(),
          updatedAt: this.h.now(),
        };
        state.work.push(fix);
        current.workIds.push(id);
        current.status = "active";
        current.delivery!.acceptanceWorkId = undefined;
        current.delivery!.candidate = undefined;
        this.h.emit(
          { type: "WorkQueued", payload: { workId: id } },
          "system",
          current.id,
          runId,
        );
      }
      this.h.emit(
        { type: "RunCompleted", payload: { runId, workId: w.id } },
        "system",
        current.id,
      );
      this.h.emit(
        { type: "MilestoneChanged", payload: { milestoneId: current.id } },
        "system",
        current.id,
      );
      this.h.repo.save(state);
    });
  }
  stop(state: CompanyState, m: Milestone, reason: string) {
    m.status = "paused";
    m.decisionReason = reason;
    m.version++;
    m.updatedAt = this.h.now();
    const thread = state.threads.find((t) => t.id === m.threadId)!;
    thread.status = "open";
    thread.unread = true;
    thread.reason = reason;
    thread.recommendation =
      "Foreman has stopped this attempt. Discuss whether to defer the outcome, change scope, or authorize a bounded follow-up. No manual PR review is needed.";
    this.h.repo.save(state);
  }
}
