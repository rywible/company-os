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
export type AgentModelOption = {
  id: string;
  label: string;
  description: string;
  reasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
  isDefault?: boolean;
};
export type AgentCatalog = Record<AgentProvider, AgentModelOption[]>;
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

const model = (
  id: string,
  label: string,
  description: string,
  reasoningEfforts: ReasoningEffort[],
  defaultReasoningEffort: ReasoningEffort,
  isDefault = false,
): AgentModelOption => ({
  id,
  label,
  description,
  reasoningEfforts,
  defaultReasoningEffort,
  isDefault,
});

// Seeds keep settings usable when a harness is temporarily unreachable. The
// server refreshes these from the authenticated harnesses and connector model
// endpoints, preserving the exact ids used for dispatch.
export const seededAgentCatalog = (): AgentCatalog => ({
  openai: [
    model(
      "gpt-5.6-sol",
      "GPT-5.6-Sol",
      "Reliable agentic workhorse for everyday tasks.",
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      "low",
      true,
    ),
    model(
      "gpt-5.6-terra",
      "GPT-5.6-Terra",
      "Balanced agentic coding model for everyday work.",
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      "medium",
    ),
    model(
      "gpt-5.6-luna",
      "GPT-5.6-Luna",
      "Fast agentic coding model.",
      ["low", "medium", "high", "xhigh", "max"],
      "medium",
    ),
    model(
      "gpt-daybreak-blue-latest",
      "Daybreak Blue",
      "Defensive cybersecurity model.",
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      "low",
    ),
    model(
      "gpt-5.5",
      "GPT-5.5",
      "Previous-generation coding and general model.",
      ["low", "medium", "high", "xhigh"],
      "medium",
    ),
  ],
  anthropic: [
    model(
      "sonnet",
      "Sonnet",
      "Claude Code's current Sonnet alias.",
      ["low", "medium", "high", "xhigh", "max"],
      "high",
      true,
    ),
    model(
      "opus",
      "Opus",
      "Claude Code's current Opus alias.",
      ["low", "medium", "high", "xhigh", "max"],
      "high",
    ),
    model(
      "fable",
      "Fable",
      "Claude Code's current Fable alias.",
      ["low", "medium", "high", "xhigh", "max"],
      "high",
    ),
  ],
  meta: [
    model(
      "muse-spark-1.3",
      "Muse Spark 1.3",
      "Meta Muse Spark model.",
      ["none", "minimal", "low", "medium", "high", "xhigh", "ultra"],
      "high",
      true,
    ),
  ],
});

export function modelOption(
  catalog: AgentCatalog,
  configuration: AgentConfiguration,
) {
  const models = catalog[configuration.provider];
  return configuration.model
    ? models.find((entry) => entry.id === configuration.model)
    : models.find((entry) => entry.isDefault) || models[0];
}

export function configurationReasoningEfforts(
  catalog: AgentCatalog,
  configuration: AgentConfiguration,
) {
  return (
    modelOption(catalog, configuration)?.reasoningEfforts ||
    reasoningEffortsByProvider[configuration.provider]
  );
}

export const providerLabel = (provider: AgentProvider) =>
  ({ openai: "Codex", anthropic: "Claude", meta: "Muse" })[provider];
