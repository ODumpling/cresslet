import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/main.ts";
import { loadConfig, paths } from "../server/config.ts";
import { Store } from "../server/store.ts";
import { createEgressProxy, egressAllows, isPublicIp, normalizeEgress, publicLookup } from "../server/egress.ts";
import { createServer as createHttp, request as httpRequest } from "node:http";
import type { LookupFunction } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const SERVER = `
import { connect } from "cloudflare:sockets";
export default {
  async fetch(req, env) {
    const get = (url) => fetch(url, { signal: AbortSignal.timeout(8000) }).then(
      async (r) => r.status + (r.status === 403 ? " " + (await r.text()) : ""), (e) => "ERR " + e.message);
    let sock;
    try { const s = connect("example.com:80"); await s.opened; sock = "open"; s.close(); } catch (e) { sock = "ERR"; }
    return Response.json({
      allowed: await get("https://example.com/"),
      body: await fetch("https://example.com/", { headers: { "accept-encoding": "gzip" } })
        .then((r) => r.text()).then((t) => t.includes("Example Domain"), () => false),
      other: await get("https://example.org/"),
      local: await get("http://127.0.0.1:9/"),
      sock, secrets: env.secrets,
    });
  },
};`;

async function tmp() {
  return await mkdtemp(join(tmpdir(), "cresslet-iso-"));
}

test("egress allowlist parsing and matching", () => {
  assert.deepEqual(normalizeEgress(["API.Stripe.com", "*.openai.com", "api.stripe.com."]), ["api.stripe.com", "*.openai.com"]);
  for (const bad of [["1.2.3.4"], ["localhost"], ["*"], ["a..b"], ["http://x.com"], [3], "x.com"]) {
    assert.throws(() => normalizeEgress(bad), Error, JSON.stringify(bad));
  }
  assert.ok(egressAllows(["*.openai.com"], "api.openai.com"));
  assert.ok(!egressAllows(["*.openai.com"], "openai.com"));
  assert.ok(!egressAllows(["*.openai.com"], "evilopenai.com"));
  assert.ok(egressAllows(["example.com"], "EXAMPLE.com."));
  assert.ok(!egressAllows(["example.com"], "www.example.com"));
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
    assert.ok(!isPublicIp(ip), ip);
  }
  for (const ip of ["2002:a00:1::1", "2001::1", "3fff::1", "64:ff9b:1::a00:1", "100::1", "192.88.99.1"]) assert.ok(!isPublicIp(ip), ip);
  for (const ip of ["93.184.215.14", "1.1.1.1", "2606:4700::1111"]) assert.ok(isPublicIp(ip), ip);
});

test("publicLookup drops non-public addresses (DNS-level SSRF guard)", async () => {
  const fake = (addrs: string[]) => ((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
    cb(null, addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })))) as never;
  const run = (addrs: string[]) =>
    new Promise<string>((res) => publicLookup(fake(addrs))("h.test", {}, (e, a) => res(e ? "ERR " + e.message : String(a))));
  assert.match(await run(["127.0.0.1", "10.0.0.1"]), /^ERR .*non-public/);
  assert.equal(await run(["127.0.0.1", "1.1.1.1"]), "1.1.1.1");
});

