import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "../server/main.ts";
import { loadConfig, paths } from "../server/config.ts";
import { INSPECT_LIMITS } from "../server/inspect.ts";

const RUNAWAY = "WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r) SELECT count(*) n FROM r";

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-inspect-"));
  const cfg = loadConfig({ dataDir, domain: "test.local", publicPort: 80, adminToken: "adm", siteAdmins: ["own@b.co"] });
  const srv = createServer(cfg);
  const json = async (method: string, path: string, token?: string, input?: unknown) => {
    const headers = new Headers({ host: "test.local" });
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (input !== undefined) headers.set("content-type", "application/json");
    const r = await srv.handler(new Request(`http://test.local${path}`, { method, headers, body: input === undefined ? undefined : JSON.stringify(input) }));
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const owner = (await json("POST", "/v1/accounts", "adm", { email: "own@b.co" })).body.token as string;
  const dep = await json("POST", "/v1/deploys", owner, { app: "shop", files: [{ path: "index.html", data: "hi" }] });
  assert.equal(dep.status, 201, JSON.stringify(dep.body));
  // The app's database, seeded directly: 1500 small rows and a few big ones.
  const dbPath = paths(cfg, dep.body.app.id).db;
  await mkdir(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE small (x INTEGER);
    WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r WHERE x < 1500) INSERT INTO small SELECT x FROM r;
    CREATE TABLE wide (b TEXT);
    WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r WHERE x < 10) INSERT INTO wide SELECT printf('%.*c', 1000000, 'a') FROM r;`);
  db.close();
  const done = async () => {
    srv.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  return { json, owner, done };
}

test("db inspection: a runaway recursive CTE times out cleanly without blocking the event loop", async () => {
  const t = await setup();
  const timeoutMs = INSPECT_LIMITS.timeoutMs;
  INSPECT_LIMITS.timeoutMs = 1500;
  try {
    // Count event-loop ticks and serve other requests while the runaway query runs.
    let ticks = 0;
    const tick = setInterval(() => ticks++, 50);
    const started = Date.now();
    const slow = t.json("POST", "/v1/apps/shop/db/query", t.owner, { sql: RUNAWAY });
    await new Promise((r) => setTimeout(r, 500));
    const t0 = Date.now();
    const other = await t.json("GET", "/v1/apps/shop", t.owner);
    assert.equal(other.status, 200);
    assert.ok(Date.now() - t0 < 500, "API stays responsive while the query runs");
    const r = await slow;
    clearInterval(tick);
    const took = Date.now() - started;
    assert.equal(r.status, 504, JSON.stringify(r.body));
    assert.equal(r.body.error, "query_timeout");
    assert.ok(took >= 1400 && took < 4000, `stopped at the deadline (${took} ms)`);
    assert.ok(ticks >= 20, `event loop kept ticking (${ticks} ticks)`);
    // The slot is free again and ordinary queries work.
    assert.deepEqual((await t.json("POST", "/v1/apps/shop/db/query", t.owner, { sql: "SELECT count(*) n FROM small" })).body, { rows: [{ n: 1500 }] });
  } finally {
    INSPECT_LIMITS.timeoutMs = timeoutMs;
    await t.done();
  }
});

test("db inspection: normal queries, row and byte caps, sql errors, busy", async () => {
  const t = await setup();
  try {
    const q = (sql: string, params?: unknown[]) => t.json("POST", "/v1/apps/shop/db/query", t.owner, { sql, params });
    assert.deepEqual((await q("SELECT x FROM small WHERE x <= ? ORDER BY x", [2])).body, { rows: [{ x: 1 }, { x: 2 }] });
    // Row cap.
    const many = await q("SELECT x FROM small");
    assert.equal(many.status, 200);
    assert.equal(many.body.rows.length, INSPECT_LIMITS.maxRows);
    assert.equal(many.body.truncated, true);
    // Byte cap: 10 rows of ~1 MB → stops before 4 MiB.
    const big = await q("SELECT b FROM wide");
    assert.equal(big.body.truncated, true);
    assert.ok(big.body.rows.length >= 3 && big.body.rows.length < 5, String(big.body.rows.length));
    // A single value bigger than the cap is refused, not built.
    const huge = await q("SELECT zeroblob(100000000) z");
    assert.equal(huge.status, 400);
    assert.equal(huge.body.error, "sql_error");
    assert.match(huge.body.message, /too big/);
    // Read-only and confined as before.
    assert.equal((await q("DELETE FROM small")).status, 400);
    assert.equal((await q("ATTACH '/etc/passwd' AS m")).status, 400);
    assert.equal((await t.json("POST", "/v1/apps/shop/db/query", t.owner, { sql: 1 })).status, 400);

    // The table listing: capped rows per table, byte budget shared.
    const tables = (await t.json("GET", "/v1/apps/shop/db?limit=5000", t.owner)).body.tables;
    assert.equal(tables.small.count, 1500);
    assert.equal(tables.small.rows.length, 1000);
    assert.equal(tables.wide.count, 10);
    assert.equal(tables.wide.truncated, true);
    assert.equal((await t.json("GET", "/v1/apps/shop/db?limit=-1", t.owner)).body.tables.small.rows.length, 0);
    assert.equal((await t.json("GET", "/v1/apps/shop/db?limit=abc", t.owner)).body.tables.small.rows.length, 100);

    // Site admin view: table counts.
    assert.deepEqual((await t.json("GET", "/v1/admin/sites/shop", t.owner)).body.database.tables, [{ name: "small", rows: 1500 }, { name: "wide", rows: 10 }]);

    // Too many at once: the per-app cap answers 429 instead of queueing processes.
    const timeoutMs = INSPECT_LIMITS.timeoutMs;
    INSPECT_LIMITS.timeoutMs = 1000;
    try {
      const all = await Promise.all([q(RUNAWAY), q(RUNAWAY), q("SELECT 1")]);
      assert.deepEqual(all.map((r) => r.status), [504, 504, 429]);
    } finally {
      INSPECT_LIMITS.timeoutMs = timeoutMs;
    }
  } finally {
    await t.done();
  }
});
