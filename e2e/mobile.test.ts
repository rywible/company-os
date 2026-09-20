import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fixture } from "./fixture";
import { renderMarkdown } from "../src/server/markdown";
import { commandSchema } from "../src/domain/model";
const backends = (process.env.UI_BACKENDS || "chrome").split(",") as (
  "chrome" | "webkit"
)[];
const widths = [
  { name: "small-phone", width: 320, height: 568 },
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "landscape", width: 844, height: 390 },
  { name: "desktop", width: 1440, height: 1000 },
];
let active:
  | {
      view: Bun.WebView;
      server: ReturnType<typeof Bun.serve>;
      store: ReturnType<typeof fixture>["store"];
    }
  | undefined;
afterEach(async () => {
  active?.view.close();
  await active?.server.stop(true);
  active?.store.close();
  active = undefined;
});
async function setup(backend: "chrome" | "webkit", size = widths[1]!) {
  const f = fixture(),
    root = resolve("dist");
  await f.drain();
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url),
      path = url.pathname;
    try {
      if (path === "/healthz") return Response.json({ ok: true });
      if (path.startsWith("/api/")) {
        let data: unknown;
        if (path === "/api/session") data = { authenticated: true };
        else if (path === "/api/company") data = f.snapshot();
        else if (path === "/api/commands") {
          data = await f.company.execute(commandSchema.parse(await req.json()));
          await f.drain();
        } else if (path === "/api/markdown")
          data = { nodes: renderMarkdown((await req.json()).source) };
        else if (path === "/api/events")
          data = f.repo.events(url.searchParams.get("entity") || undefined);
        else if (path === "/api/context")
          data = await f.company.preview(
            url.searchParams.get("q") || "",
            undefined,
            url.searchParams.get("thread") || undefined,
          );
        else if (path === "/api/search")
          data = {
            results: f.repo.search(url.searchParams.get("q") || ""),
            mode: "keyword",
          };
        else if (path.startsWith("/api/knowledge/")) {
          const d = f.repo.document(path.split("/").at(-1)!)!;
          data = {
            document: d,
            policy: f.snapshot().documents.find((v) => v.id === d.id)!.policy,
            chunks: f.repo.chunks(d.id),
            history: f.repo.history(d.id),
            usedBy: [],
          };
        } else
          return Response.json(
            { error: "Unknown fixture request " + path },
            { status: 404 },
          );
        return Response.json(data, {
          headers: { "Cache-Control": "no-store" },
        });
      }
      const file = resolve(root, "." + (path === "/" ? "/index.html" : path));
      if (!file.startsWith(root + "/"))
        return new Response(null, { status: 404 });
      const target = Bun.file(file);
      return (await target.exists())
        ? new Response(target, { headers: { "Cache-Control": "no-cache" } })
        : new Response(null, { status: 404 });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 409 });
    }
  };
  let server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const port = server.port,
    errors: unknown[] = [];
  const view = new Bun.WebView({
    backend: backend === "chrome" ? { type: "chrome", url: false } : "webkit",
    width: size.width,
    height: size.height,
    console: (level, ...args) => {
      if (level === "error") errors.push(args);
    },
  });
  active = { view, server, store: f.store };
  if (backend === "chrome") {
    await view.navigate("about:blank");
    await view.cdp("Emulation.setDeviceMetricsOverride", {
      width: size.width,
      height: size.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }
  await view.navigate(server.url.href);
  await wait(view, `!!document.querySelector('[data-workspace-ready="true"]')`);
  return {
    view,
    ...f,
    errors,
    origin: server.url.href,
    disconnect: async () => {
      await server.stop(true);
    },
    reconnect: () => {
      server = Bun.serve({ hostname: "127.0.0.1", port, fetch: handler });
      active = { view, server, store: f.store };
    },
  };
}
async function wait(view: Bun.WebView, expression: string) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (await view.evaluate(expression)) return;
    await Bun.sleep(25);
  }
  await Bun.write(
    `.artifacts/webview-failure-${Date.now()}.png`,
    await view.screenshot(),
  );
  throw Error(`Browser condition timed out: ${expression}`);
}
const visible = `(el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'`;
async function click(view: Bun.WebView, selector: string) {
  await view.scrollTo(selector, { block: "center", timeout: 7000 });
  try {
    await view.click(selector, { timeout: 7000 });
  } catch (error) {
    await Bun.write(
      `.artifacts/webview-click-failure-${Date.now()}.png`,
      await view.screenshot(),
    );
    const element = await view.evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.outerHTML`,
    );
    throw new Error(`Click failed: ${element}`, { cause: error });
  }
}
async function button(
  view: Bun.WebView,
  name: string,
  scope = "",
  exact = true,
) {
  const selector = `${scope ? scope + " " : ""}button`;
  const expression = `(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(${visible}).find(el => {
      const name = (el.getAttribute('aria-label') || el.textContent).trim();
      return ${exact ? `name === ${JSON.stringify(name)}` : `name.includes(${JSON.stringify(name)})`};
    });
    document.querySelector('[data-webview-target]')?.removeAttribute('data-webview-target');
    if (el?.disabled) return false;
    if (el) el.setAttribute('data-webview-target', '');
    return !!el;
  })()`;
  await wait(view, expression);
  await click(view, "[data-webview-target]");
}
async function fill(view: Bun.WebView, selector: string, value: string) {
  await click(view, selector);
  // Selecting the existing text does not mutate React state; native insertion
  // below fires the trusted input event, just as a user replacing text would.
  await view.evaluate(
    `document.querySelector(${JSON.stringify(selector)}).select()`,
  );
  await view.type(value);
}

async function nav(view: Bun.WebView, name: string) {
  await button(view, "Open " + name);
  await wait(
    view,
    `document.querySelector('h1')?.textContent===${JSON.stringify(name)}`,
  );
}
async function fits(view: Bun.WebView) {
  expect(
    await view.evaluate<boolean>(
      "document.documentElement.scrollWidth<=innerWidth+1",
    ),
  ).toBe(true);
}
for (const backend of backends) {
  for (const size of widths)
    describe(`${backend} ${size.name}`, () => {
      test("documents, editable understanding, context selection and Mermaid", async () => {
        const { view, repo, errors } = await setup(backend, size);
        await nav(view, "Documents");
        await wait(view, `!!document.querySelector('.diagram svg')`);
        await fits(view);
        await button(view, "Edit");
        await fill(view, "dialog input", "A clearer architecture");
        await button(view, "Save revision", "dialog");
        await wait(view, `!document.querySelector('dialog')`);
        expect(repo.document("architecture")!.version).toBe(2);
        expect(repo.document("architecture")!.indexed_version).toBe(2);
        await button(view, "Preview selection");
        await button(view, "Preview", "dialog");
        await wait(view, `!!document.querySelector('.context-view')`);
        expect(
          await view.evaluate<any>(
            `document.querySelector('.context-view').textContent.includes('Included')`,
          ),
        ).toBe(true);
        await button(view, "Close dialog");
        await wait(view, `!document.querySelector('dialog')`);
        await nav(view, "Understanding");
        await fill(view, '[aria-label="Search understanding"]', "architecture");
        await button(view, "Search");
        await button(view, "A clearer architecture", "", false);
        await wait(
          view,
          `!!document.querySelector('dialog[aria-label="Understanding record"]')`,
        );
        expect(
          await view.evaluate<any>(
            `document.querySelector('dialog').textContent.includes('Embedding chunks')`,
          ),
        ).toBe(true);
        await fits(view);
        expect(errors).toEqual([]);
      }, 30000);
      test("inbox threads and isolated Foreman conversation drafts", async () => {
        const { view, repo, errors } = await setup(backend, size);
        await button(view, "Prove the handoff before expanding", "", false);
        await button(view, "Accept revision");
        await wait(
          view,
          `document.querySelector('.revision-proposal .badge')?.textContent==='accepted'`,
        );
        expect(repo.document("sequence")!.version).toBe(2);
        await button(view, "Resolve");
        expect(repo.state().threads[0]!.status).toBe("resolved");
        await nav(view, "Foreman");
        await fill(
          view,
          '[aria-label="Message Foreman"]',
          "Preserve my direction",
        );
        await nav(view, "Documents");
        await nav(view, "Foreman");
        expect(
          await view.evaluate<any>(`document.querySelector('textarea').value`),
        ).toBe("Preserve my direction");
        await button(view, "Send message");
        await wait(view, `document.querySelectorAll('.message').length===2`);
        expect(
          repo.state().threads.filter((t) => t.kind === "conversation"),
        ).toHaveLength(1);
        await fits(view);
        expect(errors).toEqual([]);
      }, 30000);
      test("work, PR review count and complete event-driven round", async () => {
        const { view, repo, errors } = await setup(backend, size);
        await nav(view, "Settings");
        await fill(view, 'input[type="number"][max="5"]', "3");
        await button(view, "Save review policy");
        await wait(view, `!document.querySelector('button.primary:disabled')`);
        expect(repo.state().settings.requiredReviews).toBe(3);
        await nav(view, "Work");
        await button(view, "New work");
        await fill(view, "dialog input", "Investigate responsive layout");
        await fill(view, "dialog textarea", "Inspect the layout boundaries");
        await fill(view, 'dialog textarea[rows="3"]', "Concrete findings");
        await button(view, "Create work", "dialog");
        await wait(view, `!!document.querySelector('.work-detail')`);
        await fill(
          view,
          'input[type="url"]',
          "https://github.com/rywible/company-os/pull/7",
        );
        await button(view, "Link PR & start review");
        await wait(
          view,
          `document.querySelector('.review-panel')?.textContent.includes('3/3 reviews')`,
        );
        expect(repo.state().reviewRounds[0]!.status).toBe("approved");
        await button(view, "Workflow history");
        await wait(
          view,
          `document.querySelector('dialog')?.textContent.includes('WorkerSignalled')`,
        );
        await fits(view);
        expect(errors).toEqual([]);
      }, 30000);
    });
  if (backend === "chrome")
    test("Chrome PWA: icons, cache privacy, offline fallback and reconnect", async () => {
      const { view, origin, disconnect, reconnect } = await setup(backend);
      await wait(view, `!!navigator.serviceWorker.controller`);
      const manifest = await (
        await fetch(new URL("manifest.webmanifest", origin))
      ).json();
      expect(manifest.display).toBe("standalone");
      for (const icon of manifest.icons) {
        const response = await fetch(new URL(icon.src, origin));
        expect(response.ok).toBe(true);
        expect(response.headers.get("Content-Type")).toContain("image/png");
      }
      const paths = await view.evaluate<string[]>(`(async () => {
      const paths = [];
      for (const key of await caches.keys())
        for (const request of await (await caches.open(key)).keys()) paths.push(new URL(request.url).pathname);
      return paths;
    })()`);
      expect(paths.length).toBeGreaterThan(0);
      expect(
        paths.every(
          (path) => path === "/offline.html" || path.startsWith("/icons/"),
        ),
      ).toBe(true);
      // Stop the fixture origin so worker and page requests both lose network
      // access. Tab-scoped CDP offline mode does not affect worker fetches.
      await disconnect();
      await view.reload();
      await wait(
        view,
        `document.querySelector('h1')?.textContent === 'Offline'`,
      );
      reconnect();
      await wait(view, `document.querySelector('h1')?.textContent === 'Inbox'`);
    }, 30000);
}
