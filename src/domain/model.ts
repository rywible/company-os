import {
  deliveryPolicySchema,
  initialDeliveryPolicy,
  reviewFindingSchema,
} from "./delivery";
import { DomainError } from "./errors";
import {
  planningCommands,
  milestonePlanSchema,
  initialPlanning,
  initialRoles,
  initialAvailability,
  type PlanningState,
  type AgentRole,
  type Availability,
  type Milestone,
} from "./planning";
import {
  libraryLocationSchema,
  libraryUpdateSchema,
  initialLibrary,
  type LibraryState,
  type LibraryProposal,
} from "./library";
import { z } from "zod";
import {
  discoveryCommands,
  initialDiscovery,
  candidateSchema,
  assessmentSchema,
  outcomeSchema,
  type DiscoveryState,
  type Lens,
  type Signal,
  type Idea,
} from "./discovery";
import type { Document } from "../contracts";
import {
  agentConfigurationSchema,
  defaultAgentConfiguration,
  type AgentConfiguration,
} from "./agents";
export const track = z.enum(["research", "bug", "feature"]);
export const policySchema = z.object({
  inclusion: z.enum(["always", "relevant", "reference"]),
  status: z.enum(["active", "draft", "retired"]),
});
export type Policy = z.infer<typeof policySchema>;
export const defaultPolicy = (d: Document): Policy => ({
  inclusion: d.level === "constitution" ? "always" : "relevant",
  status: "active",
});
export type Note = {
  id: string;
  role: "human" | "foreman" | "system";
  content: string;
  at: string;
  runId?: string;
};
export type RevisionProposal = {
  id: string;
  documentId: string;
  version: number;
  content: string;
  reason: string;
  evidence: string[];
  status: "pending" | "accepted" | "dismissed";
};
export type Thread = {
  milestoneId?: string;
  summary?: { content: string; runId: string; updatedAt: string };
  id: string;
  kind: "conversation" | "inbox";
  subject: string;
  status: "open" | "waiting" | "resolved";
  unread: boolean;
  reason: string;
  recommendation: string;
  evidence: string[];
  workId?: string;
  discoveryId?: string;
  attachment?: { id: string; version: number };
  messages: Note[];
  proposals: RevisionProposal[];
  libraryProposals?: LibraryProposal[];
  createdAt: string;
  updatedAt: string;
};
export type Work = {
  phase?: "acceptance";
  branch?: string;
  branchHead?: string;
  mergedHead?: string;
  mergeCandidate?: import("./delivery").IntegrationCandidate;
  integrationAttempts?: number;
  reviewProgress?: import("./delivery").ReviewProgress;
  milestoneId?: string;
  assignmentKey?: string;
  roleId?: string;
  dependsOn?: string[];
  expectedOutputs?: string[];
  outputDocumentIds?: string[];
  reviews?: {
    runId: string;
    verdict: "approve" | "changes_requested";
    summary: string;
    findings: string[];
    at: string;
  }[];
  discoveryId?: string;
  discoveryPhase?: "investigation" | "delivery" | "outcome";
  id: string;
  track: z.infer<typeof track>;
  mode: "analysis" | "ui-inspection" | "implementation";
  title: string;
  instruction: string;
  criteria: string;
  status: "queued" | "running" | "blocked" | "review" | "done" | "cancelled";
  result: string;
  key: string;
  threadId?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  origin: "human" | "foreman";
  evidence: string[];
  pullRequest?: PullRequest;
};
export type ContextEntry = {
  id: string;
  title: string;
  version: number;
  included: boolean;
  reason: string;
  characters: number;
  policy: Policy;
  indexedVersion: number | null;
};
export type Context = {
  checkout?: { repository: string; branch: string; head: string; base?: string; worker?: string };
  automation?: {
    milestoneSlots?: number;
    id: string;
    name: string;
    instruction: string;
    allowedChanges: import("./permissions").AutomationPermission[];
  };
  role?: Pick<AgentRole, "id" | "name" | "purpose">;
  milestoneRequirements?: string;
  coordination?: {
    roles: Pick<AgentRole, "id" | "name" | "purpose">[];
    milestones: Pick<
      Milestone,
      "id" | "version" | "title" | "objective" | "status"
    >[];
    availability: Availability;
    availableNow: boolean;
    planning: boolean;
    milestoneRequirements: string;
  };
  milestone?: Milestone;
  dependencies?: {
    id: string;
    title: string;
    result: string;
    evidence: string[];
    documentIds: string[];
  }[];
  executionFeedback?: { error: string; proposal: AgentResult };
  implementation?: {
    repository: string;
    branch: string;
    head: string;
    files: unknown[];
    worker?: string;
  };
  acceptance?: {
    criteria: string;
    requirements: string;
    verification?: import("./delivery").Verification;
    attempt: number;
  };
  adjudication?: {
    finalVerification: boolean;
    history: ReviewRound[];
    findings: import("./delivery").ReviewProgress["findings"];
  };
  assignmentReview?: {
    result: string;
    criteria: string;
    expectedOutputs: string[];
    evidence: string[];
  };
  subject?: string;
  conversationSummary?: string;
  assignment?: string;
  gaps?: string[];
  additionalRequests?: { subject: string; reason: string }[];
  libraryPages?: Record<string, import("./library").LibraryPage>;
  freshness?: Record<string, import("./freshness").Freshness>;
  maintenance?: {
    reviewTargets?: {
      documentId: string;
      signature: string;
      reasons: string[];
    }[];
    sourcePolicies: Record<string, Policy>;
    sources: Document[];
    catalog: {
      id: string;
      title: string;
      version: number;
      collection: string;
      parentId: string | null;
    }[];
  };
  externalSources?: import("./discovery").ResearchSource[];
  discovery?: {
    lens: Lens;
    signals: Signal[];
    previousIdeas: Pick<
      Idea,
      "id" | "title" | "hypothesis" | "status" | "decisionReason"
    >[];
    idea?: Idea;
    phase: "scout" | "investigation" | "delivery" | "outcome";
  };
  query: string;
  scope: string;
  assembledAt: string;
  documents: Document[];
  entries: ContextEntry[];
  evidenceRefs: string[];
  messages: Note[];
  work?: Work;
  repository?: unknown;
  repositoryError?: string;
  searchMode: string;
  browser?: BrowserEvidence;
  constitutionRef: string | null;
  review?: {
    priorFindings?: import("./delivery").ReviewProgress["findings"];
    roundId: string;
    reviewId?: string;
    pullRequest: PullRequest;
    files: unknown[];
    instructions: string;
    findings?: string[];
    approved?: boolean;
    workerRunId?: string;
    previousResult?: AgentResult;
  };
  portfolio?: {
    work: Work[];
    pendingThreads: { id: string; subject: string; reason: string }[];
  };
};
export type BrowserEvidence = {
  worker?: string;
  at: string;
  url: string;
  viewport: { width: number; height: number };
  steps: {
    action: string;
    url: string;
    title: string;
    text: string;
    overflow: boolean;
    screenshot: string;
    navigation?: { visibleText: string; accessibleName: string | null }[];
  }[];
  errors: string[];
};
export type Run = {
  startedAt?: string;
  hasContext?: boolean;
  contextSourceCount?: number;
  executionId?: string;
  pendingOutput?: AgentResult;
  automationPermissions?: import("./permissions").AutomationPermission[];
  role?: { id: string; name: string; purpose: string };
  manual?: boolean;
  agent?: AgentConfiguration;
  budgetDay?: string;
  discoveryLensId?: string;
  discoverySignalIds?: string[];
  id: string;
  automatic: boolean;
  trigger:
    | "message"
    | "heartbeat"
    | "work"
    | "review"
    | "revision"
    | "maintenance"
    | "automation"
    | "planning"
    | "assessment"
    | "adjudication"
    | "acceptance";
  status: "queued" | "running" | "completed" | "failed";
  threadId?: string;
  workId?: string;
  reviewRoundId?: string;
  reviewId?: string;
  context: Context | null;
  contextHistory?: Context[];
  result?: AgentResult;
  error: string | null;
  createdAt: string;
  finishedAt?: string;
};
export type Settings = {
  delivery: import("./delivery").DeliveryPolicy;
  enabled: boolean;
  intervalMinutes: number;
  dailyBudget: number;
  nextHeartbeatAt: string;
  maxOpenWork: number;
  requiredReviews: number;
  allowCodeChanges: boolean;
  foremanAgent: AgentConfiguration;
  roles: AgentRole[];
  availability: Availability;
};
export type CompanyState = {
  planning: PlanningState;
  library: LibraryState;
  version: 1;
  discovery: DiscoveryState;
  reviewRounds: ReviewRound[];
  threads: Thread[];
  work: Work[];
  runs: Run[];
  policies: Record<string, Policy>;
  settings: Settings;
};
export function initialState(now: string): CompanyState {
  return {
    version: 1,
    planning: initialPlanning(),
    library: initialLibrary(),
    discovery: initialDiscovery(),
    reviewRounds: [],
    threads: [],
    work: [],
    runs: [],
    policies: {},
    settings: {
      delivery: initialDeliveryPolicy(),
      enabled: true,
      intervalMinutes: 60,
      dailyBudget: 6,
      maxOpenWork: 4,
      requiredReviews: 2,
      allowCodeChanges: false,
      foremanAgent: defaultAgentConfiguration(),
      roles: initialRoles(),
      availability: initialAvailability(),
      nextHeartbeatAt: new Date(Date.parse(now) + 3600000).toISOString(),
    },
  };
}
const text = z.string().trim().min(1);
export const commandSchema = z.discriminatedUnion("type", [
  ...discoveryCommands,
  ...planningCommands,
  z.object({
    type: z.literal("ConfigureDelivery"),
    policy: deliveryPolicySchema,
    requiredReviews: z.number().int().min(1).max(5).optional(),
    allowCodeChanges: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("SetEvidenceStatus"),
    documentId: text,
    expectedVersion: z.number().int().positive(),
    status: z.enum(["active", "retired"]),
  }),
  z.object({
    type: z.literal("DeleteEvidence"),
    documentId: text,
    expectedVersion: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("DeleteKnowledge"),
    documentId: text,
    expectedVersion: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("WithdrawEvidenceReference"),
    reference: text.max(500),
    reason: text.max(1000),
    withdrawn: z.boolean(),
  }),
  z.object({
    type: z.literal("ReviewKnowledge"),
    documentId: text,
    expectedVersion: z.number().int().positive(),
    action: z.enum(["confirm", "withdraw"]),
    sources: z.array(text).max(30),
    reviewAfter: z.string().datetime().nullable(),
  }),
  z.object({
    type: z.literal("ScheduleKnowledgeReview"),
    documentId: text,
    expectedVersion: z.number().int().positive(),
    reviewAfter: z.string().datetime().nullable(),
  }),
  z.object({
    type: z.literal("OrganizeKnowledge"),
    documentId: text,
    location: libraryLocationSchema,
  }),
  z.object({
    type: z.literal("ResolveLibraryProposal"),
    threadId: text,
    proposalId: text,
    action: z.enum(["accept", "dismiss"]),
  }),
  z.object({
    type: z.literal("StartConversation"),
    subject: text.max(160),
    content: text.max(12000),
    attachment: z
      .object({ id: text, version: z.number().int().positive() })
      .optional(),
  }),
  z.object({
    type: z.literal("Reply"),
    threadId: text,
    content: text.max(12000),
  }),
  z.object({
    type: z.literal("ThreadStatus"),
    threadId: text,
    status: z.enum(["open", "waiting", "resolved"]),
  }),
  z.object({ type: z.literal("ReadThread"), threadId: text }),
  z.object({
    type: z.literal("CreateWork"),
    track,
    mode: z.enum(["analysis", "ui-inspection"]),
    title: text.max(160),
    instruction: text.max(12000),
    criteria: text.max(4000),
  }),
  z.object({
    type: z.literal("WorkStatus"),
    workId: text,
    status: z.enum(["queued", "done", "cancelled"]),
  }),
  z.object({
    type: z.literal("SaveKnowledge"),
    library: libraryLocationSchema.optional(),
    id: text.optional(),
    title: text.max(160),
    level: z.enum([
      "constitution",
      "product",
      "architecture",
      "execution",
      "knowledge",
    ]),
    content: text.max(24000),
    expectedVersion: z.number().int().positive().optional(),
    policy: policySchema,
  }),
  z.object({
    type: z.literal("ResolveProposal"),
    threadId: text,
    proposalId: text,
    action: z.enum(["accept", "dismiss"]),
  }),
  z.object({
    type: z.literal("ConfigureForeman"),
    agent: agentConfigurationSchema,
  }),
  z.object({
    type: z.literal("ConfigureAutonomy"),
    enabled: z.boolean(),
    intervalMinutes: z.number().int().min(15).max(1440),
    dailyBudget: z.number().int().min(1).max(24),
    maxOpenWork: z.number().int().min(1).max(10),
  }),
  z.object({ type: z.literal("Heartbeat") }),
  z.object({
    type: z.literal("LinkPullRequest"),
    workId: text,
    repository: text.regex(/^[\w.-]+\/[\w.-]+$/),
    number: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("ConfigureReviews"),
    requiredReviews: z.number().int().min(1).max(5),
    allowCodeChanges: z.boolean(),
  }),
  z.object({ type: z.literal("RetryRun"), runId: text }),
  z.object({ type: z.literal("RetryDelivery"), deliveryId: text }),
  z.object({ type: z.literal("ResumeCorrections"), workId: text }),
]);
export type Command = z.infer<typeof commandSchema>;
export const agentResultSchema = z.object({
  // Executor receipt, never a model-authored claim. Older saved results omit it.
  engineering: z.object({
    runId: text,
    worker: text,
    repository: text,
    branch: text,
    base: text,
    head: text,
  }).optional(),
  milestones: z.array(milestonePlanSchema).max(2).optional(),
  milestoneRevisions: z
    .array(
      z.object({
        milestoneId: z.string().min(1),
        expectedVersion: z.number().int().positive(),
        plan: milestonePlanSchema,
      }),
    )
    .max(1)
    .optional(),
  conversationSummary: z.string().max(6000).optional(),
  libraryUpdates: z.array(libraryUpdateSchema).max(4).optional(),
  contextRequests: z
    .array(z.object({ subject: text.max(400), reason: text.max(800) }))
    .max(3)
    .optional(),
  discoveries: z.array(candidateSchema).max(2).default([]),
  discoveryAssessment: assessmentSchema.nullable().default(null),
  discoveryOutcome: outcomeSchema.nullable().default(null),
  message: z.string().min(1).max(16000),
  requests: z
    .array(
      z.object({
        subject: text.max(160),
        reason: text.max(4000),
        recommendation: text.max(4000),
        evidence: z.array(text).max(20),
      }),
    )
    .max(3),
  proposals: z
    .array(
      z.object({
        documentId: text,
        content: text.max(24000),
        reason: text.max(4000),
        evidence: z.array(text).max(20),
      }),
    )
    .max(3),
  work: z
    .array(
      z.object({
        track,
        mode: z.enum(["analysis", "ui-inspection"]),
        title: text.max(160),
        instruction: text.max(8000),
        criteria: text.max(4000),
      }),
    )
    .max(2),
  outcome: z.enum(["completed", "needs_input", "needs_execution"]),
  review: z
    .object({
      verdict: z.enum(["approve", "changes_requested"]),
      summary: text.max(8000),
      findings: z.array(text.max(4000)).max(20),
      issues: z.array(reviewFindingSchema).max(30).optional(),
    })
    .nullable(),
  changes: z
    .array(z.object({ path: text.max(300), content: z.string().max(100000) }))
    .max(20),
  observations: z
    .array(
      z.object({
        title: text.max(160),
        content: text.max(8000),
        kind: z.enum(["observation", "hypothesis"]),
        evidence: z.array(text).max(20),
      }),
    )
    .max(3),
});
export type AgentResult = z.infer<typeof agentResultSchema>;
export { DomainError } from "./errors";
export const workKey = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
export function requireTransition(
  current: Work["status"],
  next: Work["status"],
) {
  const allowed: Record<Work["status"], Work["status"][]> = {
    queued: ["running", "cancelled"],
    running: ["blocked", "review", "done", "cancelled"],
    blocked: ["queued", "done", "cancelled"],
    review: ["queued", "done", "cancelled"],
    done: [],
    cancelled: [],
  };
  if (!allowed[current].includes(next))
    throw new DomainError(`Cannot move work from ${current} to ${next}.`);
}
export type PullRequest = {
  base?: string;
  merged?: boolean;
  description?: string;
  repository: string;
  number: number;
  head: string;
  branch: string;
  url: string;
};
export type Review = {
  issues?: import("./delivery").ReviewFinding[];
  id: string;
  runId: string;
  status: "queued" | "publishing" | "completed" | "failed";
  verdict: "approve" | "changes_requested" | null;
  summary: string;
  findings: string[];
};
export type ReviewRound = {
  id: string;
  workId: string;
  pullRequest: PullRequest;
  required: number;
  workerRunId?: string;
  status: "collecting" | "approved" | "changes_requested" | "superseded";
  reviews: Review[];
  createdAt: string;
  completedAt?: string;
};
