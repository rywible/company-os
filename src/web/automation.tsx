import React, { useState } from "react";
import type { CompanyState } from "../domain/model";
import type { Lens } from "../domain/discovery";
import { taskBlocker, taskDueAt, taskUsage } from "../domain/automation";
import type { CommandHandler } from "./settings";
import { Modal } from "./modal";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  AgentConfigurationFields,
  agentConfigurationSummary,
} from "./agent-configuration";
import { defaultAgentConfiguration } from "../domain/agents";
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
}: {
  state: CompanyState;
  disabled: boolean;
  command: CommandHandler;
  configured: boolean;
  hasConstitution: boolean;
}) {
  const [editing, setEditing] = useState<Lens | null>(null),
    [requested, setRequested] = useState<string | null>(null);
  const now = new Date().toISOString();
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
      agent: defaultAgentConfiguration(),
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
        <div>
          <h3>Agent</h3>
          <p className="field-help">
            This selection applies to every phase created by this automation.
          </p>
        </div>
        <AgentConfigurationFields
          value={lens.agent}
          onChange={(agent) => setEditing({ ...lens, agent })}
        />
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
          ]
            .filter(
              (f) =>
                lens.kind !== "knowledge" ||
                ["intervalHours", "dailyRunLimit"].includes(f.key),
            )
            .map((f) => (
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
          {lens.kind === "knowledge"
            ? "Maintenance runs only when new evidence is waiting. Each pass processes up to three sources. "
            : "These limits cover this task’s research, investigations, delivery and outcome checks. "}
          The daily limit resets at midnight UTC. Runs use the next compatible
          worker in the pool.
        </p>
        {lens.kind !== "knowledge" && (
          <>
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
          </>
        )}
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
      {editing && (
        <Modal
          title={editing.name ? "Edit automation" : "New automation"}
          close={() => setEditing(null)}
        >
          {editor(editing)}
        </Modal>
      )}
      <div className="page-actions">
        <button className="primary" disabled={disabled} onClick={create}>
          <Plus size={16} /> Add automation
        </button>
      </div>
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
          const used = taskUsage(state, lens, now);
          const pct = Math.min(
            100,
            Math.round((100 * used) / Math.max(1, lens.dailyRunLimit)),
          );
          const status = !lens.enabled
            ? "Paused"
            : blocker ||
              (!due || due <= now
                ? "Ready for the next available run"
                : `Eligible ${stamp(due)}`);
          const live = lens.enabled && !blocker;
          return (
            <article
              className="automated-task"
              key={lens.id}
              aria-label={lens.name}
            >
              <div className="task-heading">
                <div>
                  <p style={{ margin: "0 0 8px" }}>
                    <span
                      className="badge"
                      data-status={
                        live ? "running" : lens.enabled ? "queued" : "paused"
                      }
                    >
                      <span className="dot" aria-hidden="true" />
                      {live ? "live" : "paused"}
                    </span>
                  </p>
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
                {lens.intervalHours === 1 ? "hour" : "hours"}. {used} of{" "}
                {lens.dailyRunLimit} runs used today.
              </p>
              <p className="task-model">
                {agentConfigurationSummary(lens.agent)}
              </p>
              <div
                className="context-meter"
                role="img"
                aria-label={`${used} of ${lens.dailyRunLimit} runs used`}
              >
                <span style={{ width: pct + "%" }} />
              </div>
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
                  title="Edit automation"
                  className="icon-button"
                >
                  <Pencil size={16} />
                </button>
                {lens.kind !== "knowledge" && (
                  <button
                    disabled={disabled}
                    onClick={() =>
                      void command({
                        type: "DeleteDiscoveryLens",
                        lensId: lens.id,
                      })
                    }
                    aria-label={`Delete ${lens.name}`}
                    title="Delete automation"
                    className="icon-button danger"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
                {requested === lens.id && (
                  <span role="status">Run requested</span>
                )}
              </div>
              {lens.lastRunAt && (
                <p className="task-last-run">
                  Last requested {stamp(lens.lastRunAt)}
                </p>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
