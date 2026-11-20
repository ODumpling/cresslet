import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/main.ts";
import { type Config, loadConfig } from "../server/config.ts";
import { createBindings, createDb } from "../server/bindings.ts";

async function setup(limits: Partial<Config["limits"]>, extra: Partial<Config> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-lim-"));
  const base = loadConfig();
  const srv = createServer(loadConfig({
    dataDir, domain: "test.local", publicPort: 80, adminToken: "adm", siteAdmins: ["boss@b.co"],
    limits: { ...base.limits, ...limits }, ...extra,
  }));
  const json = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("host")) headers.set("host", "test.local");
    if (init.body) headers.set("content-type", "application/json");
    const r = await srv.handler(new Request(`http://${headers.get("host")}${path}`, { ...init, headers }));
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const account = async (email: string) =>
    (await json("/v1/accounts", { method: "POST", headers: bearer("adm"), body: JSON.stringify({ email }) })).body.token as string;
  const deploy = (headers: Record<string, string>, app?: string) =>
    json("/v1/deploys", { method: "POST", headers, body: JSON.stringify({ app, files: [{ path: "index.html", data: "hi" }] }) });
  const done = async () => {
    srv.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  return { json, bearer, account, deploy, done };
}

test("app quota per account: new apps and claims stop at the limit; site admins are exempt", async () => {
  const t = await setup({ maxAppsPerAccount: 2 });
  try {
    const a = t.bearer(await t.account("a@b.co"));
    assert.equal((await t.deploy(a, "one")).status, 201);
    assert.equal((await t.deploy(a, "two")).status, 201);
    const over = await t.deploy(a, "three");
    assert.equal(over.status, 403);
    assert.equal(over.body.error, "quota");
    assert.equal((await t.deploy(a, "one")).status, 201, "redeploying an existing app is fine");

    const anon = await t.deploy({}, "stray");
    assert.equal(anon.status, 201);
    const claim = await t.json("/v1/apps/stray/claim", { method: "POST", headers: a, body: JSON.stringify({ deployKey: anon.body.deployKey }) });
    assert.equal(claim.status, 403);
    assert.equal(claim.body.error, "quota");

    assert.equal((await t.json("/v1/apps/two", { method: "DELETE", headers: a })).status, 200);
    assert.equal((await t.deploy(a, "three")).status, 201, "room again after a delete");

    const boss = t.bearer(await t.account("boss@b.co"));
    for (const n of ["b1", "b2", "b3"]) assert.equal((await t.deploy(boss, n)).status, 201);
  } finally {
    await t.done();
  }
});

test("anonymous apps: per client IP per hour, and a cap on the whole instance", async () => {
  const t = await setup({ anonAppsPerHour: 2, maxAnonApps: 3 }, { clientIpHeader: "cf-connecting-ip" });
  try {
    const ip = (x: string) => ({ "cf-connecting-ip": x });
    assert.equal((await t.deploy(ip("1.1.1.1"))).status, 201);
    assert.equal((await t.deploy(ip("1.1.1.1"))).status, 201);
    const limited = await t.deploy(ip("1.1.1.1"));
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, "rate_limited");
    assert.equal((await t.deploy(ip("1.1.1.1"), "Bad Name")).status, 400, "invalid requests don't reach the limiter");
    assert.equal((await t.deploy(ip("2.2.2.2"))).status, 201, "another address has its own allowance");
    const full = await t.deploy(ip("3.3.3.3"));
    assert.equal(full.status, 429, "instance-wide cap");
    assert.match(full.body.message, /log in/);

    const a = t.bearer(await t.account("a@b.co"));
    assert.equal((await t.deploy(a, "mine")).status, 201, "accounts aren't held back by the anonymous cap");
  } finally {
    await t.done();
  }
});

test("deploys per app per hour", async () => {
  const t = await setup({ deploysPerHour: 2 });
  try {
    const a = t.bearer(await t.account("a@b.co"));
    assert.equal((await t.deploy(a, "site")).status, 201);
    assert.equal((await t.deploy(a, "site")).status, 201);
    const r = await t.deploy(a, "site");
    assert.equal(r.status, 429);
    assert.match(r.body.message, /too many deploys of site/);
    assert.equal((await t.deploy(a, "other")).status, 201, "other apps unaffected");
  } finally {
    await t.done();
  }
});

