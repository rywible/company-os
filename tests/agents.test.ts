import { expect, test } from "bun:test";
import { agentExecutionError, agentOutputSchema, SpriteAgent } from "../src/adapters/agents";
import { documentEditSchema } from "../src/domain/document-edit";
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
test("the complete provider schema stays within the supported structured-output subset", () => {
  const schema = agentOutputSchema();
  function check(node: any) {
    if (!node || typeof node !== "object") return;
    for (const keyword of ["oneOf", "allOf", "not", "if", "then", "else", "dependentRequired", "dependentSchemas"])
      expect(node[keyword]).toBeUndefined();
    if (node.type === "object") {
      expect(node.additionalProperties).toBe(false);
      expect(node.required).toEqual(Object.keys(node.properties));
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(check);
      else check(value);
    }
  }
  check(schema);
  const operations = (schema as any).properties.documentEdits.items.properties.operations.items;
  expect(operations.anyOf.map((variant: any) => variant.properties.type.const)).toEqual([
    "replace_section", "insert_after_section", "append_section", "delete_section", "move_section", "replace_text",
  ]);
  expect(documentEditSchema.shape.operations.safeParse([{ type: "replace_text", oldText: "old", newText: "new", expectedOccurrences: 1 }]).success).toBe(true);
  expect(documentEditSchema.shape.operations.safeParse([{ type: "replace_text", headingPath: ["Overview"] }]).success).toBe(false);
});
test("provider JSON failures remain useful when stderr is empty", () => {
  const message = JSON.stringify({ error: { code: "invalid_json_schema", message: "Invalid schema: oneOf is not permitted." } });
  const events = [JSON.stringify({ type: "error", message }), JSON.stringify({ type: "turn.failed", error: { message } })].join("\n");
  expect(agentExecutionError(events, "", 1, false, false)).toBe("Agent could not complete the request: Invalid schema: oneOf is not permitted.");
  expect(agentExecutionError("", "", 9, false, false)).toContain("exit 9");
  expect(agentExecutionError(events, "", 143, true, true)).toContain("ten-minute execution limit");
  expect(agentExecutionError("", "Connection unavailable", 1, false, false)).toContain("Connection unavailable");
});
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
  let payload: any, options: any;
  const instance = new SpriteAgent({
    executePayload: async (_script: string, input: unknown, execution: unknown) => {
      payload = input;
      options = execution;
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
  expect(options.timeout).toBe(630000);
  expect(options.maxRunAfterDisconnect).toBe("10m");
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
