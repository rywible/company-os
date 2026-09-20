import React, { useState } from "react";
import type { CompanyState } from "../domain/model";
import type { CommandHandler } from "./settings";
export function AutomationPage({
  state,
  disabled,
  command,
  discovery,
  openWork,
  openIdeas,
}: {
  state: CompanyState;
  disabled: boolean;
  command: CommandHandler;
  discovery(mode: "perspectives" | "signals" | "limits"): React.ReactNode;
  openWork(): void;
  openIdeas(): void;
}) {
  const [tab, setTab] = useState("Overview"),
    [editing, setEditing] = useState(false),
    [limits, setLimits] = useState(false);
  const s = state.settings;
  const [schedule, setSchedule] = useState({
    intervalMinutes: s.intervalMinutes,
    dailyBudget: s.dailyBudget,
    maxOpenWork: s.maxOpenWork,
  });
  const today = state.runs.filter(
    (r) =>
      r.automatic &&
      r.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10),
  ).length;
  return (
    <div className="automation-page">
      <div
        className="section-tabs"
        role="group"
        aria-label="Automation sections"
      >
        {["Overview", "Perspectives", "Feedback"].map((name) => (
          <button
            key={name}
            aria-pressed={tab === name}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>
      {tab === "Overview" ? (
        <>
          <section className="automation-status">
            <div>
              <h2>{s.enabled ? "Foreman is on" : "Foreman is paused"}</h2>
              <p className="muted">
                {s.enabled
                  ? `Next check ${new Date(s.nextHeartbeatAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.`
                  : "Scheduled work is paused. A running task can still finish."}
              </p>
            </div>
            <button
              disabled={disabled}
              onClick={() =>
                void command({
                  ...s,
                  type: "ConfigureAutonomy",
                  enabled: !s.enabled,
                })
              }
            >
              {s.enabled ? "Pause automation" : "Resume automation"}
            </button>
          </section>
          <div className="automation-metrics">
            <div>
              <strong>
                {today} / {s.dailyBudget}
              </strong>
              <span>Runs today · UTC</span>
            </div>
            <div>
              <strong>
                {
                  state.work.filter(
                    (w) => !["done", "cancelled"].includes(w.status),
                  ).length
                }{" "}
                / {s.maxOpenWork}
              </strong>
              <span>Open work</span>
            </div>
            <div>
              <strong>{s.intervalMinutes} min</strong>
              <span>Between checks</span>
            </div>
          </div>
          <div className="automation-links">
            <button onClick={openWork}>Work in progress</button>
            <button onClick={openIdeas}>Ideas and experiments</button>
            <button
              disabled={disabled || !s.enabled}
              onClick={() => void command({ type: "Heartbeat" })}
            >
              Check now
            </button>
          </div>
          <section className="preference-section">
            <div className="preference-heading">
              <div>
                <h2>Schedule & limits</h2>
                <p className="muted">
                  Research and delivery share one daily budget.
                </p>
              </div>
              {!editing && (
                <button
                  onClick={() => {
                    setSchedule({
                      intervalMinutes: s.intervalMinutes,
                      dailyBudget: s.dailyBudget,
                      maxOpenWork: s.maxOpenWork,
                    });
                    setEditing(true);
                  }}
                >
                  Edit schedule
                </button>
              )}
            </div>
            {editing && (
              <form
                className="editor"
                onSubmit={(e) => {
                  e.preventDefault();
                  void command({
                    ...s,
                    ...schedule,
                    type: "ConfigureAutonomy",
                  }).then((ok) => {
                    if (ok) setEditing(false);
                  });
                }}
              >
                <div className="form-grid">
                  {[
                    {
                      key: "intervalMinutes",
                      name: "Minutes between checks",
                      min: 15,
                      max: 1440,
                    },
                    {
                      key: "dailyBudget",
                      name: "Runs per day",
                      min: 1,
                      max: 24,
                    },
                    {
                      key: "maxOpenWork",
                      name: "Open work limit",
                      min: 1,
                      max: 10,
                    },
                  ].map((f) => (
                    <label key={f.key}>
                      {f.name}
                      <input
                        type="number"
                        required
                        min={f.min}
                        max={f.max}
                        value={schedule[f.key as keyof typeof schedule]}
                        onChange={(e) =>
                          setSchedule({
                            ...schedule,
                            [f.key]: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <div className="actions">
                  <button className="primary" disabled={disabled}>
                    Save schedule
                  </button>
                  <button type="button" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </section>
          <section className="preference-section">
            <div className="preference-heading">
              <div>
                <h2>Exploration</h2>
                <p className="muted">
                  {state.discovery.enabled
                    ? "Investigates ideas before bringing a recommendation to your inbox."
                    : "Scouting new ideas is paused."}
                </p>
              </div>
              <button aria-expanded={limits} onClick={() => setLimits(!limits)}>
                {limits ? "Close limits" : "Adjust limits"}
              </button>
            </div>
            {limits && discovery("limits")}
          </section>
        </>
      ) : (
        discovery(tab === "Perspectives" ? "perspectives" : "signals")
      )}
    </div>
  );
}
