import { SpritesClient, ExecError } from "@fly/sprites";
import { z } from "zod";
import { foremanOutput, type ForemanOutput } from "../contracts";
import type { AgentProvider } from "../domain/agents";

const gatewayOrigin = "https://api.sprites.dev/v1/gateway";
export const model = process.env.EMBEDDING_MODEL || "gemini-embedding-001";

type Worker = { name: string; providers: Set<AgentProvider> };
const providers = new Set<AgentProvider>(["openai", "anthropic", "meta"]);
function configuredWorkers(): Worker[] {
  const names = new Set<string>();
  const configured = (process.env.SPRITE_POOL || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const [name, rawProviders = "openai"] = value.split("=");
      if (!name || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(name))
        throw new Error(`Invalid Sprite pool entry: ${value}`);
      if (names.has(name)) throw new Error(`Duplicate Sprite worker: ${name}`);
      names.add(name);
      const capabilities = rawProviders
        .split("|")
        .map((provider) => provider.trim() as AgentProvider);
      if (!capabilities.length || capabilities.some((p) => !providers.has(p)))
        throw new Error(`Invalid provider in Sprite pool entry: ${value}`);
      return { name, providers: new Set(capabilities) };
    });
  return configured.length
    ? configured
    : [
        {
          name: process.env.SPRITE_NAME || "company-os-worker",
          providers: new Set<AgentProvider>(["openai"]),
        },
      ];
}

