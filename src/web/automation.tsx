import React, { useState } from "react";
import type { CompanyState } from "../domain/model";
import type { Lens } from "../domain/discovery";
import { taskBlocker, taskDueAt, taskUsage } from "../domain/automation";
import type { CommandHandler } from "./settings";
const stamp = (at: string) =>
  new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
export function AutomationPage({
  state,
  disabled,
  command,
  configured,
  hasConstitution,
  openDocuments,
  openWork,
  openIdeas,
}: {
  state: CompanyState;
  disabled: boolean;
  command: CommandHandler;
  configured: boolean;
  hasConstitution: boolean;
  openDocuments(): void;
  openWork(): void;
  openIdeas(): void;
}) {
  const [editing, setEditing] = useState<Lens | null>(null),
    [requested, setRequested] = useState<string | null>(null);
  const now = new Date().toISOString();
  const globalBlock = !hasConstitution
    ? "Add a constitution before these tasks can run."
    : !configured
      ? "Connect the worker before these tasks can run."
      : null;
  const create = () =>
    setEditing({
      id: crypto.randomUUID(),
      name: "",
      question: "",
      enabled: true,
      intervalHours: 24,
      dailyRunLimit: 6,
      maxActiveIdeas: 6,
      maxInvestigations: 2,
      maxOpenWork: 4,
      inspectUI: false,
      sources: [],
    });
  function editor(lens: Lens) {
    return (
      <form
        className="editor task-editor"
        aria-label="Edit automated task"
        onSubmit={(e) => {
          e.preventDefault();
          void command({
            type: "SaveDiscoveryLens",
            lens: {
              ...lens,
              sources: lens.sources.map((s) => s.trim()).filter(Boolean),
            },
          }).then((ok) => {
            if (ok) setEditing(null);
          });
        }}
      >
        <label>
          Name
          <input
            required
            maxLength={80}
            value={lens.name}
            onChange={(e) => setEditing({ ...lens, name: e.target.value })}
          />
        </label>
        <label>
          What should Foreman investigate?
          <textarea
            aria-label="Task question"
            required
            maxLength={2000}
            value={lens.question}
            onChange={(e) => setEditing({ ...lens, question: e.target.value })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={lens.enabled}
            onChange={(e) => setEditing({ ...lens, enabled: e.target.checked })}
          />{" "}
          Run on a schedule
        </label>
        <div className="form-grid">
          {[
            { key: "intervalHours", label: "Hours between runs", max: 720 },
            { key: "dailyRunLimit", label: "Runs per day", max: 24 },
            { key: "maxActiveIdeas", label: "Active idea limit", max: 20 },
            {
              key: "maxInvestigations",
              label: "Investigations per idea",
              max: 3,
            },
            { key: "maxOpenWork", label: "Open work limit", max: 10 },
          ].map((f) => (
            <label key={f.key}>
              {f.label}
              <input
                aria-label={f.label}
                type="number"
                required
                min={1}
                max={f.max}
                value={lens[f.key as "intervalHours"]}
                onChange={(e) =>
                  setEditing({ ...lens, [f.key]: Number(e.target.value) })
                }
              />
            </label>
          ))}
        </div>
        <p className="field-help">
          These limits apply only to this task. The daily limit includes its
          research, investigations, delivery and outcome checks, and resets at
          midnight UTC. Runs execute one at a time.
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={lens.inspectUI}
            onChange={(e) =>
              setEditing({ ...lens, inspectUI: e.target.checked })
            }
          />{" "}
          Inspect the live interface
        </label>
        <label>
          GitHub release sources (owner/repo, one per line)
          <textarea
            aria-label="Release sources"
            value={lens.sources.join("\n")}
            onChange={(e) =>
              setEditing({ ...lens, sources: e.target.value.split("\n") })
            }
          />
        </label>
        <div className="actions">
          <button className="primary" disabled={disabled}>
            Save task
          </button>
          <button type="button" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </div>
      </form>
    );
  }
  return (
    <div className="automation-page task-automations">
      <div className="task-toolbar">
        <p className="muted">Each task runs on its own schedule.</p>
        <button disabled={disabled} onClick={create}>
          Add task
        </button>
      </div>
      {globalBlock && (
        <div className="task-notice">
          <p>{globalBlock}</p>
          {!hasConstitution && (
            <button onClick={openDocuments}>Open Documents</button>
          )}
        </div>
      )}
      {editing && !state.discovery.lenses.some((l) => l.id === editing.id) && (
        <section className="automated-task">{editor(editing)}</section>
      )}
      <div className="task-list">
        {state.discovery.lenses.map((lens) => {
          const blocker = taskBlocker(
            state,
            lens,
            now,
            hasConstitution,
            configured,
          );
          const due = taskDueAt(state, lens);
          const status = !lens.enabled
            ? "Paused"
            : globalBlock
              ? "Waiting to start"
              : blocker ||
                (!due || due <= now
                  ? "Ready for the next available run"
                  : `Eligible ${stamp(due)}`);
          return (
            <article
              className="automated-task"
              key={lens.id}
              aria-label={lens.name}
            >
              <div className="task-heading">
                <div>
                  <h2>{lens.name}</h2>
                  <p>{lens.question}</p>
                </div>
                <button
                  disabled={disabled}
                  aria-label={`${lens.enabled ? "Pause" : "Resume"} ${lens.name}`}
                  onClick={() =>
                    void command({
                      type: "SaveDiscoveryLens",
                      lens: { ...lens, enabled: !lens.enabled },
                    })
                  }
                >
                  {lens.enabled ? "Pause" : "Resume"}
                </button>
              </div>
              <p className="task-schedule">
                Every {lens.intervalHours}{" "}
                {lens.intervalHours === 1 ? "hour" : "hours"}.{" "}
                {taskUsage(state, lens, now)} of {lens.dailyRunLimit} runs used
                today.
              </p>
              <p className="task-status">{status}</p>
              <div className="task-actions">
                <button
                  className="primary"
                  disabled={disabled || !!blocker}
                  title={
                    blocker ||
                    "Run once now without changing the schedule switch"
                  }
                  aria-label={`Run ${lens.name} now`}
                  onClick={() =>
                    void command({
                      type: "ExploreDiscovery",
                      lensId: lens.id,
                    }).then((ok) => {
                      if (ok) setRequested(lens.id);
                    })
                  }
                >
                  Run now
                </button>
                <button
                  disabled={disabled}
                  onClick={() => setEditing({ ...lens })}
                  aria-label={`Edit ${lens.name}`}
                >
                  Schedule & limits
                </button>
                {requested === lens.id && (
                  <span role="status">Run requested</span>
                )}
              </div>
              {lens.lastRunAt && (
                <p className="task-last-run">
                  Last requested {stamp(lens.lastRunAt)}
                </p>
              )}
              {editing?.id === lens.id && editor(editing)}
            </article>
          );
        })}
      </div>
      <div className="automation-links">
        <button onClick={openWork}>Work in progress</button>
        <button onClick={openIdeas}>Ideas and experiments</button>
      </div>
    </div>
  );
}
