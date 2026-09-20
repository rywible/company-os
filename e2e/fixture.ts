import { Store } from "../src/server/store";
import { SQLiteRepository } from "../src/adapters/sqlite";
import { Company } from "../src/application/company";
import { defaultPolicy, type AgentResult } from "../src/domain/model";
import { workflowDefinitions } from "../src/domain/workflows";
export function fixture() {
  const store = new Store(":memory:"),
    repo = new SQLiteRepository(store);
  const answer: AgentResult = {
    message: "The evidence supports this approach.",
    requests: [],
    proposals: [],
    work: [],
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
        review: c.review?.reviewId
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
      inspect: async (repository, number) => ({
        pullRequest: {
          repository,
          number,
          head: "abc123",
          branch: "codex/example",
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
  const snapshot = () => ({
    ...repo.state(),
    documents: repo
      .documents()
      .map((d) => ({
        ...d,
        policy: repo.state().policies[d.id] || defaultPolicy(d),
      })),
    deliveryErrors: repo.deliveryErrors(),
    configured: true,
    workflows: workflowDefinitions,
  });
  return { store, repo, company, drain, snapshot };
}