test("egress proxy: survives upstream resets and client aborts mid-body; strips hop-by-hop headers", async () => {
  let seen: Record<string, unknown> = {};
  const upstream = createHttp((req, res) => {
    seen = req.headers;
    if (req.url === "/reset") {
      res.writeHead(200);
      res.write("part");
      setTimeout(() => req.socket.destroy(), 20);
    } else if (req.url === "/slow") {
      res.writeHead(200);
      const t = setInterval(() => res.write("x".repeat(1024)), 5);
      res.once("close", () => clearInterval(t));
    } else res.end("ok");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const port = (upstream.address() as { port: number }).port;
  const toLocal: LookupFunction = (_h, o, cb) =>
    (o as { all?: boolean }).all ? (cb as never as (e: null, a: unknown[]) => void)(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4);
  const logs: string[] = [];
  const proxy = createEgressProxy(["up.test"], (l) => logs.push(l), toLocal);
  const sock = join(await tmp(), "e.sock");
  await new Promise<void>((r) => proxy.listen(sock, r));
  const via = (path: string, opts: { method?: string; headers?: Record<string, string>; abortAfterFirst?: boolean } = {}) =>
    new Promise<string>((resolve) => {
      const req = httpRequest({ socketPath: sock, path: `http://up.test:${port}${path}`, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
          if (opts.abortAfterFirst) req.destroy();
        });
        res.on("end", () => resolve(`${res.statusCode} ${body}`));
        res.on("error", () => resolve("aborted"));
        res.on("close", () => resolve("closed"));
      });
      req.on("error", () => resolve("error"));
      req.end();
    });
  try {
    assert.ok(["aborted", "closed", "error"].includes(await via("/reset"))); // reset reaches the client as an abort
    await via("/slow", { abortAfterFirst: true });
    await new Promise((r) => setTimeout(r, 50));
    // Still alive after both.
    assert.equal(await via("/ok", { method: "DELETE", headers: { connection: "x-hop", "x-hop": "1", "x-keep": "1" } }), "200 ok");
    assert.equal(seen["transfer-encoding"], undefined); // bodyless DELETE stays bodyless
    assert.equal(seen["x-hop"], undefined);
    assert.equal(seen["x-keep"], "1");
  } finally {
    proxy.close();
    proxy.closeAllConnections();
    upstream.close();
    upstream.closeAllConnections();
  }
});

