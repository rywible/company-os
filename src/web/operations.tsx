import React from "react";
import { Activity, ArrowUpRight, CheckCircle2, CircleAlert, Clock3, GitBranch, History, ShieldCheck, Users } from "lucide-react";
import type { OperatingSummary } from "../application/operations";
import "./operations.css";

function Timestamp({ at }: { at: string }) {
  return <time dateTime={at} title={new Date(at).toLocaleString()}>{new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>;
}
function checkLabel(name: string) {
  if (name.startsWith("worker:")) return name.slice(7);
  return ({ backup: "Backup restore", repository: "GitHub connection", "replication-heartbeat": "Recovery heartbeat", workers: "Worker authentication" } as Record<string, string>)[name] || name;
}
export function OperatingStatus({ summary, history, inbox, work, milestone, automations }: {
  summary?: OperatingSummary;
  history(): void;
  inbox(): void;
  work(id: string): void;
  milestone(id?: string): void;
  automations(): void;
}) {
  if (!summary) return <section className="operations-page"><h1>Operating status</h1><p className="operations-empty">Status is unavailable. Refresh the page to try again.</p></section>;
  const checks = { ...summary.checks };
  if (!checks.backup) checks.backup = { status: "unknown", checkedAt: "", detail: "No backup restore has been recorded." };
  if (!Object.keys(checks).some(name => name.startsWith("worker:"))) checks.workers = { status: "unknown", checkedAt: "", detail: "Worker authentication has not been checked." };
  const attention = summary.alerts.length > 0;
  const StatusIcon = attention ? CircleAlert : CheckCircle2;
  return <section className="operations-page" aria-labelledby="operations-title">
    <header className="operations-heading">
      <div><h1 id="operations-title">Operating status</h1><p>Activity, allowances, and recovery.</p></div>
      <button onClick={history}><History size={16} /> Run history</button>
    </header>
    <div className={`operations-condition ${attention ? "needs-attention" : "checks-passing"}`}>
      <StatusIcon size={22} aria-hidden="true" />
      <strong>{attention ? `${summary.alerts.length} ${summary.alerts.length === 1 ? "issue needs" : "issues need"} attention` : "Checks passing"}</strong>
      <span>Updated <Timestamp at={summary.checkedAt} /></span>
    </div>
    <dl className="operations-activity">
      <div><dt>Running</dt><dd>{summary.activeRuns}</dd></div>
      <div><dt>Waiting</dt><dd>{summary.queuedRuns}</dd></div>
      <div><dt>Needs you</dt><dd><button onClick={inbox} aria-label={`Open inbox, ${summary.needsYou} unresolved threads`}>{summary.needsYou}<ArrowUpRight size={15} /></button></dd></div>
      <div><dt>Blocked</dt><dd>{summary.blocked.length}</dd></div>
    </dl>
    {attention && <section className="operations-alerts" aria-labelledby="operations-alerts-title">
      <h2 id="operations-alerts-title">Needs attention</h2>
      <ul>{summary.alerts.map(alert => <li key={alert.id}>
        <CircleAlert size={16} aria-hidden="true" />
        <div><p>{alert.id.startsWith("check:") ? alert.message.replace(`${alert.id.slice(6)}:`, `${checkLabel(alert.id.slice(6))}:`) : alert.message}</p><small>Since <Timestamp at={alert.since} /></small></div>
        {alert.id.startsWith("run:") && <button onClick={history}>View runs</button>}
      </li>)}</ul>
    </section>}
    <div className="operations-columns">
      <div>
        {!!summary.blocked.length && <section className="operations-section">
          <h2>Blocked assignments</h2>
          {summary.blocked.map(item => <button className="operations-link-row" key={item.id} onClick={() => work(item.id)}><strong>{item.title}</strong><ArrowUpRight size={16} /></button>)}
        </section>}
        <section className="operations-section" aria-labelledby="operations-allowances-title">
          <div className="operations-section-heading"><h2 id="operations-allowances-title">Milestone allowances</h2><button onClick={() => milestone()}>View work</button></div>
          {summary.allowances.length ? summary.allowances.map(item => <button className="operations-allowance" key={item.id} onClick={() => milestone(item.id)}>
            <span><strong>{item.title}</strong><ArrowUpRight size={16} /></span>
            <span className={item.remaining === 0 ? "operations-exhausted" : "muted"}>{item.remaining} of {item.total} runs remaining</span>
            <meter min={0} max={Math.max(1, item.total)} value={item.remaining} aria-label={`${item.title}: runs remaining`} />
          </button>) : <p className="operations-empty">No open milestones. Approved work will appear here with its remaining runs.</p>}
        </section>
        <section className="operations-section">
          <h2>Recently shipped</h2>
          {summary.shipped.length ? summary.shipped.map(item => <div className="operations-shipped" key={item.id}>
            <CheckCircle2 size={17} aria-hidden="true" />
            <div><button className="operations-text-link" onClick={() => milestone(item.id)}>{item.title}</button><small>Completed <Timestamp at={item.at} /></small></div>
            {item.url && <a href={item.url} target="_blank" rel="noreferrer" aria-label={`View ${item.title} on GitHub`}><GitBranch size={16} /> GitHub</a>}
          </div>) : <p className="operations-empty">No completed milestones yet.</p>}
        </section>
        {!!summary.automationAllowances.length && <details className="operations-section operations-automations">
          <summary>Automation allowances <span>{summary.automationAllowances.length} schedules</span></summary>
          <div className="operations-section-heading"><button onClick={automations}>View automations</button></div>
          <p className="muted">Today’s runs. Resets at midnight UTC.</p>
          {summary.automationAllowances.map(item => <div className="operations-automation" key={item.id}><strong>{item.title}</strong><span className={item.remaining === 0 ? "operations-exhausted" : "muted"}>{item.remaining} of {item.total} remaining</span></div>)}
        </details>}
      </div>
      <section className="operations-section operations-checks" aria-labelledby="operations-checks-title">
        <h2 id="operations-checks-title">Workers & recovery</h2>
        {Object.entries(checks).sort(([a], [b]) => a.localeCompare(b)).map(([name, check]) => {
          const flagged = summary.alerts.some(alert => alert.id === `check:${name}`);
          const label = check.status === "unknown" ? "Unverified" : check.status === "error" ? "Failed" : flagged ? "Overdue" : "Verified";
          const Icon = name === "backup" ? ShieldCheck : name === "repository" ? GitBranch : name.startsWith("worker") ? Users : Activity;
          return <article className="operations-check" key={name}>
            <div className="operations-check-heading"><Icon size={17} aria-hidden="true" /><h3>{checkLabel(name)}</h3><span className={`operations-check-state ${label === "Verified" ? "is-verified" : "is-unverified"}`}>{label}</span></div>
            <p>{check.detail}</p>
            {check.checkedAt && <small><Clock3 size={12} aria-hidden="true" /><Timestamp at={check.checkedAt} /></small>}
          </article>;
        })}
      </section>
    </div>
  </section>;
}
