import { z } from "zod";
import type { Document } from "../contracts";
import type { Lens } from "./discovery";
import { defaultAgentConfiguration } from "./agents";
import { DOCUMENT_OUTPUT_LIMIT } from "./document-edit";
const text = z.string().trim().min(1);
export const libraryLocationSchema = z.object({
  collection: text.max(80),
  parentId: text.nullable(),
  relatedIds: z.array(text).max(12),
});
export const libraryUpdateSchema = libraryLocationSchema.extend({
  formatVersion: z.literal(1).optional(),
  replaceWholeDocument: z.boolean().optional(),
  summary: text.max(1500).optional(),
  scope: text.max(1000).optional(),
  aliases: z.array(text.max(160)).max(12).optional(),
  documentId: text.nullable(),
  expectedVersion: z.number().int().positive().nullable(),
  title: text.max(160),
  content: text.max(DOCUMENT_OUTPUT_LIMIT),
  sources: z.array(text).min(1).max(30),
  needsApproval: z.boolean(),
  disposition: z.enum(["current", "withdrawn"]).optional(),
  reviewAfter: z.string().datetime().nullable().optional(),
  reason: text.max(2000),
});
export type LibraryUpdate = z.infer<typeof libraryUpdateSchema>;
export type LibraryPage = z.infer<typeof libraryLocationSchema> & {
  formatVersion?: 1;
  summary?: string;
  scope?: string;
  aliases?: string[];
  sources: string[];
  withdrawn?: boolean;
  reviewedAt?: string;
  reviewAfter?: string | null;
  managed: boolean;
  updatedAt: string;
};
export type LibraryProposal = LibraryUpdate & {
  appliedDocumentId?: string;
  id: string;
  reviewSignature?: string;
  status: "pending" | "accepted" | "dismissed";
};
export type LibraryState = {
  version: 1;
  intakeVersion?: 1;
  intake: Record<
    string,
    {
      status: "collecting" | "ready" | "pending_decision";
      sources: string[];
      workId?: string;
      runId?: string;
      suggestedSubjectId?: string;
      batchId?: string;
      processedCharacters?: number;
      reviewedVersion?: number;
    }
  >;
  batches: Record<
    string,
    {
      sources: {
        id: string;
        version: number;
        action: "incorporate" | "discard";
        through: number;
        documentIds: string[];
        proposalIds: string[];
      }[];
      proposalIds: string[];
      documentIds: string[];
    }
  >;
  receipts: {
    runId: string;
    at: string;
    intakeId: string;
    action: "incorporate" | "discard" | "deleted";
    documentIds: string[];
  }[];
  withdrawnSources?: Record<string, { reason: string; at: string }>;
  pages: Record<string, LibraryPage>;
  pending: Record<string, number>;
  processed: Record<string, number>;
};
export const initialLibrary = (): LibraryState => ({
  version: 1,
  intake: {},
  batches: {},
  receipts: [],
  pages: {},
  pending: {},
  processed: {},
});
export const libraryTask = (): Lens => ({
  id: "knowledge-library",
  kind: "knowledge",
  name: "Knowledge library",
  question:
    "Curate ready Intake into structured, current Knowledge subjects. Preserve useful findings, uncertainty and external citations; delete intake only after successful curation.",
  enabled: true,
  intervalHours: 1,
  schedule: "0 * * * *",
  dailyRunLimit: 6,
  maxActiveIdeas: 6,
  maxInvestigations: 2,
  maxOpenWork: 4,
  inspectUI: false,
  agent: defaultAgentConfiguration(),
  sources: [],
});
export const documentRef = (d: Pick<Document, "id" | "version">) =>
  `document:${d.id}@${d.version}`;
export function intakeReferences(content: string) {
  return [
    ...new Set(
      (content.match(/https?:\/\/[^\s<>"\]\)}]+/g) || []).map(
        (url) => "web:" + url.replace(/[.,;]+$/, ""),
      ),
    ),
  ];
}
export function parseDocumentRef(ref: string) {
  const match = /^document:(.+)@(\d+)$/.exec(ref);
  return match ? { id: match[1]!, version: Number(match[2]) } : null;
}
export const subjectKey = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function importLibrary(documents: Document[]): LibraryState {
  const library = initialLibrary();
  for (const d of documents) {
    if (
      d.level === "knowledge" &&
      ["human", "accepted-proposal"].includes(d.source)
    ) {
      library.pages[d.id] = {
        collection: "Unfiled",
        parentId: null,
        relatedIds: [],
        sources: [],
        managed: false,
        updatedAt: d.updated_at,
      };
    } else library.pending[d.id] = d.version;
  }
  return library;
}
