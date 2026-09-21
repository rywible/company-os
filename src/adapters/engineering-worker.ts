/** Runs on a leased Sprite. Keep this function self-contained: it is sent as JS. */
export async function engineeringWorker(inputPath: string) {
  const fs = await import("node:fs/promises");
  const p = await Bun.file(inputPath).json();
  if (!/^[a-zA-Z0-9_-]+$/.test(p.id) ||
      !/^[\w.-]+\/[\w.-]+$/.test(p.repository) ||
      !/^codex\/[a-zA-Z0-9_/-]+$/.test(p.branch) ||
      !/^[a-f0-9]{40}$/.test(p.base)) throw Error("Invalid engineering assignment.");
  const dir = `${p.root || "/home/sprite/company-os/engineering"}/${p.id}`;
  const cwd = `${dir}/repo`;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const remote = p.remote || `ssh://git@ssh.github.com:443/${p.repository}.git`;
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  async function command(args: string[], where = dir) {
    const child = Bun.spawn(args, { cwd: where, env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 120000);
    try {
      const [code, out, error] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      if (code !== 0) throw Error(`${args[0]} failed: ${error.slice(-4000)}`);
      return out.trim();
    } finally { clearTimeout(timer); }
  }
  const git = (...args: string[]) => command(["git", ...args], cwd);
  const json = async (file: string) => JSON.parse(await fs.readFile(`${dir}/${file}`, "utf8"));
  const save = async (file: string, value: unknown) => {
    await fs.writeFile(`${dir}/${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(`${dir}/${file}.tmp`, `${dir}/${file}`);
  };
  async function github(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${p.gateway}/repos/${p.repository}/${path}`, {
      method, headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    if (method === "DELETE" && response.status === 404) return null;
    if (!response.ok) throw Error(`GitHub ${method} ${path}: ${response.status} ${(await response.text()).slice(0,500)}`);
    return response.status === 204 ? null : response.json();
  }
  // Only the wrapper creates a write key, after the model exits and authority is
  // rechecked by the application. No personal GitHub token is copied to a worker.
  async function credentials(write: boolean) {
    if (p.remote) return; // Local bare remotes used by integration tests.
    const key = `${dir}/${write ? "push" : "read"}-key`;
    try { await fs.access(key); } catch {
      await command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", `company-os-${p.id}`, "-f", key]);
    }
    const title = `Company OS ${p.id} ${write ? "push" : "read"}`;
    const publicKey = (await fs.readFile(`${key}.pub`, "utf8")).trim();
    // Recover an add-key request whose response was lost.
    const keys = await github("keys?per_page=100");
    const existing = keys.find((k: any) => k.title === title && k.key.split(" ").slice(0,2).join(" ") === publicKey.split(" ").slice(0,2).join(" "));
    await save("key.json", { path: key, title, publicKey });
    const registered = existing || await github("keys", "POST", { title, key: publicKey, read_only: !write });
    await save("key.json", { id: registered.id, path: key });
    const metaResponse = await fetch("https://api.github.com/meta", { signal: AbortSignal.timeout(15000) });
    if (!metaResponse.ok) throw Error("Cannot verify GitHub SSH host keys.");
    const meta = await metaResponse.json() as { ssh_keys: string[] };
    if (!meta.ssh_keys?.length) throw Error("GitHub SSH host keys are missing.");
    await fs.writeFile(`${dir}/known_hosts`, meta.ssh_keys.map(k => `[ssh.github.com]:443 ${k}`).join("\n"));
    const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
    env.GIT_SSH_COMMAND = `ssh -i ${quote(key)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${quote(`${dir}/known_hosts`)}`;
  }
  async function revoke() {
    if (p.remote) return;
    let record: { id?: number; path: string; title?: string; publicKey?: string };
    try { record = await json("key.json"); } catch (e: any) { if (e.code === "ENOENT") return; throw e; }
    if (!record.id) {
      const keys = await github("keys?per_page=100");
      record.id = keys.find((k: any) => k.title === record.title &&
        k.key.split(" ").slice(0,2).join(" ") === record.publicKey?.split(" ").slice(0,2).join(" "))?.id;
    }
    if (record.id) await github(`keys/${record.id}`, "DELETE");
    await fs.rm(`${dir}/key.json`);
    await fs.rm(record.path, { force: true });
    await fs.rm(`${record.path}.pub`, { force: true });
  }
  let lock;
  try { lock = await fs.open(`${dir}/running`, "wx"); } catch {
    throw Error("Engineering may still be running on this Sprite; inspect its logs before retrying.");
  }
  try {
    await revoke();
    if (p.phase === "push") {
      const saved = await json("completed.json");
      const receipt = saved.engineering;
      if (!receipt || receipt.head !== p.head || receipt.base !== p.base ||
          receipt.branch !== p.branch || receipt.repository !== p.repository)
        throw Error("Publication receipt does not match the completed checkout.");
      if (await git("rev-parse", "HEAD") !== p.head || await git("status", "--porcelain"))
        throw Error("Checkout changed after completion; refusing publication.");
      await git("merge-base", "--is-ancestor", p.base, p.head);
      await credentials(true);
      const current = (await git("ls-remote", remote, `refs/heads/${p.branch}`)).split(/\s/)[0];
      if (current === p.head) return { head: p.head }; // Lost push response.
      if (current !== p.base) throw Error("Delegated branch changed before publication. Reconcile it before retrying.");
      let hasLfs = false;
      try { await git("lfs", "version"); hasLfs = true; } catch { /* Not required for ordinary Git files. */ }
      if (hasLfs && await git("lfs", "ls-files")) await git("lfs", "push", remote, p.head);
      // Explicit source/destination, no force, tags, mirror, deletion, or model-supplied refspec.
      await git("-c", "core.hooksPath=/dev/null", "push", remote, `${p.head}:refs/heads/${p.branch}`);
      const published = (await git("ls-remote", remote, `refs/heads/${p.branch}`)).split(/\s/)[0];
      if (published !== p.head) throw Error("Delegated branch moved during publication.");
      return { head: published };
    }
    try { return await json("completed.json"); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    await credentials(false);
    try { await fs.access(`${cwd}/.git`); } catch {
      await command(["git", "clone", "--single-branch", "--branch", p.branch, "--", remote, cwd]);
    }
    await git("config", "user.name", "Company OS");
    await git("config", "user.email", "company-os@users.noreply.github.com");
    if (await git("branch", "--show-current") !== p.branch) throw Error("Checkout is on a different branch.");
    await git("merge-base", "--is-ancestor", p.base, "HEAD");
    const remoteHead = (await git("ls-remote", remote, `refs/heads/${p.branch}`)).split(/\s/)[0];
    if (remoteHead !== p.base) throw Error("Delegated branch changed before execution.");
    await fs.writeFile(`${dir}/prompt.txt`, p.prompt);
    await save("schema.json", p.schema);
    const stdout = await fs.open(`${dir}/events.jsonl`, "w");
    const stderr = await fs.open(`${dir}/stderr.log`, "w");
    const agentEnv = { ...env, ...(p.providerEnv || {}) };
    const child = Bun.spawn(p.command, {
      cwd, env: agentEnv, detached: true,
      stdin: p.stdin ? new Blob([p.stdin]) : "ignore", stdout: stdout.fd, stderr: stderr.fd,
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, p.timeoutMs);
    let exitCode;
    try { exitCode = await child.exited; } finally {
      // Stop only this invocation's descendants, including preview servers.
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
      clearTimeout(timer); await stdout.close(); await stderr.close();
    }
    if (timedOut) throw Error("Engineering time allowance expired; checkout and logs were preserved.");
    if (exitCode !== 0) throw Error((await fs.readFile(`${dir}/stderr.log`, "utf8")).slice(-4000) || "Engineering agent failed.");
    let output: any;
    const structured = (text: string) => {
      const clean = text.trim().replace(/^```(?:json)?\s*/, "").replace(/```$/, "");
      return JSON.parse(clean);
    };
    if (p.provider === "anthropic") {
      const envelope = JSON.parse(await fs.readFile(`${dir}/events.jsonl`, "utf8"));
      if (envelope.is_error) throw Error(envelope.result || "Engineering agent failed.");
      output = envelope.structured_output || structured(envelope.result);
    } else if (p.provider === "meta") {
      const lines = (await fs.readFile(`${dir}/events.jsonl`, "utf8")).trim().split("\n");
      const terminal = lines.map(line => { try { return JSON.parse(line); } catch { return {}; } })
        .findLast(record => record.payload_type === "run.terminal.completed");
      output = structured(terminal?.payload?.text || "");
    } else output = await json("result.json");
    if (!output.message || !["completed", "needs_input", "needs_execution"].includes(output.outcome))
      throw Error("Engineering agent did not return a valid outcome.");
    if (await git("branch", "--show-current") !== p.branch) throw Error("Agent changed the delegated branch.");
    const head = await git("rev-parse", "HEAD");
    await git("merge-base", "--is-ancestor", p.base, head);
    if (output.outcome === "completed" &&
        (head === p.base || await git("status", "--porcelain")))
      throw Error("Completion requires committed changes and a clean working tree. Checkout and logs were preserved.");
    const result = {
      message: output.message, outcome: output.outcome, requests: output.requests || [],
      contextRequests: output.contextRequests || [], proposals: [], work: [], changes: [], observations: [],
      discoveries: [], discoveryAssessment: null, discoveryOutcome: null, review: null,
      ...(output.outcome === "completed" ? { engineering: {
        runId: p.id, worker: p.worker, repository: p.repository, branch: p.branch, base: p.base, head,
      }} : {}),
    };
    await save("completed.json", result);
    return result;
  } finally {
    try { await revoke(); } finally {
      await lock.close(); await fs.rm(`${dir}/running`, { force: true });
    }
  }
}
