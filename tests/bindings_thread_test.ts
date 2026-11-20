import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesSettled, serveBindings } from "../server/bindings.ts";
import { createServer } from "../server/main.ts";
import { loadConfig } from "../server/config.ts";

/** One request to a bindings socket. */
const call = (sock: string, path: string, method = "GET", body?: string) =>
  new Promise<{ status: number; text: string }>((res, rej) => {
    const r = request({ socketPath: sock, path, method, headers: { host: "host" } }, (resp) => {
      let text = "";
      resp.setEncoding("utf8").on("data", (c) => (text += c)).on("end", () => res({ status: resp.statusCode!, text }));
    });
    r.on("error", rej);
    r.end(body);
  });

test("bindings thread: serves db and files, exits on close, the app's next thread sees the data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cresslet-bthread-"));
  const run = await mkdtemp("/tmp/cbt-"); // short: unix socket paths are capped at ~104 bytes
  try {
    const a = await serveBindings(dir, join(run, "a.sock"), { secrets: { K: "v" }, maxFilesBytes: 1000 });
    assert.deepEqual(JSON.parse((await call(join(run, "a.sock"), "/secrets")).text), { K: "v" });
    assert.equal((await call(join(run, "a.sock"), "/db/exec", "POST", JSON.stringify({ sql: "CREATE TABLE t (x)" }))).status, 200);
    assert.equal((await call(join(run, "a.sock"), "/db/run", "POST", JSON.stringify({ sql: "INSERT INTO t VALUES (?)", params: [7] }))).status, 200);
    assert.equal((await call(join(run, "a.sock"), "/files?key=f", "PUT", "hello")).status, 204);
    assert.equal((await call(join(run, "a.sock"), "/files?key=g", "PUT", "x".repeat(996))).status, 413, "quota still applies");

    a.close();
    let settled = false;
    const done = filesSettled(join(dir, "files")).then(() => (settled = true));
    const b = await serveBindings(dir, join(run, "b.sock"), { maxFilesBytes: 1000 });
    assert.ok(settled, "the next thread started only after the closed one exited");
    await done;
    await assert.rejects(call(join(run, "a.sock"), "/secrets"), "closed thread no longer listens");
    assert.deepEqual(JSON.parse((await call(join(run, "b.sock"), "/db/query", "POST", JSON.stringify({ sql: "SELECT x FROM t" }))).text), [{ x: 7 }]);
    assert.equal((await call(join(run, "b.sock"), "/files?key=f")).text, "hello");
    b.close();
    await filesSettled(join(dir, "files"));
  } finally {
    await rm(run, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("bindings thread: a failed start rejects (socket path taken)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cresslet-bthread-"));
  const run = await mkdtemp("/tmp/cbt-");
  try {
    const a = await serveBindings(dir, join(run, "h.sock"), {});
    try {
      await assert.rejects(serveBindings(dir, join(run, "h.sock"), {}), /EADDRINUSE/);
      await filesSettled(join(dir, "files")); // the failed thread exited too
    } finally {
      a.close();
    }
    await filesSettled(join(dir, "files"));
  } finally {
    await rm(run, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

// Issue #27: app SQL used to run on the control plane's main thread, so one slow query stalled every request.
test("a slow app query doesn't stall the control plane", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-test-"));
  const srv = createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80 }));
  const call = (path: string, init: RequestInit & { host?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", init.host ?? "test.local");
    if (init.body) headers.set("content-type", "application/json");
    return srv.handler(new Request(`http://${init.host ?? "test.local"}${path}`, { ...init, headers }));
  };
  try {
    const server = `export default { async fetch(req, env) {
      if (new URL(req.url).pathname === "/api/warm") return Response.json(await env.db.first("SELECT 1 x"));
      return Response.json(await env.db.first(
        "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10000000) SELECT count(*) n FROM c"));
    } };`;
    const d = await call("/v1/deploys", { method: "POST", body: JSON.stringify({ files: [{ path: "index.html", data: "hi" }], server }) });
    assert.equal(d.status, 201);
    const host = `${(await d.json()).app.name}.test.local`;
    assert.deepEqual(await (await call("/api/warm", { host })).json(), { x: 1 }); // sandbox and bindings up

    const started = performance.now();
    let slowMs = 0;
    const slow = call("/api/slow", { host }).then(async (r) => {
      slowMs = performance.now() - started;
      return r.json();
    });
    // Timers and control-plane requests keep running while the query does (~1 s of SQLite).
    let worst = 0, healthz = 0;
    while (!slowMs && performance.now() - started < 20_000) {
      const t = performance.now();
      await new Promise((r) => setTimeout(r, 10));
      const h = await call("/healthz");
      assert.equal(await h.text(), "ok");
      worst = Math.max(worst, performance.now() - t);
      healthz++;
    }
    assert.deepEqual(await slow, { n: 10_000_000 });
    assert.ok(slowMs > 300, `query was slow enough to show a stall (${Math.round(slowMs)} ms)`);
    assert.ok(worst < 200, `worst timer + /healthz round trip while it ran: ${Math.round(worst)} ms of ${Math.round(slowMs)} ms`);
    assert.ok(healthz > 5, `${healthz} /healthz answered during the query`);
  } finally {
    srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
