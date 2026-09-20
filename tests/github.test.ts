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
function fixture() {
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
    executePayload: async () => {
      tests++;
      throw Error("Checks belong in repository CI");
    },
  };
  return {
    adapter: new GitHubPullRequests(port as unknown as Integrations),
    calls,
    port,
    tests: () => tests,
  };
}
test("review publication is pinned and corrections publish for repository CI without local commands", async () => {
  const f = fixture();
  await f.adapter.publishReview(pr, "review-id", "Summary", [], "approve");
  expect(f.calls.at(-1)!.body).toMatchObject({
    commit_id: "old",
    event: "COMMENT",
  });
  const updated = await f.adapter.revise(pr, "run-id", [
    { path: "src/example.ts", content: "fixed" },
  ]);
  expect(f.tests()).toBe(0);
  expect(updated.head).toBe("next-commit");
  expect(f.calls.at(-1)).toMatchObject({
    method: "PATCH",
    body: { sha: "next-commit", force: false },
  });
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
      if (path.includes("/check-runs?"))
        return {
          check_runs: [
            {
              head_sha: "tested-merge",
              name: "CI",
              status: "completed",
              conclusion: "success",
            },
          ],
        };
      if (path.includes("/check-suites?")) return { check_suites: [] };
      if (path.includes("/status?")) return { statuses: [] };
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

test("engineering authority is checked before any GitHub writes", async () => {
  const f = fixture();
  await expect(
    f.adapter.revise(
      pr,
      "run-id",
      [{ path: "src/example.ts", content: "fixed" }],
      () => false,
    ),
  ).rejects.toThrow("revoked");
  expect(f.tests()).toBe(0);
  expect(f.calls.some((c) => !!c.body)).toBe(false);
});

function ciFixture() {
  const evidence = {
    runs: [
      {
        head_sha: "candidate",
        name: "Tests",
        status: "completed",
        conclusion: "success",
        output: { summary: "All tests passed" },
      },
    ] as any[],
    statuses: [] as any[],
    suites: [
      { head_sha: "candidate", status: "completed", conclusion: "success" },
    ] as any[],
  };
  const adapter = new GitHubPullRequests({
    gateway: async (_p: string, _c: unknown, path: string) => {
      const page = Number(
        new URL("https://github.test/" + path).searchParams.get("page") || 1,
      );
      const response = (key: string, rows: any[]) => ({
        [key]: rows.slice((page - 1) * 100, page * 100),
        total_count: rows.length,
      });
      if (path.includes("/annotations?")) return [{ path: "src/level.ts", start_line: 12, message: "The win condition never becomes true" }];
      if (path.includes("/check-runs?"))
        return response("check_runs", evidence.runs);
      if (path.includes("/status?"))
        return response("statuses", evidence.statuses);
      if (path.includes("/check-suites?"))
        return response("check_suites", evidence.suites);
      throw Error(path);
    },
  } as unknown as Integrations);
  return {
    evidence,
    adapter,
    verify: () => adapter.verify(pr.repository, "candidate", "run"),
  };
}

test("CI verifies the exact integration commit and fails closed on missing or unfinished evidence", async () => {
  const f = ciFixture();
  expect(await f.verify()).toMatchObject({ head: "candidate", passed: true });
  f.evidence.runs[0].head_sha = "old";
  await expect(f.verify()).rejects.toThrow("does not match");
  f.evidence.runs[0].head_sha = "candidate";
  f.evidence.runs[0].status = "in_progress";
  await expect(f.verify()).rejects.toThrow("Waiting for GitHub CI");
  f.evidence.runs = [];
  f.evidence.suites = [];
  await expect(f.verify()).rejects.toThrow("Waiting for GitHub CI");
});

test("queued workflows and pending legacy statuses wait even if registered checks pass", async () => {
  const f = ciFixture();
  f.evidence.suites[0].status = "queued";
  await expect(f.verify()).rejects.toThrow("Waiting for GitHub CI");
  f.evidence.suites[0].status = "completed";
  f.evidence.statuses = [{ context: "External tests", state: "pending" }];
  await expect(f.verify()).rejects.toThrow("Waiting for GitHub CI");
  f.evidence.statuses[0].state = "failure";
  expect((await f.verify()).passed).toBe(false);
});

test("CI paginates checks and includes failed suites; skipped results alone cannot pass", async () => {
  const f = ciFixture();
  f.evidence.runs = Array.from({ length: 101 }, (_, i) => ({
    ...f.evidence.runs[0],
    name: `Check ${i}`,
    conclusion: i === 100 ? "failure" : "success",
  }));
  const result = await f.verify();
  expect(result.checks).toHaveLength(101);
  expect(result.passed).toBe(false);
  f.evidence.runs = [{ ...f.evidence.runs[0], conclusion: "skipped" }];
  expect((await f.verify()).passed).toBe(false);
  f.evidence.runs[0].conclusion = "success";
  f.evidence.suites[0].conclusion = "failure";
  expect((await f.verify()).passed).toBe(false);
});


test("failed CI includes repository diagnostics for the correction agent", async () => {
  const f = ciFixture();
  f.evidence.runs[0] = { ...f.evidence.runs[0], id: 123, conclusion: "failure", output: { annotations_count: 1 } };
  const result = await f.verify();
  expect(result.passed).toBe(false);
  expect(result.checks[0]!.output).toContain("src/level.ts:12");
  expect(result.checks[0]!.output).toContain("The win condition never becomes true");
});
