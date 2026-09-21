import { z } from "zod";
import { agentConfigurationSchema, defaultAgentConfiguration } from "./agents";
import { cronFromHours } from "./cron";
const text = z.string().trim().min(1);
export const roleSchema = z.object({
  id: text.regex(/^[a-z][a-z0-9-]*$/).max(60),
  name: text.max(80),
  purpose: text.max(2000),
  enabled: z.boolean(),
  agent: agentConfigurationSchema,
});
export type AgentRole = z.infer<typeof roleSchema>;
export const availabilitySchema = z
  .object({
    timeZone: text.refine((zone) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    }, "Choose a valid time zone."),
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  })
  .refine(
    (value) => value.start < value.end,
    "End time must be after start time.",
  );
export type Availability = z.infer<typeof availabilitySchema>;
export const assignmentSchema = z.object({
  key: text.regex(/^[a-z][a-z0-9-]*$/).max(60),
  title: text.max(160),
  roleId: text.max(60),
  mode: z.enum(["analysis", "ui-inspection", "implementation"]),
  instruction: text.max(24000),
  criteria: text.max(8000),
  outputs: z.array(text.max(400)).min(1).max(12),
  dependsOn: z.array(text.max(60)).max(30),
});
export const milestonePlanSchema = z.object({
  title: text.max(160),
  objective: text.max(8000),
  criteria: text.max(8000),
  boundaries: text.max(8000),
  maxRuns: z.number().int().min(2).max(200),
  maxParallel: z.number().int().min(1).max(8),
  documentIds: z.array(text).max(20),
  assignments: z.array(assignmentSchema).min(1).max(30),
});
export type MilestonePlan = z.infer<typeof milestonePlanSchema>;
export type Milestone = MilestonePlan & {
  delivery?: {
    repository: string;
    branch: string;
    policy: import("./delivery").DeliveryPolicy;
    requiredReviews: number;
    acceptanceWorkId?: string;
    attempts: number;
    candidate?: import("./delivery").IntegrationCandidate;
    verification?: import("./delivery").Verification;
    pullRequest?: import("./model").PullRequest;
    mergedHead?: string;
  };
  id: string;
  version: number;
  status:
    | "proposed"
    | "active"
    | "acceptance"
    | "paused"
    | "completed"
    | "declined";
  workIds: string[];
  threadId: string;
  createdAt: string;
  updatedAt: string;
  decisionReason: string;
};
export const planningSettingsSchema = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(168),
  dailyRunLimit: z.number().int().min(1).max(24),
  targetMilestones: z.number().int().min(1).max(5),
});
export type PlanningState = z.infer<typeof planningSettingsSchema> & {
  automationVersion?: 1;
  milestones: Milestone[];
  lastRunAt?: string;
  lastRunId?: string;
};
export const initialPlanning = (): PlanningState => ({
  enabled: true,
  intervalHours: 4,
  dailyRunLimit: 4,
  targetMilestones: 2,
  milestones: [],
});
export const initialRoles = (): AgentRole[] =>
  [
    [
      "architect",
      "Architect",
      "Establish contracts, interfaces, system boundaries, and resolve technical uncertainty before dependent streams begin.",
    ],
    [
      "implementer",
      "Implementer",
      "Own complete implementation verticals and their tests. Distinguish delivered implementation from designs; report when execution tools are unavailable.",
    ],
    [
      "reviewer",
      "Reviewer",
      "Independently evaluate the full assignment, acceptance criteria, results, and evidence. Reject unsupported completion claims.",
    ],
    [
      "adjudicator",
      "Adjudicator",
      "Resolve review disputes using concrete evidence. Dismiss preference-only blockers, verify fixes, or prescribe one final correction within the approved scope.",
    ],
    [
      "acceptance",
      "Acceptance tester",
      "Evaluate integrated milestone behavior against project acceptance criteria and recorded test or playtest evidence. Reject unsupported success claims.",
    ],
    [
      "investigator",
      "Investigator",
      "Research, diagnose problems, inspect the interface, and run bounded investigations that resolve missing information.",
    ],
  ].map(([id, name, purpose]) => ({
    id: id!,
    name: name!,
    purpose: purpose!,
    enabled: true,
    agent: {
      ...defaultAgentConfiguration(),
      reasoningEffort: id === "adjudicator" ? "xhigh" : "high",
    },
  }));
