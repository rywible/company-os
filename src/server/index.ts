import { GitHubResearchSources } from "../adapters/research-sources";
import { createHmac, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod";
import { documentInput } from "../contracts";
import { Store, Conflict } from "./store";
import { Integrations, model } from "./integrations";
import { SQLiteRepository } from "../adapters/sqlite";
import { SpriteAgent } from "../adapters/agents";
import { GitHubPullRequests } from "../adapters/github";
import { SpriteBrowser } from "../adapters/browser";
import { Company } from "../application/company";
import { Runner } from "../application/runner";
import { commandSchema, defaultPolicy, DomainError } from "../domain/model";
import { workflowDefinitions } from "../domain/workflows";
import { renderMarkdown } from "./markdown";

const production = process.env.NODE_ENV === "production";
const development = !production && process.env.BUN_DEV === "1";
const devPage = development
  ? (await import("../../index.html")).default
  : undefined;
if (
  production &&
  (!process.env.ADMIN_PASSWORD ||
    !process.env.SESSION_SECRET ||
    !process.env.PUBLIC_ORIGIN)
)
  throw new Error(
    "Production requires ADMIN_PASSWORD, SESSION_SECRET, and PUBLIC_ORIGIN",
  );
const store = new Store(),
  integrations = new Integrations(),
  repository = new SQLiteRepository(store),
  agent = new SpriteAgent(integrations),
  browser = new SpriteBrowser(
    integrations,
    process.env.PUBLIC_ORIGIN || "",
    process.env.SESSION_SECRET || "",
  ),
  company = new Company(
    repository,
    agent,
    agent,
    browser,
    undefined,
    undefined,
    new GitHubPullRequests(integrations),
    new GitHubResearchSources(),
  ),
  worker = new Runner(
    company,
    () => !!process.env.SPRITES_TOKEN,
    Number(process.env.WORKER_CONCURRENCY || integrations.capacity || 1),
  );
const port = Number(process.env.PORT || 3000),
  origin = process.env.PUBLIC_ORIGIN;
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const sign = (s: string) =>
  createHmac("sha256", process.env.SESSION_SECRET || "local-development")
    .update(s)
    .digest("hex");
function equal(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function authenticated(req: Request) {
  if (!production) return true;
  const token =
    req.headers
      .get("cookie")
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("company_session="))
      ?.slice(16) || "";
  const [expires, signature] = token.split(".");
  return (
    !!expires &&
    Number(expires) > Date.now() &&
    !!signature &&
    equal(sign(expires), signature)
  );
}
function inspecting(req: Request) {
  const value =
    req.headers
      .get("cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("company_inspection="))
      ?.slice(19) || "";
  const [expires, signature] = value.split(".");
  return (
    !!expires &&
    Number(expires) > Date.now() &&
    Number(expires) < Date.now() + 11 * 60000 &&
    !!signature &&
    equal(
      createHmac("sha256", process.env.SESSION_SECRET || "")
        .update("inspection:" + expires)
        .digest("hex"),
      signature,
    )
  );
}
const attempts = new Map<string, { count: number; since: number }>();
async function body(req: Request) {
  const text = await req.text();
  if (text.length > 100000) throw new Error("Request too large");
  return JSON.parse(text);
}

export const server = Bun.serve({
  port,
  development: development ? { hmr: true, console: true } : false,
  routes: devPage ? { "/": devPage } : undefined,
  hostname: production ? "0.0.0.0" : "127.0.0.1",
  maxRequestBodySize: 100000,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url),
      path = url.pathname;
    try {
      if (path === "/healthz") {
        store.db.query("SELECT 1").get();
        return json({ ok: true });
      }
      if (path.startsWith("/api/")) {
        if (!["GET", "HEAD"].includes(req.method)) {
          const requestOrigin = req.headers.get("origin");
          if (
            requestOrigin &&
            requestOrigin !== (production ? origin : url.origin)
          )
            return json({ error: "Origin rejected" }, 403);
        }
        if (path === "/api/session" && req.method === "GET")
          return json({
            authenticated: authenticated(req) || inspecting(req),
            readOnly: inspecting(req) && !authenticated(req),
          });
        if (path === "/api/login" && req.method === "POST") {
          const ip = server.requestIP(req)?.address || "unknown",
            old = attempts.get(ip);
          const entry =
            old && Date.now() - old.since < 60000
              ? old
              : { count: 0, since: Date.now() };
          if (++entry.count > 10)
            return json(
              { error: "Too many attempts. Try again in a minute." },
              429,
            );
          attempts.set(ip, entry);
          const { password } = z
            .object({ password: z.string().max(300) })
            .parse(await body(req));
          if (!equal(password, process.env.ADMIN_PASSWORD || ""))
            return json({ error: "Incorrect access key" }, 401);
          attempts.delete(ip);
          const expires = String(Date.now() + 7 * 86400000);
          return new Response("{}", {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
              "Set-Cookie": `company_session=${expires}.${sign(expires)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${production ? "; Secure" : ""}`,
            },
          });
        }
        if (!authenticated(req) && !inspecting(req))
          return json({ error: "Sign in to your company workspace." }, 401);
        if (
          inspecting(req) &&
          !authenticated(req) &&
          !["GET", "HEAD"].includes(req.method) &&
          path !== "/api/markdown"
        )
          return json({ error: "Inspection sessions are read-only." }, 403);
        if (path === "/api/company" && req.method === "GET")
          return json({
            ...repository.state(),
            documents: repository.documents().map((d) => ({
              ...d,
              policy: repository.state().policies[d.id] || defaultPolicy(d),
            })),
            deliveryErrors: repository.deliveryErrors(),
            configured: !!process.env.SPRITES_TOKEN,
            workflows: workflowDefinitions,
          });
        if (path === "/api/commands" && req.method === "POST")
          return json(
            await company.execute(commandSchema.parse(await body(req))),
          );
        if (path === "/api/context" && req.method === "GET")
          return json(
            await company.preview(
              (url.searchParams.get("q") || "").slice(0, 12000),
              url.searchParams.get("scope") || undefined,
              url.searchParams.get("thread") || undefined,
            ),
          );
        if (path === "/api/events" && req.method === "GET")
          return json(
            repository.events(url.searchParams.get("entity") || undefined),
          );
        const knowledge = path.match(/^\/api\/knowledge\/([^/]+)$/);
        if (knowledge && req.method === "GET") {
          const versionParam = url.searchParams.get("version");
          const version = versionParam
            ? z.coerce.number().int().positive().parse(versionParam)
            : undefined;
          const d = repository.document(knowledge[1]!, version);
          if (!d) return json({ error: "Not found" }, 404);
          return json({
            document: d,
            policy: repository.state().policies[d.id] || defaultPolicy(d),
            chunks: repository.chunks(d.id),
            history: repository.history(d.id),
            usedBy: repository
              .state()
              .runs.filter((r) =>
                r.context?.entries.some((e) => e.id === d.id && e.included),
              )
              .map((r) => ({
                id: r.id,
                at: r.createdAt,
                trigger: r.trigger,
                entry: r.context!.entries.find((e) => e.id === d.id),
              })),
          });
        }
        const artifact = path.match(/^\/api\/artifacts\/([\w-]+-\d+\.png)$/);
        if (artifact && req.method === "GET") {
          const browserRun = repository
            .state()
            .runs.find((r) =>
              r.context?.browser?.steps.some(
                (s) => s.screenshot === artifact[1],
              ),
            );
          if (!browserRun)
            return json({ error: "Not found" }, 404);
          return new Response(
            await browser.artifact(
              artifact[1]!,
              browserRun.context?.browser?.worker,
            ),
            {
              headers: {
                "Content-Type": "image/png",
                "Cache-Control": "no-store",
              },
            },
          );
        }
        if (path === "/api/logout" && req.method === "POST")
          return new Response("{}", {
            headers: {
              "Set-Cookie":
                "company_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
              "Content-Type": "application/json",
            },
          });
        if (path === "/api/markdown" && req.method === "POST") {
          const { source } = z
            .object({ source: z.string().max(24000) })
            .parse(await body(req));
          return json({ nodes: renderMarkdown(source) });
        }
        if (path === "/api/state" && req.method === "GET")
          return json({
            ...store.snapshot(),
            integrations: {
              sprites: integrations.spriteNames,
              poolCapacity: integrations.capacity,
              configured: !!process.env.SPRITES_TOKEN,
              google: !!process.env.GEMINI_CONNECTOR_ID,
              github: !!process.env.GITHUB_CONNECTOR_ID,
              anthropic: !!process.env.ANTHROPIC_CONNECTOR_ID,
              meta: !!process.env.META_CONNECTOR_ID,
              embeddingModel: model,
            },
          });
        if (
          ["/api/direction", "/api/documents"].includes(path) ||
          path.startsWith("/api/proposals/") ||
          path.match(/^\/api\/(documents|runs)\//)
        )
          return json(
            {
              error:
                "Workspace upgraded. Reload to use conversations and the inbox.",
            },
            409,
          );
        if (path === "/api/search" && req.method === "GET") {
          const query = (url.searchParams.get("q") || "").trim().slice(0, 1500);
          if (!query) return json({ results: [], mode: "keyword" });
          let vector: number[] | undefined, warning: string | undefined;
          try {
            vector = await integrations.embed(query, "RETRIEVAL_QUERY");
          } catch {
            warning =
              "Semantic search is unavailable. Showing keyword matches.";
          }
          return json({
            results: store
              .search(
                query,
                vector,
                model,
                url.searchParams.has("view") ? 60 : 6,
              )
              .filter((d) => {
                const view = url.searchParams.get("view"),
                  library = repository.state().library;
                return view === "library"
                  ? d.level !== "constitution" &&
                      (d.level !== "knowledge" || !!library.pages[d.id])
                  : view === "evidence"
                    ? d.level === "knowledge" && !library.pages[d.id]
                    : true;
              }),
            mode: vector ? "hybrid" : "keyword",
            warning,
          });
        }
        return json({ error: "Not found" }, 404);
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        return json({ error: "Method not allowed" }, 405);
      const root = resolve(development ? "public" : "dist"),
        file = resolve(join(root, decodeURIComponent(path)));
      if (!file.startsWith(root + "/") && file !== root)
        return new Response("Not found", { status: 404 });
      const target = Bun.file(file);
      if (path !== "/" && (await target.exists()))
        return new Response(target, {
          headers: {
            "Cache-Control": path.startsWith("/assets/")
              ? "public, max-age=31536000, immutable"
              : "no-cache",
            "X-Content-Type-Options": "nosniff",
            ...(path === "/manifest.webmanifest"
              ? { "Content-Type": "application/manifest+json" }
              : {}),
            ...(path === "/sw.js" ? { "Service-Worker-Allowed": "/" } : {}),
          },
        });
      if (
        path.startsWith("/assets/") ||
        path.startsWith("/icons/") ||
        path === "/sw.js" ||
        path === "/manifest.webmanifest"
      )
        return new Response("Not found", { status: 404 });
      const index = Bun.file("dist/index.html");
      if (!(await index.exists()))
        return new Response("Run bun run build, or start bun run dev.", {
          status: 503,
        });
      return new Response(index, {
        headers: {
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "same-origin",
        },
      });
    } catch (e) {
      if (e instanceof Conflict || e instanceof DomainError)
        return json({ error: e.message }, 409);
      if (e instanceof z.ZodError || e instanceof SyntaxError)
        return json(
          {
            error: "Invalid request",
            details: e instanceof z.ZodError ? e.issues : undefined,
          },
          400,
        );
      console.error(e);
      return json(
        {
          error:
            "The operation failed. Inspect delivery failures in Work or check server logs.",
        },
        500,
      );
    }
  },
});
worker.start();
console.log(`Company OS listening on port ${port}`);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    worker.stop();
    server.stop(true);
    store.close();
    process.exit(0);
  });
