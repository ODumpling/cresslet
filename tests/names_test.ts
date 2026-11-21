import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/main.ts";
import { loadConfig } from "../server/config.ts";

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-names-"));
  const srv = createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80, adminToken: "adm" }));
  const json = async (method: string, path: string, token?: string, input?: unknown) => {
    const headers = new Headers({ host: "test.local" });
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (input !== undefined) headers.set("content-type", "application/json");
    const r = await srv.handler(new Request(`http://test.local${path}`, { method, headers, body: input === undefined ? undefined : JSON.stringify(input) }));
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const account = async (email: string) =>
    (await json("POST", "/v1/accounts", "adm", { email })).body.token as string;
  return { dataDir, srv, json, account };
}

test("names: suggest a free name, check one, and create apps and pages with a chosen name", async () => {
  const t = await setup();
  try {
    const tok = await t.account("a@b.co");

    // Suggestions: a readable name for an app, an unguessable one for a page. No login needed.
    const app = (await t.json("GET", "/v1/names/suggest")).body;
    assert.match(app.name, /^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
    assert.equal(app.url, `http://${app.name}.test.local`);
    assert.match((await t.json("GET", "/v1/names/suggest?kind=page")).body.name, /^pg-[0-9a-f]{20}$/);
    assert.equal((await t.json("GET", "/v1/names/suggest?kind=x")).status, 400);

    // Checks: free, invalid (format, reserved), taken.
    assert.deepEqual((await t.json("GET", "/v1/names/my-shop")).body, { name: "my-shop", available: true, url: "http://my-shop.test.local" });
    for (const bad of ["My-Shop", "-shop", "shop-", "a--b", "api", "x".repeat(41)]) {
      const r = (await t.json("GET", `/v1/names/${bad}`)).body;
      assert.equal(r.available, false, bad);
      assert.equal(r.reason, "invalid", bad);
    }
    assert.equal((await t.json("GET", "/v1/names/api")).body.message, "api is reserved");

    // An app deployed under the chosen name gets it; the name is then taken for apps and pages alike.
    const d = await t.json("POST", "/v1/deploys", tok, { app: "my-shop", files: [{ path: "index.html", data: "hi" }] });
    assert.equal(d.status, 201);
    assert.equal(d.body.app.name, "my-shop");
    assert.equal(d.body.app.url, "http://my-shop.test.local");
    const taken = (await t.json("GET", "/v1/names/my-shop")).body;
    assert.equal(taken.available, false);
    assert.equal(taken.reason, "taken");
    // Someone else can't create (or deploy over) it.
    const other = await t.account("o@b.co");
    assert.equal((await t.json("POST", "/v1/deploys", other, { app: "my-shop", files: [{ path: "index.html", data: "x" }] })).status, 403);

    // Pages: a chosen name, or a generated one when left out.
    const p = await t.json("POST", "/v1/pages", tok, { name: "q3-report", html: "<h1>Q3</h1>" });
    assert.equal(p.status, 201);
    assert.equal(p.body.page.name, "q3-report");
    assert.equal(p.body.page.url, "http://q3-report.test.local");
    assert.match((await t.json("POST", "/v1/pages", tok, { html: "x" })).body.page.name, /^pg-[0-9a-f]{20}$/);
    assert.equal((await t.json("POST", "/v1/pages", tok, { name: "q3-report", html: "x" })).status, 409);
    assert.equal((await t.json("POST", "/v1/pages", tok, { name: "my-shop", html: "x" })).status, 409);
    assert.equal((await t.json("POST", "/v1/pages", tok, { name: "Bad Name", html: "x" })).body.error, "invalid_name");
    assert.equal((await t.json("POST", "/v1/pages", tok, { name: 7, html: "x" })).status, 400);
    assert.equal((await t.json("GET", "/v1/names/q3-report")).body.reason, "taken");
    // The chosen name is the page's (GET /v1/pages/:name).
    assert.equal((await t.json("GET", "/v1/pages/q3-report", tok)).body.page.name, "q3-report");
  } finally {
    t.srv.close();
    await rm(t.dataDir, { recursive: true, force: true });
  }
});
