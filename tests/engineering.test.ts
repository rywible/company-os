import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineeringWorker } from "../src/adapters/engineering-worker";
import { SpriteEngineering } from "../src/adapters/engineering";
import type { Integrations } from "../src/server/integrations";
const directories: string[] = [];
afterEach(async () => { for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true }); });
async function exec(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code) throw Error(error);
  return output.trim();
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "company-engineering-")); directories.push(root);
  const seed = join(root, "seed"), remote = join(root, "remote.git");
  await mkdir(seed);
  const git = (...args: string[]) => exec(["git", ...args], seed);
  await git("init", "-b", "main");
  await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.test");
  await writeFile(join(seed, "obsolete.txt"), "remove me");
  await writeFile(join(seed, "test.ts"), 'import {expect,test} from "bun:test"; test("asset and config",async()=>{expect((await Bun.file("asset.bin").bytes())[0]).toBe(0);expect((await Bun.file("package.json").json()).name).toBe("updated");});');
  await git("add", "."); await git("commit", "-m", "Initial project");
  const base = await git("rev-parse", "HEAD");
  await git("branch", "codex/delegated");
  await git("clone", "--bare", seed, remote);
  const runRoot = join(root, "runs"), dir = join(runRoot, "run-one");
  const writer = `const fs=await import("node:fs/promises");
await Bun.write("package.json",JSON.stringify({name:"updated"}));
await Bun.write("asset.bin",new Uint8Array([0,255,17]));
await fs.unlink("obsolete.txt");
for(const args of [["bun","test","./test.ts"],["git","add","."],["git","commit","-m","Deliver working feature"]]){const p=Bun.spawn(args,{stdout:"inherit",stderr:"inherit"});if(await p.exited)process.exit(1);}
await Bun.write(process.argv[1],JSON.stringify({message:"Changed configuration and binary asset, removed obsolete file; bun test passed.",outcome:"completed"}));`;
  const payload: any = {
    phase: "run", id: "run-one", root: runRoot, repository: "fixture/project", branch: "codex/delegated",
    base, worker: "fixture-worker", remote, prompt: "Implement", schema: {}, timeoutMs: 10000, provider: "openai",
    command: [process.execPath, "-e", writer, `${dir}/result.json`],
  };
  async function run(overrides: Record<string, unknown> = {}) {
    const input = join(root, "input.json"); await writeFile(input, JSON.stringify({ ...payload, ...overrides }));
    // Exercise the exact serialization used on the Sprite, not just direct calls.
    return JSON.parse(await exec([process.execPath, "-e", `console.log(JSON.stringify(await (${engineeringWorker.toString()})(process.argv[1])));`, input], root));
  }
  return { root, seed, remote, payload, run, git, base, dir };
}
test("native checkout edits config and binary files, deletes files, runs tests, commits, and publishes only its delegated branch", async () => {
  const f = await fixture();
  const output = await f.run();
  expect(output.changes).toEqual([]);
  expect(output.engineering.head).not.toBe(f.base);
  const head = output.engineering.head;
  const remoteGit = (...args: string[]) => exec(["git", "--git-dir", f.remote, ...args], f.root);
  expect(await remoteGit("rev-parse", "codex/delegated")).toBe(f.base);
  expect(await remoteGit("rev-parse", "main")).toBe(f.base);
  expect(await f.run({ phase: "push", head })).toEqual({ head });
  expect(await remoteGit("rev-parse", "codex/delegated")).toBe(head);
  expect(await remoteGit("rev-parse", "main")).toBe(f.base);
  expect(await remoteGit("show", `${head}:package.json`)).toBe('{"name":"updated"}');
  expect(await remoteGit("ls-tree", "--name-only", head)).not.toContain("obsolete.txt");
  expect(await f.run({ phase: "push", head })).toEqual({ head });
  expect((await f.run({ command: ["definitely-not-an-agent"] })).engineering.head).toBe(head);
});
test("a changed remote branch is never overwritten by a delayed publication", async () => {
  const f = await fixture(), output = await f.run();
  await f.git("checkout", "codex/delegated"); await writeFile(join(f.seed, "newer.txt"), "Concurrent change");
  await f.git("add", "."); await f.git("commit", "-m", "Concurrent work");
  await f.git("push", f.remote, "codex/delegated");
  await expect(f.run({ phase: "push", head: output.engineering.head })).rejects.toThrow("Delegated branch changed");
  expect(await exec(["git", "--git-dir", f.remote, "rev-parse", "codex/delegated"], f.root)).toBe(await f.git("rev-parse", "HEAD"));
});
test("unfinished changes cannot claim completion and remain available for recovery", async () => {
  const f = await fixture();
  const writer = 'await Bun.write("unfinished.txt","work in progress");await Bun.write(process.argv[1],JSON.stringify({message:"Done",outcome:"completed"}));';
  await expect(f.run({ command: [process.execPath, "-e", writer, `${f.dir}/result.json`] })).rejects.toThrow("committed changes and a clean working tree");
  expect(await readFile(`${f.dir}/repo/unfinished.txt`, "utf8")).toBe("work in progress");
});
test("engineering timeouts stop the invocation and preserve diagnostic files", async () => {
  const f = await fixture();
  await expect(f.run({ command: [process.execPath, "-e", "await Bun.sleep(30000)"], timeoutMs: 30 })).rejects.toThrow("time allowance expired");
  expect(await Bun.file(`${f.dir}/events.jsonl`).exists()).toBe(true);
});
test("the publisher checks current authority before dispatch and again after waiting for a worker", async () => {
  const prior = process.env.GITHUB_CONNECTOR_ID; process.env.GITHUB_CONNECTOR_ID = "fixture";
  try {
    let calls = 0, allowed = false;
    const engine = new SpriteEngineering({ executePayload: async (_s: string, _p: unknown, _o: unknown, _provider: unknown, _worker: unknown, assigned: (worker: string) => void) => {
      calls++; allowed = false; assigned("worker"); throw Error("Should not execute");
    }} as unknown as Integrations);
    const receipt = { runId: "run", worker: "worker", repository: "fixture/repo", branch: "codex/delegated", base: "a".repeat(40), head: "b".repeat(40) };
    await expect(engine.push(receipt, () => allowed)).rejects.toThrow("revoked"); expect(calls).toBe(0);
    allowed = true;
    await expect(engine.push(receipt, () => allowed)).rejects.toThrow("revoked"); expect(calls).toBe(1);
  } finally { if (prior === undefined) delete process.env.GITHUB_CONNECTOR_ID; else process.env.GITHUB_CONNECTOR_ID = prior; }
});
