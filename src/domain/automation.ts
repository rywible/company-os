import type { Document } from "../contracts";
import { hasLibraryWork, libraryFreshness } from "./freshness";
import type { CompanyState, Run } from "./model";
import type { Lens } from "./discovery";
export const activeIdea = (idea: { status: string }) =>
  ["candidate", "investigating", "ready", "pursued", "evaluating"].includes(
    idea.status,
  );
export function taskForRun(
  state: CompanyState,
  run: Pick<Run, "discoveryLensId" | "workId">,
) {
  const work = state.work.find((w) => w.id === run.workId);
  const id =
    run.discoveryLensId ||
    state.discovery.ideas.find((i) => i.id === work?.discoveryId)?.lensId;
  return state.discovery.lenses.find((l) => l.id === id);
}
export function taskUsage(state: CompanyState, lens: Lens, now: string) {
  return state.runs.filter(
    (r) =>
      r.automatic &&
      (r.budgetDay || r.createdAt.slice(0, 10)) === now.slice(0, 10) &&
      taskForRun(state, r)?.id === lens.id,
  ).length;
}
export function taskCapacity(state: CompanyState, lens: Lens) {
  return (
    lens.kind === "knowledge" ||
    state.discovery.ideas.filter((i) => i.lensId === lens.id && activeIdea(i))
      .length < lens.maxActiveIdeas
  );
}
export function taskDueAt(state: CompanyState, lens: Lens) {
  if (!lens.lastRunAt) return null;
  const signalled =
    lens.kind !== "knowledge" &&
    state.discovery.signals.some(
      (s) => !s.consumedBy && s.lensIds.includes(lens.id),
    );
  return new Date(
    Date.parse(lens.lastRunAt) +
      (signalled
        ? Math.min(lens.intervalHours * 60, 15)
        : lens.intervalHours * 60) *
        60000,
  ).toISOString();
}
export function runCanProceed(state: CompanyState, run: Run) {
  if (!run.automatic) return true;
  const lens = taskForRun(state, run);
  return lens
    ? lens.enabled || !!run.manual
    : !run.automatic || state.settings.enabled;
}
export function taskBlocker(
  state: CompanyState & { documents?: Document[] },
  lens: Lens,
  now: string,
  hasConstitution: boolean,
  configured = true,
  documents = state.documents || [],
) {
  if (!hasConstitution)
    return "Waiting for company direction before running this task.";
  if (!configured) return "Connect the worker before running this task.";
  if (
    state.runs.some(
      (r) =>
        ["queued", "running"].includes(r.status) &&
        taskForRun(state, r)?.id === lens.id,
    )
  )
    return "This task already has a run waiting or in progress.";
  if (taskUsage(state, lens, now) >= lens.dailyRunLimit)
    return "This task has reached its daily run limit. Resets at midnight UTC.";
  if (lens.kind === "knowledge" && !hasLibraryWork(state, documents, now))
    return Object.values(libraryFreshness(state, documents, now)).some(
      (f) => f.status === "needs_review",
    )
      ? "Waiting for a decision or review of a source subject."
      : "The library is up to date. New evidence or a scheduled review will queue a pass.";
  if (!taskCapacity(state, lens))
    return "This task has reached its active idea limit.";
  return null;
}
