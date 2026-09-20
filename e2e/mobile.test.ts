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
            results: f.repo
              .search(url.searchParams.get("q") || "", undefined, undefined, 60)
              .filter((d) => {
                const type = url.searchParams.get("view");
                return type === "library"
                  ? d.level !== "constitution" &&
                      (d.level !== "knowledge" ||
                        !!f.repo.state().library.pages[d.id])
                  : type === "evidence"
                    ? d.level === "knowledge" &&
                      !f.repo.state().library.pages[d.id]
                    : true;
              }),
            mode: "keyword",
          };
        else if (path.startsWith("/api/knowledge/")) {
          const d = f.repo.document(
            path.split("/").at(-1)!,
            Number(url.searchParams.get("version")) || undefined,
          )!;
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
async function choose(view: Bun.WebView, selector: string, value: string) {
  await view.evaluate(
    `(() => { const el=document.querySelector(${JSON.stringify(selector)}); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('change',{bubbles:true})); })()`,
  );
}

async function nav(view: Bun.WebView, name: string) {
  if (name === "Work" || name === "Discovery") {
    await view.evaluate(`location.hash = ${JSON.stringify("#" + name)}`);
    await wait(view, `!!document.querySelector('.inbox-drilldown')`);
    return;
  }
  await button(view, "Open " + name);
  await wait(
    view,
    `[...document.querySelectorAll('nav[aria-label="Workspace navigation"] button')].some(b => b.getAttribute('aria-current') === 'page' && b.getAttribute('aria-label') === ${JSON.stringify("Open " + name)})`,
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
      test("task schedules, local limits, manual runs and inbox triage", async () => {
        const { view, repo, errors } = await setup(backend, size);
        const state = repo.state();
        state.settings.enabled = true;
        repo.save(state);
        await view.reload();
        await wait(
          view,
          `!!document.querySelector('[data-workspace-ready="true"]')`,
        );
        await nav(view, "Automation");
        await fits(view);
        expect(
          await view.evaluate<any>(
            `[...document.querySelectorAll('nav[aria-label="Workspace navigation"] button')].map(b=>b.getAttribute('aria-label'))`,
          ),
        ).toEqual([
          "Open Inbox",
          "Open Constitution",
          "Open Knowledge",
          "Open Automation",
          "Open Settings",
        ]);
        await button(view, "Run Users & workflows now");
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
        await nav(view, "Automation");
        expect(
          await view.evaluate<any>(
            `document.querySelectorAll('.automation-page .section-tabs').length`,
          ),
        ).toBe(0);
        expect(
          await view.evaluate<any>(
            `document.querySelector('.automation-page').textContent.includes('exploratory')`,
          ),
        ).toBe(false);
        await button(view, "Pause Users & workflows");
        await wait(
          view,
          `!!document.querySelector('[aria-label="Resume Users & workflows"]')`,
        );
        expect(
          repo.state().discovery.lenses.find((l) => l.id === "users")!.enabled,
        ).toBe(false);
        expect(
          repo.state().discovery.lenses.find((l) => l.id === "direction")!
            .enabled,
        ).toBe(true);
        await button(view, "Edit Users & workflows");
        await fill(
          view,
          '[aria-label="Task question"]',
          "Where does the mobile workflow confuse me?",
        );
        await fill(view, '[aria-label="Hours between runs"]', "12");
        await fill(view, '[aria-label="Runs per day"]', "8");
        await fill(view, '[aria-label="Active idea limit"]', "3");
        await choose(view, '[aria-label="Agent provider"]', "anthropic");
        await fill(view, '[aria-label="Agent model"]', "sonnet");
        await choose(view, '[aria-label="Reasoning effort"]', "xhigh");
        await button(view, "Save task");
        await wait(view, `!document.querySelector('.task-editor')`);
        const task = repo
          .state()
          .discovery.lenses.find((l) => l.id === "users")!;
        expect(task.intervalHours).toBe(12);
        expect(task.dailyRunLimit).toBe(8);
        expect(task.maxActiveIdeas).toBe(3);
        expect(task.agent).toEqual({
          provider: "anthropic",
          model: "sonnet",
          reasoningEffort: "xhigh",
        });
        const count = repo.state().runs.length;
        await button(view, "Run Users & workflows now");
        await wait(
          view,
          `!!document.querySelector('.task-actions [role="status"]')`,
        );
        expect(repo.state().runs.length).toBeGreaterThan(count);
        expect(
          repo.state().discovery.lenses.find((l) => l.id === "users")!.enabled,
        ).toBe(false);
        await button(view, "Resume Users & workflows");
        await wait(
          view,
          `!!document.querySelector('[aria-label="Pause Users & workflows"]')`,
        );
        await fits(view);
        await Bun.write(
          `.artifacts/tasks-${size.name}.png`,
          await view.screenshot(),
        );
        expect(errors).toEqual([]);
      }, 30000);
      test("documents, editable understanding, context selection and Mermaid", async () => {
        const { view, repo, errors } = await setup(backend, size);
        await nav(view, "Knowledge");
        await button(view, "System architecture", ".library-index", false);
        await wait(view, `!!document.querySelector('.diagram svg')`);
        await fits(view);
        await button(view, "Edit");
        await fill(view, "dialog input", "A clearer architecture");
        await click(view, '[aria-label="Document content"]');
        await view.evaluate<any>(
          `(() => {const el = document.querySelector('[aria-label="Document content"]'); const start = el.value.indexOf('The application'); el.setSelectionRange(start, start + 15);})()`,
        );
        await button(view, "Bold", ".format-tools");
        await wait(
          view,
          `document.querySelector('[aria-label="Document content"]').value.includes('**The application**')`,
        );
        await button(view, "Preview", ".view-switch");
        await wait(
          view,
          `!!document.querySelector('.document-preview strong') && !!document.querySelector('.document-preview .diagram svg')`,
        );
        await fits(view);
        expect(
          await view.evaluate<any>(
            `(() => {const r=document.querySelector('.editor-footer').getBoundingClientRect();return r.top >= 0 && r.bottom <= innerHeight + 1;})()`,
          ),
        ).toBe(true);
        await Bun.write(
          `.artifacts/editor-preview-${size.name}.png`,
          await view.screenshot(),
        );
        await button(view, "Write", ".view-switch");
        await click(view, '[aria-label="Document content"]');
        // Exercise Chrome's native undo command; WebView key injection does not
        // consistently dispatch platform editing shortcuts on headless Chrome.
        await view.evaluate<any>(`document.execCommand('undo')`);
        await wait(
          view,
          `!document.querySelector('[aria-label="Document content"]').value.includes('**The application**')`,
        );
        await Bun.write(
          `.artifacts/editor-write-${size.name}.png`,
          await view.screenshot(),
        );
        await view.press("b", { modifiers: ["Control"] });
        await wait(
          view,
          `document.querySelector('[aria-label="Document content"]').value.includes('**The application**')`,
        );
        await button(view, "Preview", ".view-switch");
        await wait(
          view,
          `!!document.querySelector('.document-preview strong')`,
        );
        await button(view, "Save", "dialog");
        await wait(view, `!document.querySelector('dialog')`);
        expect(repo.document("architecture")!.version).toBe(2);
        expect(repo.document("architecture")!.indexed_version).toBe(2);
        await click(view, ".context-contract > summary");
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
        await button(view, "← Library");
        // All non-constitution documents share the library.
        expect(
          await view.evaluate<number>(
            "document.querySelectorAll('.library-row').length",
          ),
        ).toBe(
          repo.documents().filter((d) => d.level !== "constitution").length,
        );
        await button(view, "New document");
        await fill(view, "dialog input", "Editor behavior");
        await fill(
          view,
          "dialog textarea",
          "The document editor preserves unfinished drafts on mobile.",
        );
        await button(view, "Preview", "dialog");
        await wait(
          view,
          "!!document.querySelector('.document-preview .markdown p')",
        );
        await button(view, "Save", "dialog");
        await wait(view, "!document.querySelector('dialog')");
        const subject = repo
          .documents()
          .find((d) => d.title === "Editor behavior")!;
        expect(repo.state().library.pages[subject.id]?.collection).toBe(
          "Unfiled",
        );
        await wait(view, "!!document.querySelector('.library-reader')");
        await button(view, "Organize");
        await fill(view, ".library-organize input", "Product");
        await button(view, "Save organization");
        await wait(view, "!document.querySelector('.library-organize')");
        expect(repo.state().library.pages[subject.id]?.collection).toBe(
          "Product",
        );
        await button(view, "Edit", ".library-reader");
        expect(
          await view.evaluate<number>(
            "document.querySelectorAll('dialog .editor-context-policy').length",
          ),
        ).toBe(1);
        await fill(
          view,
          "dialog textarea",
          "The founder can revise this subject. Drafts persist on mobile.",
        );
        await button(view, "Save", "dialog");
        await wait(view, "!document.querySelector('dialog')");
        expect(repo.document(subject.id)?.version).toBe(2);
        expect(repo.document(subject.id)?.indexed_version).toBe(2);
        await wait(
          view,
          "document.querySelector('.library-reader')?.textContent.includes('founder can revise')",
        );
        await view.evaluate(
          `Array.from(document.querySelectorAll("summary")).find(el => el.textContent === "Revision history").click()`,
        );
        await wait(
          view,
          "document.querySelector('.library-reader')?.textContent.includes('Revision 1')",
        );
        await fits(view);
        await Bun.write(
          `.artifacts/library-reader-${size.name}.png`,
          await view.screenshot(),
        );
        await button(view, "← Library");
        await fill(view, '[aria-label="Search knowledge"]', "Editor behavior");
        await button(view, "Search");
        await wait(
          view,
          "document.querySelectorAll('.library-row').length === 1",
        );
        await fits(view);
        await Bun.write(
          `.artifacts/library-${size.name}.png`,
          await view.screenshot(),
        );
        expect(errors).toEqual([]);
      }, 30000);
      test("source revisions, review dates and withdrawal are readable on mobile", async () => {
        const { view, repo, company, origin, errors } = await setup(
          backend,
          size,
        );
        const page = company.execute({
          type: "SaveKnowledge",
          title: "Deployment understanding",
          content: "Deployments use the approved architecture.",
          level: "knowledge",
          policy: {
            inclusion: "relevant",
            status: "active",
            scope: "company",
            kind: "document",
          },
        }) as { id: string };
        const source = repo.document("architecture")!;
        const state = repo.state();
        state.library.pages[page.id]!.sources = [
          `document:${source.id}@${source.version}`,
        ];
        repo.save(state);
        company.execute({
          type: "SaveKnowledge",
          ...source,
          expectedVersion: source.version,
          content: "Updated deployment architecture",
          policy: state.policies[source.id] || {
            inclusion: "relevant",
            status: "active",
            scope: "company",
            kind: "document",
          },
        });
        await view.reload();
        await wait(
          view,
          `!!document.querySelector('[data-workspace-ready="true"]')`,
        );
        await nav(view, "Knowledge");
        await wait(view, "!!document.querySelector('.library-row')");
        await button(view, "Deployment understanding", ".library-index", false);
        await wait(view, "!!document.querySelector('.library-freshness')");
        await click(view, ".library-support > summary");
        await button(view, "v2", ".library-support");
        await wait(
          view,
          "document.querySelector('.library-reader')?.textContent.includes('Updated deployment architecture')",
        );
        await button(view, "← Subject");
        await click(view, ".library-review > summary");
        await button(view, "Confirm current sources");
        await wait(view, "!document.querySelector('.library-freshness')");
        expect(repo.document(page.id)?.version).toBe(2);
        expect(repo.state().library.pages[page.id]!.sources).toEqual([
          `document:${source.id}@2`,
        ]);
        await click(view, ".library-review > summary");
        await view.evaluate(
          `document.querySelector('input[name="reviewDate"]').value = "2099-01-01"`,
        );
        await button(view, "Save review date");
        await wait(
          view,
          "document.querySelector('input[name=reviewDate]')?.defaultValue === '2099-01-01'",
        );
        await click(view, ".library-review > summary");
        await button(view, "Withdraw subject");
        await wait(
          view,
          "document.querySelector('.library-freshness strong')?.textContent === 'Withdrawn'",
        );
        expect(repo.state().library.pages[page.id]!.withdrawn).toBe(true);
        await fits(view);
        await Bun.write(
          `.artifacts/freshness-${size.name}.png`,
          await view.screenshot(),
        );
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
        await nav(view, "Constitution");
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
        await click(view, ".context-used > summary");
        await wait(
          view,
          "document.querySelector('.context-used[open]')?.textContent.includes('Relevant knowledge')",
        );
        expect(
          await view.evaluate<boolean>(
            "document.querySelector('.context-used[open]').textContent.includes('Assignment')",
          ),
        ).toBe(true);
        await fits(view);
        await Bun.write(
          `.artifacts/inbox-context-${size.name}.png`,
          await view.screenshot(),
        );
        await click(view, ".context-used > summary");
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
        await wait(view, "!!document.querySelector('.thread-list')");
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
        await wait(view, "!!document.querySelector('.thread-list')");
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
        expect(
          await view.evaluate<any>(
            `document.querySelectorAll('.settings-page input').length`,
          ),
        ).toBe(1);
        await fill(view, ".settings-page input", "rywible/company-os");
        await button(view, "Save workspace");
        await wait(
          view,
          `document.querySelector('.settings-page [role="status"]')?.textContent === 'Saved'`,
        );
        expect(repo.state().settings.scope).toBe("rywible/company-os");
        await Bun.write(
          `.artifacts/settings-${size.name}.png`,
          await view.screenshot(),
        );
        await button(view, "Foreman", ".section-tabs");
        await choose(view, '[aria-label="Agent provider"]', "meta");
        await fill(view, '[aria-label="Agent model"]', "llama-studio");
        await choose(view, '[aria-label="Reasoning effort"]', "ultra");
        await button(view, "Save Foreman");
        await wait(
          view,
          `document.querySelector('.settings-page [role="status"]')?.textContent === 'Saved'`,
        );
        expect(repo.state().settings.foremanAgent).toEqual({
          provider: "meta",
          model: "llama-studio",
          reasoningEffort: "ultra",
        });
        await button(view, "Reviews", ".section-tabs");
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
      await wait(
        view,
        `document.querySelector('nav button[aria-label="Open Inbox"][aria-current="page"]') !== null`,
      );
    }, 30000);
}

test("empty workspace: author the constitution without starter documents or invented work", async () => {
  const { view, repo, errors } = await setup("chrome", widths[0]!, true);
  expect(repo.documents()).toHaveLength(0);
  expect(repo.state().threads).toHaveLength(0);
  expect(repo.state().work).toHaveLength(0);
  await fits(view);
  expect(
    await view.evaluate<boolean>(
      `document.querySelector('.nav-bottom') === null && document.querySelector('nav button[aria-label="Open Settings"]') !== null`,
    ),
  ).toBe(true);
  await nav(view, "Automation");
  expect(
    await view.evaluate<boolean>(
      `document.querySelector('.task-toolbar button')?.classList.contains('primary') === true && ![...document.querySelectorAll('.automation-page button')].some((b) => ['Work in progress', 'Ideas and experiments'].includes(b.textContent?.trim() || ''))`,
    ),
  ).toBe(true);
  expect(
    await view.evaluate<any>(`document.querySelector('.task-notice') === null`),
  ).toBe(true);
  expect(
    await view.evaluate<any>(
      `[...document.querySelectorAll('.task-actions .primary')].every(b=>b.disabled)`,
    ),
  ).toBe(true);
  expect(
    await view.evaluate<any>(
      `document.querySelector('.automation-page').textContent.includes('Next check')`,
    ),
  ).toBe(false);
  await nav(view, "Constitution");
  await button(view, "Write constitution");
  await fill(view, "dialog input", "Constitution");
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
  await nav(view, "Constitution");
  await wait(
    view,
    `document.querySelector('.document-reader')?.textContent.includes('small orchestras')`,
  );
  await nav(view, "Knowledge");
  expect(
    await view.evaluate<any>(
      `document.querySelectorAll('.library-row').length`,
    ),
  ).toBe(0);
  await button(view, "New document");
  expect(
    await view.evaluate<any>(
      `document.querySelectorAll('dialog .editor-context-policy').length`,
    ),
  ).toBe(1);
  await fill(view, "dialog input", "Rehearsal timing");
  await fill(view, "dialog textarea", "Leave ten minutes between rehearsals.");
  await button(view, "Save", "dialog");
  await wait(view, `!document.querySelector('dialog')`);
  const entry = repo.documents().find((d) => d.title === "Rehearsal timing")!;
  expect(entry.level).toBe("knowledge");
  expect(entry.indexed_version).toBe(1);
  await wait(
    view,
    `document.querySelector('.library-reader')?.textContent.includes('ten minutes')`,
  );
  await button(view, "← Library");
  await fill(view, '[aria-label="Search knowledge"]', "Rehearsal timing");
  await button(view, "Search");
  await wait(view, `document.querySelectorAll('.library-row').length === 1`);
  expect(
    await view.evaluate<any>(
      `document.querySelector('.library-row').textContent.includes('ten minutes')`,
    ),
  ).toBe(true);
  await nav(view, "Constitution");
  await click(view, ".context-contract > summary");
  await button(view, "Discuss with Foreman");
  await wait(
    view,
    `!!document.querySelector('dialog[aria-label="New message"]')`,
  );
  expect(
    await view.evaluate<any>(
      `document.querySelector('nav button[aria-label="Open Inbox"][aria-current="page"]') !== null`,
    ),
  ).toBe(true);
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
  await wait(
    view,
    `document.querySelector('nav button[aria-label="Open Inbox"][aria-current="page"]') !== null`,
  );
  await fits(view);
  expect(errors).toEqual([]);
}, 30000);

test("constitution and knowledge have distinct homes, with searchable editable documents", async () => {
  const { view, repo, errors } = await setup("chrome", widths[0]!);
  await nav(view, "Constitution");
  await wait(
    view,
    `document.querySelector('.document-reader')?.textContent.includes('Company constitution')`,
  );
  expect(
    await view.evaluate<any>(
      `document.querySelector('.document-list') === null`,
    ),
  ).toBe(true);
  await Bun.sleep(250); // Let the active navigation font finish its transition.
  expect(
    await view.evaluate<any>(
      `[...document.querySelectorAll('nav button span')].filter(el => el.scrollWidth > el.clientWidth).map(el => ({label: el.textContent, needed: el.scrollWidth, available: el.clientWidth}))`,
    ),
  ).toEqual([]);
  await fits(view);
  await Bun.write(
    ".artifacts/constitution-small-phone.png",
    await view.screenshot(),
  );
  await view.evaluate<any>(
    `[...document.querySelectorAll('summary')].find(el => el.textContent === 'Revision history').click()`,
  );
  await wait(
    view,
    `document.querySelector('.document-reader')?.textContent.includes('Revision 1')`,
  );
  expect(
    await view.evaluate<any>(`document.querySelector('dialog') === null`),
  ).toBe(true);
  await button(view, "Edit");
  expect(
    await view.evaluate<any>(
      `document.querySelectorAll('dialog select').length`,
    ),
  ).toBe(0);
  await fill(
    view,
    "dialog textarea",
    "Build useful software. Keep human direction explicit.",
  );
  await button(view, "Save revision", "dialog");
  await wait(view, `!document.querySelector('dialog')`);
  expect(repo.document("constitution")!.version).toBe(2);
  await nav(view, "Knowledge");
  expect(
    await view.evaluate<any>(
      `document.querySelector('.library-index').textContent.includes('Company constitution')`,
    ),
  ).toBe(false);
  await fill(view, '[aria-label="Search knowledge"]', "Litestream");
  await button(view, "Search");
  await wait(view, `document.querySelectorAll('.library-row').length === 1`);
  await button(view, "System architecture", ".library-index", false);
  await wait(view, `!!document.querySelector('.library-reader')`);
  await button(view, "New document");
  expect(
    await view.evaluate<any>(
      `[...document.querySelectorAll('dialog option')].some(o => o.value === 'constitution')`,
    ),
  ).toBe(false);
  await fill(view, "dialog input", "Approved product plan");
  await view.evaluate<any>(
    `(() => { const select = document.querySelector('dialog select'); select.value = 'product'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`,
  );
  await fill(view, "dialog textarea", "Ship the rehearsal planner first.");
  await button(view, "Save", "dialog");
  await wait(
    view,
    `!document.querySelector('dialog') && document.querySelector('.library-reader')?.textContent.includes('Approved product plan')`,
  );
  const product = repo
    .documents()
    .find((d) => d.title === "Approved product plan")!;
  expect(product.level).toBe("product");
  expect(repo.state().policies[product.id]!.kind).toBe("document");
  await button(view, "Edit", ".library-reader");
  await fill(
    view,
    "dialog textarea",
    "Ship the rehearsal planner with calendar export.",
  );
  await button(view, "Save", "dialog");
  await wait(view, `!document.querySelector('dialog')`);
  expect(repo.document(product.id)!.version).toBe(2);
  await view.evaluate<any>(`location.hash = 'Documents'`);
  await view.reload();
  await wait(view, `!!document.querySelector('.library-index')`);
  await button(view, "Approved product plan", ".library-index", false);
  await wait(
    view,
    `document.querySelector('.library-reader')?.textContent.includes('calendar export')`,
  );
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
    const evidence = await browser.inspect("browser-contract-ui-v2");
    expect(evidence.steps).toHaveLength(10);
    expect(evidence.errors).toEqual([]);
    for (const label of ["Inbox", "Constitution", "Knowledge", "Automation"]) {
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

test("library maintenance produces browsable subjects with versioned sources", async () => {
  const { view, repo, errors } = await setup("chrome", widths[1]!);
  await nav(view, "Automation");
  await button(view, "Run Knowledge library now");
  await nav(view, "Knowledge");
  await wait(
    view,
    "[...document.querySelectorAll('.library-collection')].some(el => el.textContent.includes('Company'))",
  );
  await button(view, "Working principles", ".library-index", false);
  await wait(
    view,
    "document.querySelector('.library-reader')?.textContent.includes('Maintained by Foreman')",
  );
  const subjectId = Object.keys(repo.state().library.pages)[0]!;
  const ref = repo.state().library.pages[subjectId]!.sources[0]!;
  const sourceId = /^document:(.+)@/.exec(ref)![1]!;
  await click(view, ".library-support > summary");
  await button(view, repo.document(sourceId)!.title, ".library-support", false);
  await wait(
    view,
    "document.querySelector('.library-reader')?.textContent.includes('Source revision 1')",
  );
  await fits(view);
  await button(view, "← Subject");
  await button(view, "Discuss with Foreman");
  await fill(
    view,
    '[aria-label="New message content"]',
    "Explain these principles",
  );
  await button(view, "Send", "dialog");
  await wait(view, "!!document.querySelector('.context-used')");
  await click(view, ".context-used > summary");
  await wait(
    view,
    "document.querySelector('.context-used[open]')?.textContent.includes('Working principles')",
  );
  await fits(view);
  expect(errors).toEqual([]);
}, 30000);