class SpritePool {
  readonly workers = configuredWorkers();
  private active = new Set<string>();
  private waiters: (() => void)[] = [];
  private cursor = 0;
  constructor(private client: SpritesClient) {}
  get capacity() {
    return this.workers.length;
  }
  get primary() {
    return this.client.sprite(this.workers[0]!.name);
  }
  sprite(name: string) {
    if (!this.workers.some((worker) => worker.name === name))
      throw new Error("Unknown Sprite worker.");
    return this.client.sprite(name);
  }
  async use<T>(
    provider: AgentProvider | undefined,
    operation: (
      sprite: ReturnType<SpritesClient["sprite"]>,
      name: string,
    ) => Promise<T>,
    preferred?: string,
  ): Promise<T> {
    const compatible = this.workers.filter(
      (worker) => !provider || worker.providers.has(provider),
    );
    if (!compatible.length)
      throw new Error(`No Sprite worker is configured for ${provider}.`);
    const preferredWorker = compatible.find(
      (worker) => worker.name === preferred,
    );
    if (preferred && !preferredWorker)
      throw new Error(`Preferred Sprite ${preferred} cannot run ${provider}.`);
    const eligible = preferredWorker ? [preferredWorker] : compatible;
    let selected: Worker | undefined;
    while (!selected) {
      const start = preferredWorker ? 0 : this.cursor;
      for (let offset = 0; offset < eligible.length; offset++) {
        const candidate = eligible[(start + offset) % eligible.length]!;
        if (!this.active.has(candidate.name)) {
          selected = candidate;
          this.cursor = (start + offset + 1) % eligible.length;
          this.active.add(candidate.name);
          break;
        }
      }
      if (!selected)
        await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    try {
      return await operation(this.client.sprite(selected.name), selected.name);
    } finally {
      this.active.delete(selected.name);
      const waiting = this.waiters.splice(0);
      waiting.forEach((resolve) => resolve());
    }
  }
}

export class Integrations {
  private client?: SpritesClient;
  private workerPool?: SpritePool;
  get pool() {
    if (!process.env.SPRITES_TOKEN)
      throw new Error("Configure SPRITES_TOKEN before starting the worker.");
    this.client ||= new SpritesClient(process.env.SPRITES_TOKEN);
    return (this.workerPool ||= new SpritePool(this.client));
  }
  get capacity() {
    return process.env.SPRITES_TOKEN ? this.pool.capacity : 0;
  }
  get spriteNames() {
    return process.env.SPRITES_TOKEN
      ? this.pool.workers.map((worker) => worker.name)
      : configuredWorkers().map((worker) => worker.name);
  }
  get spriteName() {
    return this.spriteNames[0]!;
  }
  get sprite() {
    return this.pool.primary;
  }
  spriteByName(name: string) {
    return this.pool.sprite(name);
  }
  withSprite<T>(
    provider: AgentProvider | undefined,
    operation: (
      sprite: ReturnType<SpritesClient["sprite"]>,
      name: string,
    ) => Promise<T>,
    preferred?: string,
  ) {
    return this.pool.use(provider, operation, preferred);
  }
  async executePayload(
    script: string,
    payload: unknown,
    options: {
      timeout: number;
      maxBuffer: number;
      maxRunAfterDisconnect?: string;
    },
    provider?: AgentProvider,
    preferred?: string,
  ) {
    return this.pool.use(
      provider,
      async (sprite, spriteName) => {
        const fs = sprite.filesystem("/home/sprite/company-os");
        await fs.mkdir("inputs", { recursive: true });
        const path =
          "/home/sprite/company-os/inputs/" + crypto.randomUUID() + ".json";
        await fs.writeFile(path, JSON.stringify(payload), { mode: 0o600 });
        try {
          const result = await sprite.execFile(
            "bun",
            ["-e", script, path],
            options,
          );
          return { ...result, spriteName };
        } catch (error) {
          if (error instanceof ExecError) return { ...error.result, spriteName };
          throw error;
        } finally {
          await fs.rm(path).catch(() => {});
        }
      },
      preferred,
    );
  }
  async gateway(
    provider: string,
    connector: string | undefined,
    path: string,
    body?: unknown,
    method?: string,
  ) {
    if (!connector) throw new Error(`${provider} connector is not configured.`);
    const script = `const p=await Bun.file(process.argv[1]).json();
   const r=await fetch(p.url,{method:p.method||(p.body?'POST':'GET'),headers:{'Content-Type':'application/json'},body:p.body?JSON.stringify(p.body):undefined,signal:AbortSignal.timeout(45000)});
   const text=await r.text();if(!r.ok){console.error('Provider returned '+r.status+': '+text.slice(0,600));process.exit(1)};console.log(text);`;
    const result = await this.executePayload(
      script,
      {
        url: `${gatewayOrigin}/${provider}/${connector}/${path}`,
        body,
        method,
      },
      { timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
    );
    if (result.exitCode !== 0)
      throw new Error(
        String(result.stderr).slice(0, 900) || "Connector request failed.",
      );
    return JSON.parse(String(result.stdout));
  }
  async embed(text: string, task: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT") {
    const data = await this.gateway(
      "custom_api",
      process.env.GEMINI_CONNECTOR_ID,
      `v1beta/models/${model}:embedContent`,
      {
        model: `models/${model}`,
        content: { parts: [{ text }] },
        taskType: task,
        outputDimensionality: 768,
      },
    );
    const values = data.embedding?.values;
    if (
      !Array.isArray(values) ||
      values.length !== 768 ||
      values.some((n: unknown) => typeof n !== "number" || !Number.isFinite(n))
    )
      throw new Error("Google returned an invalid embedding.");
    const norm = Math.sqrt(
      values.reduce((s: number, v: number) => s + v * v, 0),
    );
    if (!norm) throw new Error("Google returned a zero embedding.");
    return values.map((v: number) => v / norm) as number[];
  }
  async repository() {
    const repo = process.env.GITHUB_REPOSITORY || "rywible/company-os";
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
      throw new Error("Invalid repository configuration");
    const data = await this.gateway(
      "github",
      process.env.GITHUB_CONNECTOR_ID,
      `repos/${repo}`,
    );
    const commits = await this.gateway(
      "github",
      process.env.GITHUB_CONNECTOR_ID,
      `repos/${repo}/commits?per_page=3`,
    );
    const head = commits[0]?.sha;
    return {
      ref: `github:${repo}@${head || "unknown"}`,
      repository: repo,
      url: data.html_url,
      description: data.description,
      defaultBranch: data.default_branch,
      head,
      commits: commits.map((c: any) => ({
        sha: c.sha,
        message: c.commit.message,
        url: c.html_url,
      })),
      observedAt: new Date().toISOString(),
    };
  }
  async authStatus() {
    const r = await this.pool.use("openai", (sprite) =>
      sprite.execFile("codex", ["login", "status"], { timeout: 30000 }),
    );
    return {
      ready: r.exitCode === 0,
      detail: (String(r.stdout) + " " + String(r.stderr)).trim().slice(0, 300),
    };
  }
  async foreman(runId: string, prompt: string): Promise<ForemanOutput> {
    const schema = z.toJSONSchema(foremanOutput);
    const script = `const fs=await import('node:fs/promises');const cp=await import('node:child_process');
   const p=JSON.parse(Buffer.from(process.argv[1],'base64').toString());
   const dir='/home/sprite/company-os/runs/'+p.id;await fs.mkdir(dir,{recursive:true});
   try {console.log(await fs.readFile(dir+'/result.json','utf8'));process.exit(0)}catch{}
   let lock;try{lock=await fs.open(dir+'/running','wx')}catch{console.error('A previous attempt may still be running. Inspect the Sprite before retrying.');process.exit(1)}
   await fs.writeFile(dir+'/schema.json',JSON.stringify(p.schema));await fs.writeFile(dir+'/prompt.txt',p.prompt);
   const log=await fs.open(dir+'/events.jsonl','w');const errors=await fs.open(dir+'/stderr.log','w');
   const child=cp.spawn('codex',['exec','--skip-git-repo-check','--ignore-user-config','--ignore-rules','--sandbox','read-only','-c','approval_policy="never"','--color','never','--json','--output-schema',dir+'/schema.json','--output-last-message',dir+'/result.json','-'],{cwd:dir,stdio:['pipe',log.fd,errors.fd]});
   child.stdin.end(p.prompt);let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},240000);
   child.on('error',e=>{console.error(e.message);process.exit(1)});
   child.on('exit',async code=>{clearTimeout(timer);await lock.close();await fs.unlink(dir+'/running').catch(()=>{});
    if(code!==0){console.error(timedOut?'Foreman reached its four-minute limit.':(await fs.readFile(dir+'/stderr.log','utf8')).slice(-1800));process.exit(1)}
    console.log(await fs.readFile(dir+'/result.json','utf8'));
   });`;
    const input = Buffer.from(
      JSON.stringify({ id: runId, prompt, schema }),
    ).toString("base64");
    const r = await this.sprite.execFile(
      "node",
      ["--input-type=module", "-e", script, input],
      {
        timeout: 270000,
        maxBuffer: 2 * 1024 * 1024,
        maxRunAfterDisconnect: "30s",
      },
    );
    if (r.exitCode !== 0)
      throw new Error(
        String(r.stderr).slice(-1800) || "The Foreman did not finish.",
      );
    return foremanOutput.parse(JSON.parse(String(r.stdout)));
  }
}
export { chunkDocument } from "../domain/knowledge";
