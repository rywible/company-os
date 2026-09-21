import { expect, test } from "bun:test";
import { agentOutputSchema, SpriteAgent } from "../src/adapters/agents";
import type { Integrations } from "../src/server/integrations";
import type { Context, AgentResult } from "../src/domain/model";
import {
  configurationReasoningEfforts,
  modelOption,
  seededAgentCatalog,
} from "../src/domain/agents";
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
test("the selected provider, model and reasoning effort reach the compatible pool", async () => {
  let selected: unknown, payload: any, runner = "";
  const instance = new SpriteAgent({
    executePayload: async (
      script: string,
      input: unknown,
      _options: unknown,
      provider: unknown,
    ) => {
      runner = script;
      selected = provider;
      payload = input;
      return { exitCode: 0, stdout: JSON.stringify(result), stderr: "" };
    },
  } as unknown as Integrations);
  await instance.execute("run", context, false, {
    provider: "meta",
    model: "llama-studio",
    reasoningEffort: "ultra",
  });
  expect(selected).toBe("meta");
  expect(payload.configuration).toEqual({
    provider: "meta",
    model: "llama-studio",
    reasoningEffort: "ultra",
  });
  expect(payload.prompt).toContain(
    "Writing style for prose shown to Ryan (the message, request reasons and recommendations):",
  );
  expect(payload.prompt).toContain(
    "Write in clear, precise, natural English.",
  );
  expect(() =>
    new Bun.Transpiler({ loader: "js" }).transformSync(runner),
  ).not.toThrow();
  expect(runner).toContain(
    "p.prompt+'\\n\\nReturn only one JSON object that satisfies this JSON Schema exactly:\\n'",
  );
  expect(runner).toContain("...(p.research?['--search']:[]),'exec'");
});
test("research mode enables hosted search and requires an OpenAI-backed worker", async () => {
  let payload: any;
  const instance = new SpriteAgent({
    executePayload: async (_script: string, input: unknown) => {
      payload = input;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ...result,
          researchSources: [
            {
              url: "https://example.test/spec",
              title: "Primary specification",
              evidence: "The specification defines the required behavior.",
            },
          ],
        }),
        stderr: "",
      };
    },
  } as unknown as Integrations);
  await instance.execute(
    "research-run",
    { ...context, research: { web: true } },
    false,
    { provider: "openai", model: "", reasoningEffort: "high" },
  );
  expect(payload.research).toBe(true);
  expect(payload.prompt).toContain("hosted web search is enabled");
  expect(payload.prompt).toContain("researchSources");
  expect(
    JSON.stringify(agentOutputSchema()).includes('"format":"uri"'),
  ).toBe(false);
  await expect(
    instance.execute(
      "unsupported-research",
      { ...context, research: { web: true } },
      false,
      { provider: "anthropic", model: "", reasoningEffort: "high" },
    ),
  ).rejects.toThrow("CAPABILITY:web-research");
});
test("model selection uses exact dispatch ids and model-specific reasoning", () => {
  const catalog = seededAgentCatalog();
  const luna = {
    provider: "openai" as const,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium" as const,
  };
  expect(modelOption(catalog, luna)?.id).toBe("gpt-5.6-luna");
  expect(configurationReasoningEfforts(catalog, luna)).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  expect(
    modelOption(catalog, {
      provider: "openai",
      model: "",
      reasoningEffort: "low",
    })?.id,
  ).toBe("gpt-6-astra");
});
