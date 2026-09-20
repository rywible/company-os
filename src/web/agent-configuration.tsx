import React from "react";
import {
  providerLabel,
  reasoningEffortsByProvider,
  type AgentConfiguration,
  type AgentProvider,
  type ReasoningEffort,
} from "../domain/agents";

export function AgentConfigurationFields({
  value,
  onChange,
}: {
  value: AgentConfiguration;
  onChange(value: AgentConfiguration): void;
}) {
  const available = reasoningEffortsByProvider[value.provider];
  return (
    <div className="form-grid agent-configuration">
      <label>
        Provider
        <select
          aria-label="Agent provider"
          value={value.provider}
          onChange={(event) => {
            const provider = event.target.value as AgentProvider;
            const options = reasoningEffortsByProvider[provider];
            onChange({
              ...value,
              provider,
              reasoningEffort: options.includes(value.reasoningEffort)
                ? value.reasoningEffort
                : "high",
            });
          }}
        >
          <option value="openai">Codex · OpenAI</option>
          <option value="anthropic">Claude · Anthropic</option>
          <option value="meta">Muse · Meta</option>
        </select>
      </label>
      <label>
        Model
        <input
          aria-label="Agent model"
          maxLength={120}
          placeholder="Provider default"
          value={value.model}
          onChange={(event) =>
            onChange({ ...value, model: event.target.value })
          }
        />
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
          {available.map((effort) => (
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
