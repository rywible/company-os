import React, { useEffect, useState } from "react";
import { ChevronRight, Copy, History } from "lucide-react";
import type { CompanyState } from "../domain/model";
import type { OperatingSummary } from "../application/operations";
import "./operations.css";

export type OperationsProps = {
  summary?: OperatingSummary;
  state: Pick<CompanyState, "threads" | "work" | "runs" | "planning">;
  deliveryErrors: { id: string; error: string }[];
  disabled: boolean;
  history(): void;
  thread(id: string): void;
  work(id: string): void;
  milestone(id?: string): void;
  automations(): void;
  retryDelivery(id: string): Promise<boolean>;
};
function Timestamp({ at }: { at: string }) {
  return <time dateTime={at}>{new Date(at).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  })}</time>;
}
function savedSelection(key: string, fallback: string) {
  try { return sessionStorage.getItem(key) || fallback; }
  catch { return fallback; }
}
function systemGroups(summary: OperatingSummary) {
  const checks = Object.entries(summary.checks);
  return [
    { id: "workers", title: "Worker connections", names: checks.filter(([name]) => name.startsWith("worker:")).map(([name]) => name),
      alerts: summary.alerts.filter(a => a.id.startsWith("check:worker")),
      impact: "Workers need a working connection and a signed-in model provider to take assignments.",
      steps: ["Open the Company OS service logs and find the worker named in the diagnostic details.", "Have the coding agent that manages Company OS check that worker’s connection and renew its provider sign-in if needed.", "Worker checks repeat every five minutes. This item clears after a successful check."],
      healthy: "Worker connections and provider sign-ins are verified.",
    },
    { id: "repository", title: "GitHub connection", names: ["repository"],
      alerts: summary.alerts.filter(a => a.id === "check:repository"),
      impact: "Repository access is needed to check out code, push changes, and publish reviews.",
      steps: ["Read the diagnostic details to identify the repository and the access failure.", "Have the coding agent that manages Company OS check the GitHub connection, organization app approval, and repository key permissions.", "Repository checks repeat every five minutes. This item clears after access is verified."],
      healthy: "Repository access is verified.",
    },
    { id: "backup", title: "Backup recovery", names: ["backup"],
      alerts: summary.alerts.filter(a => a.id === "check:backup"),
      impact: "The latest backup has not been confirmed recoverable. A restore check needs attention.",
      steps: ["Open the Company OS service logs and read the restore failure in the diagnostic details.", "Have the coding agent that manages Company OS repair replication or storage access, then run the isolated backup verification. Keep the live database in place.", "A failed restore is checked again after five minutes; successful restores are normally verified hourly. This item clears after a successful restore."],
      healthy: "A backup was restored and its saved records were checked.",
    },
    { id: "jobs", title: "Delayed or failed work", names: [],
      alerts: summary.alerts.filter(a => !a.id.startsWith("check:")),
      impact: "Some work has failed or is taking longer than expected. An age warning alone does not mean a job has stopped.",
      steps: ["Open the affected assignment or conversation below and read its latest result.", "For a failure, correct the reported problem before retrying. For a delay, check the worker connections and any pending GitHub checks before intervening."],
      healthy: "No delayed or failed deliveries need attention.",
    },
  ];

}
type SystemGroup = ReturnType<typeof systemGroups>[number];
function SystemDetail({ props, system }: { props: OperationsProps; system: SystemGroup }) {
  const { state, work, thread, history } = props;
  const checks = Object.entries(props.summary?.checks || {});
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const systemChecks = checks.filter(([name]) => system.names.includes(name));
  const hasProblem = system.alerts.length > 0;
  const checkProblem = system.id === "jobs" ? "" : systemChecks.some(([, check]) => check.status === "error")
    ? "The latest check failed. "
    : system.alerts.some(alert => alert.message.includes("overdue"))
      ? "Verification is overdue. The last result is no longer current. "
      : "Verification has not completed. ";
  const monitoring = location.hostname.endsWith(".fly.dev")
    ? `https://fly.io/apps/${location.hostname.slice(0, -8)}/monitoring` : null;
  const brief = [
    `Company OS: ${system.title}`, system.impact, ...system.steps,
    ...system.alerts.map(a => `${a.message} (since ${a.since})`),
    ...systemChecks.map(([name, check]) => `${name}: ${check.detail} (${check.checkedAt})`),
  ].join("\n\n");
  async function copyBrief() {
    try { await navigator.clipboard.writeText(brief); setCopied(true); setCopyError(false); }
    catch { setCopied(false); setCopyError(true); }
  }

  return <article className="operations-focus" key={system.id}>
          <p className="operations-context">{hasProblem ? "System repair" : "System verification"}</p><h2>{system.title}</h2>
          <p className="operations-reason">{hasProblem ? checkProblem + system.impact : systemChecks.length || system.id === "jobs" ? system.healthy : "A check has not been recorded yet."}</p>
          {hasProblem && <><h3>What to do</h3><ol className="operations-steps">{system.steps.map(step => <li key={step}>{step}</li>)}</ol>
            {system.id !== "jobs" && <div className="operations-actions"><button onClick={() => void copyBrief()}><Copy size={15} />{copied ? "Copied repair brief" : "Copy repair brief"}</button>{monitoring && <a href={monitoring} target="_blank" rel="noreferrer">Open service logs</a>}</div>}
            {system.id === "jobs" && system.alerts.map(alert => {
              const run = state.runs.find(r => `run:${r.id}` === alert.id);
              const assignment = state.work.find(w => w.id === run?.workId);
              const conversation = state.threads.find(t => t.id === run?.threadId);
              const failed = props.deliveryErrors.find(d => `delivery:${d.id}` === alert.id);
              return <div className="operations-job" key={alert.id}><h3>{assignment?.title || conversation?.subject || (failed ? "Failed delivery" : "Delayed work")}</h3><p>{alert.message}</p>
                {assignment ? <button onClick={() => work(assignment.id)}>Open assignment</button> : conversation ? <button onClick={() => thread(conversation.id)}>Open conversation</button> : <button onClick={history}>Review run history</button>}
                {failed && <button disabled={props.disabled} onClick={() => void props.retryDelivery(failed.id)}>Retry delivery</button>}
              </div>;
            })}
          </>}
          {copyError && <p role="status">Copy is unavailable. Select the repair brief in Diagnostic details below.</p>}
          <details className="operations-diagnostics" open={copyError || undefined}><summary>Diagnostic details</summary>
            {system.alerts.map(alert => <p key={alert.id}>{alert.message}<small>Since <Timestamp at={alert.since} /></small></p>)}
            {systemChecks.map(([name, check]) => <p key={name}><strong>{name.startsWith("worker:") ? name.slice(7) : system.title}</strong><br />{check.detail}<small>Last checked <Timestamp at={check.checkedAt} /></small></p>)}
            {!system.alerts.length && !systemChecks.length && <p>No additional details.</p>}
            {hasProblem && system.id !== "jobs" && <><p>Share this brief with the coding agent that manages Company OS:</p><textarea readOnly aria-label="Repair brief" value={brief} rows={6} /></>}
          </details>
        </article>;
}