export const initialAvailability = (): Availability => ({
  timeZone: "America/Denver",
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "17:00",
});
export function triageAvailable(
  availability: Availability,
  now: string,
): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: availability.timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const part = (type: string) =>
    parts.find((p) => p.type === type)?.value || "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    part("weekday"),
  );
  const time = `${part("hour")}:${part("minute")}`;
  return (
    availability.days.includes(day) &&
    time >= availability.start &&
    time < availability.end
  );
}
export function minimumPlanRuns(plan: MilestonePlan, requiredReviews = 2): number {
  return plan.assignments.reduce((sum, assignment) =>
    sum + 1 + (assignment.mode === "implementation" ? requiredReviews : 1), 0) + 1;
}
export function validatePlan(plan: MilestonePlan, roles: AgentRole[], requiredReviews = 2): void {
  const byKey = new Map(plan.assignments.map((a) => [a.key, a]));
  if (byKey.size !== plan.assignments.length)
    throw Error("Assignment keys must be unique.");
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (key: string) => {
    if (visited.has(key)) return;
    if (visiting.has(key))
      throw Error("Milestone dependencies must not contain a cycle.");
    const node = byKey.get(key);
    if (!node)
      throw Error(
        "Every dependency must name an assignment in this milestone.",
      );
    if (!roles.some((r) => r.id === node.roleId && r.enabled))
      throw Error("Every assignment needs an enabled role.");
    if (new Set(node.dependsOn).size !== node.dependsOn.length)
      throw Error("Dependencies must be unique.");
    visiting.add(key);
    node.dependsOn.forEach(visit);
    visiting.delete(key);
    visited.add(key);
  };
  plan.assignments.forEach((a) => visit(a.key));
  if (!roles.some((r) => r.id === "reviewer" && r.enabled))
    throw Error("Enable the Reviewer role before planning work.");
  if (!roles.some((r) => r.id === "acceptance" && r.enabled))
    throw Error("Enable the Acceptance tester role before planning work.");
  const minimum = minimumPlanRuns(plan, requiredReviews);
  if (plan.maxRuns < minimum)
    throw Error(`Allow at least ${minimum} runs for implementation, required reviews, and milestone acceptance. Corrections need additional runs.`);
}
export const planningCommands = [
  z.object({ type: z.literal("SaveRole"), role: roleSchema }),
  z.object({
    type: z.literal("ConfigureAvailability"),
    availability: availabilitySchema,
  }),
  z.object({
    type: z.literal("ConfigurePlanning"),
    settings: planningSettingsSchema,
  }),
  z.object({ type: z.literal("RequestPlanning") }),
  z.object({ type: z.literal("ProposeMilestone"), plan: milestonePlanSchema }),
  z.object({
    type: z.literal("ReviseMilestone"),
    milestoneId: text,
    expectedVersion: z.number().int().positive(),
    plan: milestonePlanSchema,
  }),
  z.object({
    type: z.literal("DecideMilestone"),
    milestoneId: text,
    expectedVersion: z.number().int().positive(),
    action: z.enum(["approve", "defer", "decline", "pause", "resume"]),
    reason: text.max(4000),
  }),
] as const;

export function planningAutomation(
  state: PlanningState,
): import("./discovery").Lens {
  return {
    id: "milestone-planning",
    kind: "planning",
    name: "Plan upcoming milestones",
    question:
      "Review company direction, existing work and evidence. Propose useful next milestones with clear outcomes, acceptance criteria and bounded authority. Decompose the work internally, establish interfaces first and parallelize independent streams. Do not duplicate existing milestones or manufacture busywork.",
    enabled: state.enabled,
    intervalHours: state.intervalHours,
    schedule: cronFromHours(state.intervalHours),
    dailyRunLimit: state.dailyRunLimit,
    targetMilestones: state.targetMilestones,
    maxActiveIdeas: 6,
    maxInvestigations: 2,
    maxOpenWork: 4,
    inspectUI: false,
    agent: defaultAgentConfiguration(),
    sources: [],
    permissions: ["milestones"],
    lastRunAt: state.lastRunAt,
    lastRunId: state.lastRunId,
  };
}
