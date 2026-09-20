import React, { useState } from "react";
import type { CompanyState, Command, Context } from "../domain/model";

type Props = {
  mode?: "archive" | "idea";
  state: CompanyState;
  disabled: boolean;
  selected: string | null;
  select(id: string | null): void;
  command(cmd: Command): Promise<boolean>;
  openWork(id: string): void;
  openThread(id: string): void;
  inspect(context: Context): void;
  openKnowledge(id: string): void;
};
const stamp = (at?: string) =>
  at ? new Date(at).toLocaleString() : "Not checked yet";
export function DiscoveryPage(p: Props) {
  const d = p.state.discovery;
  const [filter, setFilter] = useState("active"),
    [reason, setReason] = useState("");
  const idea = d.ideas.find((i) => i.id === p.selected);
  const pending = d.ideas.filter((i) =>
    ["candidate", "investigating", "ready", "pursued", "evaluating"].includes(
      i.status,
    ),
  );
  const command = p.command;
  const decide = (action: "pursue" | "park" | "discard" | "revisit") =>
    idea &&
    command({ type: "DecideDiscovery", ideaId: idea.id, action, reason });
  return (
    <section
      className={
        "discovery-page " + (p.mode === "idea" ? "discovery-inline" : "")
      }
    >
      {
        <>
          {p.mode !== "idea" && (
            <label className="discovery-filter">
              Show{" "}
              <select
                aria-label="Filter ideas"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                {[
                  "active",
                  "ready",
                  "learned",
                  "parked",
                  "discarded",
                  "all",
                ].map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </label>
          )}
          <div className="discovery-layout">
            {p.mode !== "idea" && (
              <div className="discovery-list">
                {d.ideas
                  .filter(
                    (i) =>
                      filter === "all" ||
                      (filter === "active"
                        ? pending.includes(i)
                        : i.status === filter),
                  )
                  .toReversed()
                  .map((i) => (
                    <button
                      key={i.id}
                      aria-pressed={i.id === p.selected}
                      onClick={() => {
                        p.select(i.id);
                        setReason("");
                      }}
                    >
                      <strong>{i.title}</strong>
                      <span>
                        {d.lenses.find((l) => l.id === i.lensId)?.name} ·{" "}
                        {i.status}
                      </span>
                    </button>
                  ))}
                {!d.ideas.length && (
                  <p className="muted">
                    No ideas yet. Explore a perspective or leave a signal.
                  </p>
                )}
              </div>
            )}
            {idea && (
              <article className="discovery-detail" aria-label="Discovery idea">
                <div className="discovery-heading">
                  <h2>{idea.title}</h2>
                  <span className="status-pill">{idea.status}</span>
                </div>
                <p className="muted">{stamp(idea.createdAt)}</p>
                <Finding title="Observation" text={idea.observation} />
                <Finding title="Hypothesis" text={idea.hypothesis} />
                <Finding title="Expected benefit" text={idea.impact} />
                <Finding title="Uncertainty" text={idea.uncertainty} />
                <details>
                  <summary>Experiment</summary>
                  <p>{idea.experiment.instruction}</p>
                  <p>Success: {idea.experiment.criteria}</p>
                </details>
                {idea.assessment && (
                  <Finding
                    title={`Investigation · ${idea.assessment.verdict}`}
                    text={idea.assessment.finding}
                  />
                )}
                {idea.assessment?.proposedWork && (
                  <Finding
                    title="Proposed work"
                    text={`${idea.assessment.proposedWork.instruction}\n\nSuccess: ${idea.assessment.proposedWork.criteria}`}
                  />
                )}
                {idea.outcome && (
                  <Finding
                    title={`Outcome · ${idea.outcome.verdict.replaceAll("_", " ")}`}
                    text={idea.outcome.finding}
                  />
                )}
                {idea.decisionReason && (
                  <Finding title="Your decision" text={idea.decisionReason} />
                )}
                <details>
                  <summary>Evidence & context</summary>
                  <ul>
                    {[
                      ...new Set([
                        ...idea.evidence,
                        ...(idea.assessment?.evidence || []),
                        ...(idea.outcome?.evidence || []),
                      ]),
                    ].map((ref) => (
                      <li key={ref}>
                        <code>{ref}</code>
                      </li>
                    ))}
                  </ul>
                  {p.state.runs
                    .filter(
                      (r) =>
                        r.id === idea.runId ||
                        p.state.work.some(
                          (w) => w.id === r.workId && w.discoveryId === idea.id,
                        ),
                    )
                    .map((r) => (
                      <button
                        key={r.id}
                        disabled={!r.context}
                        onClick={() => r.context && p.inspect(r.context)}
                      >
                        {r.discoveryLensId
                          ? "Scout"
                          : p.state.work.find((w) => w.id === r.workId)
                              ?.discoveryPhase}{" "}
                        · {r.status} · context
                      </button>
                    ))}
                </details>
                <div className="discovery-links">
                  {[
                    ...idea.investigationWorkIds,
                    idea.deliveryWorkId,
                    idea.outcomeWorkId,
                  ]
                    .filter((id): id is string => !!id)
                    .map((id) => (
                      <button key={id} onClick={() => p.openWork(id)}>
                        {p.state.work.find((w) => w.id === id)?.discoveryPhase}{" "}
                        work ↗
                      </button>
                    ))}
                  {idea.threadId && (
                    <button onClick={() => p.openThread(idea.threadId!)}>
                      Inbox thread ↗
                    </button>
                  )}
                  {idea.knowledgeId && (
                    <button onClick={() => p.openKnowledge(idea.knowledgeId!)}>
                      Knowledge entry ↗
                    </button>
                  )}
                </div>
                {!["pursued", "evaluating"].includes(idea.status) && (
                  <div className="discovery-actions">
                    <label>
                      Decision note
                      <textarea
                        aria-label="Discovery decision note"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="What changed, or why this matters"
                      />
                    </label>
                    <div>
                      {idea.status === "ready" && (
                        <button
                          className="primary"
                          disabled={p.disabled}
                          onClick={() => void decide("pursue")}
                        >
                          Pursue
                        </button>
                      )}
                      {["candidate", "investigating", "ready"].includes(
                        idea.status,
                      ) && (
                        <button
                          disabled={p.disabled}
                          onClick={() => void decide("park")}
                        >
                          Park
                        </button>
                      )}
                      {[
                        "candidate",
                        "investigating",
                        "ready",
                        "parked",
                      ].includes(idea.status) && (
                        <button
                          disabled={p.disabled}
                          onClick={() => void decide("discard")}
                        >
                          Discard
                        </button>
                      )}
                      {["parked", "discarded", "learned"].includes(
                        idea.status,
                      ) && (
                        <button
                          disabled={p.disabled || !reason.trim()}
                          onClick={() => void decide("revisit")}
                        >
                          Revisit with new evidence
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </article>
            )}
          </div>
        </>
      }
    </section>
  );
}
function Finding({ title, text }: { title: string; text: string }) {
  return (
    <section>
      <h3>{title}</h3>
      <p className="discovery-prose">{text}</p>
    </section>
  );
}
