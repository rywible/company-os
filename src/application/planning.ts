import { milestoneBranch } from "../domain/delivery";
import {
  milestonePlanSchema,
  validatePlan,
  triageAvailable,
  type Milestone,
  type MilestonePlan,
} from "../domain/planning";
import type {
  CompanyState,
  Command,
  Run,
  Work,
  Thread,
  Context,
} from "../domain/model";
import { taskBlocker, taskDueAt } from "../domain/automation";
import { automationPermissions } from "../domain/permissions";
import { DomainError } from "../domain/model";
import type { Repository } from "./ports";
import type { DomainEvent, EventInput } from "../domain/events";
type Hooks = {
  repo: Repository;
  now(): string;
  id(): string;
  emit(
    input: EventInput,
    actor: DomainEvent["actor"],
    correlation: string,
    cause?: string | null,
  ): void;
  run(
    state: CompanyState,
    input: Pick<Run, "trigger" | "threadId" | "workId">,
  ): Run;
  inbox(
    state: CompanyState,
    input: {
      subject: string;
      reason: string;
      recommendation: string;
      evidence: string[];
      workId?: string;
    },
    cause: string,
  ): Thread;
};
export class Planning {
  constructor(private h: Hooks) {}
  private validate(state: CompanyState, plan: MilestonePlan) {
    try {
      validatePlan(plan, state.settings.roles);
    } catch (error) {
      throw new DomainError(
        error instanceof Error
          ? error.message
          : "Invalid milestone dependencies.",
      );
    }
  }
  propose(
    state: CompanyState,
    raw: MilestonePlan,
    cause: string,
    actor: DomainEvent["actor"] = "foreman",
  ) {
    const plan = milestonePlanSchema.parse(raw);
    this.validate(state, plan);
    if (plan.documentIds.some((id) => !this.h.repo.document(id)))
      throw new DomainError("A linked knowledge document is unavailable.");
    if (
      state.planning.milestones.some(
        (m) =>
          m.status !== "declined" &&
          m.title.toLowerCase() === plan.title.toLowerCase(),
      )
    )
      throw new DomainError(
        "This milestone already exists. Revise its proposal instead.",
      );
    const id = this.h.id();
    const thread = this.h.inbox(
      state,
      {
        subject: `Milestone: ${plan.title}`,
        reason: plan.objective,
        recommendation: plan.boundaries,
        evidence: [],
      },
      cause,
    );
    thread.milestoneId = id;
    const milestone: Milestone = {
      ...plan,
      id,
      version: 1,
      status: "proposed",
      workIds: [],
      threadId: thread.id,
      createdAt: this.h.now(),
      updatedAt: this.h.now(),
      decisionReason: "",
    };
    state.planning.milestones.push(milestone);
    this.h.emit(
      { type: "MilestoneChanged", payload: { milestoneId: id } },
      actor,
      id,
      cause,
    );
    return milestone;
  }
  configure(state: CompanyState, cmd: Command): boolean {
    if (cmd.type === "SaveRole") {
      const existing = state.settings.roles.find((r) => r.id === cmd.role.id);
      if (
        cmd.role.id === "reviewer" &&
        !cmd.role.enabled &&
        state.planning.milestones.some((m) => m.status === "active")
      )
        throw new DomainError(
          "Keep Reviewer enabled while milestones are active.",
        );
      if (existing) Object.assign(existing, cmd.role);
      else state.settings.roles.push(cmd.role);
      this.h.emit(
        { type: "RoleConfigured", payload: { roleId: cmd.role.id } },
        "human",
        cmd.role.id,
      );
    } else if (cmd.type === "ConfigureAvailability") {
      state.settings.availability = cmd.availability;
      this.h.emit(
        { type: "AvailabilityConfigured", payload: {} },
        "human",
        "availability",
      );
    } else if (cmd.type === "ConfigurePlanning") {
      // Compatibility for saved clients; the automation owns scheduling now.
      const task = state.discovery.lenses.find((t) => t.kind === "planning");
      if (!task)
        throw new DomainError("The milestone automation has been deleted.");
      Object.assign(task, cmd.settings);
      Object.assign(state.planning, cmd.settings);
      this.h.emit(
        { type: "PlanningConfigured", payload: {} },
        "human",
        "planning",
      );
    } else return false;
    return true;
  }
  revise(
    state: CompanyState,
    id: string,
    version: number,
    plan: MilestonePlan,
    actor: DomainEvent["actor"] = "human",
    cause?: string,
  ) {
    const m = this.current(state, id, version);
    if (m.status !== "proposed")
      throw new DomainError(
        "Only proposed milestones can be revised. Pause active work and propose a follow-up milestone for changed boundaries.",
      );
    this.validate(state, plan);
    if (plan.documentIds.some((id) => !this.h.repo.document(id)))
      throw new DomainError("A linked knowledge document is unavailable.");
    Object.assign(m, plan, { version: m.version + 1, updatedAt: this.h.now() });
    const t = state.threads.find((t) => t.id === m.threadId)!;
    t.subject = `Milestone: ${m.title}`;
    t.reason = m.objective;
    t.recommendation = m.boundaries;
    t.status = "open";
    t.unread = true;
    this.h.emit(
      { type: "MilestoneChanged", payload: { milestoneId: id } },
      actor,
      id,
      cause,
    );
  }
  private current(state: CompanyState, id: string, version: number) {
    const m = state.planning.milestones.find((m) => m.id === id);
    if (!m) throw new DomainError("Milestone not found.");
    if (m.version !== version)
      throw new DomainError("This milestone changed. Reload before deciding.");
    return m;
  }
  decide(
    state: CompanyState,
    cmd: Extract<Command, { type: "DecideMilestone" }>,
  ) {
    const m = this.current(state, cmd.milestoneId, cmd.expectedVersion);
    const thread = state.threads.find((t) => t.id === m.threadId)!;
    if (cmd.action === "approve") {
      if (m.status !== "proposed")
        throw new DomainError("Only a proposal can be approved.");
      this.validate(state, m);
      m.delivery = {
        repository: process.env.GITHUB_REPOSITORY || "rywible/company-os",
        branch: milestoneBranch(m.id),
        policy: structuredClone(state.settings.delivery),
        requiredReviews: state.settings.requiredReviews,
        attempts: 0,
      };
      const ids = new Map(m.assignments.map((a) => [a.key, this.h.id()]));
      for (const a of m.assignments) {
        const work: Work = {
          id: ids.get(a.key)!,
          milestoneId: m.id,
          assignmentKey: a.key,
          roleId: a.roleId,
          dependsOn: a.dependsOn.map((key) => ids.get(key)!),
          expectedOutputs: a.outputs,
          outputDocumentIds: [],
          reviews: [],
          track: "feature",
          mode: a.mode,
          title: a.title,
          instruction: a.instruction,
          criteria: a.criteria,
          key: `${m.id}:${a.key}`,
          origin: "foreman",
          status: "queued",
          result: "",
          evidence: [],
          attempts: 0,
          createdAt: this.h.now(),
          updatedAt: this.h.now(),
        };
        state.work.push(work);
        m.workIds.push(work.id);
      }
      m.status = "active";
      thread.status = "resolved";
    } else if (
      cmd.action === "pause" &&
      ["active", "acceptance"].includes(m.status)
    )
      m.status = "paused";
    else if (cmd.action === "resume" && m.status === "paused") {
      this.validate(state, m);
      const allocated = state.runs.filter(
        (r) => r.workId && m.workIds.includes(r.workId),
      );
      if (
        allocated.length >= m.maxRuns &&
        !allocated.some((r) => ["queued", "running"].includes(r.status))
      )
        throw new DomainError(
          "The approved allowance is exhausted. Propose a follow-up milestone.",
        );
      m.status = m.delivery?.acceptanceWorkId ? "acceptance" : "active";
      thread.status = "resolved";
    } else if (cmd.action === "defer" && m.status === "proposed")
      thread.status = "waiting";
    else if (cmd.action === "decline" && m.status === "proposed") {
      m.status = "declined";
      thread.status = "resolved";
    } else
      throw new DomainError("That action is not available for this milestone.");
    m.decisionReason = cmd.reason;
    m.version++;
    m.updatedAt = this.h.now();
    thread.unread = false;
    thread.messages.push({
      id: this.h.id(),
      role: "human",
      content: `${cmd.action}: ${cmd.reason}`,
      at: this.h.now(),
    });
    this.h.emit(
      { type: "MilestoneChanged", payload: { milestoneId: m.id } },
      "human",
      m.id,
    );
  }
  ready(state: CompanyState, work: Work) {
    if (!work.milestoneId) return true;
    const m = state.planning.milestones.find((m) => m.id === work.milestoneId);
    return (
      (m?.status === "active" ||
        (m?.status === "acceptance" && work.phase === "acceptance")) &&
      (work.dependsOn || []).every(
        (id) => state.work.find((w) => w.id === id)?.status === "done",
      )
    );
  }
  canQueue(state: CompanyState, work: Work) {
    const m = state.planning.milestones.find((m) => m.id === work.milestoneId);
    if (!m) return true;
    const runs = state.runs.filter(
      (r) => r.workId && m.workIds.includes(r.workId),
    );
    return (
      runs.length < m.maxRuns &&
      runs.filter((r) => ["queued", "running"].includes(r.status)).length <
        m.maxParallel
    );
  }
  reconcile(state: CompanyState) {
    for (const m of state.planning.milestones.filter(
      (m) => m.status === "active",
    )) {
      const work = state.work.filter((w) => w.milestoneId === m.id && !w.phase);
      if (work.length && work.every((w) => w.status === "done")) {
        if (m.delivery) {
          this.h.emit(
            { type: "IntegrationRequested", payload: { milestoneId: m.id } },
            "system",
            m.id,
          );
          continue;
        }
        m.status = "completed";
        m.updatedAt = this.h.now();
        m.version++;

        const thread = this.h.inbox(
          state,
          {
            subject: `Completed: ${m.title}`,
            reason: m.objective,
            recommendation:
              "Every assignment passed review. Review the milestone result in Work.",
            evidence: work.flatMap((w) => w.evidence).slice(0, 20),
          },
          m.id,
        );
        thread.milestoneId = m.id;
        continue;
      }
      const runs = state.runs.filter(
        (r) => r.workId && m.workIds.includes(r.workId),
      );
      if (
        runs.length >= m.maxRuns &&
        !runs.some((r) => ["queued", "running"].includes(r.status))
      ) {
        m.status = "paused";
        m.version++;
        m.updatedAt = this.h.now();
        const t = this.h.inbox(
          state,
          {
            subject: `Run allowance reached: ${m.title}`,
            reason: "This milestone used its approved run allowance.",
            recommendation:
              "Review the results and propose a bounded follow-up before spending more runs.",
            evidence: [],
          },
          m.id,
        );
        t.milestoneId = m.id;
        continue;
      }
      for (const w of work.filter(
        (w) => w.status === "review" && !w.pullRequest,
      )) {
        if (
          w.pullRequest &&
          !state.reviewRounds.some(
            (r) =>
              r.workId === w.id &&
              r.pullRequest.head === w.pullRequest!.head &&
              r.status === "approved",
          )
        )
          continue;
        if (!state.settings.roles.some((r) => r.id === "reviewer" && r.enabled))
          continue;
        const latest = state.runs
          .filter(
            (r) =>
              r.workId === w.id &&
              ["work", "message", "revision"].includes(r.trigger),
          )
          .at(-1);
        if (
          latest?.status !== "completed" ||
          latest.result?.outcome !== "completed" ||
          !this.canQueue(state, w)
        )
          continue;
        if (
          state.runs
            .slice(state.runs.indexOf(latest) + 1)
            .some((r) => r.workId === w.id && r.trigger === "assessment")
        )
          continue;
        const review = this.h.run(state, {
          trigger: "assessment",
          workId: w.id,
        });
        this.h.emit(
          { type: "RunRequested", payload: { runId: review.id } },
          "system",
          w.id,
          latest.id,
        );
      }
      const downstream = (id: string, seen = new Set<string>()): number => {
        for (const child of work.filter((w) => w.dependsOn?.includes(id)))
          if (!seen.has(child.id)) {
            seen.add(child.id);
            downstream(child.id, seen);
          }
        return seen.size;
      };
      const ready = work
        .filter((w) => w.status === "queued" && this.ready(state, w))
        .sort((a, b) => downstream(b.id) - downstream(a.id));
      for (const w of ready)
        if (
          !runs.some(
            (r) =>
              r.workId === w.id && ["queued", "running"].includes(r.status),
          )
        )
          this.h.emit(
            { type: "WorkQueued", payload: { workId: w.id } },
            "system",
            w.id,
            m.id,
          );
    }
  }
  request(
    state: CompanyState,
    manual = false,
    taskId?: string,
  ): { runId?: string; skipped?: string } {
    const task = state.discovery.lenses.find((t) =>
      taskId ? t.id === taskId : t.kind === "planning",
    );
    if (!task)
      return { skipped: "Schedule an automation to propose milestones." };
    const hasConstitution = this.h.repo
      .documents()
      .some((d) => d.level === "constitution" && d.content.trim());
    const blocker = taskBlocker(
      state,
      task,
      this.h.now(),
      hasConstitution,
      true,
      this.h.repo.documents(),
    );
    if (blocker) return { skipped: blocker };
    if (!manual && !task.enabled)
      return { skipped: "This automation is paused." };
    const due = taskDueAt(state, task);
    if (!manual && due && due > this.h.now())
      return { skipped: "This automation is not due yet." };
    const run = this.h.run(state, { trigger: "planning" });
    run.discoveryLensId = task.id;
    run.automationPermissions = automationPermissions(task);
    run.agent = structuredClone(task.agent);
    run.manual = manual;
    task.lastRunAt = this.h.now();
    task.lastRunId = run.id;
    state.planning.lastRunAt = task.lastRunAt;
    state.planning.lastRunId = run.id;
    this.h.emit(
      { type: "RunRequested", payload: { runId: run.id } },
      manual ? "human" : "system",
      run.id,
    );
    return { runId: run.id };
  }

