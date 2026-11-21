import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createServer } from "../server/main.ts";
import { loadConfig, paths } from "../server/config.ts";
import type { Cluster } from "../server/cluster.ts";

const SERVER = `
export default {
  async fetch(req) { return new Response("server " + new URL(req.url).pathname); },
  async scheduled() {},
};`;

/** A cluster where the apps in `remote` are owned by another node; forwards are recorded and answered with 203. */
function fakeCluster() {
  const remote = new Set<string>();
  const forwards: { appId: string; method: string; url: string; body: string }[] = [];
  const upgrades: string[] = [];
  let failUpgrade = false;
  const cluster: Cluster = {
    local: (id) => !remote.has(id),
    async forward(appId, req) {
      forwards.push({ appId, method: req.method, url: req.url, body: await req.text() });
      return new Response("from owner", { status: 203 });
    },
    async forwardUpgrade(appId, req, socket) {
      upgrades.push(`${appId} ${req.url}`);
      if (failUpgrade) throw new Error("owner unreachable");
      socket.end("HTTP/1.1 418 I'm a teapot\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    },
  };
  return { cluster, remote, forwards, upgrades, failUpgrade: (v: boolean) => (failUpgrade = v) };
}

/** Status of an upgrade request with a custom Host, or "error" if the socket is destroyed. */
const upgradeStatus = (port: number, host: string) =>
  new Promise<number | "error">((resolve) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: "/api/ws",
      headers: { host, upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" },
    });
    req.on("response", (res) => (res.resume(), resolve(res.statusCode!)));
    req.on("upgrade", (res, s) => (s.destroy(), resolve(res.statusCode!)));
    req.on("error", () => resolve("error"));
    req.end();
  });

