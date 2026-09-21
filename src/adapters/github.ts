import {
  ChecksPending,
  IntegrationChanged,
  VerificationFailed,
} from "../domain/delivery";
import type { IntegrationCandidate, Verification } from "../domain/delivery";
import type { PullRequestPort } from "../application/ports";
import type { PullRequest } from "../domain/model";
import { Integrations } from "../server/integrations";
export class GitHubPullRequests implements PullRequestPort {
  constructor(private integrations: Integrations) {}
  async branchHead(repository: string, branch: string) {
    const commit = await this.request(repository, `commits/${encodeURIComponent(branch)}`);
    return String(commit.sha);
  }
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
  async head(repo: string, number: number): Promise<PullRequest> {
    const p = await this.request(repo, `pulls/${number}`);
    if (p.state !== "open" && !p.merged)
      throw Error("Pull request is closed without merging.");
    if (p.head.repo?.full_name !== repo)
      throw Error("Only same-repository branches can enter autonomous review.");
    return {
      repository: repo,
      number,
      head: p.head.sha,
      branch: p.head.ref,
      url: p.html_url,
      base: p.base?.ref,
      merged: !!p.merged,
      description: String(p.body || "").slice(0, 12000),
    };
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
      const blob = f.status !== "removed" || !f.patch
        ? await this.request(repo, `git/blobs/${f.sha}`) : undefined;
      let content: string | undefined, binary = false;
      if (blob) {
        const bytes = Buffer.from(blob.content, "base64");
        try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { binary = true; }
        binary ||= bytes.includes(0);
      }
      // GitHub omits binary patches and unchanged-content renames. Record those
      // explicitly; missing/truncated text diffs still fail closed.
      if (!f.patch && !binary && (f.additions || f.deletions || f.status === "modified"))
        throw Error("Review diff unavailable for " + f.filename + ". A partial review cannot approve this PR.");
      const patchLines = String(f.patch).split("\n");
      if (f.patch && (
        patchLines.filter((line: string) => line.startsWith("+")).length !==
          f.additions ||
        patchLines.filter((line: string) => line.startsWith("-")).length !==
          f.deletions
      ))
        throw Error("Incomplete review diff for " + f.filename);
      const file: any = {
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
        previousPath: f.previous_filename,
        sha: f.sha,
        ...(binary ? { binary: true, size: blob.size,
          evidence: "Binary identity and size only. Require recorded tests/playtest evidence; visual/audio contents have not been inspected." } : {}),
      };
      if (f.status !== "removed" && !binary && blob) {
        if (blob.size > 100000)
          throw Error(
            "Review source exceeds the per-file limit: " + f.filename,
          );
        file.content = content;
      }
      total += JSON.stringify(file).length;
      if (total > 320000)
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
        base: p.base?.ref,
        description: String(p.body || "").slice(0, 12000),
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
    authorize?: () => boolean,
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
        !/^(src|tests|e2e|docs)\/[\w./-]+\.(ts|tsx|css|md|json|glsl|gd|cs)$/.test(
          file.path,
        ) ||
        file.path.split("/").includes("..") ||
        file.content.length > 100000
      )
        throw Error(
          "Correction contains a file outside the permitted source/test paths.",
        );
    return {
      ...pr,
      head: await this.publishChanges(
        pr.repository,
        pr.branch,
        pr.head,
        runId,
        changes,
        authorize,
      ),
    };
  }
  private async publishChanges(
    repository: string,
    branch: string,
    head: string,
    runId: string,
    changes: { path: string; content: string }[],
    authorize?: () => boolean,
  ) {
    const pr = { repository, branch, head };
    if (authorize && !authorize())
      throw Error("Engineering authority was revoked before publication.");
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
    if (authorize && !authorize())
      throw Error("Engineering authority was revoked before branch update.");
    await this.request(
      pr.repository,
      `git/refs/heads/${pr.branch}`,
      { sha: next.sha, force: false },
      "PATCH",
    );
    return next.sha;
  }
  private safeBranch(branch: string) {
    if (!/^codex\/[a-zA-Z0-9_/-]+$/.test(branch))
      throw Error("Invalid managed branch.");
  }
  async ensureBranch(
    repo: string,
    branch: string,
    from: string,
  ): Promise<string> {
    this.safeBranch(branch);
    const refs = await this.request(repo, `git/matching-refs/heads/${branch}`);
    const existing = refs.find((r: any) => r.ref === `refs/heads/${branch}`);
    if (existing) return existing.object.sha;
    const base = await this.request(
      repo,
      `commits/${encodeURIComponent(from)}`,
    );
    try {
      await this.request(repo, "git/refs", {
        ref: `refs/heads/${branch}`,
        sha: base.sha,
      });
    } catch (error) {
      const current = await this.request(
        repo,
        `git/matching-refs/heads/${branch}`,
      );
      if (
        !current.some(
          (r: any) =>
            r.ref === `refs/heads/${branch}` && r.object.sha === base.sha,
        )
      )
        throw error;
    }
    return base.sha;
  }
  private async checkout(repo: string, head: string) {
    const tree = await this.request(repo, `git/trees/${head}?recursive=1`);
    if (tree.truncated) throw Error("Repository tree is incomplete.");
    const files: { path: string; base64: string }[] = [];
    let bytes = 0;
    for (const entry of tree.tree || []) {
      if (entry.type === "tree") continue;
      if (entry.type !== "blob" || entry.mode === "120000")
        throw Error("Unsupported repository entry: " + entry.path);
      if (
        entry.path.startsWith(".git/") ||
        /(^|\/)\.env($|\.)/.test(entry.path)
      )
        continue;
      if (entry.size > 2000000)
        throw Error("Source file exceeds verification limit: " + entry.path);
      const data = await this.request(repo, `git/blobs/${entry.sha}`);
      bytes += data.size || 0;
      if (bytes > 20000000 || files.length >= 1000)
        throw Error("Repository exceeds bounded verification size.");
      files.push({ path: entry.path, base64: data.content });
    }
    return files;
  }
  async source(repo: string, ref: string) {
    const commit = await this.request(
      repo,
      `commits/${encodeURIComponent(ref)}`,
    );
    const checkout = await this.checkout(repo, commit.sha);
    let size = 0;
    const files = checkout
      .filter((f) => /\.(ts|tsx|css|md|json|glsl|gd|cs)$/.test(f.path))
      .map((f) => {
        const content = Buffer.from(f.base64, "base64").toString();
        size += content.length;
        return { path: f.path, content };
      });
    if (size > 1200000)
      throw Error(
        "Repository exceeds implementation context limit. Narrow the project before execution.",
      );
    return { head: commit.sha, files };
  }
  async implement(
    repo: string,
    branch: string,
    head: string,
    runId: string,
    changes: { path: string; content: string }[],
    authorize?: () => boolean,
  ) {
    this.safeBranch(branch);
    if (
      !changes.length ||
      changes.some(
        (f) =>
          !/^(src|tests|e2e|docs)\/[\w./-]+\.(ts|tsx|css|md|json|glsl|gd|cs)$/.test(
            f.path,
          ) ||
          f.path.split("/").includes("..") ||
          f.content.length > 100000,
      )
    )
      throw Error(
        "Implementation contains a file outside the permitted source/test paths.",
      );
    const current = await this.request(
      repo,
      `commits/${encodeURIComponent(branch)}`,
    );
    if (current.sha !== head) {
      if (current.commit.message.includes(`Company OS run ${runId}`))
        return current.sha;
      throw Error("Assignment branch changed before publication.");
    }
    return this.publishChanges(repo, branch, head, runId, changes, authorize);
  }
  async open(
    repo: string,
    branch: string,
    base: string,
    title: string,
    body: string,
  ): Promise<PullRequest> {
    this.safeBranch(branch);
    if (branch === base) throw Error("A PR requires distinct branches.");
    const owner = repo.split("/")[0];
    const prior = await this.request(
      repo,
      `pulls?state=all&head=${encodeURIComponent(owner + ":" + branch)}&base=${encodeURIComponent(base)}&per_page=100`,
    );
    const existing = prior.find(
      (p: any) => p.head.ref === branch && p.base.ref === base,
    );
    if (existing) return this.head(repo, existing.number);
    const p = await this.request(repo, "pulls", {
      head: branch,
      base,
      title,
      body,
    });
    return this.head(repo, p.number);
  }
  async candidate(pr: PullRequest): Promise<IntegrationCandidate> {
    const current = await this.head(pr.repository, pr.number);
    if (current.merged)
      throw Error("PR was already merged outside this attempt.");
    if (current.head !== pr.head || !pr.base || current.base !== pr.base)
      throw Error("PR changed before integration.");
    const base = await this.request(
      pr.repository,
      `commits/${encodeURIComponent(pr.base)}`,
    );
    const branch = `codex/integration-${pr.number}-${pr.head}-${base.sha}`;
    await this.ensureBranch(pr.repository, branch, base.sha);
    await this.request(pr.repository, "merges", {
      base: branch,
      head: pr.head,
      commit_message: `Integrate PR #${pr.number}`,
    });
    const merged = await this.request(
      pr.repository,
      `commits/${encodeURIComponent(branch)}`,
    );
    return { pullRequest: pr, base: base.sha, head: merged.sha };
  }
  private async pages(repo: string, path: string, key: string) {
    const rows: any[] = [];
    for (let page = 1; page <= 20; page++) {
      const result = await this.request(
        repo,
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const batch = result[key];
      if (!Array.isArray(batch))
        throw Error("GitHub returned incomplete CI evidence.");
      rows.push(...batch);
      if (batch.length < 100 && rows.length >= (result.total_count || 0))
        return rows;
    }
    throw Error("GitHub CI evidence exceeds the pagination limit.");
  }
  async verify(
    repo: string,
    head: string,
    _runId: string,
  ): Promise<Verification> {
    // Inspect the exact integration commit, never an earlier PR-head result.
    // Suites cover queued workflows whose individual jobs are not registered yet.
    const [runs, statuses, suites] = await Promise.all([
      this.pages(
        repo,
        `commits/${head}/check-runs?filter=latest`,
        "check_runs",
      ),
      this.pages(repo, `commits/${head}/status`, "statuses"),
      this.pages(repo, `commits/${head}/check-suites`, "check_suites"),
    ]);
    if (
      runs.some((r) => r.head_sha !== head) ||
      suites.some((s) => s.head_sha !== head)
    )
      throw Error("GitHub CI evidence does not match the integration commit.");
    if (
      (!runs.length && !statuses.length) ||
      runs.some((r) => r.status !== "completed") ||
      suites.some((s) => s.status !== "completed") ||
      statuses.some((s) => s.state === "pending")
    )
      throw new ChecksPending(
        `Waiting for GitHub CI on ${head}. Checks must run on managed integration branches.`,
      );
    const accepted = (conclusion: string) =>
      ["success", "neutral", "skipped"].includes(conclusion);
    const checks: Verification["checks"] = runs.map((r) => ({
      name: r.name,
      passed: accepted(r.conclusion),
      output: [
        r.conclusion,
        r.output?.title,
        r.output?.summary,
        r.output?.text,
        r.details_url || r.html_url,
      ]
        .filter(Boolean)
        .join("\n")
        .slice(-12000),
    }));
    for (const [index, run] of runs.entries()) {
      if (checks[index]!.passed || !run.output?.annotations_count) continue;
      const annotations = await this.request(
        repo,
        `check-runs/${run.id}/annotations?per_page=50`,
      );
      if (!Array.isArray(annotations))
        throw Error("GitHub returned incomplete CI diagnostics.");
      checks[index]!.output = [
        checks[index]!.output,
        ...annotations.map(
          (a: any) =>
            `${a.path || ""}:${a.start_line || ""} ${a.title || ""}\n${a.message || ""}`,
        ),
      ]
        .join("\n")
        .slice(-16000);
    }
    for (const status of statuses)
      checks.push({
        name: status.context,
        passed: status.state === "success",
        output: [status.state, status.description, status.target_url]
          .filter(Boolean)
          .join("\n"),
      });
    for (const suite of suites.filter((s) => !accepted(s.conclusion)))
      checks.push({
        name: suite.app?.name || "CI workflow",
        passed: false,
        output: `Workflow concluded: ${suite.conclusion || "unknown"}`,
      });
    if (
      !runs.some((r) => r.conclusion === "success") &&
      !statuses.some((s) => s.state === "success")
    )
      checks.push({
        name: "CI evidence",
        passed: false,
        output:
          "No automated check succeeded; skipped or neutral results alone cannot authorize integration.",
      });
    return {
      head,
      passed: checks.length > 0 && checks.every((c) => c.passed),
      checks,
    };
  }
  async merge(candidate: IntegrationCandidate) {
    const pr = candidate.pullRequest;
    if (!pr.base) throw Error("PR target is missing.");
    const base = await this.request(
      pr.repository,
      `commits/${encodeURIComponent(pr.base)}`,
    );
    if (base.sha === candidate.head) return candidate.head; // Replayed successful fast-forward.
    if (base.sha !== candidate.base) {
      const comparison = await this.request(
        pr.repository,
        `compare/${candidate.head}...${base.sha}`,
      );
      if (["ahead", "identical"].includes(comparison.status))
        return candidate.head;
      throw new IntegrationChanged(
        "Integration target advanced; a new candidate must be tested.",
      );
    }
    const current = await this.head(pr.repository, pr.number);
    if (current.head !== pr.head || current.base !== pr.base || current.merged)
      throw new IntegrationChanged("PR changed before merge.");
    // Recheck before the write: a rerun can invalidate earlier successful evidence.
    const verification = await this.verify(
      pr.repository,
      candidate.head,
      `merge-${pr.number}`,
    );
    if (!verification.passed)
      throw new VerificationFailed(
        "GitHub CI no longer passes: " +
          verification.checks
            .filter((c) => !c.passed)
            .map((c) => `${c.name}: ${c.output}`)
            .join("\n"),
      );
    // Publish the exact tested merge commit. A concurrent target update rejects
    // this non-force fast-forward rather than merging an untested combination.
    try {
      await this.request(
        pr.repository,
        `git/refs/heads/${pr.base}`,
        { sha: candidate.head, force: false },
        "PATCH",
      );
    } catch (error) {
      const latest = await this.request(
        pr.repository,
        `commits/${encodeURIComponent(pr.base)}`,
      );
      if (latest.sha === candidate.head) return candidate.head;
      if (latest.sha !== candidate.base)
        throw new IntegrationChanged(
          "Integration target changed during merge.",
        );
      throw error;
    }
    return candidate.head;
  }
}
