import type { ReviewRound } from "./model";
// Review state belongs to a commit, never just a PR number. A quorum cannot be
// assembled from different heads, duplicate deliveries, or unfinished reviewers.
export function reviewOutcome(
  round: ReviewRound,
  currentHead: string,
): "superseded" | "waiting" | "approved" | "changes_requested" {
  if (round.pullRequest.head !== currentHead) return "superseded";
  if (
    round.reviews.length !== round.required ||
    round.reviews.some((r) => r.status !== "completed")
  )
    return "waiting";
  return round.reviews.every((r) => r.verdict === "approve")
    ? "approved"
    : "changes_requested";
}
