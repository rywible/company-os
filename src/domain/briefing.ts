import type { Context } from "./model";
import { documentRef } from "./library";
/** Explicit sections are also reflected by the inbox's snapshot inspector. */
export function renderBriefing(context: Context): string {
  const pages = (constitution: boolean) =>
    context.documents
      .filter((d) => (d.level === "constitution") === constitution)
      .map((d) => ({
        subject: d.title,
        reference: documentRef(d),
        freshness: context.freshness?.[d.id],
        authority:
          (context.freshness?.[d.id] &&
            context.freshness[d.id]!.status !== "current") ||
          context.entries
            .find((e) => e.id === d.id)
            ?.reason.includes("historical")
            ? "Historical or unreviewed material. Do not treat it as current guidance."
            : constitution
              ? "Human-owned company direction"
              : d.level !== "knowledge"
                ? "Governing document"
                : "Current understanding; assess evidence and uncertainty in the content",
        selectedBecause: context.entries.find((e) => e.id === d.id)?.reason,
        content: d.content,
      }));
  return [
    "# 1. Constitution\n" + JSON.stringify(pages(true), null, 2),
    "# 2. Relevant knowledge\n" +
      JSON.stringify(
        {
          pages: pages(false),
          gaps: context.gaps || [],
          additionalContextRequested: context.additionalRequests || [],
        },
        null,
        2,
      ),
    "# 3. Conversation\n" +
      JSON.stringify(
        {
          subject: context.subject,
          runningSummary: context.conversationSummary,
          messages: context.messages,
        },
        null,
        2,
      ),
    "# 4. Assignment\n" +
      JSON.stringify(
        {
          task: context.assignment || context.query,
          work: context.work,
          discovery: context.discovery,
          review: context.review,
          maintenance: context.maintenance,
          portfolio: context.portfolio,
        },
        null,
        2,
      ),
    "# Supporting evidence\n" +
      JSON.stringify(
        {
          repository: context.repository,
          repositoryError: context.repositoryError,
          browser: context.browser,
          externalSources: context.externalSources,
          evidenceRefs: context.evidenceRefs,
        },
        null,
        2,
      ),
  ].join("\n\n");
}
