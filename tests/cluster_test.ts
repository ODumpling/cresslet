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
  const forwards: { appId: string; method: string; url: string; body: Uint8Array; length: string | null; signal: AbortSignal }[] = [];
  const upgrades: string[] = [];
  let failUpgrade = false;
  /** Apps that move to the other side of `remote` right after the next ownership check. */
  const moveAfterCheck = new Set<string>();
  const cluster: Cluster = {
    local: (id) => {
      const here = !remote.has(id);
      if (moveAfterCheck.delete(id)) here ? remote.add(id) : remote.delete(id);
      return here;
    },
    async forward(appId, req) {
      forwards.push({ appId, method: req.method, url: req.url, body: new Uint8Array(await req.arrayBuffer()), length: req.headers.get("content-length"), signal: req.signal });
      return new Response("from owner", { status: 203 });
    },
    async forwardUpgrade(appId, req, socket) {
      upgrades.push(`${appId} ${req.url}`);
      if (failUpgrade) throw new Error("owner unreachable");
      socket.end("HTTP/1.1 418 I'm a teapot\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    },
  };
  return { cluster, remote, forwards, upgrades, moveAfterCheck, failUpgrade: (v: boolean) => (failUpgrade = v) };
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
  const srv = await createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80, adminToken: "adm" }), fake.cluster);
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
    await srv.store.db.run("INSERT INTO domains (domain, app_id, token, verified_at, created_at) VALUES ('shop.example.com', ?, 't', 1, 1)", app.id);
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
    // A deploy, as sent (byte for byte, BOM included), before auth: a token this node rejects still goes to the owner.
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(deployBody)]);
    const deployHeaders = { authorization: "Bearer clv_acct_unknown", "content-length": String(bom.length) };
    const client = new AbortController();
    assert.equal(await text("/v1/deploys", { method: "POST", headers: deployHeaders, body: bom, signal: client.signal }), "203 from owner");
    assert.equal(await text("/v1/admin/sites/shop", { method: "DELETE" }), "203 from owner");
    // Create-only (the studio's address picker): the name is taken, answered here (not forwarded).
    const create = await call("/v1/deploys", { method: "POST", headers: auth, body: JSON.stringify({ app: "shop", create: true, files: [{ path: "index.html", data: "x" }] }) });
    assert.equal(create.status, 409);
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
    assert.equal(new TextDecoder().decode(fake.forwards[5].body), '{"deployId":"d1"}');
    assert.deepEqual(fake.forwards[6].body, bom); // read here to find the app, forwarded intact
    assert.equal(fake.forwards[6].length, String(bom.length));
    client.abort(); // the client going away reaches the owner
    assert.ok(fake.forwards[6].signal.aborted);
    // An app another node creates while this one checks the token: still forwarded, not deployed here.
    const useToken = srv.store.useToken.bind(srv.store);
    let late = "";
    srv.store.useToken = async (t) => {
      if (!late) fake.remote.add(late = (await srv.store.createApp("late", null, null)).app.id);
      return useToken(t);
    };
    const lateBody = JSON.stringify({ app: "late", files: [{ path: "index.html", data: "x" }] });
    assert.equal(await text("/v1/deploys", { method: "POST", headers: auth, body: lateBody }), "203 from owner");
    srv.store.useToken = useToken;
    assert.equal(fake.forwards.at(-1)!.appId, late);
    assert.equal(new TextDecoder().decode(fake.forwards.at(-1)!.body), lateBody);
    assert.equal((await srv.store.deploys(late)).length, 0);
    fake.forwards.pop();
    // Not app-scoped, or a CORS preflight: answered here.
    assert.equal((await call("/v1/apps/shop", { method: "OPTIONS", headers: { origin: "http://x", "access-control-request-method": "GET" } })).status, 204);
    assert.equal((await call("/v1/apps", { headers: auth })).status, 200);
    assert.equal(fake.forwards.length, 8);
    assert.equal((await srv.store.deploys(app.id)).length, 1); // the forwarded deploy didn't land here

    // Crons: not queued for it (even if it moves here before the run would start), and a run queued
    // while it was owned here doesn't start after it moved.
    fake.moveAfterCheck.add(app.id);
    await srv.scheduler.tick(new Date("2026-11-19T10:10:00Z"));
    assert.ok(!fake.remote.has(app.id));
    assert.equal(cronRuns(), 2);
    fake.moveAfterCheck.add(app.id);
    await srv.scheduler.tick(new Date("2026-11-19T10:15:00Z"));
    assert.ok(fake.remote.has(app.id));
    assert.equal(cronRuns(), 2);

    // Deleted sites are forwarded too (admin restore and purge on the owner, which holds the files).
    fake.remote.delete(app.id);
    assert.equal((await call("/v1/admin/sites/shop", { method: "DELETE", headers: { authorization: "Bearer adm" } })).status, 200);
    fake.remote.add(app.id);
    assert.equal(await text("/v1/admin/sites/shop/restore", { method: "POST" }), "203 from owner");
    assert.equal(await text("/v1/admin/sites/shop?purge=1", { method: "DELETE" }), "203 from owner");
    assert.ok(await srv.store.appById(app.id, true) && existsSync(paths(srv.cfg, app.id).app));

    // Reaping (expired or long-deleted): only by the owner.
    await srv.store.db.run("UPDATE apps SET deleted_at = 1 WHERE id = ?", app.id);
    await srv.reap();
    assert.ok(await srv.store.appById(app.id, true) && existsSync(paths(srv.cfg, app.id).app));
    fake.remote.delete(app.id);
    await srv.reap();
    assert.ok(!await srv.store.appById(app.id, true) && !existsSync(paths(srv.cfg, app.id).app));
  } finally {
    http.close();
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a single node rejects a bad token on a deploy without reading its body", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-cluster-"));
  const srv = await createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80 }));
  try {
    const pending = new ReadableStream({ start() {} }); // never ends
    const res = srv.handler(new Request("http://test.local/v1/deploys", {
      method: "POST",
      headers: { host: "test.local", "content-type": "application/json", authorization: "Bearer clv_acct_unknown" },
      body: pending,
      duplex: "half",
    } as RequestInit));
    const timeout = new Promise<string>((r) => setTimeout(() => r("still reading the body"), 2000).unref());
    assert.equal(await Promise.race([res.then((r) => r.status), timeout]), 401);
  } finally {
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("cluster forwarding caps oversized payloads (Content-Length and chunked) before forwarding", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-cluster-cap-"));
  const fake = fakeCluster();
  const base = loadConfig();
  const jsonCap = 128;
  const deployCap = 512;
  const srv = await createServer(loadConfig({
    dataDir, domain: "test.local", publicPort: 80, adminToken: "adm",
    limits: { ...base.limits, jsonBodyBytes: jsonCap, deployBodyBytes: deployCap },
  }), fake.cluster);
  try {
    // 1. Oversized Content-Length on /v1/deploys: rejected with 413 without reading stream or forwarding.
    let pulledCl = 0;
    let cancelledCl = false;
    const clStream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulledCl++;
        ctrl.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelledCl = true;
      },
    }, { highWaterMark: 0 });
    const clRes = await srv.handler(new Request("http://test.local/v1/deploys", {
      method: "POST",
      headers: { host: "test.local", "content-type": "application/json", "content-length": String(deployCap + 1) },
      body: clStream,
      duplex: "half",
    } as RequestInit));
    assert.equal(clRes.status, 413);
    assert.equal((await clRes.json()).error, "body_too_large");
    assert.equal(pulledCl, 0, "must reject on Content-Length without pulling body");
    assert.equal(cancelledCl, true);
    assert.equal(fake.forwards.length, 0);

    // 2. Oversized chunked stream (no Content-Length) on /v1/deploys: aborted mid-stream, cancelled, not forwarded.
    let pulled = 0;
    let cancelled = false;
    const chunked = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (pulled >= 20) return ctrl.close();
        pulled++;
        ctrl.enqueue(new Uint8Array(200).fill(0x78));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const chRes = await srv.handler(new Request("http://test.local/v1/deploys", {
      method: "POST",
      headers: { host: "test.local", "content-type": "application/json" },
      body: chunked,
      duplex: "half",
    } as RequestInit));
    assert.equal(chRes.status, 413);
    assert.equal((await chRes.json()).error, "body_too_large");
    assert.equal(pulled, 3, "aborts on the exact chunk that crosses deployCap");
    assert.equal(cancelled, true);
    assert.equal(fake.forwards.length, 0);

    // 3. Invalid JSON within cap still answers 400 cleanly.
    const badRes = await srv.handler(new Request("http://test.local/v1/deploys", {
      method: "POST",
      headers: { host: "test.local", "content-type": "application/json" },
      body: "{not-json",
    }));
    assert.equal(badRes.status, 400);
    assert.equal((await badRes.json()).error, "bad_request");

    // 4. Remote app/page routes (toOwner) enforce tier caps before forwarding can buffer.
    const { app: remoteApp } = await srv.store.createApp("remote-app", null, null);
    const remotePage = await srv.store.createPage("pg-remote", (await srv.store.createAccount("p@b.co")).id, { title: null, visibility: "private", retentionDays: 30 });
    fake.remote.add(remoteApp.id);
    fake.remote.add(remotePage.id);

    // Remote metadata route rejects > jsonCap (chunked).
    let rbPulled = 0;
    let rbCancelled = false;
    const rbStream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (rbPulled >= 10) return ctrl.close();
        rbPulled++;
        ctrl.enqueue(new Uint8Array(100).fill(0x61));
      },
      cancel() {
        rbCancelled = true;
      },
    }, { highWaterMark: 0 });
    const rbRes = await srv.handler(new Request("http://test.local/v1/apps/remote-app/rollback", {
      method: "POST",
      headers: { host: "test.local", "content-type": "application/json" },
      body: rbStream,
      duplex: "half",
    } as RequestInit));
    assert.equal(rbRes.status, 413);
    assert.equal((await rbRes.json()).error, "body_too_large");
    assert.equal(rbPulled, 2);
    assert.equal(rbCancelled, true);

    // Remote PUT /v1/pages/:name allows > jsonCap and <= deployCap, rejects > deployCap.
    const okPagePut = await srv.handler(new Request("http://test.local/v1/pages/pg-remote", {
      method: "PUT",
      headers: { host: "test.local", "content-type": "application/json" },
      body: JSON.stringify({ html: "x".repeat(jsonCap + 50) }),
    }));
    assert.equal(okPagePut.status, 203);
    const overPagePut = await srv.handler(new Request("http://test.local/v1/pages/pg-remote", {
      method: "PUT",
      headers: { host: "test.local", "content-type": "application/json" },
      body: JSON.stringify({ html: "x".repeat(deployCap) }),
    }));
    assert.equal(overPagePut.status, 413);
    assert.equal((await overPagePut.json()).error, "body_too_large");
  } finally {
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
