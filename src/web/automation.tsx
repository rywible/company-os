import React, { useEffect, useState } from "react";
import type { CompanyState } from "../domain/model";
import {
  automationPermissions,
  permissionLabels,
  type AutomationPermission,
} from "../domain/permissions";
import type { Lens } from "../domain/discovery";
import { taskBlocker, taskDueAt, taskUsage } from "../domain/automation";
import type { CommandHandler } from "./settings";
import { Modal } from "./modal";
import { Pencil, Trash2 } from "lucide-react";
import {
  AgentConfigurationFields,
  agentConfigurationSummary,
} from "./agent-configuration";
import {
  defaultAgentConfiguration,
  type AgentCatalog,
  type AgentProvider,
} from "../domain/agents";
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
  agentCatalog,
  availableAgentProviders,
  disabled,
  command,
  configured,
  hasConstitution,
  creating = false,
  closeCreate,
  showList = true,
}: {
  state: CompanyState;
  agentCatalog: AgentCatalog;
  availableAgentProviders: AgentProvider[];
  disabled: boolean;
  command: CommandHandler;
  configured: boolean;
  hasConstitution: boolean;
  creating?: boolean;
  closeCreate(): void;
  showList?: boolean;
}) {
  const [editing, setEditing] = useState<Lens | null>(null),
    [requested, setRequested] = useState<string | null>(null);
  const now = new Date().toISOString();
  const create = () =>
    setEditing({
      id: crypto.randomUUID(),
      name: "",
      kind: "task",
      permissions: ["evidence"],
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
  const close = () => {
    setEditing(null);
    closeCreate();
  };
  useEffect(() => {
    if (creating) create();
  }, [creating]);
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
            if (ok) close();
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
          What should Foreman do?
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
          <h3>Execution profile</h3>
          <p className="field-help">
            Foreman uses this model for this automation. Your Inbox
            conversations keep their own model.
          </p>
        </div>
        <AgentConfigurationFields
          value={lens.agent}
          catalog={agentCatalog}
          availableProviders={availableAgentProviders}
          onChange={(agent) => setEditing({ ...lens, agent })}
        />
        <fieldset className="automation-permissions">
          <legend>Allowed changes</legend>
          {(Object.keys(permissionLabels) as AutomationPermission[])
            .filter((p) =>
              lens.kind === "knowledge"
                ? p === "knowledge"
                : lens.kind === "planning"
                  ? p === "evidence" || p === "milestones"
                  : lens.kind === "task"
                    ? p !== "investigate"
                    : p === "evidence" || p === "investigate",
            )
            .map((permission) => (
              <label className="check" key={permission}>
                <input
                  type="checkbox"
                  value={permission}
                  checked={automationPermissions(lens).includes(permission)}
                  onChange={(e) =>
                    setEditing({
                      ...lens,
                      permissions: e.target.checked
                        ? [...automationPermissions(lens), permission]
                        : automationPermissions(lens).filter(
                            (p) => p !== permission,
                          ),
                    })
                  }
                />
                {permissionLabels[permission]}
              </label>
            ))}
          <p className="field-help">
            All automations can read relevant context. Only the selected changes
            are permitted. Milestones still require your approval; company
            direction remains yours to edit.
          </p>
        </fieldset>
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
                !lens.kind ||
                lens.kind === "research" ||
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
        {automationPermissions(lens).includes("milestones") && (
          <label>
            Upcoming milestone limit
            <input
              type="number"
              min={1}
              max={5}
              required
              value={lens.targetMilestones || 2}
              onChange={(e) =>
                setEditing({
                  ...lens,
                  targetMilestones: Number(e.target.value),
                })
              }
            />
            <span className="field-help">
              Wait for capacity when this many milestones are proposed, active
              or paused.
            </span>
          </label>
        )}
        <p className="field-help">
          {lens.kind === "knowledge"
            ? "Maintenance runs only when new evidence is waiting. Each pass processes up to three sources. "
            : !lens.kind || lens.kind === "research"
              ? "These limits cover this task’s research, investigations, delivery and outcome checks. "
              : "This automation follows its own cadence and run allowance. "}
          The daily limit resets at midnight UTC.
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
          <button type="button" onClick={close}>
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
          title={
            state.discovery.lenses.some((t) => t.id === editing.id)
              ? "Edit automation"
              : "Schedule work"
          }
          close={close}
        >
          {editor(editing)}
        </Modal>
      )}
      {showList && (
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
                <p className="task-permissions">
                  Allowed changes:{" "}
                  {automationPermissions(lens)
                    .map((p) => permissionLabels[p].toLowerCase())
                    .join(", ") || "read only"}
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
                {(() => {
                  const run = state.runs.find((r) => r.id === lens.lastRunId);
                  return run?.result || run?.error ? (
                    <details className="automation-result">
                      <summary>
                        {run.error
                          ? "Last run needs attention"
                          : "Latest result"}
                      </summary>
                      <p>{run.error || run.result?.message}</p>
                    </details>
                  ) : null;
                })()}
                {lens.lastRunAt && (
                  <p className="task-last-run">
                    Last requested {stamp(lens.lastRunAt)}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
