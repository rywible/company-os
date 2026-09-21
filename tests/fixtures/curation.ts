import type { Context } from "../../src/domain/model";
import { agentResultSchema } from "../../src/domain/model";
import { KNOWLEDGE_SECTIONS } from "../../src/domain/document-edit";
export function structuredKnowledge(content: string) {
  return KNOWLEDGE_SECTIONS.map(
    (h) =>
      `## ${h}\n\n${h === "Current understanding" ? content.replace(/^#{1,2} /gm, "### ") : h === "Overview" ? "Current account of this subject." : "Not established."}`,
  ).join("\n\n");
}
export function curateFixture(c: Context) {
  const sources = c.maintenance!.sources.filter(
    (d) => !!c.maintenance!.intake?.[d.id],
  );
  const deliverables = sources.filter(
    (d) => d.content !== "Verified output" && d.content !== "Grounded result",
  );
  return agentResultSchema.parse({
    message: "Curated intake",
    outcome: "completed",
    requests: [],
    proposals: [],
    work: [],
    observations: [],
    review: null,
    changes: [],
    libraryUpdates: deliverables.map((d) => ({
      documentId: null,
      expectedVersion: null,
      title: d.title,
      content: structuredKnowledge(d.content),
      formatVersion: 1,
      summary: d.title,
      scope: d.title,
      aliases: [],
      collection: "Research",
      parentId: null,
      relatedIds: [],
      sources: [`document:${d.id}@${d.version}`],
      needsApproval: false,
      reason: "Preserve reviewed research",
    })),
    intakeResolutions: sources.map((d) => ({
      documentId: d.id,
      version: d.version,
      action: deliverables.includes(d) ? "incorporate" : "discard",
      reason: "Preserve substantive research; discard empty receipts",
      updateIndexes: deliverables.includes(d) ? [deliverables.indexOf(d)] : [],
    })),
  });
}
