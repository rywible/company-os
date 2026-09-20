import { z } from "zod";
import type { Document } from "../contracts";
import type { Lens } from "./discovery";
import { defaultAgentConfiguration } from "./agents";
const text = z.string().trim().min(1);
export const libraryLocationSchema = z.object({
  collection: text.max(80),
  parentId: text.nullable(),
  relatedIds: z.array(text).max(12),
});
export const libraryUpdateSchema = libraryLocationSchema.extend({
  documentId: text.nullable(),
  expectedVersion: z.number().int().positive().nullable(),
  title: text.max(160),
  content: text.max(24000),
  sources: z.array(text).min(1).max(30),
  needsApproval: z.boolean(),
  disposition: z.enum(["current", "withdrawn"]).optional(),
  reviewAfter: z.string().datetime().nullable().optional(),
  reason: text.max(2000),
});
export type LibraryUpdate = z.infer<typeof libraryUpdateSchema>;
export type LibraryPage = z.infer<typeof libraryLocationSchema> & {
  sources: string[];
  withdrawn?: boolean;
  reviewedAt?: string;
  reviewAfter?: string | null;
  managed: boolean;
  updatedAt: string;
};
export type LibraryProposal = LibraryUpdate & {
  id: string;
  reviewSignature?: string;
  status: "pending" | "accepted" | "dismissed";
};
export type LibraryState = {
  version: 1;
  withdrawnSources?: Record<string, { reason: string; at: string }>;
  pages: Record<string, LibraryPage>;
  pending: Record<string, number>;
  processed: Record<string, number>;
};
export const initialLibrary = (): LibraryState => ({
  version: 1,
  pages: {},
  pending: {},
  processed: {},
});
export const libraryTask = (): Lens => ({
  id: "knowledge-library",
  kind: "knowledge",
  name: "Knowledge library",
  question:
    "Maintain coherent subject pages from new documents and findings. Preserve evidence, decisions and uncertainty; bring changes of direction to the inbox.",
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