test("secrets: encrypted at rest, plaintext rows migrated, env key takes over from file key", async () => {
  const dir = await tmp();
  try {
    let store = new Store(dir);
    const { app } = await store.createApp("a", null, null);
    store.setSecret(app.id, "TOKEN", "hunter2");
    // Simulate a database from before encryption: plaintext TEXT rows (one written by an older
    // version after a rollback that happens to look sealed), and a secret deleted back then.
    store.db.exec("PRAGMA user_version = 0");
    const legacy = store.db.prepare("INSERT INTO secrets (app_id, key, value) VALUES (?, ?, ?)");
    legacy.run(app.id, "OLD", "plain");
    legacy.run(app.id, "LOOKS_SEALED", "v1:not:sealed");
    legacy.run(app.id, "GONE", "deleted-long-ago");
    store.deleteSecret(app.id, "GONE");
    store.db.close();

    store = new Store(dir);
    const all = { LOOKS_SEALED: "v1:not:sealed", OLD: "plain", TOKEN: "hunter2" };
    assert.deepEqual(store.secrets(app.id), all);
    // While the server runs, old plaintext is gone from the files too (free pages, WAL).
    for (const f of ["cresslet.db", "cresslet.db-wal"]) {
      const bytes = await readFile(join(dir, f)).catch(() => Buffer.alloc(0));
      for (const p of ["plain", "deleted-long-ago", "not:sealed"]) assert.ok(!bytes.includes(p), `${f} still contains ${p}`);
    }
    store.db.close();
    const raw = () =>
      new DatabaseSync(join(dir, "cresslet.db")).prepare("SELECT key, value, typeof(value) t FROM secrets ORDER BY key").all() as {
        value: Uint8Array;
        t: string;
      }[];
    for (const r of raw()) {
      assert.equal(r.t, "blob");
      assert.match(Buffer.from(r.value).toString(), /^v1:/);
    }

    // Operator sets CRESSLET_SECRETS_KEY later: rows are re-sealed, the file key is no longer needed.
    const before = raw().map((r) => Buffer.from(r.value).toString());
    process.env.CRESSLET_SECRETS_KEY = "operator-key";
    try {
      new Store(dir).db.close();
      assert.notDeepEqual(raw().map((r) => Buffer.from(r.value).toString()), before);
      await rm(join(dir, "secrets.key"));
      store = new Store(dir);
      assert.deepEqual(store.secrets(app.id), all);
      assert.ok(!existsSync(join(dir, "secrets.key")));
      store.db.close();
    } finally {
      delete process.env.CRESSLET_SECRETS_KEY;
    }
    // Wrong key fails loudly instead of returning garbage.
    process.env.CRESSLET_SECRETS_KEY = "wrong";
    try {
      assert.throws(() => new Store(dir), /cannot decrypt/);
    } finally {
      delete process.env.CRESSLET_SECRETS_KEY;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("claimed app: egress allowlist enforced at the network level; secrets never on disk", async () => {
  const dataDir = await tmp();
  // Left behind by older versions: swept at startup.
  await mkdir(join(dataDir, "apps", "app_old", "run"), { recursive: true });
  await writeFile(join(dataDir, "apps", "app_old", "run", "secrets.json"), '{"OLD":"plaintext"}');
  const srv = createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80, adminToken: "adm" }));
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
  try {
    assert.ok(!existsSync(join(dataDir, "apps", "app_old", "run", "secrets.json")));
    const acct = await json("/v1/accounts", { method: "POST", headers: { authorization: "Bearer adm" }, body: '{"email":"a@b.co"}' });
    const auth = { authorization: `Bearer ${acct.body.token}` };
    const d = await json("/v1/deploys", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ files: [{ path: "index.html", data: "x" }], server: SERVER }),
    });
    const { app } = d.body;
    const host = `${app.name}.test.local`;
    await json(`/v1/apps/${app.name}/secrets`, { method: "PUT", headers: auth, body: '{"API_KEY":"s3cret"}' });

    // Default: any public host.
    const open = (await json("/api/x", { host })).body;
    assert.equal(open.allowed, "200");
    assert.equal(open.other, "200");
    assert.notEqual(open.local, "200");
    assert.equal(open.sock, "open");
    assert.deepEqual(open.secrets, { API_KEY: "s3cret" });
    assert.ok(!existsSync(join(paths(srv.cfg, app.id).run, "secrets.json")));

    // Validation + auth.
    assert.equal((await json(`/v1/apps/${app.name}/egress`, { method: "PUT", headers: auth, body: '{"allow":["10.0.0.1"]}' })).status, 400);
    assert.equal((await json(`/v1/apps/${app.name}/egress`, { method: "PUT", body: '{"allow":[]}' })).status, 403);

    const set = await json(`/v1/apps/${app.name}/egress`, { method: "PUT", headers: auth, body: '{"allow":["example.com"]}' });
    assert.deepEqual(set.body.allow, ["example.com"]);
    assert.deepEqual((await json(`/v1/apps/${app.name}/egress`, { headers: auth })).body.allow, ["example.com"]);
    const locked = (await json("/api/x", { host })).body;
    assert.equal(locked.allowed, "200");
    assert.equal(locked.body, true); // compressed upstream bodies are decoded by the sandbox
    assert.match(locked.other, /^403 .*example\.org is not in the allowlist/);
    assert.match(locked.local, /^403 /);
    assert.equal(locked.sock, "ERR");
    assert.deepEqual(locked.secrets, { API_KEY: "s3cret" });
    const logs = srv.runtime.logs.recent(app.id, 1000).map((l) => l.msg).join("\n");
    assert.match(logs, /egress blocked: example\.org/);
    assert.match(logs, /egress blocked: raw socket/);

    // A policy change while a sandbox is cold-starting under the old one: later requests get the new policy.
    await json(`/v1/apps/${app.name}/egress`, { method: "PUT", headers: auth, body: '{"allow":null}' });
    const racing = call("/api/x", { host }).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 5));
    await json(`/v1/apps/${app.name}/egress`, { method: "PUT", headers: auth, body: '{"allow":["example.com"]}' });
    const after = (await json("/api/x", { host })).body;
    await racing;
    assert.match(after.other, /^403 /);

    // Clearing restores public access.
    await json(`/v1/apps/${app.name}/egress`, { method: "PUT", headers: auth, body: '{"allow":null}' });
    assert.equal((await json("/api/x", { host })).body.other, "200");
  } finally {
    srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("concurrent requests to an app that crashes on start share one failed start", async () => {
  const dataDir = await tmp();
  const srv = createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80 }));
  try {
    const req = (path: string, host = "test.local", init: RequestInit = {}) =>
      srv.handler(new Request(`http://${host}${path}`, { ...init, headers: { host, "content-type": "application/json" } }));
    const d = await (await req("/v1/deploys", "test.local", {
      method: "POST",
      body: JSON.stringify({ files: [{ path: "index.html", data: "x" }], server: 'throw new Error("boom-at-start"); export default {}' }),
    })).json();
    const host = `${d.app.name}.test.local`;
    const starts = () => srv.runtime.logs.recent(d.app.id, 1000).filter((l) => l.msg.startsWith("sandbox exited (")).length;
    await (await req("/api/x", host)).text();
    const one = starts();
    assert.ok(one >= 1);
    await Promise.all(Array.from({ length: 5 }, () => req("/api/x", host).then((r) => r.text())));
    assert.equal(starts() - one, 1, `expected one more start, got ${starts() - one}`);
  } finally {
    srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("unclaimed apps can't set an egress allowlist", async () => {
  const dataDir = await tmp();
  const srv = createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80 }));
  try {
    const req = (path: string, init: RequestInit = {}) =>
      srv.handler(new Request(`http://test.local${path}`, { ...init, headers: { host: "test.local", "content-type": "application/json", ...init.headers } }));
    const d = await (await req("/v1/deploys", { method: "POST", body: JSON.stringify({ files: [{ path: "index.html", data: "x" }] }) })).json();
    const r = await req(`/v1/apps/${d.app.name}/egress`, {
      method: "PUT",
      headers: { "x-cresslet-deploy-key": d.deployKey },
      body: '{"allow":["example.com"]}',
    });
    assert.equal(r.status, 403);
  } finally {
    srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("app SQL can't reach other databases (ATTACH / VACUUM INTO)", async () => {
  const dataDir = await tmp();
  const srv = createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80 }));
  const SQL = `export default { async fetch(req, env) {
    const sql = new URL(req.url).searchParams.get("sql");
    try { return Response.json(await env.db.query(sql)); } catch (e) { return new Response(e.message, { status: 400 }); }
  } };`;
  try {
    const req = (path: string, host = "test.local", init: RequestInit = {}) =>
      srv.handler(new Request(`http://${host}${path}`, { ...init, headers: { host, "content-type": "application/json", ...init.headers } }));
    const d = await (await req("/v1/deploys", "test.local", {
      method: "POST",
      body: JSON.stringify({ files: [{ path: "index.html", data: "x" }], server: SQL }),
    })).json();
    const host = `${d.app.name}.test.local`;
    const run = (sql: string) => req(`/api/q?sql=${encodeURIComponent(sql)}`, host);
    const meta = join(dataDir, "cresslet.db");
    for (const sql of [
      `ATTACH '${meta}' AS m`,
      `ATTACH 'file:${meta}?mode=ro' AS m`,
      `VACUUM INTO '${join(dataDir, "copy.db")}'`,
      `PRAGMA temp_store_directory = '${dataDir}'`,
      "SELECT fts3_tokenizer('simple')",
    ]) {
      const r = await run(sql);
      assert.equal(r.status, 400, sql);
      assert.match(await r.text(), /not authorized|denied/);
    }
    assert.ok(!existsSync(join(dataDir, "copy.db")));
    assert.equal((await run("SELECT 1 AS one")).status, 200); // ordinary SQL still works
    assert.equal((await run("VACUUM")).status, 200);
    // Same for the owner's read-only inspection endpoint.
    const q = await req(`/v1/apps/${d.app.name}/db/query`, "test.local", {
      method: "POST",
      headers: { "x-cresslet-deploy-key": d.deployKey },
      body: JSON.stringify({ sql: `ATTACH '${meta}' AS m` }),
    });
    assert.equal(q.status, 400);
  } finally {
    srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
