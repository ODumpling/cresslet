import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/main.ts";
import { loadConfig } from "../server/config.ts";
import { BUCKET_MS, Metrics } from "../server/metrics.ts";

const SERVER = `
export default {
  async fetch(req, env) {
    if (new URL(req.url).pathname === "/api/boom") return new Response("no", { status: 500 });
    await env.db.exec("CREATE TABLE IF NOT EXISTS c (id INTEGER PRIMARY KEY)");
    await env.db.run("INSERT INTO c DEFAULT VALUES");
    return Response.json(await env.db.first("SELECT count(*) n FROM c"));
  },
};`;

test("Metrics buckets requests over 24h and drops older ones", () => {
  const m = new Metrics();
  const t0 = Date.UTC(2026, 0, 1);
  m.record("a", 200, 10, t0);
  m.record("a", 500, 30, t0 + 1000);
  m.record("a", 404, undefined, t0 + BUCKET_MS);
  let v = m.view("a", t0 + BUCKET_MS);
  assert.equal(v.series.length, 288);
  assert.deepEqual(v.totals, { requests: 3, errors: 1, clientErrors: 1, avgMs: 20, maxMs: 30 });
  assert.deepEqual(v.series.at(-2), { t: new Date(t0).toISOString(), requests: 2, errors: 1, avgMs: 20 });
  assert.deepEqual(v.series.at(-1), { t: new Date(t0 + BUCKET_MS).toISOString(), requests: 1, errors: 0, avgMs: null });
  // a day later the first bucket is out of the window
  v = m.view("a", t0 + 86_400_000);
  assert.deepEqual(v.totals, { requests: 1, errors: 0, clientErrors: 1, avgMs: null, maxMs: null });
  m.record("a", 200, 1, t0 + 2 * 86_400_000);
  assert.equal(m.view("a", t0 + 2 * 86_400_000).totals.requests, 1);
  m.drop("a");
  assert.equal(m.view("a").totals.requests, 0);
});

test("GET /v1/apps/:name/metrics: requests, usage and tables, for anyone who can read the app", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-metrics-"));
  const srv = await createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80, adminToken: "adm" }));
  const call = (path: string, init: RequestInit & { host?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", init.host ?? "test.local");
    if (init.body) headers.set("content-type", "application/json");
    return srv.handler(new Request(`http://${init.host ?? "test.local"}${path}`, { ...init, headers }));
  };
  const json = async (path: string, init: RequestInit & { host?: string } = {}) => {
    const r = await call(path, init);
    return { status: r.status, body: await r.json() };
  };
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const account = async (email: string) =>
    (await json("/v1/accounts", { method: "POST", headers: bearer("adm"), body: JSON.stringify({ email }) })).body.token as string;
  try {
    const owner = await account("dev@example.com");
    const other = await account("other@example.com");
    assert.equal((await json("/v1/deploys", {
      method: "POST",
      headers: bearer(owner),
      body: JSON.stringify({ app: "shop", files: [{ path: "index.html", data: "<h1>hi</h1>" }], server: SERVER, config: { routes: ["/api/*"] } }),
    })).status, 201);
    const host = "shop.test.local";
    await (await call("/api/n", { host })).text();
    await (await call("/api/n", { host })).text();
    await (await call("/api/boom", { host })).text();
    await (await call("/", { host })).text();
    await (await call("/nope.png", { host })).text();

    // the app's runtime is only up or down to its users: no pid or other host details
    assert.deepEqual((await json("/v1/apps/shop", { headers: bearer(owner) })).body.runtime, { running: true });
    assert.equal((await json("/v1/apps/shop/metrics", { headers: bearer(other) })).status, 403);
    const m = await json("/v1/apps/shop/metrics", { headers: bearer(owner) });
    assert.equal(m.status, 200);
    assert.equal(m.body.totals.requests, 5);
    assert.equal(m.body.totals.errors, 1);
    assert.equal(m.body.totals.clientErrors, 1);
    assert.ok(m.body.totals.avgMs !== null && m.body.totals.maxMs >= m.body.totals.avgMs);
    assert.equal(m.body.series.length, 288);
    assert.equal(m.body.series.reduce((n: number, b: { requests: number }) => n + b.requests, 0), 5);
    assert.deepEqual(m.body.database, { tables: [{ name: "c", rows: 2 }], error: null });
    assert.ok(m.body.usage.deploys > 0 && m.body.usage.database > 0);
    assert.deepEqual(m.body.domains, []);

    // a purge forgets them
    assert.equal((await json("/v1/apps/shop", { method: "DELETE", headers: bearer(owner) })).status, 200);
    assert.equal((await json("/v1/apps/shop/metrics", { headers: bearer(owner) })).status, 404);
  } finally {
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