test("app database size cap, and apps can't raise it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cresslet-dbcap-"));
  try {
    const db = createDb(join(dir, "db.sqlite"), 256 * 1024);
    db.exec("CREATE TABLE t (b BLOB)");
    db.run("INSERT INTO t VALUES (randomblob(64 * 1024))");
    assert.throws(() => {
      for (let i = 0; i < 10; i++) db.run("INSERT INTO t VALUES (randomblob(64 * 1024))");
    }, /full/);
    assert.throws(() => db.exec("PRAGMA max_page_count = 1000000"), /not authorized/);
    assert.throws(() => db.exec("PRAGMA page_size = 65536"), /not authorized/);
    assert.ok(db.first("PRAGMA max_page_count"), "reading it is fine");
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("app files total size cap (replacing a file counts its new size only)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cresslet-filecap-"));
  const b = createBindings(dir, { maxFilesBytes: 100 });
  try {
    const put = (key: string, n: number) =>
      b.fetch(new Request(`http://h/files?key=${key}`, { method: "PUT", body: new Uint8Array(n) }));
    assert.equal((await put("a", 60)).status, 204);
    const over = await put("b", 60);
    assert.equal(over.status, 413);
    assert.match(await over.text(), /quota/);
    assert.equal((await put("a", 90)).status, 204, "replace within the cap");
    assert.equal((await put("b", 10)).status, 204);
    assert.equal((await b.fetch(new Request("http://h/files?key=a", { method: "DELETE" }))).status, 204);
    assert.equal((await put("c", 80)).status, 204, "room again after a delete");
  } finally {
    b.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("storage caps apply to a running app's env.db and env.files", async () => {
  const t = await setup({ appDbBytes: 256 * 1024, appFilesBytes: 64 * 1024, requestMs: 10_000 });
  try {
    const server = `export default { async fetch(req, env) {
      const url = new URL(req.url);
      const out = {};
      try {
        await env.db.exec("CREATE TABLE IF NOT EXISTS t (b BLOB)");
        for (let i = 0; i < 20; i++) await env.db.run("INSERT INTO t VALUES (randomblob(32768))");
        out.db = "no limit";
      } catch (e) { out.db = String(e.message) }
      try { await env.db.exec("PRAGMA max_page_count = 1000000"); out.raise = "raised" } catch (e) { out.raise = String(e.message) }
      try {
        await env.files.put("a", new Uint8Array(40 * 1024));
        await env.files.put("b", new Uint8Array(40 * 1024));
        out.files = "no limit";
      } catch (e) { out.files = String(e.message) }
      return Response.json(out);
    } }`;
    const a = t.bearer(await t.account("a@b.co"));
    const d = await t.json("/v1/deploys", { method: "POST", headers: a, body: JSON.stringify({ app: "filler", files: [{ path: "index.html", data: "x" }], server }) });
    assert.equal(d.status, 201);
    const r = await t.json("/api/fill", { headers: { host: "filler.test.local" } });
    assert.equal(r.status, 200);
    assert.match(r.body.db, /full/);
    assert.match(r.body.raise, /not authorized/);
    assert.match(r.body.files, /quota/);
  } finally {
    await t.done();
  }
});

test("quotas hold under concurrent requests", async () => {
  const t = await setup({ maxAppsPerAccount: 2, maxAnonApps: 2, anonAppsPerHour: 100 });
  try {
    const a = t.bearer(await t.account("a@b.co"));
    const mine = await Promise.all(["c1", "c2", "c3", "c4"].map((n) => t.deploy(a, n)));
    assert.equal(mine.filter((r) => r.status === 201).length, 2, "account quota");
    const anon = await Promise.all([1, 2, 3, 4].map(() => t.deploy({})));
    assert.equal(anon.filter((r) => r.status === 201).length, 2, "instance-wide anonymous cap");
  } finally {
    await t.done();
  }
});

test("files cap holds under concurrent puts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cresslet-filecap2-"));
  const b = createBindings(dir, { maxFilesBytes: 100 });
  try {
    const put = (key: string, n: number) =>
      b.fetch(new Request(`http://h/files?key=${key}`, { method: "PUT", body: new Uint8Array(n) }));
    const rs = await Promise.all([put("a", 60), put("b", 60), put("c", 60)]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [204, 413, 413]);
  } finally {
    b.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("apps can't turn off WAL checkpoints or change the journal mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cresslet-wal-"));
  try {
    const db = createDb(join(dir, "db.sqlite"), 1024 * 1024);
    assert.throws(() => db.exec("PRAGMA wal_autocheckpoint = 0"), /not authorized/);
    assert.throws(() => db.exec("PRAGMA journal_mode = DELETE"), /not authorized/);
    assert.throws(() => db.exec("PRAGMA journal_size_limit = -1"), /not authorized/);
    assert.equal((db.first("PRAGMA journal_mode") as { journal_mode: string }).journal_mode, "wal", "reading it is fine");
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("app SQL can't grow temporary databases past the cap (temp tables, ATTACH ''); VACUUM still works", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cresslet-temp-"));
  try {
    const db = createDb(join(dir, "db.sqlite"), 256 * 1024);
    assert.throws(() => db.exec("CREATE TEMP TABLE t (b BLOB)"), /not authorized/);
    assert.throws(() => db.exec("ATTACH '' AS scratch"), /not authorized|authorization denied/);
    assert.throws(() => db.exec("VACUUM; ATTACH '' AS scratch"), /not authorized|authorization denied/);
    db.exec("CREATE TABLE k (v)");
    db.run("INSERT INTO k VALUES (1)");
    db.exec("VACUUM");
    assert.equal((db.first("SELECT count(*) n FROM k") as { n: number }).n, 1);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("files cap counts a write cut off by a redeploy (another bindings instance sees it)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cresslet-filecap3-"));
  try {
    const put = (b: ReturnType<typeof createBindings>, key: string, n: number) =>
      b.fetch(new Request(`http://h/files?key=${key}`, { method: "PUT", body: new Uint8Array(n) }));
    const old = createBindings(dir, { maxFilesBytes: 100 });
    const inflight = put(old, "a", 60);
    await new Promise((r) => setImmediate(r)); // the check has run; the blob write is pending
    old.close();
    await inflight.catch(() => {});
    const next = createBindings(dir, { maxFilesBytes: 100 });
    assert.equal((await put(next, "b", 60)).status, 413);
    next.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("files across a redeploy: writes to one key land in order; a failed write leaves nothing behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cresslet-filecap4-"));
  try {
    const put = (b: ReturnType<typeof createBindings>, key: string, n: number) =>
      b.fetch(new Request(`http://h/files?key=${key}`, { method: "PUT", body: new Uint8Array(n) }));
    const list = async (b: ReturnType<typeof createBindings>) =>
      (await (await b.fetch(new Request("http://h/files/list"))).json()) as { key: string; size: number }[];
    const old = createBindings(dir, { maxFilesBytes: 1000 });
    const first = put(old, "a", 60);
    await new Promise((r) => setImmediate(r)); // body read, write queued (accepted)
    old.close();
    const next = createBindings(dir, { maxFilesBytes: 1000 });
    const second = put(next, "a", 20);
    assert.deepEqual([(await first).status, (await second).status], [204, 204]);
    assert.deepEqual((await list(next)).map((f) => [f.key, f.size]), [["a", 20]]);
    assert.equal((await (await next.fetch(new Request("http://h/files?key=a"))).arrayBuffer()).byteLength, 20);

    assert.equal((await put(next, "d/x", 10)).status, 204);
    assert.equal((await put(next, "d", 10)).status, 400, "d is a directory");
    assert.deepEqual((await list(next)).map((f) => f.key), ["a", "d/x"], "no phantom entry");
    next.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("VACUUM with comments works; comments can't smuggle a second statement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cresslet-vac-"));
  try {
    const db = createDb(join(dir, "db.sqlite"), 256 * 1024);
    db.exec("/* tidy */ VACUUM -- now\n");
    assert.throws(() => db.exec("VACUUM -- /*\n; ATTACH '' AS x; -- */"), /not authorized|authorization denied/);
    assert.throws(() => db.exec("VACUUM /* '*/; ATTACH '' AS x"), /not authorized|authorization denied/);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
