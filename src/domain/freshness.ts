import type { Document } from "../contracts";
import type { CompanyState } from "./model";
import { parseDocumentRef } from "./library";
export type FreshnessReason = {
  code:
    | "changed"
    | "missing"
    | "inactive"
    | "withdrawn"
    | "upstream"
    | "cycle"
    | "due";
  message: string;
  source?: string;
};
export type Freshness = {
  status: "current" | "needs_review" | "withdrawn";
  reasons: FreshnessReason[];
  signature: string;
};
/** Derived at use time, so neither outbox lag nor an overdue scheduler can expose stale pages. */
export function libraryFreshness(
  state: CompanyState,
  documents: Document[],
  now: string,
): Record<string, Freshness> {
  const docs = new Map(documents.map((d) => [d.id, d]));
  const result: Record<string, Freshness> = {};
  const visiting = new Set<string>();
  function visit(id: string): Freshness {
    if (result[id]) return result[id]!;
    const page = state.library.pages[id];
    if (!page) return { status: "current", reasons: [], signature: "" };
    if (visiting.has(id))
      return {
        status: "needs_review",
        reasons: [
          {
            code: "cycle",
            message: "Circular source dependency needs review.",
          },
        ],
        signature: "cycle",
      };
    visiting.add(id);
    const reasons: FreshnessReason[] = [];
    if (page.withdrawn)
      reasons.push({
        code: "withdrawn",
        message: "This subject has been withdrawn.",
      });
    if (page.reviewAfter && Date.parse(page.reviewAfter) <= Date.parse(now))
      reasons.push({
        code: "due",
        message: `Scheduled review was due ${page.reviewAfter.slice(0, 10)}.`,
      });
    for (const source of page.sources) {
      const withdrawn = state.library.withdrawnSources?.[source];
      if (withdrawn) {
        reasons.push({
          code: "withdrawn",
          source,
          message: `Source withdrawn: ${withdrawn.reason}`,
        });
        continue;
      }
      const ref = parseDocumentRef(source);
      if (!ref) continue; // External evidence changes require an explicit signal or a scheduled review.
      const d = docs.get(ref.id),
        title = d?.title || ref.id;
      if (!d) {
        reasons.push({
          code: "missing",
          source,
          message: `Source “${title}” is missing.`,
        });
        continue;
      }
      if ((state.policies[ref.id]?.status || "active") !== "active")
        reasons.push({
          code: "inactive",
          source,
          message: `Source “${title}” is ${state.policies[ref.id]!.status}.`,
        });
      if (d.version !== ref.version)
        reasons.push({
          code: "changed",
          source,
          message: `Source “${title}” changed from v${ref.version} to v${d.version}.`,
        });
      if (state.library.pages[ref.id]) {
        const parent = visit(ref.id);
        if (parent.status !== "current")
          reasons.push({
            code:
              parent.status === "withdrawn"
                ? "withdrawn"
                : visiting.has(ref.id)
                  ? "cycle"
                  : "upstream",
            source,
            message: `Source subject “${title}” ${parent.status === "withdrawn" ? "was withdrawn" : "needs review"}.`,
          });
      }
    }
    visiting.delete(id);
    const status =
      page.withdrawn || state.policies[id]?.status === "retired"
        ? "withdrawn"
        : reasons.length
          ? "needs_review"
          : "current";
    const signature = JSON.stringify({
      version: docs.get(id)?.version,
      status,
      reasons,
      reviewAfter: page.reviewAfter || null,
    });
    return (result[id] = { status, reasons, signature });
  }
  for (const id of Object.keys(state.library.pages)) visit(id);
  return result;
}
export function reviewTargets(
  state: CompanyState,
  documents: Document[],
  now: string,
) {
  const freshness = libraryFreshness(state, documents, now);
  return Object.keys(freshness).filter((id) => {
    const f = freshness[id]!;
    return (
      f.status === "needs_review" &&
      (state.policies[id]?.status || "active") === "active" &&
      !f.reasons.some((r) => r.code === "upstream") &&
      !state.threads.some((t) =>
        t.libraryProposals?.some(
          (p) =>
            p.documentId === id &&
            p.status === "pending" &&
            p.reviewSignature === f.signature,
        ),
      )
    );
  });
}
export const hasLibraryWork = (
  state: CompanyState,
  documents: Document[],
  now: string,
) =>
  Object.keys(state.library.pending).length > 0 ||
  reviewTargets(state, documents, now).length > 0;
