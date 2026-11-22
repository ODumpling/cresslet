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
import { loadConfig } from "../server/config.ts";
import { ownerAuth } from "./owner.ts";

const SERVER = `
export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (path === "/api/deny") return new Response("nope", { status: 403 });
    if (path === "/api/big") return new Response("x".repeat(8 * 1024 * 1024), { status: 403 });
    if (path === "/api/hang") await new Promise((r) => setTimeout(r, 5000));
    if (req.headers.get("upgrade") !== "websocket") return new Response("plain");
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", (e) => server.send("echo:" + e.data + ":" + new URL(req.url).pathname
      + ":" + (req.headers.get("x-cresslet-scheduled") ?? "-")));
    return new Response(null, { status: 101, webSocket: client });
  },
};`;

/** Minimal RFC 6455 client: upgrade with a custom Host, send one masked text frame, read one frame. */
function wsRoundTrip(port: number, host: string, path: string, text: string, headers: Record<string, string> = {}, keep?: (s: Socket) => void) {
  return new Promise<{ status: number; reply?: string; body?: string }>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      headers: { host, upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": randomBytes(16).toString("base64"), "sec-websocket-version": "13", ...headers },
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (c) => (body += c)).on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("upgrade", (res, socket: Socket) => {
      const payload = Buffer.from(text), mask = randomBytes(4);
      const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, payload.map((b, i) => b ^ mask[i % 4])]);
      socket.write(frame);
      socket.once("data", (d: Buffer) => {
        resolve({ status: res.statusCode!, reply: d.subarray(2, 2 + (d[1] & 0x7f)).toString() });
        if (keep) keep(socket);
        else socket.destroy();
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("websockets reach the app server through the sandbox", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-ws-"));
  const srv = await createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80, limits: { requestMs: 1000, idleMs: 0 } as never }));
  const http = serve({ fetch: srv.handler, port: 0 });
  http.on("upgrade", srv.upgrade);
  await new Promise((r) => http.once("listening", r));
  const port = (http.address() as { port: number }).port;
  try {
    const d = await (await srv.handler(new Request("http://test.local/v1/deploys", {
      method: "POST",
      headers: { host: "test.local", "content-type": "application/json", ...await ownerAuth(srv.store) },
      body: JSON.stringify({ files: [{ path: "index.html", data: "x" }], server: SERVER }),
    }))).json();
    const host = `${d.app.name}.test.local`;

    let open!: Socket;
    const ok = await wsRoundTrip(port, host, "/api/ws?x=1", "hi", { "x-cresslet-scheduled": "forged" }, (s) => (open = s));
    assert.deepEqual(ok, { status: 101, reply: "echo:hi:/api/ws:-" });
    // An open socket keeps the sandbox up through an idle reap (idleMs = 0); closing it lets it go.
    srv.runtime.reapIdle();
    assert.equal(srv.runtime.status(d.app.id).running, true);
    open.destroy();
    await new Promise((r) => setTimeout(r, 100));
    srv.runtime.reapIdle();
    assert.equal(srv.runtime.status(d.app.id).running, false);
    assert.equal(await (await srv.handler(new Request(`http://${host}/api/x`, { headers: { host } }))).text(), "plain");

    // Non-101 answers are relayed once and the connection closed; a hung handshake times out.
    assert.deepEqual(await wsRoundTrip(port, host, "/api/deny", "hi"), { status: 403, body: "nope" });
    assert.equal((await wsRoundTrip(port, host, "/api/hang", "hi")).status, 504);
    await new Promise((r) => setTimeout(r, 20));
    srv.runtime.reapIdle();
    assert.equal(srv.runtime.status(d.app.id).running, false); // nothing left in flight
    assert.equal((await wsRoundTrip(port, host, "//evil/api/ws", "hi")).status, 400);
    // A large non-101 body reaches a slow reader in full.
    const big = await new Promise<number>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, path: "/api/big", headers: { host, upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": randomBytes(16).toString("base64"), "sec-websocket-version": "13" } });
      r.on("response", (res) => {
        let n = 0;
        res.pause();
        setTimeout(() => res.on("data", (c) => (n += c.length)).on("end", () => resolve(n)).resume(), 300);
      });
      r.on("error", reject);
      r.end();
    });
    assert.equal(big, 8 * 1024 * 1024);

    assert.equal((await wsRoundTrip(port, host, "/not-a-route", "hi")).status, 404); // static route
    assert.equal((await wsRoundTrip(port, "nope.test.local", "/api/ws", "hi")).status, 404);
    // Verified custom domains route upgrades too.
    await srv.store.db.run("INSERT INTO domains (domain, app_id, token, verified_at, created_at) VALUES ('ws.example.com', ?, 't', 1, 1)", d.app.id);
    assert.equal((await wsRoundTrip(port, "WS.example.com.", "/api/ws", "hi")).reply, "echo:hi:/api/ws:-");
    assert.equal((await wsRoundTrip(port, "test.local", "/api/ws", "hi")).status, 404); // root host
    assert.equal((await wsRoundTrip(port, "preview.test.local", "/api/ws", "hi")).status, 404); // studio preview host
    const logs = srv.runtime.logs.recent(d.app.id, 100).map((l) => l.msg).join("\n");
    assert.match(logs, /WS \/api\/ws 101/);
  } finally {
    http.close();
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
