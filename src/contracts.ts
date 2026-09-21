import { z } from "zod";
import { DOCUMENT_STORAGE_LIMIT, DOCUMENT_OUTPUT_LIMIT } from "./domain/document-edit";
export const levels = [
  "constitution",
  "product",
  "architecture",
  "execution",
  "knowledge",
  "intake",
] as const;
export const documentInput = z.object({
  title: z.string().trim().min(1).max(160),
  level: z.enum(levels),
  content: z.string().trim().min(1).max(DOCUMENT_STORAGE_LIMIT),
  expectedVersion: z.number().int().positive().optional(),
});
export const proposalInput = z.object({
  title: z.string().min(1).max(160),
  kind: z.enum(["product", "architecture", "sequence", "challenge"]),
  rationale: z.string().max(8000),
  recommendation: z.string().max(8000),
  documentId: z.string(),
  content: z.string().max(DOCUMENT_OUTPUT_LIMIT),
  evidenceRefs: z.array(z.string()).max(20),
});
export const foremanOutput = z.object({
  message: z.string().min(1).max(16000),
  proposals: z.array(proposalInput).max(4),
});
export type ForemanOutput = z.infer<typeof foremanOutput>;
export type Document = {
  id: string;
  title: string;
  level: (typeof levels)[number];
  content: string;
  version: number;
  updated_at: string;
  indexed_version: number | null;
  source: string;
};
export type Event = {
  id: number;
  type: string;
  actor: string;
  entity_id: string;
  payload: string;
  created_at: string;
};
export type Message = {
  id: string;
  role: string;
  content: string;
  run_id: string | null;
  created_at: string;
};
export type Proposal = {
  id: string;
  run_id: string;
  title: string;
  kind: string;
  rationale: string;
  recommendation: string;
  document_id: string;
  content: string;
  evidence_refs: string;
  base_version: number;
  status: string;
  created_at: string;
  resolved_at: string | null;
};
export type Run = {
  id: string;
  status: string;
  context: string;
  result: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};
export type SearchHit = Document & {
  excerpt: string;
  score: number;
  match: string;
};
export type Snapshot = {
  documents: Document[];
  events: Event[];
  proposals: Proposal[];
  messages: Message[];
  runs: Run[];
  jobs: { status: string; count: number }[];
  integrations: {
    sprite: string;
    configured: boolean;
    google: boolean;
    github: boolean;
    embeddingModel: string;
  };
};
