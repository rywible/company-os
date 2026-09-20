import { z } from "zod";
const text = z.string().trim().min(1);
export const deliveryPolicySchema = z.object({
  autoMerge: z.boolean(),
  correctionRounds: z.number().int().min(0).max(3),
  acceptanceAttempts: z.number().int().min(1).max(3),
  milestoneRequirements: z.string().trim().max(8000),
});
export type DeliveryPolicy = z.infer<typeof deliveryPolicySchema>;
export const initialDeliveryPolicy = (): DeliveryPolicy => ({
  autoMerge: true,
  correctionRounds: 2,
  acceptanceAttempts: 2,
  milestoneRequirements: "",
});
// Preserve company requirements while retiring executable checks and project overrides.
export function migrateDeliveryPolicy(value: unknown): DeliveryPolicy {
  const prior = (value || {}) as Record<string, any>;
  return deliveryPolicySchema.parse({
    ...initialDeliveryPolicy(),
    ...prior,
    milestoneRequirements:
      prior.milestoneRequirements ??
      prior.companyAcceptance?.instructions ??
      "",
  });
}
export function milestoneCriteria(
  criteria: string,
  requirements: string,
): string {
  return requirements.trim()
    ? `${criteria}\n\nAdditional company requirements\n${requirements}`
    : criteria;
}
// Waiting for external CI is a durable retry, never another agent attempt.
export class ChecksPending extends Error {}
export type Verification = {
  head: string;
  passed: boolean;
  checks: { name: string; passed: boolean; output: string }[];
};
export type IntegrationCandidate = {
  pullRequest: import("./model").PullRequest;
  base: string;
  head: string;
};
export const reviewFindingSchema = z.object({
  id: text.max(100),
  severity: z.enum(["blocker", "suggestion"]),
  category: z.enum([
    "correctness",
    "security",
    "checks",
    "acceptance",
    "style",
  ]),
  problem: text.max(3000),
  evidence: text.max(3000),
  verification: text.max(3000),
  status: z.enum(["open", "resolved", "dismissed"]),
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewProgress = {
  policy: Pick<DeliveryPolicy, "correctionRounds">;
  corrections: number;
  adjudicationRunId?: string;
  finalCorrectionRunId?: string;
  stopped?: string;
  findings: (ReviewFinding & { head: string; reviewerId: string })[];
};
// Stable server-generated refs, never model-supplied branch names.
export function milestoneBranch(id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id))
    throw Error("Invalid milestone identifier.");
  return `codex/milestone-${id}`;
}
export function assignmentBranch(milestoneId: string, workId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(workId))
    throw Error("Invalid assignment identifier.");
  return `${milestoneBranch(milestoneId)}/work-${workId}`.replace(
    "/work-",
    "-work-",
  );
}
export class IntegrationChanged extends Error {}
export class VerificationFailed extends Error {}
