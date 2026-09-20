import { test, expect } from "bun:test";
import { GitHubResearchSources } from "../src/adapters/research-sources";
test("public release feeds are bounded and use human-selected repositories on a fixed origin", async () => {
  const calls: { url: string; options: any }[] = [];
  const adapter = new GitHubResearchSources(async (url: any, options: any) => {
    calls.push({ url, options });
    return Response.json([
      {
        id: 123,
        tag_name: "v1.4.2",
        name: "Release",
        published_at: "2026-09-19T00:00:00Z",
        body: "Fresh notes",
      },
    ]);
  });
  const result = await adapter.read(["oven-sh/bun"]);
  expect(calls[0]!.url).toBe(
    "https://api.github.com/repos/oven-sh/bun/releases?per_page=3",
  );
  expect(calls[0]!.options.redirect).toBe("error");
  expect(result[0]!.releases[0]!.ref).toBe("release:oven-sh/bun@123");
  const invalid = await adapter.read(["http://localhost/admin"]);
  expect(invalid[0]!.error).toBeDefined();
  expect(calls).toHaveLength(1);
});
test("unavailable or oversized external evidence is explicit, never fabricated", async () => {
  const unavailable = new GitHubResearchSources(
    async () => new Response(null, { status: 403 }),
  );
  const a = (await unavailable.read(["owner/repo"]))[0]!;
  expect(a.releases).toEqual([]);
  expect(a.error).toContain("403");
  const huge = new GitHubResearchSources(
    async () => new Response("x".repeat(512001)),
  );
  expect((await huge.read(["owner/repo"]))[0]!.error).toContain("limit");
});
