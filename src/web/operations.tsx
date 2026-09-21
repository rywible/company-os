import React from "react";
import type { OperatingSummary } from "../application/operations";
export function OperatingStatus({summary, history}: {summary:OperatingSummary;history():void}) {
  return <details className="operating-status">
    <summary>Operating status · {summary.alerts.length ? `${summary.alerts.length} need attention` : "Checks passing"}</summary>
    <p>{summary.activeRuns} running · {summary.queuedRuns} waiting · {summary.needsYou} inbox decisions · {summary.blocked.length} blocked assignments</p>
    {summary.alerts.length > 0 && <ul>{summary.alerts.map(alert => <li key={alert.id}>{alert.message}</li>)}</ul>}
    {summary.allowances.length > 0 && <ul>{summary.allowances.map(m => <li key={m.id}>{m.title}: {m.remaining} of {m.total} runs remaining</li>)}</ul>}
    {!!summary.automationAllowances.length && <details><summary>Automation allowances today (UTC)</summary><ul>{summary.automationAllowances.map(task => <li key={task.id}>{task.title}: {task.remaining} of {task.total} runs remaining</li>)}</ul></details>}
    <p>{summary.shipped.length ? "Recently shipped" : "No completed milestones yet."}</p>
    {summary.shipped.map(m => <p key={m.id}>{m.url ? <a href={m.url} target="_blank" rel="noreferrer">{m.title}</a> : m.title} · {new Date(m.at).toLocaleDateString()}</p>)}
    <details><summary>Worker and recovery checks</summary>{Object.entries(summary.checks).map(([name,check]) => <p key={name}><strong>{name}</strong>: {check.detail} <time>{new Date(check.checkedAt).toLocaleString()}</time></p>)}</details>
    <button onClick={history}>Run history</button>
  </details>;
}