export function OperatingStatus(props: OperationsProps) {
  const { summary, history, milestone, automations } = props;
  const [tab, setTab] = useState(() => savedSelection("status:tab", "In progress") === "System checks" ? "System checks" : "In progress");
  const [systemSelected, setSystemSelected] = useState(() => savedSelection("status:system", "workers"));
  useEffect(() => {
    try { sessionStorage.setItem("status:tab", tab); sessionStorage.setItem("status:system", systemSelected); }
    catch { /* Keep navigation usable. */ }
  }, [tab, systemSelected]);
  if (!summary) return <section className="operations-page"><h1>Operating status</h1><p>Status is unavailable. Refresh the page to try again.</p></section>;
  const groups = systemGroups(summary);
  const system = groups.find(group => group.id === systemSelected) || groups[0]!;
  const checks = Object.entries(summary.checks);
  return <section className="operations-page" aria-labelledby="operations-title">
    <header className="operations-heading"><div><h1 id="operations-title">Operating status</h1><p>Progress and system health. Decisions live in Inbox.</p></div><button onClick={history}><History size={16} /> Run history</button></header>
    <div className="section-tabs operations-tabs" role="tablist" aria-label="Status sections">{["In progress", "System checks"].map(title => <button key={title} role="tab" id={`status-tab-${title.replaceAll(" ", "-")}`} aria-selected={tab === title} aria-controls="status-content" onClick={() => setTab(title)}>{title}</button>)}</div>
    <div id="status-content" role="tabpanel" aria-labelledby={`status-tab-${tab.replaceAll(" ", "-")}`}>
      {tab === "In progress" && <div className="operations-progress">
        <p className="operations-quiet">{summary.activeRuns} running · {summary.queuedRuns} waiting</p>
        <section><h2>Open milestones</h2>
          {summary.allowances.length ? summary.allowances.map(item => <button className="operations-work-row" key={item.id} onClick={() => milestone(item.id)}><span><strong>{item.title}</strong><small>{item.remaining} of {item.total} runs remaining</small></span><ChevronRight size={16} /></button>) : <p className="operations-quiet">No open milestones.</p>}
          <button onClick={() => milestone()}>Open work</button>
        </section>
        <section><h2>Recently shipped</h2>
          {summary.shipped.length ? summary.shipped.map(item => <div className="operations-shipped" key={item.id}><button className="operations-work-row" onClick={() => milestone(item.id)}><span><strong>{item.title}</strong><small>Completed <Timestamp at={item.at} /></small></span><ChevronRight size={16} /></button>{item.url && <a href={item.url} target="_blank" rel="noreferrer">View on GitHub</a>}</div>) : <p className="operations-quiet">No completed milestones yet.</p>}
        </section>
        <details className="operations-diagnostics"><summary>Daily automation allowances</summary><p className="operations-quiet">Resets at midnight UTC.</p>{summary.automationAllowances.map(item => <p key={item.id}>{item.title}: {item.remaining} of {item.total} runs remaining</p>)}<button onClick={automations}>Open automations</button></details>
      </div>}

      {tab === "System checks" && <div className="operations-focus-layout">
        <label className="operations-picker">Check area<select value={system.id} onChange={e => setSystemSelected(e.target.value)}>{groups.map(group => <option key={group.id} value={group.id}>{group.title}</option>)}</select></label>
        <nav className="operations-queue" aria-label="System checks">{groups.map(group => <button key={group.id} aria-current={system.id === group.id ? "true" : undefined} onClick={() => setSystemSelected(group.id)}><span>{group.title}<small>{group.alerts.length ? "Needs attention" : group.id !== "jobs" && !checks.some(([name]) => group.names.includes(name)) ? "Not yet checked" : "Checked"}</small></span><ChevronRight size={15} /></button>)}</nav>
        <SystemDetail key={system.id} props={props} system={system} />
      </div>}
    </div>
    <footer className="operations-footer"><p className="operations-updated">Updated <Timestamp at={summary.checkedAt} /></p><button className="operations-history-mobile" onClick={history}><History size={16} /> Run history</button></footer>
  </section>;
}
