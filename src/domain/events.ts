import { z } from "zod";
const id = z.string().min(1),
  version = z.number().int().positive();
export const eventPayloads = {
  DiscoveryScoutRequested: z.object({ runId: id, lensId: id }),
  DiscoveryEvaluationRequested: z.object({ ideaId: id }),
  DiscoveryIdentified: z.object({ ideaId: id }),
  DiscoveryAssessed: z.object({ ideaId: id, verdict: z.string() }),
  DiscoveryDecided: z.object({
    ideaId: id,
    action: z.string(),
    reason: z.string(),
  }),
  DiscoveryLearned: z.object({ ideaId: id, verdict: z.string() }),
  DiscoverySignalRecorded: z.object({ signalId: id }),
  DiscoveryConfigured: z.object({ lensId: id.optional() }),
  ConversationStarted: z.object({ threadId: id, runId: id }),
  ReplyReceived: z.object({ threadId: id, runId: id, workId: id.optional() }),
  ThreadStatusChanged: z.object({ threadId: id, status: z.string() }),
  WorkCreated: z.object({ workId: id }),
  WorkQueued: z.object({ workId: id }),
  WorkStatusChanged: z.object({ workId: id, status: z.string() }),
  HeartbeatDue: z.object({ runId: id }),
  RunRequested: z.object({ runId: id }),
  RunStarted: z.object({ runId: id }),
  RunCompleted: z.object({
    runId: id,
    threadId: id.optional(),
    workId: id.optional(),
  }),
  RunFailed: z.object({ runId: id, error: z.string() }),
  InputRequested: z.object({ threadId: id, workId: id.optional() }),
  LibraryMaintenanceRequested: z.object({ runId: id }),
  KnowledgeReviewScheduled: z.object({ documentId: id }),
  EvidenceReferenceChanged: z.object({ reference: id, withdrawn: z.boolean() }),
  LibraryOrganized: z.object({ documentId: id }),
  LibraryMaintained: z.object({ runId: id, documentIds: z.array(id) }),
  LibraryProposalResolved: z.object({
    threadId: id,
    proposalId: id,
    action: z.enum(["accept", "dismiss"]),
  }),
  KnowledgeChanged: z.object({ documentId: id, version }),
  KnowledgeIndexed: z.object({ documentId: id, version }),
  ProposalResolved: z.object({
    threadId: id,
    proposalId: id,
    action: z.enum(["accept", "dismiss"]),
  }),
  WorkCompleted: z.object({
    workId: id,
    repository: id,
    number: z.number().int().positive(),
    head: id,
  }),
  ReviewRoundStarted: z.object({ roundId: id, runIds: z.array(id) }),
  ReviewSubmitted: z.object({ roundId: id, reviewId: id, head: id }),
  ReviewCompleted: z.object({ roundId: id, workId: id, approved: z.boolean() }),
  ReviewSuperseded: z.object({ roundId: id, workId: id, head: id }),
  WorkerSignalled: z.object({ runId: id, workId: id, roundId: id }),
  PullRequestUpdated: z.object({ workId: id, head: id }),
  ReviewPolicyConfigured: z.object({
    requiredReviews: z.number().int().min(1).max(5),
    allowCodeChanges: z.boolean(),
  }),
  WorkspaceConfigured: z.object({ scope: z.string().min(1).max(160) }),
  AutonomyConfigured: z.object({ enabled: z.boolean() }),
} as const;
export type EventType = keyof typeof eventPayloads;
export type DomainEvent = {
  [K in EventType]: {
    id: string;
    sequence: number;
    schemaVersion: 1;
    type: K;
    at: string;
    actor: "human" | "foreman" | "system";
    correlationId: string;
    causationId: string | null;
    payload: z.infer<(typeof eventPayloads)[K]>;
  };
}[EventType];
export type EventInput = {
  [K in EventType]: { type: K; payload: z.infer<(typeof eventPayloads)[K]> };
}[EventType];
export type Effect =
  | { type: "QueueLibrarySource"; documentId: string; version: number }
  | { type: "ObserveDiscovery" }
  | { type: "InvestigateDiscovery"; ideaId: string }
  | { type: "StartReview"; workId: string }
  | { type: "SignalWorker"; roundId: string }
  | { type: "PublishReview"; roundId: string; reviewId: string }
  | { type: "RunAgent"; runId: string }
  | { type: "ScheduleWork"; workId: string }
  | { type: "IndexKnowledge"; documentId: string; version: number };
export type Delivery = {
  id: string;
  event: DomainEvent;
  effect: Effect;
  attempts: number;
};
