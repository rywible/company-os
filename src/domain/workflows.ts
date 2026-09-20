import type { DomainEvent, Effect } from "./events";
// This is the workflow definition, not a logging hook. Every emitted effect is
// stored with its triggering event in the same database transaction.
export function workflows(event: DomainEvent): Effect[] {
  switch (event.type) {
    case "DiscoveryEvaluationRequested":
    case "DiscoveryIdentified":
      return [{ type: "InvestigateDiscovery", ideaId: event.payload.ideaId }];
    case "RoleConfigured":
    case "MilestoneChanged":
      return [{ type: "ReconcileMilestones" }];
    case "WorkStatusChanged":
    case "RunFailed":
      return [{ type: "ObserveDiscovery" }, { type: "ReconcileMilestones" }];
    case "LibraryMaintenanceRequested":
    case "DiscoveryScoutRequested":
    case "ConversationStarted":
    case "ReplyReceived":
    case "HeartbeatDue":
    case "RunRequested":
      return [{ type: "RunAgent", runId: event.payload.runId }];
    case "WorkCreated":
    case "WorkQueued":
      return [{ type: "ScheduleWork", workId: event.payload.workId }];
    case "KnowledgeChanged":
      return [
        {
          type: "QueueLibrarySource",
          documentId: event.payload.documentId,
          version: event.payload.version,
        },
        ...(event.actor === "human"
          ? [{ type: "ObserveDiscovery" as const }]
          : []),
        {
          type: "IndexKnowledge",
          documentId: event.payload.documentId,
          version: event.payload.version,
        },
      ];
    case "WorkCompleted":
    case "PullRequestUpdated":
    case "ReviewSuperseded":
      return [{ type: "StartReview", workId: event.payload.workId }];
    case "ReviewRoundStarted":
      return event.payload.runIds.map((runId) => ({
        type: "RunAgent" as const,
        runId,
      }));
    case "ReviewSubmitted":
      return [
        {
          type: "PublishReview",
          roundId: event.payload.roundId,
          reviewId: event.payload.reviewId,
        },
      ];
    case "ReviewCompleted":
      return [
        { type: "SignalWorker", roundId: event.payload.roundId },
        { type: "ObserveDiscovery" },
      ];
    case "WorkerSignalled":
      return [{ type: "RunAgent", runId: event.payload.runId }];
    default:
      return [];
  }
}
export const workflowDefinitions = [
  {
    name: "Milestone coordination",
    steps: [
      "Planning schedule → bounded milestone proposals → Inbox",
      "Human approval → dependency DAG → ready assignments",
      "Worker result → independent role review → accepted outputs",
      "Accepted dependencies → parallel streams; blocked descendants wait",
      "Completed milestone → replenish planning pipeline",
    ],
  },
  {
    name: "Knowledge library",
    steps: [
      "KnowledgeChanged → QueueLibrarySource + IndexKnowledge",
      "Due maintenance task → LibraryMaintenanceRequested → RunAgent",
      "Routine synthesis → LibraryMaintained → KnowledgeChanged",
      "Changed decision or human-edited subject → inbox → LibraryProposalResolved",
    ],
  },
  {
    name: "Continuous discovery",
    steps: [
      "Signal / rotating heartbeat → DiscoveryScoutRequested",
      "DiscoveryIdentified → bounded investigation",
      "DiscoveryAssessed → inbox only when ready",
      "DiscoveryDecided → delivery work",
      "WorkStatusChanged (done) → outcome check",
      "DiscoveryLearned → KnowledgeChanged → re-embed",
    ],
  },
  {
    name: "Pull request review",
    steps: [
      "WorkCompleted (PR head)",
      "StartReview: N independent reviewers",
      "ReviewSubmitted (same head)",
      "ReviewCompleted (all N)",
      "WorkerSignalled",
      "Corrections → PullRequestUpdated → new review round",
    ],
  },
  {
    name: "Conversation",
    steps: [
      "ConversationStarted / ReplyReceived",
      "RunAgent",
      "RunCompleted / InputRequested",
      "ReplyReceived",
    ],
  },
  {
    name: "Understanding",
    steps: ["KnowledgeChanged", "IndexKnowledge", "KnowledgeIndexed"],
  },
  {
    name: "Review",
    steps: [
      "InputRequested",
      "ReplyReceived / ProposalResolved",
      "WorkQueued / KnowledgeChanged",
    ],
  },
];
