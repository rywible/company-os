import React, { useState } from "react";
import type { CompanyState, Command, Context } from "../domain/model";
import type { Lens } from "../domain/discovery";

type Props = {
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
  const [tab, setTab] = useState("ideas"),
    [filter, setFilter] = useState("active"),
    [reason, setReason] = useState(""),
    [feedback, setFeedback] = useState(""),
    [feedbackLens, setFeedbackLens] = useState("users"),
    [editing, setEditing] = useState<Lens | null>(null);
  const idea = d.ideas.find((i) => i.id === p.selected);
  const pending = d.ideas.filter((i) =>
    ["candidate", "investigating", "ready", "pursued", "evaluating"].includes(
      i.status,
    ),
  );
  const count = p.state.runs.filter(
    (r) =>
      r.automatic &&
      r.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10),
  ).length;
  const command = p.command;
  const decide = (action: "pursue" | "park" | "discard" | "revisit") =>
    idea &&
    command({ type: "DecideDiscovery", ideaId: idea.id, action, reason });
  return (
    <section className="discovery-page">
      <div className="discovery-summary">
        <p>
          {d.enabled && p.state.settings.enabled
            ? "Discovery on"
            : "Discovery paused"}{" "}
          · {pending.length}/{d.maxActiveIdeas} active ideas · {count}/
          {p.state.settings.dailyBudget} shared runs today
        </p>
        <button
          disabled={p.disabled || !d.enabled || !p.state.settings.enabled}
          onClick={() => void command({ type: "ExploreDiscovery" })}
        >
          Explore next
        </button>
      </div>
      <p className="muted">
        A hunch gets investigated before it reaches your inbox. Outcomes feed
        back into Memory.
      </p>
      <div className="discovery-tabs" role="group" aria-label="Discovery views">
        {["ideas", "perspectives", "signals"].map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === "ideas" && (
        <>
          <label className="discovery-filter">
            Show{" "}
            <select
              aria-label="Filter ideas"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              {["active", "ready", "learned", "parked", "discarded", "all"].map(
                (f) => (
                  <option key={f}>{f}</option>
                ),
              )}
            </select>
          </label>
          <div className="discovery-layout">
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
            {idea && (
              <article className="discovery-detail" aria-label="Discovery idea">
                <div className="discovery-heading">
                  <h2>{idea.title}</h2>
                  <span>{idea.status}</span>
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
                      Memory record ↗
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
      )}
      {tab === "perspectives" && (
        <>
          <form
            className="discovery-settings"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void command({
                type: "ConfigureDiscovery",
                enabled: f.get("enabled") === "on",
                explorationEvery: Number(f.get("exploration")),
                maxActiveIdeas: Number(f.get("capacity")),
                maxInvestigations: Number(f.get("investigations")),
              });
            }}
            key={`${d.enabled}:${d.explorationEvery}:${d.maxActiveIdeas}:${d.maxInvestigations}`}
          >
            <label>
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={d.enabled}
                disabled={p.disabled}
              />{" "}
              Discovery enabled
            </label>
            <label>
              Reserve an exploratory scout every{" "}
              <input
                name="exploration"
                type="number"
                min="1"
                max="12"
                defaultValue={d.explorationEvery}
              />{" "}
              scouts
            </label>
            <label>
              Active idea limit
              <input
                name="capacity"
                type="number"
                min="1"
                max="20"
                defaultValue={d.maxActiveIdeas}
              />
            </label>
            <label>
              Investigations per idea
              <input
                name="investigations"
                type="number"
                min="1"
                max="3"
                defaultValue={d.maxInvestigations}
              />
            </label>
            <button disabled={p.disabled}>Save discovery settings</button>
          </form>
          <p className="muted">
            Scouts and their work share the automatic run budget in Settings.
            Exploratory perspectives reserve time for questions without an
            existing ticket. All perspectives use repository context, Memory and
            your signals; UI experiments also inspect Chrome. Perspectives can
            also read current public GitHub releases from up to three
            repositories you choose. General web search is not connected.
          </p>
          <button
            disabled={p.disabled}
            onClick={() =>
              setEditing({
                id: crypto.randomUUID(),
                name: "",
                question: "",
                enabled: true,
                exploratory: true,
                inspectUI: false,
                intervalHours: 48,
                sources: [],
              })
            }
          >
            Add perspective
          </button>
          {editing && (
            <form
              className="discovery-editor"
              aria-label="Edit perspective"
              onSubmit={(e) => {
                e.preventDefault();
                void command({
                  type: "SaveDiscoveryLens",
                  lens: {
                    ...editing,
                    sources: editing.sources
                      .map((s) => s.trim())
                      .filter(Boolean),
                  },
                }).then((ok) => {
                  if (ok) setEditing(null);
                });
              }}
            >
              <label>
                Name
                <input
                  aria-label="Perspective name"
                  required
                  maxLength={80}
                  value={editing.name}
                  onChange={(e) =>
                    setEditing({ ...editing, name: e.target.value })
                  }
                />
              </label>
              <label>
                Question
                <textarea
                  aria-label="Perspective question"
                  required
                  maxLength={2000}
                  value={editing.question}
                  onChange={(e) =>
                    setEditing({ ...editing, question: e.target.value })
                  }
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={editing.inspectUI}
                  onChange={(e) =>
                    setEditing({ ...editing, inspectUI: e.target.checked })
                  }
                />{" "}
                Inspect the live interface before scouting
              </label>
              <label>
                GitHub release sources (owner/repo, one per line)
                <textarea
                  aria-label="Release sources"
                  value={(editing.sources || []).join("\n")}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      sources: e.target.value.split("\n"),
                    })
                  }
                />
              </label>
              <label>
                Hours between checks
                <input
                  type="number"
                  min="1"
                  max="720"
                  value={editing.intervalHours}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      intervalHours: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={editing.enabled}
                  onChange={(e) =>
                    setEditing({ ...editing, enabled: e.target.checked })
                  }
                />{" "}
                Enabled
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={editing.exploratory}
                  onChange={(e) =>
                    setEditing({ ...editing, exploratory: e.target.checked })
                  }
                />{" "}
                Exploratory
              </label>
              <button disabled={p.disabled} className="primary">
                Save perspective
              </button>
              <button type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </form>
          )}
          <div className="discovery-lenses">
            {d.lenses.map((l) => (
              <article key={l.id}>
                <h3>{l.name}</h3>
                <p>{l.question}</p>
                <p className="muted">
                  {l.enabled ? `Every ${l.intervalHours}h` : "Disabled"}
                  {l.exploratory ? " · exploratory" : ""}
                  <br />
                  {stamp(l.lastRunAt)}
                </p>
                {l.lastRunId && (
                  <p>
                    {p.state.runs.find((r) => r.id === l.lastRunId)?.status} ·{" "}
                    {p.state.runs.find((r) => r.id === l.lastRunId)?.result
                      ?.message || "Awaiting result"}
                  </p>
                )}
                <div>
                  <button
                    disabled={p.disabled}
                    onClick={() => setEditing({ ...l })}
                  >
                    Edit {l.name}
                  </button>
                  <button
                    disabled={
                      p.disabled ||
                      !l.enabled ||
                      !d.enabled ||
                      !p.state.settings.enabled
                    }
                    onClick={() =>
                      void command({ type: "ExploreDiscovery", lensId: l.id })
                    }
                  >
                    Explore {l.name}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
      {tab === "signals" && (
        <>
          <form
            className="discovery-editor"
            onSubmit={(e) => {
              e.preventDefault();
              void command({
                type: "RecordDiscoverySignal",
                lensId: feedbackLens,
                content: feedback,
              }).then((ok) => {
                if (ok) setFeedback("");
              });
            }}
          >
            <label>
              Feedback, a surprising result, or something worth looking into
              <textarea
                aria-label="Discovery signal"
                value={feedback}
                required
                maxLength={8000}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="Include the observation, source or link, and why it might matter."
              />
            </label>
            <label>
              Perspective
              <select
                value={feedbackLens}
                onChange={(e) => setFeedbackLens(e.target.value)}
              >
                {d.lenses.map((l) => (
                  <option value={l.id} key={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={p.disabled || !feedback.trim()}>
              Add signal
            </button>
          </form>
          <p className="muted">
            Signals bring checks forward after a cooldown. Links are retained as
            your input; they are not automatically fetched.
          </p>
          {d.signals.toReversed().map((s) => (
            <article className="discovery-signal" key={s.id}>
              <h3>{s.title}</h3>
              <p>{s.detail}</p>
              <small>
                {stamp(s.at)} ·{" "}
                {s.consumedBy ? "Considered by a scout" : "Pending"}{" "}
                {s.count > 1 ? `· ${s.count} occurrences` : ""}
              </small>
            </article>
          ))}
        </>
      )}
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