  context(state: CompanyState, run: Run, context: Context) {
    const work = state.work.find((w) => w.id === run.workId);
    if (run.role) context.role = structuredClone(run.role);
    if (!context.discovery && !context.maintenance && !run.reviewRoundId)
      context.coordination = {
        roles: state.settings.roles
          .filter((r) => r.enabled)
          .map(({ id, name, purpose }) => ({ id, name, purpose })),
        milestones: [...state.planning.milestones]
          .sort(
            (a, b) =>
              Number(["completed", "declined"].includes(a.status)) -
              Number(["completed", "declined"].includes(b.status)),
          )
          .slice(0, 20)
          .map(({ id, version, title, objective, status }) => ({
            id,
            version,
            title,
            objective: objective.slice(0, 1000),
            status,
          })),
        availability: state.settings.availability,
        availableNow: triageAvailable(
          state.settings.availability,
          this.h.now(),
        ),
        planning: run.trigger === "planning",
      };
    const threadMilestoneId = state.threads.find(
      (t) => t.id === run.threadId,
    )?.milestoneId;
    if (threadMilestoneId)
      context.milestone = state.planning.milestones.find(
        (m) => m.id === threadMilestoneId,
      );
    if (work?.milestoneId) {
      context.milestone = state.planning.milestones.find(
        (m) => m.id === work.milestoneId,
      );
      context.dependencies = (work.dependsOn || [])
        .map((id) => state.work.find((w) => w.id === id)!)
        .filter(Boolean)
        .map((w) => ({
          id: w.id,
          title: w.title,
          result: w.result,
          evidence: w.evidence,
          documentIds: w.outputDocumentIds || [],
        }));
      context.evidenceRefs.push(
        `assignment:${work.id}`,
        ...(context.dependencies || []).map((w) => `work:${w.id}`),
      );
      if (run.trigger === "assessment")
        context.assignmentReview = {
          result: work.result,
          criteria: work.criteria,
          expectedOutputs: work.expectedOutputs || [],
          evidence: work.evidence,
        };
    }
  }
}
