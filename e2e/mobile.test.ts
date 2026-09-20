import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fixture } from "./fixture";
import { renderMarkdown } from "../src/server/markdown";
import { commandSchema } from "../src/domain/model";
const backends = (process.env.UI_BACKENDS || "chrome").split(",") as (
  | "chrome"
  | "webkit"
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
async function setup(
  backend: "chrome" | "webkit",
  size = widths[1]!,
  empty = false,
) {
  const f = fixture(empty),
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
    backend:
      backend === "chrome"
        ? {
            type: "chrome",
            url: false,
            argv: process.platform === "linux" ? ["--no-sandbox"] : [],
          }
        : "webkit",
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
    if (await view.evaluate<any>(expression)) return;
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
    const element = await view.evaluate<any>(
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
  await view.evaluate<any>(
    `document.querySelector(${JSON.stringify(selector)}).select()`,
  );
  await view.type(value);
}

async function nav(view: Bun.WebView, name: string) {
  if (name === "Work" || name === "Discovery") {
    await nav(view, "Inbox");
    await click(view, ".inbox-background summary");
    await button(
      view,
      name === "Work" ? "Work in progress" : "Ideas and experiments",
    );
    await wait(view, `!!document.querySelector('.inbox-drilldown')`);
    return;
  }
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
      test("discovery: investigate, triage, learn, edit perspectives and record feedback", async () => {
        const { view, repo, errors } = await setup(backend, size);
        const state = repo.state();
        state.settings.enabled = true;
        repo.save(state);
        await view.reload();
        await wait(
          view,
          `!!document.querySelector('[data-workspace-ready="true"]')`,
        );
        await nav(view, "Discovery");
        await fits(view);
        expect(
          await view.evaluate<any>(
            `[...document.querySelectorAll('nav[aria-label="Workspace navigation"] button')].map(b=>b.getAttribute('aria-label'))`,
          ),
        ).toEqual(["Open Inbox", "Open Documents", "Open Knowledge"]);
        await button(view, "Explore next");
        await nav(view, "Inbox");
        await button(view, "Make navigation clearer", ".thread-list", false);
        await wait(
          view,
          `!!document.querySelector('.email-original .markdown')`,
        );
        expect(repo.state().discovery.ideas[0]!.status).toBe("ready");
        expect(repo.state().threads.filter((t) => t.discoveryId)).toHaveLength(
          1,
        );
        await fits(view);
        expect(
          await view.evaluate<any>(
            `document.querySelectorAll('.conversation .discovery-detail, .conversation details').length`,
          ),
        ).toBe(0);
        await button(view, "Pursue");
        await wait(
          view,
          `![...document.querySelectorAll('.mail-decision button')].some(b => b.textContent === 'Pursue')`,
        );
        expect(repo.state().discovery.ideas[0]!.status).toBe("learned");
        await fits(view);
        await nav(view, "Settings");
        await click(view, ".settings-discovery > summary");
        await button(view, "Perspectives");
        await fits(view);
        await button(view, "Edit Users & workflows");
        await fill(
          view,
          '[aria-label="Perspective question"]',
          "Where does the mobile workflow confuse me?",
        );
        await button(view, "Save perspective");
        await wait(
          view,
          `!document.querySelector('[aria-label="Edit perspective"]')`,
        );
        expect(
          repo.state().discovery.lenses.find((l) => l.id === "users")!.question,
        ).toContain("mobile workflow");
        await button(view, "Signals");
        await fill(
          view,
          '[aria-label="Discovery signal"]',
          "I could not tell which navigation label to use on my phone.",
        );
        await button(view, "Add signal");
        await wait(
          view,
          `document.querySelector('.discovery-signal')?.textContent.includes('navigation label')`,
        );
        expect(
          repo
            .state()
            .discovery.signals.some((s) =>
              s.detail.includes("navigation label"),
            ),
        ).toBe(true);
        await fits(view);
        await Bun.write(
          `.artifacts/discovery-${size.name}.png`,
          await view.screenshot(),
        );
        expect(errors).toEqual([]);
      }, 30000);
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
        await nav(view, "Knowledge");
        await fill(view, '[aria-label="Search knowledge"]', "architecture");
        await button(view, "Search");
        await button(view, "Edit A clearer architecture");
        expect(
          await view.evaluate<any>(
            `[...document.querySelectorAll('dialog label')].map(l => l.firstChild.textContent.trim())`,
          ),
        ).toEqual(["Subject", "Content"]);
        expect(
          await view.evaluate<any>(
            `document.querySelectorAll('dialog details, dialog select').length`,
          ),
        ).toBe(0);
        await fill(
          view,
          "dialog textarea",
          "Architecture: the founder can revise this text directly from the search results.",
        );
        await button(view, "Save", "dialog");
        await wait(view, `!document.querySelector('dialog')`);
        expect(repo.document("architecture")!.version).toBe(3);
        expect(repo.document("architecture")!.indexed_version).toBe(3);
        await wait(
          view,
          `document.querySelector('.knowledge-card')?.textContent.includes('founder can revise')`,
        );
        expect(
          await view.evaluate<any>(
            `document.querySelectorAll('.knowledge-card details, .knowledge-card small').length`,
          ),
        ).toBe(0);
        await fits(view);
        await Bun.write(
          `.artifacts/knowledge-${size.name}.png`,
          await view.screenshot(),
        );
        await button(view, "A clearer architecture", "", false);
        await wait(
          view,
          `!!document.querySelector('dialog[aria-label="Edit entry"]')`,
        );
        expect(
          await view.evaluate<any>(
            `document.querySelector('dialog textarea').value.includes('founder can revise')`,
          ),
        ).toBe(true);
        await fits(view);
        expect(errors).toEqual([]);
      }, 30000);
      test("email threads, new messages, archive and isolated drafts", async () => {
        const { view, repo, errors } = await setup(backend, size);
        await button(view, "Prove the handoff before expanding", "", false);
        expect(
          await view.evaluate<any>(
            `document.querySelectorAll('.thread-list').length`,
          ),
        ).toBe(0);
        await click(view, ".mail-attachment");
        await wait(
          view,
          `!!document.querySelector('dialog .markdown p') && !document.querySelector('dialog .markdown-source')`,
        );
        await button(view, "Accept revision", "dialog");
        await wait(view, `!document.querySelector('dialog')`);
        expect(repo.document("sequence")!.version).toBe(2);
        await fill(
          view,
          '[aria-label="Message Foreman"]',
          "Keep this reply separate",
        );
        await button(view, "New message");
        await fill(view, "dialog input", "Product direction");
        await fill(
          view,
          '[aria-label="New message content"]',
          "Preserve my direction",
        );
        await fits(view);
        await button(view, "Close dialog");
        expect(
          await view.evaluate<any>(
            `document.querySelector('[aria-label="Message Foreman"]').value`,
          ),
        ).toBe("Keep this reply separate");
        await nav(view, "Documents");
        await nav(view, "Inbox");
        await button(view, "New message");
        expect(
          await view.evaluate<any>(
            `document.querySelector('dialog input').value`,
          ),
        ).toBe("Product direction");
        expect(
          await view.evaluate<any>(
            `document.querySelector('dialog textarea').value`,
          ),
        ).toBe("Preserve my direction");
        await button(view, "Send", "dialog");
        await wait(
          view,
          `!document.querySelector('dialog') && document.querySelectorAll('.message').length===2`,
        );
        expect(
          repo.state().threads.filter((t) => t.kind === "conversation"),
        ).toHaveLength(1);
        expect(
          repo.state().threads.find((t) => t.kind === "conversation")!.subject,
        ).toBe("Product direction");
        await fill(
          view,
          '[aria-label="Message Foreman"]',
          "A follow-up on direction",
        );
        await button(view, "Send message");
        await wait(view, `document.querySelectorAll('.message').length===4`);
        expect(
          repo
            .state()
            .threads.find((t) => t.kind === "conversation")!
            .messages.filter((m) => m.role === "human"),
        ).toHaveLength(2);
        await Bun.write(
          `.artifacts/mail-thread-${size.name}.png`,
          await view.screenshot(),
        );
        await button(view, "Archive");
        await wait(view, `!!document.querySelector('.thread-list')`);
        expect(
          repo.state().threads.find((t) => t.kind === "conversation")!.status,
        ).toBe("resolved");
        await button(view, "Archived", ".filters");
        await button(view, "Product direction", ".thread-list", false);
        await button(view, "Move to inbox");
        await button(view, "Inbox", ".filters");
        await button(view, "Product direction", ".thread-list", false);
        await button(view, "← Inbox");
        await button(
          view,
          "Prove the handoff before expanding",
          ".thread-list",
          false,
        );
        expect(
          await view.evaluate<any>(
            `document.querySelector('[aria-label="Message Foreman"]').value`,
          ),
        ).toBe("Keep this reply separate");
        await button(view, "Archive");
        expect(repo.state().threads[0]!.status).toBe("resolved");
        await fits(view);
        await Bun.write(
          `.artifacts/mail-list-${size.name}.png`,
          await view.screenshot(),
        );
        expect(errors).toEqual([]);
      }, 30000);
      test("work, PR review count and complete event-driven round", async () => {
        const { view, repo, errors } = await setup(backend, size);
        await nav(view, "Settings");
        expect(
          await view.evaluate<any>(
            `document.querySelector('main').innerText.includes('Objective')`,
          ),
        ).toBe(false);
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

test("empty workspace: author the constitution without starter documents or invented work", async () => {
  const { view, repo, errors } = await setup("chrome", widths[0]!, true);
  expect(repo.documents()).toHaveLength(0);
  expect(repo.state().threads).toHaveLength(0);
  expect(repo.state().work).toHaveLength(0);
  await fits(view);
  await button(view, "Write constitution");
  await fill(
    view,
    "dialog textarea",
    "Build software that helps small orchestras plan rehearsals. Keep proposals grounded in observed problems.",
  );
  await button(view, "Save revision", "dialog");
  await wait(view, `!document.querySelector('dialog')`);
  expect(repo.documents()).toHaveLength(1);
  expect(repo.documents()[0]!.level).toBe("constitution");
  expect(repo.documents()[0]!.indexed_version).toBe(1);
  await nav(view, "Documents");
  await wait(
    view,
    `document.querySelector('.document-reader')?.textContent.includes('small orchestras')`,
  );
  await nav(view, "Knowledge");
  expect(
    await view.evaluate<any>(
      `document.querySelectorAll('.knowledge-card').length`,
    ),
  ).toBe(1);
  await button(view, "New entry");
  expect(
    await view.evaluate<any>(
      `document.querySelectorAll('dialog select, dialog details').length`,
    ),
  ).toBe(0);
  await fill(view, "dialog input", "Rehearsal timing");
  await fill(view, "dialog textarea", "Leave ten minutes between rehearsals.");
  await button(view, "Save", "dialog");
  await wait(view, `!document.querySelector('dialog')`);
  const entry = repo.documents().find((d) => d.title === "Rehearsal timing")!;
  expect(entry.level).toBe("knowledge");
  expect(entry.indexed_version).toBe(1);
  await fill(view, '[aria-label="Search knowledge"]', "Rehearsal timing");
  await button(view, "Search");
  await wait(view, `document.querySelectorAll('.knowledge-card').length === 1`);
  expect(
    await view.evaluate<any>(
      `document.querySelector('.knowledge-card').textContent.includes('ten minutes')`,
    ),
  ).toBe(true);
  await nav(view, "Documents");
  await button(view, "Discuss with Foreman");
  await wait(
    view,
    `!!document.querySelector('dialog[aria-label="New message"]')`,
  );
  expect(
    await view.evaluate<any>(`document.querySelector('h1').textContent`),
  ).toBe("Inbox");
  expect(
    await view.evaluate<any>(
      `document.querySelector('dialog .attachment').textContent.includes('Constitution')`,
    ),
  ).toBe(true);
  await fill(
    view,
    '[aria-label="New message content"]',
    "Help me refine this constitution.",
  );
  await button(view, "Send", "dialog");
  await wait(view, `!document.querySelector('dialog')`);
  expect(repo.state().threads[0]!.attachment).toEqual({
    id: repo.documents().find((d) => d.level === "constitution")!.id,
    version: 1,
  });
  await view.evaluate<any>(`location.hash = 'Foreman'`);
  await wait(view, `document.querySelector('h1')?.textContent === 'Inbox'`);
  await fits(view);
  expect(errors).toEqual([]);
}, 30000);

test("browser inspection uses the real accessible names at desktop and phone widths", async () => {
  const { view, origin } = await setup("chrome");
  // The visible label is intentionally shorter than the accessible name.
  expect(
    await view.evaluate<string>(
      `document.querySelector('nav button[aria-label="Open Knowledge"]').textContent`,
    ),
  ).toBe("Knowledge");
  const { SpriteBrowser } = await import("../src/adapters/browser");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(tmpdir() + "/company-inspection-");
  try {
    const integrations = {
      sprite: {
        execFile: async (_command: string, args: string[]) => {
          const payload = JSON.parse(
            Buffer.from(args[2]!, "base64").toString(),
          );
          payload.url = origin;
          const script = args[1]!.replace(
            "/home/sprite/company-os/browser",
            dir,
          );
          const child = Bun.spawn(
            [
              "bun",
              "-e",
              script,
              Buffer.from(JSON.stringify(payload)).toString("base64"),
            ],
            { stdout: "pipe", stderr: "pipe" },
          );
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          return { stdout, stderr, exitCode };
        },
      },
    };
    const browser = new SpriteBrowser(
      integrations as any,
      "https://inspection.example",
      "test-secret",
    );
    const evidence = await browser.inspect("browser-contract");
    expect(evidence.steps).toHaveLength(8);
    expect(evidence.errors).toEqual([]);
    for (const label of ["Inbox", "Documents", "Knowledge"]) {
      expect(
        evidence.steps.some(
          (s) => s.action === "Phone: click " + label && s.title === label,
        ),
      ).toBe(true);
    }
    const memory = evidence.steps
      .at(-1)!
      .navigation?.find((n) => n.visibleText === "Knowledge");
    expect(memory?.accessibleName).toBe("Open Knowledge");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 45000);
