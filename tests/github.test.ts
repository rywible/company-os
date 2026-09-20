import { expect, test } from "bun:test";
import { GitHubPullRequests } from "../src/adapters/github";
import type { Integrations } from "../src/server/integrations";
const pr = {
  repository: "rywible/company-os",
  number: 12,
  head: "old",
  branch: "codex/correction",
  url: "https://github.com/rywible/company-os/pull/12",
};
function fixture(fail = false) {
  const calls: { path: string; body: any; method?: string }[] = [];
  let tests = 0;
  const gateway = async (
    _provider: string,
    _connector: unknown,
    path: string,
    body?: any,
    method?: string,
  ) => {
    calls.push({ path, body, method });
    if (path.endsWith("/pulls/12"))
      return {
        state: "open",
        changed_files: 1,
        head: {
          sha: "old",
          ref: pr.branch,
          repo: { full_name: pr.repository },
        },
        html_url: pr.url,
      };
    if (path.includes("/files?"))
      return [
        {
          filename: "src/example.ts",
          sha: "blob",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-old\n+new",
        },
      ];
    if (path.includes("/reviews?")) return [];
    if (path.endsWith("/reviews")) return { id: 1 };
    if (path.includes("/git/trees/"))
      return {
        truncated: false,
        tree: [{ type: "blob", path: "src/example.ts", size: 3, sha: "blob" }],
      };
    if (path.includes("/git/blobs/"))
      return { size: 3, content: Buffer.from("new").toString("base64") };
    if (path.endsWith("/git/commits/old")) return { tree: { sha: "tree" } };
    if (path.endsWith("/git/blobs")) return { sha: "next-blob" };
    if (path.endsWith("/git/trees")) return { sha: "next-tree" };
    if (path.endsWith("/git/commits")) return { sha: "next-commit" };
    if (path.includes("/git/refs/")) return {};
    throw Error("Unexpected request " + path);
  };
  const port = {
    gateway,
    executePayload: async (_s: string, p: any) => {
      tests++;
      expect(p.changes[0].path).toBe("src/example.ts");
      return { exitCode: fail ? 1 : 0, stderr: fail ? "test failed" : "" };
    },
  };
  return {
    adapter: new GitHubPullRequests(port as unknown as Integrations),
    calls,
    port,
    tests: () => tests,
  };
}
test("review publication is pinned and correction publishing follows successful verification without force", async () => {
  const f = fixture();
  await f.adapter.publishReview(pr, "review-id", "Summary", [], "approve");
  expect(f.calls.at(-1)!.body).toMatchObject({
    commit_id: "old",
    event: "COMMENT",
  });
  const updated = await f.adapter.revise(pr, "run-id", [
    { path: "src/example.ts", content: "fixed" },
  ]);
  expect(f.tests()).toBe(1);
  expect(updated.head).toBe("next-commit");
  expect(f.calls.at(-1)).toMatchObject({
    method: "PATCH",
    body: { sha: "next-commit", force: false },
  });
});
test("failed verification never creates or updates GitHub objects", async () => {
  const f = fixture(true);
  await expect(
    f.adapter.revise(pr, "run-id", [
      { path: "src/example.ts", content: "fixed" },
    ]),
  ).rejects.toThrow("verification");
  expect(f.calls.some((c) => !!c.body)).toBe(false);
});
test("corrections cannot write configuration, escape source paths or target an unapproved branch", async () => {
  const f = fixture();
  for (const path of [
    ".env",
    "package.json",
    "src/../secret.ts",
    ".github/workflows/run.yml",
  ])
    await expect(
      f.adapter.revise(pr, "run-id", [{ path, content: "x" }]),
    ).rejects.toThrow("permitted");
  await expect(
    f.adapter.revise({ ...pr, branch: "main" }, "run-id", [
      { path: "src/a.ts", content: "x" },
    ]),
  ).rejects.toThrow("codex/");
  expect(f.tests()).toBe(0);
});
test("repository scope is enforced before gateway access", async () => {
  const f = fixture();
  await expect(f.adapter.inspect("other/company", 1)).rejects.toThrow("scope");
  expect(f.calls).toHaveLength(0);
});
