import React from "react";
import { ArrowLeft, GitBranch } from "lucide-react";
import type { CompanyState, Command, Work } from "../domain/model";
import type { Document } from "../contracts";
import type { Milestone } from "../domain/planning";
import { triageAvailable } from "../domain/planning";
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
      ) : ["active", "acceptance"].includes(m.status) ? (
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
}) {
  const m = state.planning.milestones.find((m) => m.id === selected);
  const tasks = m ? state.work.filter((w) => w.milestoneId === m.id) : [];
  const decisions = tasks
    .filter((w) => w.status === "blocked" && w.threadId)
    .map((w) => state.threads.find((t) => t.id === w.threadId))
    .filter((t) => t && t.status !== "resolved");
  const outputs = [...new Set(tasks.flatMap((w) => w.outputDocumentIds || []))];
  const status = (milestone: Milestone) =>
    ({
      proposed: "Needs approval",
      active: "In progress",
      acceptance: "Acceptance testing",
      paused: "Paused",
      completed: "Completed",
      declined: "Declined",
    })[milestone.status];
  return (
    <section className="milestones-page" aria-label="Milestones">
      {m ? (
        <>
          <button className="back" onClick={() => select(null)}>
            <ArrowLeft size={15} /> All milestones
          </button>
          <header className="milestone-heading">
            <div>
              <p className="milestone-state">{status(m)}</p>
              <h2>{m.title}</h2>
            </div>
            <button onClick={() => openThread(m.threadId)}>
              Discuss with Foreman
            </button>
          </header>
          <div className="milestone-brief">
            <h3>Outcome</h3>
            {markdown(m.objective)}
            <h3>Success looks like</h3>
            {markdown(m.criteria)}
            {!!(
              m.delivery?.policy.milestoneRequirements ??
              state.settings.delivery.milestoneRequirements
            ) && (
              <>
                <h3>Additional company requirements</h3>
                {markdown(
                  m.delivery?.policy.milestoneRequirements ??
                    state.settings.delivery.milestoneRequirements,
                )}
              </>
            )}
            <h3>Authority and boundaries</h3>
            {markdown(m.boundaries)}
          </div>
          <p className="milestone-allowance">
            {m.maxRuns} agent runs authorized. Foreman coordinates delivery and
            review within this allowance.
          </p>
          <MilestoneActions
            milestone={m}
            command={command}
            disabled={disabled}
          />
          {m.status === "proposed" && (
            <p className="muted">
              Discuss changes with Foreman before approving. Approval covers
              this outcome and its stated boundaries.
            </p>
          )}
          {decisions.length > 0 && (
            <section className="milestone-decisions">
              <h3>Needs your input</h3>
              {decisions.map((t) => (
                <article key={t!.id}>
                  {markdown(t!.reason)}
                  {markdown(t!.recommendation)}
                  <button onClick={() => openThread(t!.id)}>
                    Discuss this decision
                  </button>
                </article>
              ))}
              <p className="muted">
                Independent approved work can continue while these decisions
                wait.
              </p>
            </section>
          )}
          {m.delivery && (
            <section className="milestone-brief">
              <h3>Acceptance</h3>
              <p>
                {m.status === "completed"
                  ? "The integrated result passed acceptance."
                  : m.status === "acceptance"
                    ? "Testing the integrated result against the approved requirements."
                    : "The integrated result will be tested before this milestone completes."}
              </p>
              {m.delivery.verification && (
                <details>
                  <summary>Test results</summary>
                  {m.delivery.verification.checks.map((check, i) => (
                    <details key={i}>
                      <summary>
                        {check.passed ? "Passed" : "Failed"}: {check.name}
                      </summary>
                      <pre>{check.output}</pre>
                    </details>
                  ))}
                </details>
              )}
              {tasks
                .filter((w) => w.phase === "acceptance" && w.result)
                .map((w) => (
                  <details key={w.id}>
                    <summary>Acceptance report</summary>
                    {markdown(w.result)}
                  </details>
                ))}
            </section>
          )}
          {!!outputs.length && (
            <section className="milestone-documents">
              <h3>Results</h3>
              {outputs.map((id) => (
                <button key={id} onClick={() => openKnowledge(id)}>
                  {documents.find((d) => d.id === id)?.title ||
                    "Document unavailable"}
                </button>
              ))}
            </section>
          )}
          {!!m.documentIds.length && (
            <details className="milestone-documents">
              <summary>Related knowledge</summary>
              {m.documentIds.map((id) => (
                <button key={id} onClick={() => openKnowledge(id)}>
                  {documents.find((d) => d.id === id)?.title ||
                    "Document unavailable"}
                </button>
              ))}
            </details>
          )}
          <details className="milestone-graph">
            <summary>
              <GitBranch size={16} /> How Foreman organized this work
            </summary>
            {markdown(graph(m))}
            <details className="milestone-diagnostics">
              <summary>Execution details</summary>
              <div className="assignment-list">
                {m.assignments.map((a) => {
                  const w = tasks.find((w) => w.assignmentKey === a.key);
                  return (
                    <article className="assignment-row" key={a.key}>
                      <strong>{a.title}</strong>
                      <p className="muted">
                        {w
                          ? assignmentStatus(w, state.work)
                          : "Awaiting approval"}
                      </p>
                      {w && (
                        <button onClick={() => openWork(w.id)}>
                          Inspect execution
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
            </details>
          </details>
        </>
      ) : (
        <>
          <div className="milestones-heading">
            <div>
              <h2>Milestones</h2>
              <p>
                Foreman proposes outcomes here for you to review and discuss.
              </p>
            </div>
          </div>
          {!state.planning.milestones.length && (
            <div className="milestone-empty">
              <h3>No milestones yet</h3>
              <p>
                Foreman will bring proposals here as scheduled work uncovers
                useful next steps. You can also discuss your direction with
                Foreman in Inbox.
              </p>
            </div>
          )}
          {(
            [
              "proposed",
              "active",
              "acceptance",
              "paused",
              "completed",
              "declined",
            ] as const
          ).map((group) => {
            const milestones = state.planning.milestones.filter(
              (m) => m.status === group,
            );
            return !milestones.length ? null : (
              <section className="milestone-group" key={group}>
                <h3>
                  {
                    {
                      proposed: "Needs approval",
                      active: "In progress",
                      acceptance: "Acceptance testing",
                      paused: "Paused",
                      completed: "Completed",
                      declined: "Declined",
                    }[group]
                  }
                </h3>
                {milestones.map((m) => {
                  const work = state.work.filter((w) => w.milestoneId === m.id),
                    done = work.filter((w) => w.status === "done").length;
                  const percent = work.length
                    ? Math.round((done / work.length) * 100)
                    : 0;
                  const needsInput = work.some((w) => w.status === "blocked");
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
                          {needsInput ? "Needs your input" : status(m)}
                          {m.status === "active"
                            ? " · " + percent + "% complete"
                            : ""}
                        </span>
                      </div>
                      {m.status === "active" && (
                        <progress
                          value={percent}
                          max={100}
                          aria-label={m.title + " progress"}
                        />
                      )}
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