test("apps another node owns: their requests are forwarded; their crons and reaping are skipped", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-cluster-"));
  const fake = fakeCluster();
  const srv = createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80, adminToken: "adm" }), fake.cluster);
  srv.scheduler.stop(); // the test drives ticks itself
  const http = serve({ fetch: srv.handler, port: 0 });
  http.on("upgrade", srv.upgrade);
  await new Promise((r) => http.once("listening", r));
  const port = (http.address() as { port: number }).port;
  const call = (path: string, init: RequestInit & { host?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", init.host ?? "test.local");
    if (init.body) headers.set("content-type", "application/json");
    return srv.handler(new Request(`http://${init.host ?? "test.local"}${path}`, { ...init, headers }));
  };
  const text = async (path: string, init: RequestInit & { host?: string } = {}) => {
    const r = await call(path, init);
    return `${r.status} ${await r.text()}`;
  };
  try {
    const auth = { authorization: `Bearer ${(await (await call("/v1/accounts", { method: "POST", headers: { authorization: "Bearer adm" }, body: '{"email":"a@b.co"}' })).json()).token}` };
    const deployBody = JSON.stringify({ app: "shop", files: [{ path: "index.html", data: "<h1>shop</h1>" }], server: SERVER, config: { crons: ["* * * * *", "*/5 * * * *"] } });
    const deployed = await call("/v1/deploys", { method: "POST", headers: auth, body: deployBody });
    assert.equal(deployed.status, 201);
    const app = (await deployed.json()).app;
    srv.store.db.prepare("INSERT INTO domains (domain, app_id, token, verified_at, created_at) VALUES ('shop.example.com', ?, 't', 1, 1)").run(app.id);
    const host = "shop.test.local";
    const cronRuns = () => srv.runtime.logs.recent(app.id, 1000).filter((l) => l.msg.startsWith("cron ")).length;

    // Owned here: served as on a single node.
    assert.equal(await text("/", { host }), "200 <h1>shop</h1>");
    assert.equal(await text("/api/x", { host }), "200 server /api/x");
    await srv.scheduler.tick(new Date("2026-11-19T10:05:00Z"));
    assert.equal(cronRuns(), 2);
    assert.equal(fake.forwards.length, 0);

    fake.remote.add(app.id);
    // App hosts: static files and server routes, on its subdomain and its custom domain.
    assert.equal(await text("/", { host }), "203 from owner");
    assert.equal(await text("/api/x", { host }), "203 from owner");
    assert.equal(await text("/", { host: "shop.example.com" }), "203 from owner");
    assert.equal(await upgradeStatus(port, host), 418);
    fake.failUpgrade(true);
    assert.equal(await upgradeStatus(port, host), "error"); // a failed forward destroys the socket
    assert.deepEqual(fake.upgrades, [`${app.id} /api/ws`, `${app.id} /api/ws`]);
    // App-scoped API calls, before auth: the owner authorizes.
    assert.equal(await text("/v1/apps/shop"), "203 from owner");
    assert.equal(await text("/v1/apps/shop/logs?n=5"), "203 from owner");
    assert.equal(await text("/v1/apps/shop/rollback", { method: "POST", body: '{"deployId":"d1"}' }), "203 from owner");
    assert.equal(await text("/v1/deploys", { method: "POST", headers: auth, body: deployBody }), "203 from owner");
    assert.equal(await text("/v1/admin/sites/shop", { method: "DELETE" }), "203 from owner");
    assert.deepEqual(fake.forwards.map((f) => `${f.method} ${f.url}`), [
      "GET http://shop.test.local/",
      "GET http://shop.test.local/api/x",
      "GET http://shop.example.com/",
      "GET http://test.local/v1/apps/shop",
      "GET http://test.local/v1/apps/shop/logs?n=5",
      "POST http://test.local/v1/apps/shop/rollback",
      "POST http://test.local/v1/deploys",
      "DELETE http://test.local/v1/admin/sites/shop",
    ]);
    assert.ok(fake.forwards.every((f) => f.appId === app.id));
    assert.equal(fake.forwards[5].body, '{"deployId":"d1"}');
    assert.equal(fake.forwards[6].body, deployBody); // read here to find the app, forwarded intact
    // Not app-scoped, or a CORS preflight: answered here.
    assert.equal((await call("/v1/apps/shop", { method: "OPTIONS", headers: { origin: "http://x", "access-control-request-method": "GET" } })).status, 204);
    assert.equal((await call("/v1/apps", { headers: auth })).status, 200);
    assert.equal(fake.forwards.length, 8);
    assert.equal(srv.store.deploys(app.id).length, 1); // the forwarded deploy didn't land here

    // Crons: not queued for it, and a run queued while it was owned here doesn't start after it moved.
    await srv.scheduler.tick(new Date("2026-11-19T10:10:00Z"));
    fake.remote.delete(app.id);
    const queued = srv.scheduler.tick(new Date("2026-11-19T10:15:00Z"));
    fake.remote.add(app.id);
    await queued;
    assert.equal(cronRuns(), 2);

    // Deleted sites are forwarded too (admin restore and purge on the owner, which holds the files).
    fake.remote.delete(app.id);
    assert.equal((await call("/v1/admin/sites/shop", { method: "DELETE", headers: { authorization: "Bearer adm" } })).status, 200);
    fake.remote.add(app.id);
    assert.equal(await text("/v1/admin/sites/shop/restore", { method: "POST" }), "203 from owner");
    assert.equal(await text("/v1/admin/sites/shop?purge=1", { method: "DELETE" }), "203 from owner");
    assert.ok(srv.store.appById(app.id, true) && existsSync(paths(srv.cfg, app.id).app));

    // Reaping (expired or long-deleted): only by the owner.
    srv.store.db.prepare("UPDATE apps SET deleted_at = 1 WHERE id = ?").run(app.id);
    await srv.reap();
    assert.ok(srv.store.appById(app.id, true) && existsSync(paths(srv.cfg, app.id).app));
    fake.remote.delete(app.id);
    await srv.reap();
    assert.ok(!srv.store.appById(app.id, true) && !existsSync(paths(srv.cfg, app.id).app));
  } finally {
    http.close();
    srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
