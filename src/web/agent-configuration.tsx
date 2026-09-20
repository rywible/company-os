import React from "react";
import {
  configurationReasoningEfforts,
  modelOption,
  providerLabel,
  type AgentCatalog,
  type AgentConfiguration,
  type AgentProvider,
  type ReasoningEffort,
} from "../domain/agents";

export function AgentConfigurationFields({
  value,
  catalog,
  availableProviders,
  onChange,
}: {
  value: AgentConfiguration;
  catalog: AgentCatalog;
  availableProviders: AgentProvider[];
  onChange(value: AgentConfiguration): void;
}) {
  const models = catalog[value.provider],
    selected = modelOption(catalog, value),
    efforts = configurationReasoningEfforts(catalog, value),
    savedModelMissing =
      !!value.model && !models.some((entry) => entry.id === value.model),
    savedEffortMissing = !efforts.includes(value.reasoningEffort);
  return (
    <div className="form-grid agent-configuration">
      <label>
        Provider
        <select
          aria-label="Agent provider"
          value={value.provider}
          onChange={(event) => {
            const provider = event.target.value as AgentProvider;
            const recommended =
              catalog[provider].find((entry) => entry.isDefault) ||
              catalog[provider][0];
            onChange({
              ...value,
              provider,
              model: "",
              reasoningEffort:
                recommended?.defaultReasoningEffort || "high",
            });
          }}
        >
          <option
            value="openai"
            disabled={!availableProviders.includes("openai")}
          >
            Codex · OpenAI
          </option>
          <option
            value="anthropic"
            disabled={!availableProviders.includes("anthropic")}
          >
            Claude · Anthropic
          </option>
          <option
            value="meta"
            disabled={!availableProviders.includes("meta")}
          >
            Muse · Meta
          </option>
        </select>
      </label>
      <label>
        Model
        <select
          aria-label="Agent model"
          value={value.model}
          onChange={(event) => {
            const model = event.target.value,
              option = model
                ? models.find((entry) => entry.id === model)
                : models.find((entry) => entry.isDefault) || models[0];
            onChange({
              ...value,
              model,
              reasoningEffort:
                option && !option.reasoningEfforts.includes(value.reasoningEffort)
                  ? option.defaultReasoningEffort
                  : value.reasoningEffort,
            });
          }}
        >
          <option value="">
            Provider default{selected ? ` · ${selected.label}` : ""}
          </option>
          {savedModelMissing && (
            <option value={value.model}>Saved · {value.model}</option>
          )}
          {models.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Reasoning effort
        <select
          aria-label="Reasoning effort"
          value={value.reasoningEffort}
          onChange={(event) =>
            onChange({
              ...value,
              reasoningEffort: event.target.value as ReasoningEffort,
            })
          }
        >
          {savedEffortMissing && (
            <option value={value.reasoningEffort}>
              Saved · {value.reasoningEffort}
            </option>
          )}
          {efforts.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export const agentConfigurationSummary = (value: AgentConfiguration) =>
  `${providerLabel(value.provider)} · ${value.model || "provider default"} · ${value.reasoningEffort}`;
