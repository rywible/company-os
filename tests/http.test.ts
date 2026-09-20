import { createHmac } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const temp = mkdtempSync(join(tmpdir(), "company-os-http-"));
const port = 41000 + Math.floor(Math.random() * 10000),
  base = `http://127.0.0.1:${port}`;
let processHandle: ReturnType<typeof Bun.spawn>;
let cookie = "";
beforeAll(async () => {
  processHandle = Bun.spawn(["bun", "src/server/index.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      DATABASE_PATH: join(temp, "test.sqlite"),
      PUBLIC_ORIGIN: base,
      ADMIN_PASSWORD: "test-key",
      SESSION_SECRET: "test-signing-secret",
      SPRITES_TOKEN: "",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/healthz")).ok) return;
    } catch {}
    await Bun.sleep(30);
  }
  throw Error("HTTP server did not start");
});
afterAll(async () => {
  processHandle?.kill();
  await processHandle?.exited;
  rmSync(temp, { recursive: true, force: true });
});
test("production denies anonymous state and tampered sessions", async () => {
  expect((await fetch(base + "/api/state")).status).toBe(401);
  expect(
    (
      await fetch(base + "/api/state", {
        headers: { cookie: `company_session=${Date.now() + 10000}.invalid` },
      })
    ).status,
  ).toBe(401);
});
test("login rejects invalid keys and establishes a private session", async () => {
  const login = (password: string) =>
    fetch(base + "/api/login", {
      method: "POST",
      headers: { origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
  expect((await login("éééé")).status).toBe(401);
  const response = await login("test-key");
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie")!;
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Strict");
  cookie = setCookie.split(";")[0]!;
  expect(
    (await fetch(base + "/api/state", { headers: { cookie } })).status,
  ).toBe(200);
});
test("authenticated mutations require same origin and current document version", async () => {
  const update = (origin: string, expectedVersion?: number) =>
    fetch(base + "/api/commands", {
      method: "POST",
      headers: { origin, cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "SaveKnowledge",
        id: "product-direction",
        policy: {
          inclusion: "relevant",
          status: "active",
          scope: "company",
          kind: "document",
        },
        title: "Product",
        level: "product",
        content: "A refined direction",
        expectedVersion,
      }),
    });
  expect(
    (await (await fetch(base + "/api/company", { headers: { cookie } })).json())
      .documents,
  ).toHaveLength(0);
  expect((await update(base)).status).toBe(200);
  expect((await update("https://untrusted.example", 1)).status).toBe(403);
  expect((await update(base)).status).toBe(409);
  expect((await update(base, 1)).status).toBe(200);
  expect((await update(base, 1)).status).toBe(409);
});
test("Markdown rendering is private, uncached, and bounded", async () => {
  const render = (source: unknown, session = cookie) =>
    fetch(base + "/api/markdown", {
      method: "POST",
      headers: {
        origin: base,
        cookie: session,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ source }),
    });
  expect((await render("# Private", "")).status).toBe(401);
  expect((await render("a".repeat(24001))).status).toBe(400);
  expect((await render({ invalid: true })).status).toBe(400);
  const response = await render("# Private");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect((await response.json()).nodes[0].tag).toBe("h1");
});

test("browser inspection sessions can read context but cannot mutate company state", async () => {
  const expires = String(Date.now() + 600000),
    signature = createHmac("sha256", "test-signing-secret")
      .update("inspection:" + expires)
      .digest("hex");
  const headers = {
    cookie: `company_inspection=${expires}.${signature}`,
    origin: base,
    "Content-Type": "application/json",
  };
  expect((await fetch(base + "/api/company", { headers })).status).toBe(200);
  expect(
    (
      await fetch(base + "/api/commands", {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "Heartbeat" }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(base + "/api/markdown", {
        method: "POST",
        headers,
        body: JSON.stringify({ source: "# Inspection" }),
      })
    ).status,
  ).toBe(200);
  expect(
    (await (await fetch(base + "/api/session", { headers })).json()).readOnly,
  ).toBe(true);
});
