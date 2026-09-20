import type { ResearchSourcesPort, ResearchSource } from "../application/ports";
/** Only human-configured public GitHub repositories. No arbitrary URL fetching or credentials. */
export class GitHubResearchSources implements ResearchSourcesPort {
  constructor(
    private request: (
      url: string,
      options: RequestInit,
    ) => Promise<Response> = fetch,
  ) {}
  async read(repositories: string[]): Promise<ResearchSource[]> {
    return Promise.all(
      repositories.slice(0, 3).map(async (repository) => {
        const result: ResearchSource = {
          repository,
          fetchedAt: new Date().toISOString(),
          releases: [],
        };
        try {
          if (
            !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/.test(
              repository,
            )
          )
            throw Error("Invalid public repository name.");
          const response = await this.request(
            `https://api.github.com/repos/${repository}/releases?per_page=3`,
            {
              headers: {
                Accept: "application/vnd.github+json",
                "User-Agent": "Company-OS-Discovery",
              },
              redirect: "error",
              signal: AbortSignal.timeout(10000),
            },
          );
          if (!response.ok)
            throw Error(
              `Public release feed returned HTTP ${response.status}.`,
            );
          // Bound both the network response and the snapshot supplied to the agent.
          const reader = response.body!.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > 512000)
                throw Error("Release feed exceeds the snapshot limit.");
              chunks.push(value);
            }
          } finally {
            await reader.cancel();
          }
          const releases = JSON.parse(Buffer.concat(chunks).toString());
          if (!Array.isArray(releases)) throw Error("Invalid release feed.");
          result.releases = releases
            .filter((r) => !r.draft && !r.prerelease)
            .slice(0, 3)
            .map((r) => {
              if (!Number.isSafeInteger(r.id) || typeof r.tag_name !== "string")
                throw Error("Invalid release record.");
              return {
                ref: `release:${repository}@${r.id}`,
                title: String(r.name || r.tag_name).slice(0, 200),
                url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(r.tag_name)}`,
                publishedAt: String(r.published_at || "unknown"),
                content: String(r.body || "No release notes.").slice(0, 12000),
              };
            });
        } catch (error) {
          result.error =
            error instanceof Error
              ? error.message
              : "Release source unavailable.";
        }
        return result;
      }),
    );
  }
}
