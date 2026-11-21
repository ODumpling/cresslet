import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createServer } from "../server/main.ts";
import { type Config, loadConfig } from "../server/config.ts";
import { createBindings, createDb } from "../server/bindings.ts";
import { removeAppFiles } from "../server/deploys.ts";
import { existsSync, mkdirSync } from "node:fs";
import { paths } from "../server/config.ts";
import { ipKey } from "../server/limits.ts";
import type { Store } from "../server/store.ts";

async function setup(limits: Partial<Config["limits"]>, extra: Partial<Config> = {}, reuseDir?: string) {
  const dataDir = reuseDir ?? await mkdtemp(join(tmpdir(), "cresslet-lim-"));
  const base = loadConfig();
  const srv = await createServer(loadConfig({
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
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  /** Stops the server but keeps its data (to start another on it). */
  const stop = () => srv.close();
  return { srv, json, bearer, account, deploy, done, stop, dataDir, store: srv.store };
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

test("new apps and pages per account per hour: create/delete loops get 429; redeploys and site admins don't count", async () => {
  const t = await setup({ createsPerHour: 3 });
  try {
    const a = t.bearer(await t.account("a@b.co"));
    const page = () => t.json("/v1/pages", { method: "POST", headers: a, body: JSON.stringify({ html: "<p>x</p>" }) });
    for (let i = 0; i < 2; i++) {
      const p = await page();
      assert.equal(p.status, 201);
      assert.equal((await t.json(`/v1/pages/${p.body.page.name}`, { method: "DELETE", headers: a })).status, 200);
    }
    assert.equal((await t.deploy(a, "loop")).status, 201, "apps and pages share the allowance");
    assert.equal((await t.json("/v1/apps/loop", { method: "DELETE", headers: a })).status, 200);
    const app = await t.deploy(a, "loop");
    assert.equal(app.status, 429, "deleting doesn't give the allowance back");
    assert.equal(app.body.error, "rate_limited");
    assert.match(app.body.message, /too many new apps and artifacts \(3 per hour\)/);
    const p = await page();
    assert.equal(p.status, 429);
    assert.equal(p.body.error, "rate_limited");

    const b = t.bearer(await t.account("b@b.co"));
    assert.equal((await t.deploy(b, "theirs")).status, 201, "other accounts have their own allowance");
    assert.equal((await t.deploy(b, "theirs")).status, 201, "redeploying an existing app isn't a new one");
    assert.equal((await t.deploy(b, "theirs")).status, 201);
    assert.equal((await t.deploy(b, "theirs")).status, 201);

    const boss = t.bearer(await t.account("boss@b.co"));
    for (let i = 0; i < 4; i++) assert.equal((await t.deploy(boss, `b${i}`)).status, 201, "site admins are exempt");
  } finally {
    await t.done();
  }
});

/** Runs `meanwhile` once, inside the next call of `store[method]` (after the request's own checks, before its insert). */
function interleave<K extends "createApp" | "createPage">(store: Store, method: K, meanwhile: () => Promise<void>) {
  const orig = store[method].bind(store) as (...a: unknown[]) => Promise<unknown>;
  let once = true;
  (store as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
    if (once) {
      once = false;
      await meanwhile();
    }
    return orig(...args);
  };
}

test("a create that loses the last quota slot to a concurrent one doesn't spend the hourly allowance", async () => {
  const t = await setup({ createsPerHour: 2, maxPagesPerAccount: 1 });
  try {
    const a = t.bearer(await t.account("a@b.co"));
    const page = () => t.json("/v1/pages", { method: "POST", headers: a, body: JSON.stringify({ html: "<p>x</p>" }) });
    let won = "";
    interleave(t.store, "createPage", async () => {
      const r = await page();
      assert.equal(r.status, 201);
      won = r.body.page.name;
    });
    assert.equal((await page()).status, 403, "the slot went to the other request");
    assert.equal((await t.json(`/v1/pages/${won}`, { method: "DELETE", headers: a })).status, 200);
    assert.equal((await page()).status, 201, "the 403 didn't count");
  } finally {
    await t.done();
  }
});

test("two first deploys of one name: the loser gets 409 and keeps its hourly allowance", async () => {
  const t = await setup({ createsPerHour: 2 });
  try {
    const a = t.bearer(await t.account("a@b.co"));
    interleave(t.store, "createApp", async () => assert.equal((await t.deploy(a, "same")).status, 201));
    const lost = await t.deploy(a, "same");
    assert.equal(lost.status, 409);
    assert.equal(lost.body.error, "conflict");
    assert.equal((await t.json("/v1/apps/same", { method: "DELETE", headers: a })).status, 200);
    assert.equal((await t.deploy(a, "next")).status, 201, "the 409 didn't count");
  } finally {
    await t.done();
  }
});

test("hourly limits survive a restart", async () => {
  const t = await setup({ createsPerHour: 1, anonAppsPerHour: 1 }, { clientIpHeader: "cf-connecting-ip" });
  let tok: string;
  try {
    tok = await t.account("a@b.co");
    assert.equal((await t.deploy(t.bearer(tok), "one")).status, 201);
    const anon = await t.deploy({ "cf-connecting-ip": "1.1.1.1" });
    assert.equal(anon.status, 201);
    assert.equal((await t.json(`/v1/apps/${anon.body.app.name}`, { method: "DELETE", headers: { "x-cresslet-deploy-key": anon.body.deployKey } })).status, 200);
    t.stop();
  } catch (e) {
    await t.done();
    throw e;
  }
  const again = await setup({ createsPerHour: 1, anonAppsPerHour: 1 }, { clientIpHeader: "cf-connecting-ip" }, t.dataDir);
  try {
    assert.equal((await again.deploy(again.bearer(tok), "two")).status, 429);
    assert.equal((await again.deploy({ "cf-connecting-ip": "1.1.1.1" })).status, 429);
    assert.equal((await again.deploy({ "cf-connecting-ip": "2.2.2.2" })).status, 201);
  } finally {
    await again.done();
  }
});

test("anonymous pool under saturation: live apps per client IP (IPv6 by /64), freed by delete or claim", async () => {
  const t = await setup({ anonAppsPerHour: 100, maxAnonAppsPerIp: 2, maxAnonApps: 5 }, { clientIpHeader: "cf-connecting-ip" });
  try {
    const ip = (x: string) => ({ "cf-connecting-ip": x });
    const mine = [await t.deploy(ip("1.1.1.1")), await t.deploy(ip("1.1.1.1"))];
    for (const r of mine) assert.equal(r.status, 201);
    const held = await t.deploy(ip("1.1.1.1"));
    assert.equal(held.status, 429, "one address can't take the whole pool");
    assert.match(held.body.message, /live anonymous apps from your address \(2\)/);

    assert.equal((await t.deploy(ip("2001:db8:1:2::1"))).status, 201);
    assert.equal((await t.deploy(ip("2001:db8:1:2:ffff::9"))).status, 201);
    assert.equal((await t.deploy(ip("2001:db8:1:2::abcd"))).status, 429, "the same IPv6 /64 is one client");

    const third = await t.deploy(ip("3.3.3.3"));
    assert.equal(third.status, 201, "pool: 5 of 5");
    const full = await t.deploy(ip("4.4.4.4"));
    assert.equal(full.status, 429, "a full pool still turns new clients away");
    assert.match(full.body.message, /too many anonymous apps on this server/);

    const del = await t.json(`/v1/apps/${third.body.app.name}`, { method: "DELETE", headers: { "x-cresslet-deploy-key": third.body.deployKey } });
    assert.equal(del.status, 200);
    assert.equal((await t.deploy(ip("4.4.4.4"))).status, 201, "a delete frees a slot");

    // 1.1.1.1 is still at its cap (2 live): a claim takes one off it, and off the pool.
    const a = t.bearer(await t.account("a@b.co"));
    const claim = await t.json(`/v1/apps/${mine[1].body.app.name}/claim`, { method: "POST", headers: a, body: JSON.stringify({ deployKey: mine[1].body.deployKey }) });
    assert.equal(claim.status, 200);
    assert.equal((await t.deploy(ip("1.1.1.1"))).status, 201, "a claim frees the address's live slot and a pool slot");
    assert.equal((await t.deploy(ip("1.1.1.1"))).status, 429, "pool full again");
  } finally {
    await t.done();
  }
});

test("ipKey: IPv4 as is, IPv6 by its /64", () => {
  assert.equal(ipKey("1.2.3.4"), "1.2.3.4");
  assert.equal(ipKey("1.2.3.4:5678"), "1.2.3.4");
  assert.equal(ipKey("[2001:db8:1:2::1]:443"), "2001:db8:1:2::/64");
  assert.equal(ipKey("[2001::2:3:4:5:6]:443"), "2001:0:0:2::/64");
  assert.equal(ipKey("1.2.3.4:443") === ipKey("1.9.8.7:443"), false);
  assert.equal(ipKey("::ffff:1.2.3.4"), "1.2.3.4");
  assert.equal(ipKey("::ffff:0102:0304"), "1.2.3.4", "hex IPv4-mapped");
  assert.equal(ipKey("0:0:0:0:0:ffff:5.6.7.8"), "5.6.7.8");
  assert.equal(ipKey("2001:0db8:0001:0002:0000:0000:0000:0001"), "2001:db8:1:2::/64", "fully expanded");
  assert.equal(ipKey("2001:DB8:0001:0002:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(ipKey("2001:db8:1:2::"), "2001:db8:1:2::/64");
  assert.equal(ipKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(ipKey("[2001:db8:1:2:3:4:5:6]"), "2001:db8:1:2::/64");
  assert.equal(ipKey("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.equal(ipKey("::1"), "0:0:0:0::/64");
  assert.equal(ipKey("unknown"), "unknown");
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

test("deleting an app waits for its queued file writes; writes after close are refused", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-purge-"));
  try {
    const cfg = loadConfig({ dataDir });
    const p = paths(cfg, "app_x");
    mkdirSync(p.data, { recursive: true });
    const b = createBindings(p.data, { maxFilesBytes: 10_000_000 });
    const put = (key: string, body: BodyInit) =>
      b.fetch(new Request(`http://h/files?key=${key}`, { method: "PUT", body, duplex: "half" } as RequestInit));
    const queued = Array.from({ length: 30 }, (_, i) => put(`f${i}`, new Uint8Array(1000)));
    await new Promise((r) => setImmediate(r));
    let release!: () => void;
    const late = put("late", new ReadableStream({
      async start(c) {
        await new Promise<void>((r) => (release = r));
        c.enqueue(new Uint8Array(10));
        c.close();
      },
    }));
    b.close();
    release();
    assert.equal((await late).status, 503, "body finished after close");
    const del = await b.fetch(new Request("http://h/files?key=f0", { method: "DELETE" }));
    assert.equal(del.status, 503, "deletes after close are refused too");
    await removeAppFiles(cfg, "app_x");
    assert.deepEqual([...new Set((await Promise.all(queued)).map((r) => r.status))], [204], "accepted writes all land");
    assert.ok(!existsSync(p.app), "nothing left behind");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

/** A ReadableStream that yields `count` chunks of `chunkSize` bytes and records pulls + cancellation. */
function trackedStream(chunkSize: number, count: number) {
  let pulled = 0;
  let cancelled = false;
  const chunk = new Uint8Array(chunkSize).fill(0x61); // 'a'
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (pulled >= count) return ctrl.close();
      pulled++;
      ctrl.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, stats: () => ({ pulled, cancelled }) };
}

test("JSON request body caps: config validation, default tiers, Content-Length pre-check, chunked abort, and boundaries", async () => {
  const defaults = loadConfig().limits;
  assert.equal(defaults.jsonBodyBytes, 1024 * 1024);
  assert.ok(defaults.deployBodyBytes >= 40 * 1024 * 1024 && defaults.deployBodyBytes <= 45 * 1024 * 1024);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.throws(() => loadConfig({ limits: { ...defaults, jsonBodyBytes: bad } }), /jsonBodyBytes/);
    assert.throws(() => loadConfig({ limits: { ...defaults, deployBodyBytes: bad } }), /deployBodyBytes/);
  }
  const scaled = loadConfig({ limits: { deployBytes: 50 * 1024 * 1024 } as never }).limits;
  assert.ok(scaled.deployBodyBytes > 70 * 1024 * 1024, "deployBodyBytes rescales with deployBytes override");
  const fractional = loadConfig({ limits: { serverBytes: 0.1 * 1024 * 1024 } as never }).limits;
  assert.ok(Number.isSafeInteger(fractional.deployBodyBytes) && fractional.deployBodyBytes > 0, "fractional serverBytes rounds cleanly");

  const jsonCap = 256;
  const deployCap = 2048;
  const t = await setup({ jsonBodyBytes: jsonCap, deployBodyBytes: deployCap }, {
    github: { clientId: "id", clientSecret: "sec", webUrl: "https://github.com", apiUrl: "https://api.github.com" },
  });
  const send = (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    headers.set("host", "test.local");
    return t.srv.handler(new Request(`http://test.local${path}`, { ...init, headers, duplex: "half" } as RequestInit));
  };
  try {
    const token = await t.account("a@b.co");
    const auth = t.bearer(token);
    const created = await t.deploy(auth, "demo");
    assert.equal(created.status, 201);

    // 1. Oversized Content-Length on metadata endpoint: rejected immediately without reading stream.
    const unread = trackedStream(1024, 10);
    const clRes = await send("/v1/auth/cli/token", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(jsonCap + 1) },
      body: unread.stream,
    });
    assert.equal(clRes.status, 413);
    assert.equal((await clRes.json()).error, "body_too_large");
    assert.equal(unread.stats().pulled, 0, "Content-Length pre-check must not read body");
    assert.equal(unread.stats().cancelled, true, "Content-Length pre-check must cancel body");

    // 2. Chunked / no Content-Length on metadata endpoint: aborts mid-stream past cap.
    const chunked = trackedStream(100, 20);
    const chRes = await send("/v1/auth/cli/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chunked.stream,
    });
    assert.equal(chRes.status, 413);
    assert.equal((await chRes.json()).error, "body_too_large");
    assert.ok(chunked.stats().pulled <= 4, `expected early abort, pulled ${chunked.stats().pulled} chunks`);
    assert.equal(chunked.stats().cancelled, true, "oversized stream must be cancelled");

    // 3. Lying Content-Length (claims small, streams past cap): still aborted mid-stream.
    const lying = trackedStream(100, 20);
    const lieRes = await send("/v1/auth/cli/token", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "10" },
      body: lying.stream,
    });
    assert.equal(lieRes.status, 413);
    assert.equal((await lieRes.json()).error, "body_too_large");
    assert.equal(lying.stats().cancelled, true);

    // 4. Exact boundary on metadata tier (including explicit Content-Length === cap and 1-byte chunks).
    const prefix = '{"K":"';
    const suffix = '"}';
    const exactSecret = prefix + "x".repeat(jsonCap - prefix.length - suffix.length) + suffix;
    assert.equal(Buffer.byteLength(exactSecret), jsonCap);
    assert.equal((await t.json("/v1/apps/demo/secrets", {
      method: "PUT", headers: { ...auth, "content-length": String(jsonCap) }, body: exactSecret,
    })).status, 200);
    const exactBytes = new TextEncoder().encode(exactSecret);
    let idx = 0;
    const fragmented = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (idx >= exactBytes.length) return ctrl.close();
        ctrl.enqueue(new Uint8Array(0)); // empty chunk ignored
        ctrl.enqueue(exactBytes.subarray(idx, ++idx));
      },
    }, { highWaterMark: 0 });
    assert.equal((await send("/v1/apps/demo/secrets", {
      method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: fragmented,
    })).status, 200, "fragmented 1-byte chunks at exact cap succeed");
    const overSecret = prefix + "x".repeat(jsonCap - prefix.length - suffix.length + 1) + suffix;
    assert.equal(Buffer.byteLength(overSecret), jsonCap + 1);
    const overSecretRes = await t.json("/v1/apps/demo/secrets", { method: "PUT", headers: auth, body: overSecret });
    assert.equal(overSecretRes.status, 413);
    assert.equal(overSecretRes.body.error, "body_too_large");

    // 5. Optional-body metadata endpoints (/claim and /pages/:name/view) must not swallow 413.
    const anon = await t.deploy({}, "unclaimed");
    assert.equal(anon.status, 201);
    const bigClaim = await t.json("/v1/apps/unclaimed/claim", {
      method: "POST",
      headers: { ...auth, "x-cresslet-deploy-key": anon.body.deployKey },
      body: JSON.stringify({ deployKey: "x".repeat(jsonCap) }),
    });
    assert.equal(bigClaim.status, 413);
    assert.equal(bigClaim.body.error, "body_too_large");
    // Empty body on /claim still succeeds using header key.
    assert.equal((await t.json("/v1/apps/unclaimed/claim", {
      method: "POST",
      headers: { ...auth, "x-cresslet-deploy-key": anon.body.deployKey },
    })).status, 200);

    // 6. Deploy/page tier: exact deployCap passes, deployCap + 1 returns 413.
    const dPrefix = '{"app":"demo","files":[{"path":"index.html","data":"';
    const dSuffix = '"}]}';
    const exactDeploy = dPrefix + "a".repeat(deployCap - dPrefix.length - dSuffix.length) + dSuffix;
    assert.equal(Buffer.byteLength(exactDeploy), deployCap);
    assert.equal((await t.json("/v1/deploys", {
      method: "POST", headers: { ...auth, "content-length": String(deployCap) }, body: exactDeploy,
    })).status, 201, "deploy at exact deployCap succeeds");

    const overDeploy = dPrefix + "a".repeat(deployCap - dPrefix.length - dSuffix.length + 1) + dSuffix;
    assert.equal(Buffer.byteLength(overDeploy), deployCap + 1);
    const hugeDeploy = await t.json("/v1/deploys", { method: "POST", headers: auth, body: overDeploy });
    assert.equal(hugeDeploy.status, 413);
    assert.equal(hugeDeploy.body.error, "body_too_large");

    // Chunked deploy past deployCap aborts stream.
    const bigDeployStream = trackedStream(512, 20);
    const bigDeployRes = await send("/v1/deploys", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: bigDeployStream.stream,
    });
    assert.equal(bigDeployRes.status, 413);
    assert.equal(bigDeployStream.stats().cancelled, true);

    // POST /v1/pages and PUT /v1/pages/:name use deploy tier; PATCH /v1/pages/:name and POST /view use metadata tier.
    const mediumHtml = "a".repeat(jsonCap + 200);
    const pageCreate = await t.json("/v1/pages", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ html: mediumHtml }),
    });
    assert.equal(pageCreate.status, 201, "POST /v1/pages > jsonCap and <= deployCap succeeds");
    const pageName = pageCreate.body.page.name as string;

    const pageOver = await t.json("/v1/pages", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ html: "a".repeat(deployCap) }),
    });
    assert.equal(pageOver.status, 413);
    assert.equal(pageOver.body.error, "body_too_large");

    const pagePutOk = await t.json(`/v1/pages/${pageName}`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ html: mediumHtml + "!" }),
    });
    assert.equal(pagePutOk.status, 200, "PUT /v1/pages/:name > jsonCap and <= deployCap succeeds");

    const pagePutOver = await t.json(`/v1/pages/${pageName}`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ html: "a".repeat(deployCap) }),
    });
    assert.equal(pagePutOver.status, 413);
    assert.equal(pagePutOver.body.error, "body_too_large");

    const pagePatchOver = await t.json(`/v1/pages/${pageName}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ title: "t".repeat(jsonCap) }),
    });
    assert.equal(pagePatchOver.status, 413, "PATCH /v1/pages/:name uses metadata cap");
    assert.equal(pagePatchOver.body.error, "body_too_large");

    const pageViewOver = await t.json(`/v1/pages/${pageName}/view`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ path: "/" + "x".repeat(jsonCap) }),
    });
    assert.equal(pageViewOver.status, 413, "POST /v1/pages/:name/view does not swallow 413");
    assert.equal(pageViewOver.body.error, "body_too_large");
    assert.equal((await t.json(`/v1/pages/${pageName}/view`, { method: "POST", headers: auth })).status, 200);
  } finally {
    await t.done();
  }
});

test("closed instance rejects unauthenticated POST /v1/deploys before reading body", async () => {
  const t = await setup({ deployBodyBytes: 2048 }, { anonDeploys: false });
  try {
    const unread = trackedStream(512, 10);
    const res = await t.srv.handler(new Request("http://test.local/v1/deploys", {
      method: "POST",
      headers: { host: "test.local", "content-type": "application/json" },
      body: unread.stream,
      duplex: "half",
    } as RequestInit));
    assert.equal(res.status, 401);
    assert.equal(unread.stats().pulled, 0, "must not read body before 401 on closed instance");
  } finally {
    await t.done();
  }
});

test("JSON request body cap over real HTTP/1.1 chunked transfer encoding rejects before upload ends", { timeout: 5000 }, async () => {
  const t = await setup({ jsonBodyBytes: 256, deployBodyBytes: 1024 });
  const http = serve({ fetch: t.srv.handler, port: 0 });
  await new Promise((r) => http.once("listening", r));
  const port = (http.address() as { port: number }).port;
  try {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      let responded = false;
      const req = httpRequest({
        host: "127.0.0.1",
        port,
        path: "/v1/accounts",
        method: "POST",
        headers: { host: "test.local", authorization: "Bearer adm", "content-type": "application/json", "transfer-encoding": "chunked" },
      }, (r) => {
        responded = true;
        const parts: Buffer[] = [];
        r.on("data", (d) => parts.push(d));
        r.on("end", () => {
          req.destroy();
          resolve({ status: r.statusCode!, body: Buffer.concat(parts).toString() });
        });
      });
      req.on("error", (err) => {
        if (!responded) reject(err);
      });
      // Send more than jsonBodyBytes WITHOUT calling req.end(): proves early streaming 413.
      req.write('{"email":"' + "a".repeat(200));
      req.write("b".repeat(200));
    });
    assert.equal(res.status, 413);
    assert.equal(JSON.parse(res.body).error, "body_too_large");
  } finally {
    http.close();
    await t.done();
  }
});
