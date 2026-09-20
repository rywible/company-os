import type { PullRequestPort } from "../application/ports";
import type { PullRequest } from "../domain/model";
import { Integrations } from "../server/integrations";
export class GitHubPullRequests implements PullRequestPort {
  constructor(private integrations: Integrations) {}
  private check(repo: string) {
    if (repo !== (process.env.GITHUB_REPOSITORY || "rywible/company-os"))
      throw Error("Repository is outside the configured connector scope.");
  }
  private request(repo: string, path: string, body?: unknown, method?: string) {
    this.check(repo);
    return this.integrations.gateway(
      "github",
      process.env.GITHUB_CONNECTOR_ID,
      `repos/${repo}/${path}`,
      body,
      method,
    );
  }
  async inspect(repo: string, number: number) {
    const p = await this.request(repo, `pulls/${number}`);
    if (p.state !== "open") throw Error("Pull request is not open.");
    if (p.head.repo?.full_name !== repo)
      throw Error("Only same-repository branches can enter autonomous review.");
    if (p.changed_files > 100)
      throw Error(
        "PR exceeds the 100-file review limit. Split the work before review.",
      );
    const changed = await this.request(
        repo,
        `pulls/${number}/files?per_page=100`,
      ),
      files = [];
    let total = 0;
    for (const f of changed) {
      if (!f.patch)
        throw Error(
          "Review diff unavailable for " +
            f.filename +
            ". A partial review cannot approve this PR.",
        );
      const patchLines = String(f.patch).split("\n");
      if (
        patchLines.filter((line: string) => line.startsWith("+")).length !==
          f.additions ||
        patchLines.filter((line: string) => line.startsWith("-")).length !==
          f.deletions
      )
        throw Error("Incomplete review diff for " + f.filename);
      const file: any = {
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      };
      if (
        f.status !== "removed" &&
        /^(src|tests|e2e)\/.*\.(ts|tsx|css)$/.test(f.filename)
      ) {
        const blob = await this.request(repo, `git/blobs/${f.sha}`);
        if (blob.size > 100000)
          throw Error(
            "Review source exceeds the per-file limit: " + f.filename,
          );
        file.content = Buffer.from(blob.content, "base64").toString();
      }
      total += JSON.stringify(file).length;
      if (total > 240000)
        throw Error("PR exceeds the bounded review context. Split the work.");
      files.push(file);
    }
    const confirmed = await this.request(repo, `pulls/${number}`);
    if (confirmed.state !== "open" || confirmed.head.sha !== p.head.sha)
      throw Error(
        "PR changed while collecting review evidence. Retry with the current commit.",
      );
    return {
      pullRequest: {
        repository: repo,
        number,
        head: p.head.sha,
        branch: p.head.ref,
        url: p.html_url,
      },
      files,
    };
  }
  async publishReview(
    pr: PullRequest,
    id: string,
    summary: string,
    findings: string[],
    verdict: string,
  ) {
    const marker = `<!-- company-os-review:${id} -->`;
    for (let page = 1; page <= 20; page++) {
      const prior = await this.request(
        pr.repository,
        `pulls/${pr.number}/reviews?per_page=100&page=${page}`,
      );
      if (prior.some((r: any) => r.body?.includes(marker))) return;
      if (prior.length < 100) break;
      if (page === 20)
        throw Error("Review history exceeds the idempotency scan limit.");
    }
    await this.request(pr.repository, `pulls/${pr.number}/reviews`, {
      commit_id: pr.head,
      event: "COMMENT",
      body: `${marker}\nCompany OS independent review · ${verdict}\n\n${summary}\n\n${findings.map((f) => "- " + f).join("\n")}\n\nReviewed commit: ${pr.head}`,
    });
  }
  async revise(
    pr: PullRequest,
    runId: string,
    changes: { path: string; content: string }[],
  ) {
    if (!pr.branch.startsWith("codex/"))
      throw Error("Automatic corrections require a codex/ branch.");
    const current = await this.inspect(pr.repository, pr.number);
    if (current.pullRequest.head !== pr.head) {
      const commit = await this.request(
        pr.repository,
        `git/commits/${current.pullRequest.head}`,
      );
      if (commit.message?.includes(`Company OS run ${runId}`))
        return current.pullRequest;
      throw Error("PR changed before corrections could be applied.");
    }
    if (!changes.length) throw Error("No correction files supplied.");
    for (const file of changes)
      if (
        !/^(src|tests|e2e)\/[\w./-]+\.(ts|tsx|css)$/.test(file.path) ||
        file.path.split("/").includes("..") ||
        file.content.length > 100000
      )
        throw Error(
          "Correction contains a file outside the permitted source/test paths.",
        );
    // Build a clean, detached verification checkout on the Sprite. No GitHub
    // credentials are copied into it; publishing uses the scoped gateway below.
    const tree = await this.request(
      pr.repository,
      `git/trees/${pr.head}?recursive=1`,
    );
    if (tree.truncated) throw Error("Repository tree is incomplete.");
    const files = [];
    let bytes = 0;
    for (const entry of tree.tree || []) {
      if (
        entry.type !== "blob" ||
        entry.size > 200000 ||
        entry.path.startsWith(".git") ||
        entry.path.includes(".env")
      )
        continue;
      const data = await this.request(pr.repository, `git/blobs/${entry.sha}`);
      bytes += data.size || 0;
      if (bytes > 5000000)
        throw Error("Repository exceeds verification transfer limit.");
      files.push({ path: entry.path, base64: data.content });
      if (files.length > 300)
        throw Error("Repository exceeds bounded verification size.");
    }
    const payload = { runId, files, changes };
    const script = `const p=await Bun.file(process.argv[1]).json();const fs=await import('node:fs/promises');const path=await import('node:path');const dir='/home/sprite/company-os/corrections/'+p.runId;await fs.rm(dir,{recursive:true,force:true});await fs.mkdir(dir,{recursive:true});for(const f of p.files){const target=path.resolve(dir,f.path);if(!target.startsWith(dir+'/'))throw Error('Unsafe source path');await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,Buffer.from(f.base64,'base64'));}for(const f of p.changes){const target=path.join(dir,f.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,f.content);}for(const cmd of [['bun','install','--frozen-lockfile'],['bun','run','typecheck'],['bun','test'],['bun','run','build']]){const out=Bun.spawnSync(cmd,{cwd:dir,env:{...process.env,SPRITES_TOKEN:'',NODE_ENV:'test'},timeout:180000,stdout:'pipe',stderr:'pipe'});if(out.exitCode!==0)throw Error(cmd.join(' ')+': '+Buffer.from(out.stderr).toString().slice(-4000));}console.log('Verification passed');`;
    const tested = await this.integrations.executePayload(script, payload, {
      timeout: 240000,
      maxBuffer: 1024 * 1024,
    });
    if (tested.exitCode !== 0)
      throw Error(
        "Corrections failed verification: " +
          String(tested.stderr).slice(-3000),
      );
    const commit = await this.request(pr.repository, `git/commits/${pr.head}`),
      blobs = [];
    for (const file of changes) {
      const blob = await this.request(pr.repository, "git/blobs", {
        content: file.content,
        encoding: "utf-8",
      });
      blobs.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
    }
    const nextTree = await this.request(pr.repository, "git/trees", {
      base_tree: commit.tree.sha,
      tree: blobs,
    });
    const next = await this.request(pr.repository, "git/commits", {
      message: `Address independent review findings\n\nCompany OS run ${runId}`,
      tree: nextTree.sha,
      parents: [pr.head],
    });
    await this.request(
      pr.repository,
      `git/refs/heads/${pr.branch}`,
      { sha: next.sha, force: false },
      "PATCH",
    );
    return { ...pr, head: next.sha };
  }
}
