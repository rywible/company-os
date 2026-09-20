import { z } from "zod";

export const agentProviderSchema = z.enum(["openai", "anthropic", "meta"]);
export const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export type AgentProvider = z.infer<typeof agentProviderSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export const reasoningEffortsByProvider: Record<
  AgentProvider,
  ReasoningEffort[]
> = {
  openai: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  anthropic: ["low", "medium", "high", "xhigh", "max"],
  meta: ["none", "minimal", "low", "medium", "high", "xhigh", "ultra"],
};
export const agentConfigurationSchema = z
  .object({
    provider: agentProviderSchema,
    model: z.string().trim().max(120),
    reasoningEffort: reasoningEffortSchema,
  })
  .superRefine((value, context) => {
    if (
      !reasoningEffortsByProvider[value.provider].includes(
        value.reasoningEffort,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["reasoningEffort"],
        message: `${value.reasoningEffort} is not supported by ${value.provider}.`,
      });
  });

export type AgentConfiguration = z.infer<typeof agentConfigurationSchema>;

export const defaultAgentConfiguration = (): AgentConfiguration => ({
  provider: "openai",
  model: "",
  reasoningEffort: "high",
});

export const providerLabel = (provider: AgentProvider) =>
  ({ openai: "Codex", anthropic: "Claude", meta: "Muse" })[provider];
