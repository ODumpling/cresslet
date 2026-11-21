// CRESSLET_MAX_RUNNING_SANDBOXES (LRU eviction of idle sandboxes, 503 when every slot is serving) and
// the WebSocket caps / timeouts that keep open sockets from pinning sandboxes forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { serve } from "@hono/node-server";
import { createServer } from "../server/main.ts";
import { type Config, loadConfig } from "../server/config.ts";

const SERVER = `
export default {
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/api/hang") await new Promise((r) => setTimeout(r, Number(new URL(req.url).searchParams.get("ms") ?? 800)));
    if (req.headers.get("upgrade") !== "websocket") return new Response("ok");
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", (e) => server.send("echo:" + e.data));
    return new Response(null, { status: 101, webSocket: client });
  },
};`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(limits: Partial<Config["limits"]>, apps: string[]) {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-cap-"));
  const base = loadConfig();
  const srv = createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80, limits: { ...base.limits, requestMs: 5000, ...limits } }));
  const http = serve({ fetch: srv.handler, port: 0 });
  http.on("upgrade", srv.upgrade);
  await new Promise((r) => http.once("listening", r));
  const port = (http.address() as { port: number }).port;
  const ids: Record<string, string> = {};
  for (const name of apps) {
    const r = await srv.handler(new Request("http://test.local/v1/deploys", {
      method: "POST",
      headers: { host: "test.local", "content-type": "application/json" },
      body: JSON.stringify({ app: name, files: [{ path: "index.html", data: "x" }], server: SERVER }),
    }));
    assert.equal(r.status, 201, await r.clone().text());
    ids[name] = (await r.json()).app.id;
  }
  const get = async (name: string, path = "/api/x") => {
    const host = `${name}.test.local`;
    const r = await srv.handler(new Request(`http://${host}${path}`, { headers: { host } }));
    return { status: r.status, text: await r.text(), retryAfter: r.headers.get("retry-after") };
  };
  const running = () => Object.keys(ids).filter((n) => srv.runtime.status(ids[n]).running).sort();
  const logs = (name: string) => srv.runtime.logs.recent(ids[name], 100).map((l) => l.msg).join("\n");
  /** Opens a WebSocket; resolves with the open socket (status 101) or the refusal's status. */
  const ws = (name: string) =>
    new Promise<{ status: number; socket?: Socket }>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port,
        path: "/api/ws",
        headers: { host: `${name}.test.local`, upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": randomBytes(16).toString("base64"), "sec-websocket-version": "13" },
      });
      req.on("response", (res) => {
        res.resume();
        resolve({ status: res.statusCode! });
      });
      req.on("upgrade", (res, socket: Socket) => resolve({ status: res.statusCode!, socket }));
      req.on("error", reject);
      req.end();
    });
  /** One masked text frame, and its echo. */
  const echo = (s: Socket, text: string) =>
    new Promise<string>((resolve) => {
      const payload = Buffer.from(text), mask = randomBytes(4);
      s.once("data", (d: Buffer) => resolve(d.subarray(2, 2 + (d[1] & 0x7f)).toString()));
      s.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, payload.map((b, i) => b ^ mask[i % 4])]));
    });
  const closed = (s: Socket) => new Promise<void>((r) => (s.destroyed ? r() : s.once("close", () => r())));
  const done = async () => {
    http.close();
    srv.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  return { srv, ids, get, running, logs, ws, echo, closed, done };
}

test("sandbox cap: a new app evicts the least recently used idle sandbox", async () => {
  const t = await setup({ maxRunningSandboxes: 2 }, ["a1", "b1", "c1"]);
  try {
    assert.equal((await t.get("a1")).text, "ok");
    await sleep(5);
    assert.equal((await t.get("b1")).text, "ok");
    assert.deepEqual(t.running(), ["a1", "b1"]);
    await sleep(5);
    // c1 needs a slot: a1 is the least recently used.
    assert.equal((await t.get("c1")).text, "ok");
    assert.deepEqual(t.running(), ["b1", "c1"]);
    assert.match(t.logs("a1"), /sandbox stopped while idle: 2 running \(CRESSLET_MAX_RUNNING_SANDBOXES\)/);
    // Using b1 makes c1 the oldest; a1 comes back in c1's slot.
    await sleep(5);
    assert.equal((await t.get("b1")).text, "ok");
    await sleep(5);
    assert.equal((await t.get("a1")).text, "ok");
    assert.deepEqual(t.running(), ["a1", "b1"]);
    // A warm app needs no slot: nothing is evicted.
    assert.equal((await t.get("b1")).text, "ok");
    assert.deepEqual(t.running(), ["a1", "b1"]);
  } finally {
    await t.done();
  }
});

test("sandbox cap: 503 with retry-after when every slot is serving; a busy sandbox is never evicted", async () => {
  const t = await setup({ maxRunningSandboxes: 2 }, ["a2", "b2", "c2"]);
  try {
    const slowA = t.get("a2", "/api/hang?ms=1500");
    const slowB = t.get("b2", "/api/hang?ms=1500");
    // Both sandboxes up and serving.
    for (let i = 0; i < 200 && !(t.srv.runtime.procs.get(t.ids.a2)?.inflight && t.srv.runtime.procs.get(t.ids.b2)?.inflight); i++) await sleep(10);
    const busy = await t.get("c2");
    assert.equal(busy.status, 503);
    assert.equal(busy.retryAfter, "5");
    assert.deepEqual(t.running(), ["a2", "b2"], "neither busy sandbox was stopped");
    // The running apps still serve.
    assert.equal((await t.get("a2")).text, "ok");
    assert.equal((await slowA).text, "ok");
    assert.equal((await slowB).text, "ok");
    // Once one is idle, the waiting app gets its slot.
    assert.equal((await t.get("c2")).text, "ok");
    assert.equal(t.running().length, 2);
  } finally {
    await t.done();
  }
});

