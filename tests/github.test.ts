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
      return {
        exitCode: fail ? 1 : 0,
        stderr: fail ? "test failed" : "",
        stdout: JSON.stringify(
          p.checks.map((c: any) => ({
            name: c.name,
            passed: true,
            output: "passed",
          })),
        ),
      };
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

test("branch creation and PR creation reuse existing GitHub identities after retries", async () => {
  const writes: string[] = [];
  const adapter = new GitHubPullRequests({
    gateway: async (_p: string, _c: unknown, path: string, body?: any) => {
      if (body) writes.push(path);
      if (path.includes("matching-refs"))
        return [
          { ref: "refs/heads/codex/milestone-test", object: { sha: "root" } },
        ];
      if (path.includes("pulls?"))
        return [
          {
            number: 12,
            head: { ref: pr.branch },
            base: { ref: "codex/milestone-test" },
          },
        ];
      if (path.endsWith("pulls/12"))
        return {
          state: "open",
          head: {
            sha: pr.head,
            ref: pr.branch,
            repo: { full_name: pr.repository },
          },
          base: { ref: "codex/milestone-test" },
          html_url: pr.url,
        };
      throw Error(path);
    },
  } as unknown as Integrations);
  expect(
    await adapter.ensureBranch(pr.repository, "codex/milestone-test", "main"),
  ).toBe("root");
  expect(
    (
      await adapter.open(
        pr.repository,
        pr.branch,
        "codex/milestone-test",
        "Title",
        "Body",
      )
    ).number,
  ).toBe(12);
  expect(writes).toHaveLength(0);
});

test("integration publishes only the tested merge candidate and never force updates the target", async () => {
  let base = "base",
    changed = false;
  const writes: any[] = [];
  const adapter = new GitHubPullRequests({
    gateway: async (_p: string, _c: unknown, path: string, body?: any) => {
      if (path.endsWith("commits/main")) return { sha: base };
      if (path.includes("compare/")) return { status: "diverged" };
      if (path.endsWith("pulls/12"))
        return {
          state: "open",
          head: {
            sha: changed ? "unexpected" : pr.head,
            ref: pr.branch,
            repo: { full_name: pr.repository },
          },
          base: { ref: "main" },
          html_url: pr.url,
        };
      if (path.endsWith("git/refs/heads/main")) {
        writes.push(body);
        base = body.sha;
        return {};
      }
      throw Error(path);
    },
  } as unknown as Integrations);
  const candidate = {
    pullRequest: { ...pr, base: "main" },
    base: "base",
    head: "tested-merge",
  };
  changed = true;
  await expect(adapter.merge(candidate)).rejects.toThrow("changed");
  expect(writes).toHaveLength(0);
  changed = false;
  expect(await adapter.merge(candidate)).toBe("tested-merge");
  expect(writes).toEqual([{ sha: "tested-merge", force: false }]);
  expect(await adapter.merge(candidate)).toBe("tested-merge");
  expect(writes).toHaveLength(1);
  base = "another-head";
  await expect(adapter.merge(candidate)).rejects.toThrow("advanced");
  expect(writes).toHaveLength(1);
});

test("engineering authority is rechecked after verification before any GitHub writes", async () => {
  const f = fixture();
  await expect(
    f.adapter.revise(
      pr,
      "run-id",
      [{ path: "src/example.ts", content: "fixed" }],
      undefined,
      () => false,
    ),
  ).rejects.toThrow("revoked");
  expect(f.tests()).toBe(1);
  expect(f.calls.some((c) => !!c.body)).toBe(false);
});

test("verification checks cannot silently change the source that will be published", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(tmpdir() + "/company-verification-");
  try {
    const f = fixture();
    f.port.executePayload = async (script: string, payload: any) => {
      const file = root + "/input.json";
      await Bun.write(file, JSON.stringify(payload));
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          script.replace(
            "/home/sprite/company-os/verification/",
            root + "/checkout/",
          ),
          file,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    };
    await expect(
      f.adapter.revise(
        pr,
        "integrity-test",
        [{ path: "src/example.ts", content: "proposed" }],
        {
          instructions: "Verify the submitted source",
          checks: [
            {
              name: "Mutating check",
              command: [
                process.execPath,
                "-e",
                "await Bun.write('src/example.ts','silently fixed');",
              ],
            },
          ],
        },
      ),
    ).rejects.toThrow("A check changed tracked source");
    expect(f.calls.some((c) => !!c.body)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
