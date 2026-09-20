import { expect, test } from "bun:test";
import { SpriteAgent } from "../src/adapters/agents";
import type { Integrations } from "../src/server/integrations";
import type { Context, AgentResult } from "../src/domain/model";
const context: Context = {
  query: "Review",
  scope: "company",
  assembledAt: new Date().toISOString(),
  documents: [],
  entries: [],
  evidenceRefs: [],
  messages: [],
  searchMode: "keyword",
  constitutionRef: null,
};
const result: AgentResult = {
  message: "Review finished.",
  requests: [],
  proposals: [],
  work: [],
  discoveries: [],
  discoveryAssessment: null,
  discoveryOutcome: null,
  observations: [],
  changes: [],
  review: { verdict: "approve", summary: "Looks correct.", findings: [] },
  outcome: "completed",
};
function agent(events: string, output: unknown) {
  return new SpriteAgent({
    executePayload: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Transport ended after command completion",
    }),
    sprite: {
      filesystem: () => ({
        readFile: async (path: string) =>
          path === "events.jsonl" ? events : JSON.stringify(output),
      }),
    },
  } as unknown as Integrations);
}
test("completed, valid output is recovered after a remote execution transport failure", async () => {
  expect(
    await agent('{"type":"turn.completed"}\n', result).execute(
      "run",
      context,
      false,
    ),
  ).toEqual(result);
});
test("incomplete or malformed cached output cannot turn an execution failure into success", async () => {
  await expect(
    agent('{"type":"turn.started"}', result).execute("run", context, false),
  ).rejects.toThrow("Transport");
  await expect(
    agent('{"type":"turn.completed"}', { message: "Incomplete" }).execute(
      "run",
      context,
      false,
    ),
  ).rejects.toThrow("Transport");
});