test("sandbox cap: concurrent cold starts can't overshoot it", async () => {
  const t = await setup({ maxRunningSandboxes: 2 }, ["a3", "b3", "c3", "d3"]);
  try {
    const res = await Promise.all(["a3", "b3", "c3", "d3"].map((n) => t.get(n, "/api/hang?ms=300")));
    const codes = res.map((r) => r.status).sort();
    assert.deepEqual(codes, [200, 200, 503, 503]);
    assert.equal(t.running().length, 2);
  } finally {
    await t.done();
  }
});

test("sandbox cap: an open WebSocket keeps its sandbox busy (not evicted)", async () => {
  const t = await setup({ maxRunningSandboxes: 1 }, ["a4", "b4"]);
  try {
    const open = await t.ws("a4");
    assert.equal(open.status, 101);
    assert.equal((await t.get("b4")).status, 503);
    open.socket!.destroy();
    await t.closed(open.socket!);
    await sleep(50);
    assert.equal((await t.get("b4")).text, "ok");
    assert.deepEqual(t.running(), ["b4"]);
  } finally {
    await t.done();
  }
});

test("websocket caps: per app and per instance, freed when a socket closes", async () => {
  const t = await setup({ maxWebSocketsPerApp: 2, maxWebSockets: 3 }, ["a5", "b5"]);
  try {
    const a = [await t.ws("a5"), await t.ws("a5")];
    assert.deepEqual(a.map((x) => x.status), [101, 101]);
    assert.equal((await t.ws("a5")).status, 503, "per-app cap");
    const b = await t.ws("b5");
    assert.equal(b.status, 101);
    assert.equal((await t.ws("b5")).status, 503, "instance cap (b5 has only one)");
    // Refusals don't leak slots; closing one frees it.
    a[0].socket!.destroy();
    await t.closed(a[0].socket!);
    await sleep(50);
    const again = await t.ws("b5");
    assert.equal(again.status, 101);
    assert.equal(await t.echo(again.socket!, "hi"), "echo:hi");
    for (const s of [a[1], b, again]) s.socket!.destroy();
  } finally {
    await t.done();
  }
});

test("websocket idle timeout: traffic keeps it open; silence closes it and frees the sandbox", async () => {
  const t = await setup({ wsIdleMs: 400, wsMaxMs: 0, idleMs: 0 }, ["a6"]);
  try {
    const { status, socket } = await t.ws("a6");
    assert.equal(status, 101);
    // Messages every 150 ms for ~900 ms (past the 400 ms idle limit): stays open.
    for (let i = 0; i < 6; i++) {
      assert.equal(await t.echo(socket!, `m${i}`), `echo:m${i}`);
      await sleep(150);
    }
    assert.equal(socket!.destroyed, false);
    const start = Date.now();
    await t.closed(socket!);
    assert.ok(Date.now() - start < 1500);
    await sleep(20);
    assert.equal(t.srv.runtime.procs.get(t.ids.a6)?.inflight, 0);
    t.srv.runtime.reapIdle();
    assert.equal(t.srv.runtime.status(t.ids.a6).running, false, "no longer pinned");
    assert.match(t.logs("a6"), /websocket \/api\/ws closed: no traffic for 400ms/);
  } finally {
    await t.done();
  }
});

test("websocket max duration: closed even while active", async () => {
  const t = await setup({ wsIdleMs: 0, wsMaxMs: 600, idleMs: 0 }, ["a7"]);
  try {
    const { status, socket } = await t.ws("a7");
    assert.equal(status, 101);
    const opened = Date.now();
    let alive = true;
    const gone = t.closed(socket!).then(() => (alive = false));
    while (alive && Date.now() - opened < 3000) {
      await Promise.race([t.echo(socket!, "x"), gone]);
      await sleep(50);
    }
    const lived = Date.now() - opened;
    assert.ok(!alive && lived >= 550 && lived < 1500, `lived ${lived}ms`);
    await sleep(20);
    t.srv.runtime.reapIdle();
    assert.equal(t.srv.runtime.status(t.ids.a7).running, false);
    assert.match(t.logs("a7"), /closed: open for 600ms/);
  } finally {
    await t.done();
  }
});

test("limit settings: from env, 0 = off, invalid values refused", () => {
  const keys = ["CRESSLET_MAX_RUNNING_SANDBOXES", "CRESSLET_MAX_WEBSOCKETS", "CRESSLET_MAX_WEBSOCKETS_PER_APP", "CRESSLET_WS_IDLE_MS", "CRESSLET_WS_MAX_MS"];
  const prev = keys.map((k) => process.env[k]);
  try {
    const d = loadConfig().limits;
    assert.deepEqual([d.maxRunningSandboxes, d.maxWebSockets, d.maxWebSocketsPerApp, d.wsIdleMs, d.wsMaxMs], [32, 1000, 100, 600_000, 3_600_000]);
    keys.forEach((k, i) => (process.env[k] = String(i)));
    const l = loadConfig().limits;
    assert.deepEqual([l.maxRunningSandboxes, l.maxWebSockets, l.maxWebSocketsPerApp, l.wsIdleMs, l.wsMaxMs], [0, 1, 2, 3, 4]);
    for (const bad of ["-1", "1.5", "lots"]) {
      process.env.CRESSLET_MAX_RUNNING_SANDBOXES = bad;
      assert.throws(() => loadConfig(), /CRESSLET_MAX_RUNNING_SANDBOXES must be a whole number/, bad);
    }
  } finally {
    keys.forEach((k, i) => (prev[i] === undefined ? delete process.env[k] : (process.env[k] = prev[i])));
  }
});
