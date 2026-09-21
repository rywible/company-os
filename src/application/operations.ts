import { taskUsage } from "../domain/automation";
import type { CompanyState } from "../domain/model";
export type OperationalCheck = {status: "ok" | "error" | "unknown"; checkedAt: string; detail: string};
export type OperationalAlert = {id:string; message:string; since:string};
export function operatingSummary(state: CompanyState, deliveries: {id:string;status:string;at:string;error:string|null;type:string}[], checks: Record<string, OperationalCheck>, now = Date.now()) {
  const alerts: OperationalAlert[] = [];
  const alert = (id:string, message:string, since:string) => alerts.push({id,message,since});
  for (const run of state.runs) {
    const since = run.startedAt || run.createdAt;
    const minutes = Math.floor((now - Date.parse(since)) / 60000);
    if (run.status === "queued" && minutes >= 5) alert(`run:${run.id}`, `A ${run.trigger} run has been waiting ${minutes} minutes. Check worker availability and its milestone allowance.`, since);
    if (run.status === "running" && minutes >= 35) alert(`run:${run.id}`, `A ${run.trigger} run has been running ${minutes} minutes. Inspect its worker and logs.`, since);
  }
  for (const job of deliveries) {
    const minutes = Math.floor((now - Date.parse(job.at)) / 60000);
    if (job.status === "failed") alert(`delivery:${job.id}`, job.error || `${job.type} failed.`, job.at);
    else if (minutes >= 15) alert(`delivery:${job.id}`, `${job.type} has waited ${minutes} minutes${job.error ? `: ${job.error}` : ". Check its worker or repository CI."}`, job.at);
  }
  for (const [name, check] of Object.entries(checks)) {
    const stale = now - Date.parse(check.checkedAt) > (name === "backup" ? 2 * 3600000 : 10 * 60000);
    if (check.status !== "ok" || stale) alert(`check:${name}`, `${name}: ${stale ? "Verification is overdue." : check.detail}`, check.checkedAt);
  }
  if (!checks.backup) alert("check:backup", "Backup recovery has not been verified.", new Date(now).toISOString());
  if (!Object.keys(checks).some(name => name.startsWith("worker:"))) alert("check:workers", "Worker authentication has not been verified.", new Date(now).toISOString());
  const milestones = state.planning.milestones;
  return {
    checkedAt: new Date(now).toISOString(), alerts, checks,
    shipped: milestones.filter(m => m.status === "completed").map(m => ({id:m.id,title:m.title,at:m.updatedAt,url:m.delivery?.pullRequest?.url})).slice(-10).reverse(),
    needsYou: state.threads.filter(t => t.kind === "inbox" && t.status !== "resolved").length,
    blocked: state.work.filter(w => w.status === "blocked").map(w => ({id:w.id,title:w.title})),
    activeRuns: state.runs.filter(r => r.status === "running").length,
    queuedRuns: state.runs.filter(r => r.status === "queued").length,
    automationAllowances: state.discovery.lenses.filter(task => task.enabled).map(task => ({id:task.id,title:task.name,remaining:Math.max(0,task.dailyRunLimit-taskUsage(state,task,new Date(now).toISOString())),total:task.dailyRunLimit})),
    allowances: milestones.filter(m => !["completed","declined"].includes(m.status)).map(m => {
      const used = state.runs.filter(r => r.workId && m.workIds.includes(r.workId)).length;
      return {id:m.id,title:m.title,used,remaining:Math.max(0,m.maxRuns-used),total:m.maxRuns};
    }),
  };
}
export type OperatingSummary = ReturnType<typeof operatingSummary>;
