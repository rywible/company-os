export const initialDocuments = [
  {
    id: "constitution",
    title: "Company constitution",
    level: "constitution",
    content: `# Purpose
Build an operating system for pure software companies. Preserve human intent as it becomes useful software.

## Ryan's role
Ryan directs product, technology choices, and consequential sequencing. He reviews and refines proposals. Routine tickets and implementation details are delegated, with the ability to drill down at any time.

## Operating principles
- Bring decisions with a recommendation, tradeoffs, and supporting evidence.
- Challenge assumptions honestly. Distinguish implementation failure from technical or product thesis failure.
- Preserve uncertainty and contradictory evidence.
- Keep documents connected to the work they describe. Separate proposals from implemented reality.
- Agents may propose constitutional changes; only Ryan can change this document.

## Initial authority
The first slice can inspect project evidence, discuss direction, and propose document changes. Publishing changes to the company’s product and architecture documents requires Ryan’s acceptance. This slice does not execute engineering tickets, merge code, or deploy generated changes autonomously.`,
  },
  {
    id: "product-direction",
    title: "A company you can steer",
    level: "product",
    content: `# Product direction
Company OS is for pure software companies. Its default experience is consequential decisions, current understanding, and working results.

## The relationship
The Foreman translates direction into work, preserves coherence, and returns when new evidence requires human judgment. Ryan should be a triage machine, not the owner of every detail.

## What should be visible
- What the company is pursuing, and why.
- Product and architecture proposals with recommendations.
- Evidence that challenges an assumption.
- Documents at different levels of detail, connected to their sources.

## First slice
A private workspace for direction, Foreman proposals, versioned understanding, semantic search, and an ordered activity log. Acceptance turns a proposal into a document revision and triggers reindexing.

## Open questions
How should escalation preferences evolve? Which decisions should eventually proceed without review?`,
  },
  {
    id: "architecture",
    title: "System architecture",
    level: "architecture",
    content: `# Initial architecture
The application and SQLite database share one Fly Machine. Agents execute in a separate Sprite. Litestream backs up the database to Tigris. Google generates embeddings through a Sprite connector.

\`\`\`mermaid
flowchart LR
  U[Ryan] --> W[Company OS · Bun]
  W --> D[(SQLite + sqlite-vec)]
  W --> S[Worker Sprite · Codex]
  S --> G[Google embeddings]
  S --> H[GitHub evidence]
  D --> L[Litestream]
  L --> T[Tigris backups]
\`\`\`

## Ownership
The application owns decisions, revisions, and workflow state. Agents propose changes through structured results. They cannot write directly to the company database.

## Boundaries
The worker accesses Google and GitHub through scoped Sprite connectors. Codex uses a separately authenticated ChatGPT subscription. Human-readable documents and agent context come from the same records.

## Availability
There is one database writer. Backups are asynchronous; this is recoverable single-machine hosting, not automatic high availability.`,
  },
  {
    id: "sequence",
    title: "From direction to understanding",
    level: "execution",
    content: `# Current sequence
1. Capture direction and keep an ordered event history.
2. Assemble the constitution and relevant current understanding for the Foreman.
3. Return a recommendation with evidence and an optional document revision.
4. Let Ryan refine, accept, or dismiss proposals.
5. Record acceptance atomically and update the search index.

## Later
Engineering execution, revision-aware independent PR reviews, automatic repository-driven documentation maintenance, and broader delegation.

## Success criterion
A fresh agent can continue from accepted decisions and evidence, without requiring Ryan to repeat the entire conversation.`,
  },
] as const;
