import { DeliverySettings } from "./delivery-settings";
import React, { useState } from "react";
import type { Command, Settings } from "../domain/model";
import { RolesSettings, AvailabilitySettings } from "./work-settings";
import { InstallCard } from "./platform";
import { AgentConfigurationFields } from "./agent-configuration";
import type { AgentCatalog, AgentProvider } from "../domain/agents";
export type CommandHandler = (command: Command) => Promise<boolean>;

export function SettingsPage({
  settings,
  agentCatalog,
  availableAgentProviders,
  disabled,
  command,
}: {
  settings: Settings;
  agentCatalog: AgentCatalog;
  availableAgentProviders: AgentProvider[];
  disabled: boolean;
  command: CommandHandler;
}) {
  const [tab, setTab] = useState("Workspace");
  const [foremanAgent, setForemanAgent] = useState(settings.foremanAgent);
  const [saved, setSaved] = useState(false);
  return (
    <div className="settings-page">
      <div
        className="section-tabs"
        role="tablist"
        aria-label="Settings sections"
      >
        {["Workspace", "Foreman", "Roles", "Availability", "Reviews"].map(
          (name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              onClick={() => {
                setTab(name);
                setSaved(false);
              }}
            >
              {name}
            </button>
          ),
        )}
      </div>
      {tab === "Workspace" ? (
        <InstallCard />
      ) : tab === "Foreman" ? (
        <form
          className="preference-section editor"
          onChange={() => setSaved(false)}
          onSubmit={(event) => {
            event.preventDefault();
            void command({
              type: "ConfigureForeman",
              agent: foremanAgent,
            }).then(setSaved);
          }}
        >
          <div>
            <h2>Foreman model</h2>
            <p className="muted">
              The model for new Inbox conversations. Every automation is also
              Foreman, using its own execution profile and permissions. Runs
              already queued keep their original selection.
            </p>
          </div>
          <AgentConfigurationFields
            value={foremanAgent}
            catalog={agentCatalog}
            availableProviders={availableAgentProviders}
            onChange={setForemanAgent}
          />
          <p className="field-help">
            Model IDs and supported reasoning levels come from the provider
            harness. Provider default follows the harness recommendation.
          </p>
          <div className="actions">
            <button className="primary" disabled={disabled}>
              Save Foreman
            </button>
            {saved && <span role="status">Saved</span>}
          </div>
        </form>
      ) : tab === "Roles" ? (
        <RolesSettings
          settings={settings}
          catalog={agentCatalog}
          providers={availableAgentProviders}
          disabled={disabled}
          command={command}
        />
      ) : tab === "Availability" ? (
        <AvailabilitySettings
          settings={settings}
          disabled={disabled}
          command={command}
        />
      ) : (
        <DeliverySettings
          settings={settings}
          disabled={disabled}
          command={command}
        />
      )}
    </div>
  );
}
