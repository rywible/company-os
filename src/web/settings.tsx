import React, { useState } from "react";
import type { Command, Settings } from "../domain/model";
import { InstallCard } from "./platform";
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
  const [scope, setScope] = useState(settings.scope);
  const [count, setCount] = useState(settings.requiredReviews);
  const [allow, setAllow] = useState(settings.allowCodeChanges);
  const [saved, setSaved] = useState(false);
  return (
    <div className="settings-page">
      <div className="section-tabs" role="group" aria-label="Settings sections">
        {["Workspace", "Reviews"].map((name) => (
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
        <>
          <form
            className="preference-section editor"
            onChange={() => setSaved(false)}
            onSubmit={(e) => {
              e.preventDefault();
              void command({
                type: "ConfigureAutonomy",
                ...settings,
                scope,
              }).then(setSaved);
            }}
          >
            <div>
              <h2>Repository</h2>
              <p className="muted">
                The repository Foreman works with. Direction comes from your
                constitution.
              </p>
            </div>
            <label>
              Repository scope
              <input
                required
                maxLength={160}
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              />
            </label>
            <div className="actions">
              <button className="primary" disabled={disabled}>
                Save workspace
              </button>
              {saved && <span role="status">Saved</span>}
            </div>
          </form>
          <InstallCard />
        </>
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
              Reviews use separate agent runs with the same model and GitHub
              account, so they do not count as independent GitHub account
              approvals.
            </p>
          </details>
        </form>
      )}
    </div>
  );
}
