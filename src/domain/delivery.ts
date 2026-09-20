import { z } from "zod";
const text = z.string().trim().min(1);
export const acceptancePolicySchema = z.object({
  instructions: text.max(8000),
  checks: z
    .array(
      z.object({
        name: text.max(120),
        command: z.array(text.max(1000)).min(1).max(30),
      }),
    )
    .min(1)
    .max(12),
});
export const deliveryPolicySchema = z.object({
  verificationChecks: acceptancePolicySchema.shape.checks,
  autoMerge: z.boolean(),
  correctionRounds: z.number().int().min(0).max(3),
  acceptanceAttempts: z.number().int().min(1).max(3),
  companyAcceptance: acceptancePolicySchema,
  projectAcceptance: acceptancePolicySchema.nullable(),
});
export type DeliveryPolicy = z.infer<typeof deliveryPolicySchema>;
export type AcceptancePolicy = z.infer<typeof acceptancePolicySchema>;
export const initialDeliveryPolicy = (): DeliveryPolicy => ({
  verificationChecks: [
    {
      name: "Install dependencies",
      command: ["bun", "install", "--frozen-lockfile"],
    },
    { name: "Type checking", command: ["bun", "run", "typecheck"] },
    { name: "Unit tests", command: ["bun", "test", "tests"] },
    { name: "Build", command: ["bun", "run", "build"] },
  ],
  autoMerge: true,
  correctionRounds: 2,
  acceptanceAttempts: 2,
  companyAcceptance: {
    instructions:
      "Verify the integrated milestone against its acceptance criteria. All configured checks must pass. Report evidence and limitations; a successful build alone is not proof of the requested behavior.",
    checks: [
      {
        name: "Install dependencies",
        command: ["bun", "install", "--frozen-lockfile"],
      },
      { name: "Type checking", command: ["bun", "run", "typecheck"] },
      { name: "Unit tests", command: ["bun", "test", "tests"] },
      { name: "Build", command: ["bun", "run", "build"] },
      { name: "Browser acceptance", command: ["bun", "run", "test:ui"] },
    ],
  },
  projectAcceptance: null,
});
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

export const engineeringChecks = (
  policy: DeliveryPolicy,
): AcceptancePolicy => ({
  instructions:
    "Verify this assignment without requiring downstream milestone behavior.",
  checks: policy.verificationChecks,
});
