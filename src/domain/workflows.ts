import type { DomainEvent, Effect } from "./events";
// This is the workflow definition, not a logging hook. Every emitted effect is
// stored with its triggering event in the same database transaction.
export function workflows(event: DomainEvent): Effect[] {
  switch (event.type) {
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
      return [{ type: "SignalWorker", roundId: event.payload.roundId }];
    case "WorkerSignalled":
      return [{ type: "RunAgent", runId: event.payload.runId }];
    default:
      return [];
  }
}
export const workflowDefinitions = [
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
    name: "Autonomous work",
    steps: [
      "HeartbeatDue",
      "RunAgent",
      "WorkCreated",
      "ScheduleWork",
      "RunRequested",
      "RunAgent",
      "RunCompleted / InputRequested",
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
