import type { Context } from "./model";
/** Stable aliases for material actually supplied in this snapshot, including legacy snapshots. */
export function evidenceReferences(context: Context): string[] {
  const refs = new Set(context.evidenceRefs);
  for (const work of [
    ...(context.portfolio?.work || []),
    ...(context.work ? [context.work] : []),
  ]) {
    refs.add(`work:${work.id}`);
    const pr = work.pullRequest;
    // This reference covers supplied PR metadata/description, not an unseen diff or test execution.
    if (pr) refs.add(`github:${pr.repository}#${pr.number}@${pr.head}`);
  }
  return [...refs];
}
