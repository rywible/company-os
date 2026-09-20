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
export const track = z.enum(["research", "bug", "feature"]);
export const policySchema = z.object({
  inclusion: z.enum(["always", "relevant", "reference"]),
  status: z.enum(["active", "draft", "retired"]),
  scope: z.string().min(1).max(160),
  kind: z.enum(["document", "observation", "hypothesis", "decision"]),
});
export type Policy = z.infer<typeof policySchema>;
export const defaultPolicy = (d: Document): Policy => ({
  inclusion: d.level === "constitution" ? "always" : "relevant",
  status: "active",
  scope: "company",
  kind: "document",
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
  createdAt: string;
  updatedAt: string;
};
export type Work = {
  discoveryId?: string;
  discoveryPhase?: "investigation" | "delivery" | "outcome";
  id: string;
  track: z.infer<typeof track>;
  mode: "analysis" | "ui-inspection";
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
  manual?: boolean;
  budgetDay?: string;
  discoveryLensId?: string;
  discoverySignalIds?: string[];
  id: string;
  automatic: boolean;
  trigger: "message" | "heartbeat" | "work" | "review" | "revision";
  status: "queued" | "running" | "completed" | "failed";
  threadId?: string;
  workId?: string;
  reviewRoundId?: string;
  reviewId?: string;
  context: Context | null;
  result?: AgentResult;
  error: string | null;
  createdAt: string;
  finishedAt?: string;
};
export type Settings = {
  enabled: boolean;
  intervalMinutes: number;
  dailyBudget: number;
  scope: string;
  nextHeartbeatAt: string;
  maxOpenWork: number;
  requiredReviews: number;
  allowCodeChanges: boolean;
};
export type CompanyState = {
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
    discovery: initialDiscovery(),
    reviewRounds: [],
    threads: [],
    work: [],
    runs: [],
    policies: {},
    settings: {
      enabled: true,
      intervalMinutes: 60,
      dailyBudget: 6,
      maxOpenWork: 4,
      requiredReviews: 2,
      allowCodeChanges: false,
      scope: "rywible/company-os",
      nextHeartbeatAt: new Date(Date.parse(now) + 3600000).toISOString(),
    },
  };
}
const text = z.string().trim().min(1);
export const commandSchema = z.discriminatedUnion("type", [
  ...discoveryCommands,
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
  z.object({ type: z.literal("ConfigureWorkspace"), scope: text.max(160) }),
  z.object({
    type: z.literal("ConfigureAutonomy"),
    enabled: z.boolean(),
    intervalMinutes: z.number().int().min(15).max(1440),
    dailyBudget: z.number().int().min(1).max(24),
    maxOpenWork: z.number().int().min(1).max(10),
    scope: text.max(160),
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
export class DomainError extends Error {}
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
  description?: string;
  repository: string;
  number: number;
  head: string;
  branch: string;
  url: string;
};
export type Review = {
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
