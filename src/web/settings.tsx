import React, { useState } from "react";
import type { Command, Settings } from "../domain/model";
import { InstallCard } from "./platform";
import { AgentConfigurationFields } from "./agent-configuration";
export type CommandHandler = (command: Command) => Promise<boolean>;

export function SettingsPage({
  settings,
  disabled,
  command,
}: {
  settings: Settings;
  disabled: boolean;
  command: CommandHandler;
}) {
  const [tab, setTab] = useState("Workspace");
  const [count, setCount] = useState(settings.requiredReviews);
  const [allow, setAllow] = useState(settings.allowCodeChanges);
  const [foremanAgent, setForemanAgent] = useState(settings.foremanAgent);
  const [saved, setSaved] = useState(false);
  return (
    <div className="settings-page">
      <div className="section-tabs" role="group" aria-label="Settings sections">
        {["Workspace", "Foreman", "Reviews"].map((name) => (
          <button
            key={name}
            aria-pressed={tab === name}
            onClick={() => {
              setTab(name);
              setSaved(false);
            }}
          >
            {name}
          </button>
        ))}
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
              The default used for conversations, reviews and work that does
              not belong to an automation. Runs already queued keep their
              original selection.
            </p>
          </div>
          <AgentConfigurationFields
            value={foremanAgent}
            onChange={setForemanAgent}
          />
          <p className="field-help">
            Leave model blank to use the provider’s current default.
          </p>
          <div className="actions">
            <button className="primary" disabled={disabled}>
              Save Foreman
            </button>
            {saved && <span role="status">Saved</span>}
          </div>
        </form>
      ) : (
        <form
          className="preference-section editor"
          onChange={() => setSaved(false)}
          onSubmit={(e) => {
            e.preventDefault();
            void command({
              type: "ConfigureReviews",
              requiredReviews: count,
              allowCodeChanges: allow,
            }).then(setSaved);
          }}
        >
          <div>
            <h2>Review policy</h2>
            <p className="muted">
              Applies to the next review round. Every reviewer must approve the
              same commit.
            </p>
          </div>
          <label>
            Required independent reviews
            <input
              type="number"
              min={1}
              max={5}
              required
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={allow}
              onChange={(e) => setAllow(e.target.checked)}
            />{" "}
            Allow verified code corrections
          </label>
          <p className="field-help">
            Corrections are limited to linked codex/ branches and must pass
            checks. Nothing merges automatically.
          </p>
          <div className="actions">
            <button className="primary" disabled={disabled}>
              Save review policy
            </button>
            {saved && <span role="status">Saved</span>}
          </div>
          <details className="preference-note">
            <summary>How reviews work</summary>
            <p>
              New commits restart review. The original worker receives the
              combined findings; three unsuccessful rounds reach your inbox.
              Reviews use separate agent runs with the owning automation’s
              profile or the Foreman default. They share one GitHub account,
              so they do not count as independent GitHub account approvals.
            </p>
          </details>
        </form>
      )}
    </div>
  );
}
