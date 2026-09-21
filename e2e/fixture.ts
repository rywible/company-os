import { seedFixture } from "../tests/fixtures/documents";
import { Store } from "../src/server/store";
import { SQLiteRepository } from "../src/adapters/sqlite";
import { Company } from "../src/application/company";
import { defaultPolicy, type AgentResult } from "../src/domain/model";
import { workflowDefinitions } from "../src/domain/workflows";
import { seededAgentCatalog } from "../src/domain/agents";
export function fixture(empty = false) {
  const store = empty
      ? new Store(":memory:")
      : seedFixture(new Store(":memory:")),
    repo = new SQLiteRepository(store);
  const answer: AgentResult = {
    message: "The evidence supports this approach.",
    requests: [],
    proposals: [],
    work: [],
    discoveries: [],
    discoveryAssessment: null,
    discoveryOutcome: null,
    observations: [],
    changes: [],
    review: null,
    outcome: "completed",
  };
  const company = new Company(
    repo,
    {
      repository: async () => ({ ref: "github:example@abc", head: "abc" }),
      execute: async (_id, c) => ({
        ...answer,
        ...(c.maintenance
          ? {
              libraryUpdates: [
                {
                  documentId: null,
                  expectedVersion: null,
                  title: "Working principles",
                  content:
                    "The company prioritizes a complete, auditable workflow. Implementation details remain open questions.",
                  collection: "Company",
                  parentId: null,
                  relatedIds: [],
                  sources: c.maintenance.sources.map(
                    (d) => `document:${d.id}@${d.version}`,
                  ),
                  needsApproval: false,
                  reason:
                    "Consolidate the supplied direction into a subject overview.",
                },
              ],
            }
          : {}),
        ...(c.discovery?.phase === "scout"
          ? {
              discoveries: [
                {
                  title: "Make navigation clearer",
                  observation: "The source uses two names for one view",
                  hypothesis: "Consistent naming will reduce confusion",
                  impact: "Fewer wrong turns",
                  uncertainty: "User benefit is not measured",
                  evidence: ["github:example@abc"],
                  experiment: {
                    track: "research" as const,
                    mode: "analysis" as const,
                    title: "Investigate navigation names",
                    instruction: "Compare the visible names",
                    criteria: "An evidenced assessment",
                  },
                },
              ],
            }
          : {}),
        ...(c.discovery?.phase === "investigation"
          ? {
              discoveryAssessment: {
                verdict: "recommend" as const,
                finding:
                  "The two labels are inconsistent; a small experiment is warranted.",
                evidence: ["github:example@abc"],
                proposedWork: {
                  track: "research" as const,
                  mode: "analysis" as const,
                  title: "Propose one consistent name",
                  instruction: "Write a naming recommendation",
                  criteria: "One clear recommendation",
                },
                nextExperiment: null,
              },
            }
          : {}),
        ...(c.discovery?.phase === "outcome"
          ? {
              discoveryOutcome: {
                verdict: "inconclusive" as const,
                finding:
                  "A recommendation exists; user benefit has not been measured.",
                evidence: ["github:example@abc"],
              },
            }
          : {}),
        review:
          c.review?.reviewId || c.assignmentReview
            ? {
                verdict: "approve",
                summary: "Boundary cases checked.",
                findings: [],
              }
            : null,
      }),
    },
    {
      model: "fixture",
      embed: async () => Array.from({ length: 768 }, (_, i) => (i ? 0 : 1)),
    },
    {
      inspect: async () => ({
        at: new Date().toISOString(),
        url: "https://example.test",
        viewport: { width: 390, height: 844 },
        steps: [],
        errors: [],
      }),
      artifact: async () => new Uint8Array(),
    },
    undefined,
    undefined,
    {
      candidate: async (pullRequest) => ({
        pullRequest,
        base: "base",
        head: "integrated",
      }),
      verify: async (_repo, head) => ({
        head,
        passed: true,
        checks: [
          { name: "Fixture acceptance", passed: true, output: "Passed" },
        ],
      }),
      merge: async (candidate) => candidate.head,
      head: async (repository, number) => ({
        repository,
        number,
        head: "abc123",
        branch: "codex/example",
        base: "main",
        url: `https://github.com/${repository}/pull/${number}`,
      }),
      inspect: async (repository, number) => ({
        pullRequest: {
          repository,
          number,
          head: "abc123",
          branch: "codex/example",
          base: "main",
          url: `https://github.com/${repository}/pull/${number}`,
        },
        files: [],
      }),
      publishReview: async () => {},
      revise: async (pr) => ({ ...pr, head: "def456" }),
    },
  );
  const s = repo.state();
  s.settings.enabled = false;
  if (!empty)
    s.threads.push({
      id: "inbox-one",
      kind: "inbox",
      subject: "Prove the handoff before expanding",
      reason: "We need a sequencing decision.",
      recommendation: "Validate the complete loop first.",
      evidence: ["document:sequence@1"],
      status: "open",
      unread: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      proposals: [
        {
          id: "proposal-one",
          documentId: "sequence",
          version: 1,
          content: "# Next step\nProve the handoff before expanding.",
          reason: "Validate the whole loop.",
          evidence: ["document:sequence@1"],
          status: "pending",
        },
      ],
    });
  repo.save(s);
  async function drain() {
    for (let i = 0; i < 50; i++) {
      const d = repo.claim();
      if (!d) return;
      await company.deliver(d);
      repo.acknowledge(d.id);
    }
    throw Error("Fixture workflow did not settle");
  }
  const snapshot = (thread?: string, work?: string) => ({
    ...repo.workspace(thread, work),
    operations:repo.operations(),
    documents: repo.documents().map((d) => ({
      ...d,
      policy: repo.state().policies[d.id] || defaultPolicy(d),
    })),
    deliveryErrors: repo.deliveryErrors(),
    configured: true,
    agentCatalog: seededAgentCatalog(),
    availableAgentProviders: ["openai", "anthropic", "meta"],
    workflows: workflowDefinitions,
  });
  return { store, repo, company, drain, snapshot };
}
