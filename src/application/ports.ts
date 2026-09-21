import type { Document, SearchHit } from "../contracts";
import type {
  CompanyState,
  Context,
  AgentResult,
  BrowserEvidence,
  PullRequest,
} from "../domain/model";
import type { AgentConfiguration } from "../domain/agents";
import type { DomainEvent, EventInput, Delivery } from "../domain/events";
export interface Repository {
  transaction<T>(fn: () => T): T;
  state(): CompanyState;
  save(state: CompanyState): void;
  publish(
    event: EventInput,
    meta: {
      actor: DomainEvent["actor"];
      correlationId: string;
      causationId: string | null;
      at: string;
    },
  ): void;
  events(entityId?: string): DomainEvent[];
  claim(): Delivery | null;
  acknowledge(id: string): void;
  reject(id: string, error: string, retry: boolean): void;
  recover(): void;
  retryDelivery(id: string): void;
  documents(): Document[];
  document(id: string, version?: number): Document | undefined;
  saveDocument(
    input: {
      id?: string;
      title: string;
      level: string;
      content: string;
      expectedVersion?: number;
    },
    actor?: string,
  ): Document;
  archiveDocument(id: string, expectedVersion: number): void;
  search(
    query: string,
    vector?: number[],
    model?: string,
    limit?: number,
  ): SearchHit[];
  index(
    id: string,
    version: number,
    model: string,
    chunks: { text: string; vector: number[] }[],
  ): boolean;
  chunks(
    id: string,
  ): { id: number; version: number; model: string; text: string }[];
  history(id: string): unknown[];
  deliveryErrors(): { id: string; error: string; attempts: number }[];
}
export interface AgentPort {
  reviewCheckout?(runId: string, context: Context, configuration: AgentConfiguration, assigned: (worker: string) => void): Promise<AgentResult>;
  engineer?(
    runId: string,
    context: Context,
    configuration: AgentConfiguration,
    assigned: (worker: string) => void,
  ): Promise<AgentResult>;
  pushEngineering?(
    receipt: NonNullable<AgentResult["engineering"]>,
    authorize: () => boolean,
  ): Promise<string>;
  execute(
    runId: string,
    context: Context,
    heartbeat: boolean,
    configuration: AgentConfiguration,
  ): Promise<AgentResult>;
  repository(): Promise<unknown>;
}
export interface EmbeddingPort {
  model: string;
  embed(
    text: string,
    task: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT",
  ): Promise<number[]>;
}
export interface BrowserPort {
  inspect(
    runId: string,
    configuration?: AgentConfiguration,
  ): Promise<BrowserEvidence>;
  artifact(path: string, worker?: string): Promise<Uint8Array>;
}
export interface Clock {
  now(): Date;
}
export interface Ids {
  next(): string;
}

export interface PullRequestPort {
  branchHead?(repository: string, branch: string): Promise<string>;
  ensureBranch?(
    repository: string,
    branch: string,
    from: string,
  ): Promise<string>;
  source?(
    repository: string,
    ref: string,
  ): Promise<{ head: string; files: unknown[] }>;
  implement?(
    repository: string,
    branch: string,
    head: string,
    runId: string,
    changes: { path: string; content: string }[],
    authorize?: () => boolean,
  ): Promise<string>;
  open?(
    repository: string,
    branch: string,
    base: string,
    title: string,
    body: string,
  ): Promise<PullRequest>;
  candidate?(
    pr: PullRequest,
  ): Promise<import("../domain/delivery").IntegrationCandidate>;
  verify?(
    repository: string,
    head: string,
    runId: string,
  ): Promise<import("../domain/delivery").Verification>;
  merge?(
    candidate: import("../domain/delivery").IntegrationCandidate,
  ): Promise<string>;

  head(repository: string, number: number): Promise<PullRequest>;
  inspect(
    repository: string,
    number: number,
    checkout?: boolean,
  ): Promise<{ pullRequest: PullRequest; files: unknown[] }>;
  publishReview(
    pullRequest: PullRequest,
    reviewId: string,
    summary: string,
    findings: string[],
    verdict: string,
  ): Promise<void>;
  revise(
    pullRequest: PullRequest,
    runId: string,
    changes: { path: string; content: string }[],
    authorize?: () => boolean,
  ): Promise<PullRequest>;
}

import type { ResearchSource } from "../domain/discovery";
export type { ResearchSource } from "../domain/discovery";
export interface ResearchSourcesPort {
  read(repositories: string[]): Promise<ResearchSource[]>;
}
