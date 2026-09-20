import React, { useState } from "react";
import { Plus, ArrowLeft, GitBranch } from "lucide-react";
import type { CompanyState, Command, Work } from "../domain/model";
import type { Document } from "../contracts";
import type { Milestone, MilestonePlan } from "../domain/planning";
import { triageAvailable } from "../domain/planning";
import { Modal } from "./modal";
import "./work.css";
type CommandHandler = (command: Command) => Promise<boolean>;
export function AvailabilityNote({ state }: { state: CompanyState }) {
  return (
    <p className="availability-note">
      {triageAvailable(state.settings.availability, new Date().toISOString())
        ? "Within triage hours"
        : "Outside triage hours"}
      <span>Approved work continues independently.</span>
    </p>
  );
}
export function MilestoneActions({
  milestone: m,
  command,
  disabled,
}: {
  milestone: Milestone;
  command: CommandHandler;
  disabled: boolean;
}) {
  const act = (action: "approve" | "defer" | "decline" | "pause" | "resume") =>
    void command({
      type: "DecideMilestone",
      milestoneId: m.id,
      expectedVersion: m.version,
      action,
      reason: {
        approve:
          "Approved the outcome, assignments, run allowance, and boundaries.",
        defer: "Deferred for later triage; independent work may continue.",
        decline: "Declined this milestone.",
        pause: "Paused this milestone.",
        resume: "Resumed this milestone within its original allowance.",
      }[action],
    });
  return (
    <div className="milestone-actions">
      {m.status === "proposed" ? (
        <>
          <button
            className="primary"
            disabled={disabled}
            onClick={() => act("approve")}
          >
            Approve milestone
          </button>
          <button disabled={disabled} onClick={() => act("defer")}>
            Defer
          </button>
          <button disabled={disabled} onClick={() => act("decline")}>
            Decline
          </button>
        </>
      ) : m.status === "active" ? (
        <button disabled={disabled} onClick={() => act("pause")}>
          Pause milestone
        </button>
      ) : m.status === "paused" ? (
        <button disabled={disabled} onClick={() => act("resume")}>
          Resume milestone
        </button>
      ) : null}
    </div>
  );
}
export function assignmentStatus(work: Work, all: Work[]) {
  if (
    work.status === "queued" &&
    work.dependsOn?.some(
      (id) => all.find((w) => w.id === id)?.status !== "done",
    )
  )
    return "Waiting on dependencies";
  return {
    queued: "Ready",
    running: "Running",
    blocked: "Blocked",
    review: "In review",
    done: "Accepted",
    cancelled: "Cancelled",
  }[work.status];
}
function graph(m: Milestone) {
  const safe = (s: string) =>
    s.replace(/[^\p{L}\p{N}\s.,:!?()/-]/gu, "").replace(/\s+/g, " ");
  const lines = m.assignments.map((a, i) => `n${i}["${safe(a.title)}"]`);
  m.assignments.forEach((a, i) =>
    a.dependsOn.forEach((key) =>
      lines.push(`n${m.assignments.findIndex((n) => n.key === key)} --> n${i}`),
    ),
  );
  return "```mermaid\nflowchart LR\n" + lines.join("\n") + "\n```";
}
export function MilestonesPage({
  state,
  documents,
  selected,
  select,
  command,
  disabled,
  markdown,
  openWork,
  openThread,
  openKnowledge,
  requestBrief,
}: {
  state: CompanyState;
  documents: Document[];
  selected: string | null;
  select(id: string | null): void;
  command: CommandHandler;
  disabled: boolean;
  markdown(text: string): React.ReactNode;
  openWork(id: string): void;
  openThread(id: string): void;
  openKnowledge(id: string): void;
  requestBrief(subject: string, content: string): Promise<boolean>;
}) {
  const [brief, setBrief] = useState<string | null>(null),
    [editing, setEditing] = useState<Milestone | null>(null);
  const m = state.planning.milestones.find((m) => m.id === selected);
  const run = state.runs.find((r) => r.id === state.planning.lastRunId);
  const planning = run && ["queued", "running"].includes(run.status);
  return (
    <section className="milestones-page" aria-label="Milestones">
      {brief !== null && (
        <Modal title="Plan a milestone" close={() => setBrief(null)}>
          <form
            className="editor"
            onSubmit={(e) => {
              e.preventDefault();
              void requestBrief(
                "Plan a milestone",
                `Develop a milestone proposal and dependency DAG for this outcome. Use large coherent assignments, establish interfaces early, and parallelize independent verticals. Bring the proposed outcome and boundaries to my inbox for approval.\n\n${brief}`,
              ).then((ok) => {
                if (ok) setBrief(null);
              });
            }}
          >
            <label>
              What outcome should Foreman plan?
              <textarea
                required
                rows={8}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="Describe the outcome, constraints, and what success looks like."
              />
            </label>
            <button className="primary" disabled={disabled || !brief.trim()}>
              Ask Foreman to plan
            </button>
          </form>
        </Modal>
      )}
      {editing && (
        <MilestoneEditor
          milestone={editing}
          state={state}
          command={command}
          disabled={disabled}
          close={() => setEditing(null)}
        />
      )}
      {m ? (
        <>
          <button className="back" onClick={() => select(null)}>
            <ArrowLeft size={15} /> All milestones
          </button>
          <header className="milestone-heading">
            <div>
              <p className="milestone-state">{m.status}</p>
              <h2>{m.title}</h2>
            </div>
            <button onClick={() => openThread(m.threadId)}>
              Decision thread
            </button>
          </header>
          <div className="milestone-brief">
            <h3>Outcome</h3>
            {markdown(m.objective)}
            <h3>Acceptance criteria</h3>
            {markdown(m.criteria)}
            <h3>Authority and boundaries</h3>
            {markdown(m.boundaries)}
          </div>
          <p className="milestone-allowance">
            {
              state.runs.filter((r) => r.workId && m.workIds.includes(r.workId))
                .length
            }{" "}
            of {m.maxRuns} runs used. Up to {m.maxParallel} assignments or
            reviews in parallel.
          </p>
          <MilestoneActions
            milestone={m}
            command={command}
            disabled={disabled}
          />
          {m.status === "proposed" && (
            <button
              disabled={disabled}
              onClick={() => setEditing(structuredClone(m))}
            >
              Revise proposal
            </button>
          )}
          {!!m.documentIds.length && (
            <div className="milestone-documents">
              <h3>Shared knowledge</h3>
              {m.documentIds.map((id) => (
                <button key={id} onClick={() => openKnowledge(id)}>
                  {documents.find((d) => d.id === id)?.title ||
                    "Unavailable document"}
                </button>
              ))}
            </div>
          )}
          <details className="milestone-graph">
            <summary>
              <GitBranch size={16} /> Dependency graph
            </summary>
            {markdown(graph(m))}
          </details>
          <h3 className="assignment-list-title">Assignments</h3>
          <div className="assignment-list">
            {m.assignments.map((a) => {
              const w = state.work.find(
                (w) => w.milestoneId === m.id && w.assignmentKey === a.key,
              );
              const role = state.settings.roles.find((r) => r.id === a.roleId);
              return (
                <article className="assignment-row" key={a.key}>
                  <div className="assignment-row-title">
                    {w ? (
                      <button onClick={() => openWork(w.id)}>{a.title}</button>
                    ) : (
                      <strong>{a.title}</strong>
                    )}
                    <span>
                      {w
                        ? assignmentStatus(w, state.work)
                        : "Awaiting approval"}
                    </span>
                  </div>
                  <p className="muted">
                    {role?.name || a.roleId}
                    {a.dependsOn.length
                      ? ` · After ${a.dependsOn.map((key) => m.assignments.find((n) => n.key === key)?.title).join(", ")}`
                      : " · No dependencies"}
                  </p>
                  <details>
                    <summary>Assignment brief</summary>
                    {markdown(a.instruction)}
                    <h4>Acceptance criteria</h4>
                    {markdown(a.criteria)}
                    <h4>Expected outputs</h4>
                    <ul>
                      {a.outputs.map((o) => (
                        <li key={o}>{o}</li>
                      ))}
                    </ul>
                  </details>
                </article>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <div className="milestones-heading">
            <div>
              <h2>Milestones</h2>
              <p>Outcomes and the assignments that deliver them.</p>
            </div>
            <button
              className="primary"
              disabled={disabled}
              onClick={() => setBrief("")}
            >
              <Plus size={16} /> New milestone
            </button>
          </div>
          <AvailabilityNote state={state} />
          <div className="planning-status">
            <span>
              {planning
                ? "Foreman is preparing the next milestone."
                : run?.status === "failed"
                  ? "The last planning run needs attention."
                  : state.planning.enabled
                    ? "Automatic milestone planning is on."
                    : "Automatic planning is paused."}
            </span>
            <button
              disabled={
                disabled ||
                !!planning ||
                !documents.some(
                  (d) => d.level === "constitution" && d.content.trim(),
                )
              }
              onClick={() => void command({ type: "RequestPlanning" })}
            >
              Plan next milestone
            </button>
          </div>
          {!state.planning.milestones.length && (
            <div className="milestone-empty">
              <h3>Start with an outcome</h3>
              <p>
                Give Foreman a direction. It will propose substantial
                assignments, their dependencies, and the boundaries for
                autonomous work.
              </p>
            </div>
          )}
          {(
            ["active", "proposed", "paused", "completed", "declined"] as const
          ).map((status) => {
            const items = state.planning.milestones.filter(
              (m) => m.status === status,
            );
            return !items.length ? null : (
              <section className="milestone-group" key={status}>
                <h3>
                  {
                    {
                      active: "In progress",
                      proposed: "Upcoming · needs a decision",
                      paused: "Paused",
                      completed: "Completed",
                      declined: "Declined",
                    }[status]
                  }
                </h3>
                {items.map((m) => {
                  const tasks = state.work.filter(
                      (w) => w.milestoneId === m.id,
                    ),
                    done = tasks.filter((w) => w.status === "done").length;
                  const blocked = tasks.filter(
                    (w) =>
                      ["blocked", "review"].includes(w.status) && w.threadId,
                  );
                  return (
                    <button
                      className="milestone-row"
                      key={m.id}
                      onClick={() => select(m.id)}
                    >
                      <div>
                        <strong>{m.title}</strong>
                        <p>{m.objective}</p>
                        <span>
                          {m.status === "proposed"
                            ? `${m.assignments.length} assignments proposed`
                            : `${done} of ${m.assignments.length} assignments accepted`}
                          {blocked.length
                            ? ` · ${blocked.length} need input`
                            : ""}
                        </span>
                      </div>
                      <progress
                        aria-label={`${m.title} progress`}
                        value={done}
                        max={m.assignments.length}
                      />
                    </button>
                  );
                })}
              </section>
            );
          })}
        </>
      )}
    </section>
  );
}
function MilestoneEditor({
  milestone: m,
  state,
  command,
  disabled,
  close,
}: {
  milestone: Milestone;
  state: CompanyState;
  command: CommandHandler;
  disabled: boolean;
  close(): void;
}) {
  const [plan, setPlan] = useState<MilestonePlan>(m);
  return (
    <Modal title="Revise milestone proposal" close={close}>
      <form
        className="editor milestone-editor"
        onSubmit={(e) => {
          e.preventDefault();
          void command({
            type: "ReviseMilestone",
            milestoneId: m.id,
            expectedVersion: m.version,
            plan,
          }).then((ok) => {
            if (ok) close();
          });
        }}
      >
        <label>
          Title
          <input
            required
            maxLength={160}
            value={plan.title}
            onChange={(e) => setPlan({ ...plan, title: e.target.value })}
          />
        </label>
        {(["objective", "criteria", "boundaries"] as const).map((key) => (
          <label key={key}>
            {
              {
                objective: "Outcome",
                criteria: "Acceptance criteria",
                boundaries: "Authority and boundaries",
              }[key]
            }
            <textarea
              required
              value={plan[key]}
              onChange={(e) => setPlan({ ...plan, [key]: e.target.value })}
            />
          </label>
        ))}
        <div className="form-grid">
          <label>
            Run allowance
            <input
              type="number"
              min={2}
              max={200}
              value={plan.maxRuns}
              onChange={(e) =>
                setPlan({ ...plan, maxRuns: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Parallel assignments
            <input
              type="number"
              min={1}
              max={8}
              value={plan.maxParallel}
              onChange={(e) =>
                setPlan({ ...plan, maxParallel: Number(e.target.value) })
              }
            />
          </label>
        </div>
        {plan.assignments.map((a, i) => (
          <details key={a.key}>
            <summary>{a.title}</summary>
            <label>
              Assigned role
              <select
                value={a.roleId}
                onChange={(e) =>
                  setPlan({
                    ...plan,
                    assignments: plan.assignments.map((v, j) =>
                      i === j ? { ...v, roleId: e.target.value } : v,
                    ),
                  })
                }
              >
                {state.settings.roles
                  .filter((r) => r.enabled)
                  .map((r) => (
                    <option value={r.id} key={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Assignment
              <textarea
                required
                value={a.instruction}
                onChange={(e) =>
                  setPlan({
                    ...plan,
                    assignments: plan.assignments.map((v, j) =>
                      i === j ? { ...v, instruction: e.target.value } : v,
                    ),
                  })
                }
              />
            </label>
            <label>
              Completion criteria
              <textarea
                required
                value={a.criteria}
                onChange={(e) =>
                  setPlan({
                    ...plan,
                    assignments: plan.assignments.map((v, j) =>
                      i === j ? { ...v, criteria: e.target.value } : v,
                    ),
                  })
                }
              />
            </label>
            <fieldset>
              <legend>Depends on</legend>
              {plan.assignments
                .filter((v) => v.key !== a.key)
                .map((v) => (
                  <label className="check" key={v.key}>
                    <input
                      type="checkbox"
                      checked={a.dependsOn.includes(v.key)}
                      onChange={(e) =>
                        setPlan({
                          ...plan,
                          assignments: plan.assignments.map((n, j) =>
                            i === j
                              ? {
                                  ...n,
                                  dependsOn: e.target.checked
                                    ? [...n.dependsOn, v.key]
                                    : n.dependsOn.filter((k) => k !== v.key),
                                }
                              : n,
                          ),
                        })
                      }
                    />
                    {v.title}
                  </label>
                ))}
            </fieldset>
          </details>
        ))}
        <p className="field-help">
          For a different assignment breakdown, ask Foreman to revise the
          proposal in its decision thread.
        </p>
        <button className="primary" disabled={disabled}>
          Save proposal
        </button>
      </form>
    </Modal>
  );
}
