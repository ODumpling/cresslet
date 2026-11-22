// The studio preview's server worker (studio/server-worker.ts) under Node: the shared SDK contract cases
// (tests/fixtures/sdk-contract.js) and its sql.js database, with the sql.js version the studio pins (a devDependency
// here). The worker runs in a worker thread: it patches globals (Response, console, WebSocketPair) as in the browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { stripTypes } from "../server/strip.ts";

const ROOT = join(import.meta.dirname, "..");
const SDK = await readFile(join(ROOT, "studio/vendor/cresslet-sdk.js"), "utf8");
const CONTRACT = await readFile(join(ROOT, "tests/fixtures/sdk-contract.js"), "utf8");

/** studio/server-worker.ts (as the browser gets it: types stripped) with sql.js from node_modules and the worker-thread
 *  port as its postMessage/onmessage. */
async function workerSource() {
  const src = stripTypes(await readFile(join(ROOT, "studio/server-worker.ts"), "utf8"));
  const sqlJs = import.meta.resolve("sql.js");
  const wasm = fileURLToPath(new URL("sql-wasm.wasm", sqlJs));
  const swap = (s: string, from: string | RegExp, to: string) => {
    const out = s.replace(from, to);
    assert.notEqual(out, s, `server-worker.ts changed: ${from}`);
    return out;
  };
  let out = swap(src, /^import initSqlJs from "[^"]+";$/m, `import initSqlJs from ${JSON.stringify(sqlJs)};`);
  out = swap(out, /^const SQL_WASM = "[^"]+";$/m, `const SQL_WASM = ${JSON.stringify(wasm)};`);
  // no blob: module URLs in Node: a data: URL
  out = swap(out, 'URL.createObjectURL(new Blob([m.code], { type: "text/javascript" }))', '"data:text/javascript;base64," + Buffer.from(m.code).toString("base64")');
  return `import { parentPort } from "node:worker_threads";
globalThis.postMessage = (m, transfer) => parentPort.postMessage(m, transfer);
globalThis.addEventListener = () => {};
var onmessage;
parentPort.on("message", (data) => onmessage({ data, ports: [] }));
${out}`;
}

function withSdk(app: string) {
  const re = /^import \{[^}]*\} from "cresslet";$/m;
  assert.match(app, re);
  return `${SDK}\n${app.replace(re, "")}`;
}

/** Starts the worker with `code` as the app's server bundle; `get(path)` → { status, json }; `snapshot()` → last db save. */
async function startWorker(code: string, { serial = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cresslet-studio-worker-"));
  const file = join(dir, "server-worker.mjs");
  await writeFile(file, await workerSource());
  const w = new Worker(file);
  const files = new Map<string, { bytes: Uint8Array; contentType: string; updatedAt: number }>();
  const responses = new Map<number, (m: { status: number; body: ArrayBuffer }) => void>();
  const scripts = new Map<number, (m: { result?: unknown; error?: string }) => void>();
  let snapshot: Uint8Array | null = null;
  let lastSeen: Uint8Array | null = null;
  let ready!: () => void;
  let fatal!: (e: Error) => void;
  const started = new Promise<void>((res, rej) => ((ready = res), (fatal = rej)));
  w.on("message", (m) => {
    if (m.type === "ready") ready();
    else if (m.type === "fatal") fatal(new Error(m.message));
    else if (m.type === "db") snapshot = m.bytes;
    else if (m.type === "response") responses.get(m.id)?.(m);
    else if (m.type === "sql-result") scripts.get(m.id)?.(m);
    else if (m.type === "files") {
      // the studio keeps these in the project's VFS (cresslet-plugin.ts fileOp); a Map does here
      const r: Record<string, unknown> = { type: "files-result", id: m.id };
      if (m.op === "put") files.set(m.key, { bytes: m.bytes, contentType: m.contentType, updatedAt: Date.now() });
      else if (m.op === "get") Object.assign(r, files.has(m.key) ? { found: true, ...files.get(m.key) } : { found: false });
      else if (m.op === "delete") files.delete(m.key);
      else if (m.op === "list") {
        r.items = [...files].filter(([k]) => k.startsWith(m.prefix)).sort(([a], [b]) => a.localeCompare(b))
          .map(([key, v]) => ({ key, size: v.bytes.byteLength, contentType: v.contentType, updatedAt: v.updatedAt }));
      }
      w.postMessage(r);
    }
  });
  let id = 0;
  const get = (path: string) =>
    new Promise<{ status: number; json: any }>((resolve) => {
      const n = ++id;
      responses.set(n, (m) => {
        const text = new TextDecoder().decode(m.body);
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = text; // e.g. a 500's stack trace: the assertion that follows shows it
        }
        resolve({ status: m.status, json });
      });
      w.postMessage({ type: "request", id: n, url: `https://app.preview${path}`, method: "GET", headers: [], body: null });
    });
  /** A Database view script (the `sql` message): its result, or `{ error }`. */
  const sql = (text: string) =>
    new Promise<any>((resolve) => {
      const n = ++id;
      scripts.set(n, (m) => resolve(m.error !== undefined ? { error: m.error } : m.result));
      w.postMessage({ type: "sql", id: n, sql: text });
    });
  w.postMessage({
    type: "init",
    code,
    app: { id: "studio", name: "preview", url: "https://app.preview", deployId: "dev" },
    secrets: { CONTRACT_SECRET: "s3cret" },
    db: null,
    serial,
  });
  await started;
  const sqlJs = "sql.js"; // untyped package
  const SQL = await ((await import(sqlJs)).default as () => Promise<{
    Database: new (b: Uint8Array) => { exec(sql: string): { values: unknown[][] }[] };
  }>)();
  return {
    get,
    sql,
    /**
     * The database the studio would reload from, once pending saves (300 ms debounce) have run. Each call needs a new
     * save since the last one: what was just done must have scheduled it.
     */
    async saved() {
      await new Promise((r) => setTimeout(r, 700));
      assert.ok(snapshot && snapshot !== lastSeen, "a new snapshot was posted");
      lastSeen = snapshot;
      return new SQL.Database(snapshot!);
    },
    /** Whether a save has been posted since the last saved() call (no waiting). */
    saving: () => !!snapshot && snapshot !== lastSeen,
    async close() {
      await w.terminate();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("studio preview worker: contract cases pass; its database snapshot keeps every write", async () => {
  const w = await startWorker(withSdk(CONTRACT));
  try {
    const { status, json } = await w.get("/api/contract");
    assert.equal(status, 200);
    const { results } = json as { results: { name: string; ok: boolean; error?: string }[] };
    assert.ok(results.length >= 14, `${results.length} cases`);
    for (const r of results) assert.ok(r.ok, `${r.name}: ${r.error}`);
    const saved = await w.saved();
    assert.deepEqual(saved.exec("SELECT v FROM contract_b ORDER BY id")[0].values, [["a!"], ["b!"], ["env"]]);
    assert.deepEqual(saved.exec("SELECT n FROM contract_c")[0].values, [[20]]);
  } finally {
    await w.close();
  }
});

test("studio preview worker: the module's top level and its export getters see no bindings", async () => {
  const w = await startWorker(withSdk(`import { app } from "cresslet";
const name = () => { try { return app.name; } catch (e) { return e.name; } };
const top = name();
export default { get fetch() { const got = name(); return () => Response.json({ top, getter: got, later: name() }); } };`));
  try {
    assert.deepEqual((await w.get("/")).json, { top: "CressletError", getter: "CressletError", later: "preview" });
  } finally {
    await w.close();
  }
});

test("studio preview worker: schema changes through query are saved, lastInsertRowid survives a save, unsafe bigints refused", async () => {
  const w = await startWorker(withSdk(`import { db } from "cresslet";
export default { async fetch(req) {
  const p = new URL(req.url).pathname;
  const json = (v) => Response.json(v);
  if (p === "/ins") return json(await db.run(db.sql\`CREATE TABLE IF NOT EXISTS t (v); \`).then(() => db.run(db.sql\`INSERT INTO t VALUES (\${"x"})\`)));
  if (p === "/ddl") return json(await db.sql\`CREATE TABLE ddl_only (x)\`);
  if (p === "/rowid") return json((await db.batch(["SELECT 1"]))[0].lastInsertRowid);
  if (p === "/ret") return json(await db.first(db.sql\`INSERT INTO t VALUES (\${"r"}) RETURNING rowid AS id\`));
  if (p === "/zero") return json((await db.batch(["INSERT INTO t (rowid, v) VALUES (0, 'z')"]))[0].lastInsertRowid);
  if (p === "/touch") return json(await db.run("UPDATE t SET v = v"));
  if (p === "/partial-run") return db.run("INSERT OR FAIL INTO u VALUES (3), (4), (3)").then(() => json("no error"), (e) => json(e.message));
  if (p === "/partial-exec") return db.exec("INSERT INTO u VALUES (5); INSERT INTO u VALUES (5);").then(() => json("no error"), (e) => json(e.message));
  if (p === "/poll") return json(await db.query("WITH x AS (SELECT 1 AS n) SELECT n FROM x"));
  if (p === "/fk-off") return db.query("PRAGMA foreign_keys = OFF").then(() => json("off"));
  if (p === "/fk") return json(await db.first("PRAGMA foreign_keys"));
  if (p === "/table-info") return json((await db.query("PRAGMA table_info(t)")).length);
  if (p === "/vacuum-inc") return json(await db.query("PRAGMA incremental_vacuum"));
  if (p === "/version") return json(await db.query("PRAGMA main.user_version = 7"));
  if (p === "/version-call") return json(await db.query("PRAGMA user_version(8)"));
  if (p === "/version-comment") return json(await db.query("PRAGMA main.user_version /* c */ = 9"));
  if (p === "/mk-u") return db.exec("CREATE TABLE u (k INTEGER PRIMARY KEY)").then(() => json("ok"));
  if (p === "/partial") {
    return db.query("INSERT OR FAIL INTO u VALUES (1), (2), (1) RETURNING k").then(() => json("no error"), (e) => json(e.message));
  }
  if (p === "/big") return db.batch([db.sql\`SELECT \${9007199254740993n}\`]).then(() => json("stored"), (e) => json(e.message));
  if (p === "/big-row") {
    await db.exec("CREATE TABLE IF NOT EXISTS ids (id INTEGER PRIMARY KEY)");
    const e = await db.batch([db.sql\`INSERT INTO ids VALUES (9007199254740993) RETURNING id\`]).then(() => "no error", (e) => e.message);
    return json({ e, rows: await db.sql\`SELECT count(*) AS n FROM ids\` });
  }
  if (p === "/first-big") return json(await db.first("SELECT column1 AS v FROM (VALUES (1), (9007199254740993))"));
  if (p === "/proto") return json(Object.keys((await db.batch(['SELECT 42 AS "__proto__"']))[0].rows[0]));
  if (p === "/safe") return json(await db.first(db.sql\`SELECT \${5n} AS x\`));
} };`));
  try {
    assert.ok((await w.get("/ins")).json.lastInsertRowid > 0);
    assert.equal((await w.get("/zero")).json, 0); // rowid 0 is a rowid
    const ins = (await w.get("/ins")).json;
    await w.saved(); // a save reopens sql.js's connection
    assert.equal((await w.get("/rowid")).json, ins.lastInsertRowid);
    // an insert through first, then a save: still its rowid
    const ret = (await w.get("/ret")).json;
    await w.saved();
    assert.equal((await w.get("/rowid")).json, ret.id);
    // a second save with no insert in between keeps it too
    await w.get("/touch");
    await w.saved();
    assert.equal((await w.get("/rowid")).json, ret.id);
    // a query that failed part-way: SQLite kept the rows it wrote, and so does the save (the table's own save is done
    // first, so the one after must come from the failing call)
    await w.get("/mk-u");
    await w.saved();
    assert.match((await w.get("/partial")).json, /UNIQUE constraint failed/);
    assert.deepEqual((await w.saved()).exec("SELECT k FROM u ORDER BY k")[0].values, [[1], [2]]);
    assert.match((await w.get("/partial-run")).json, /UNIQUE constraint failed/);
    assert.deepEqual((await w.saved()).exec("SELECT k FROM u ORDER BY k")[0].values, [[1], [2], [3], [4]]);
    assert.match((await w.get("/partial-exec")).json, /UNIQUE constraint failed/);
    assert.deepEqual((await w.saved()).exec("SELECT k FROM u ORDER BY k")[0].values, [[1], [2], [3], [4], [5]]);
    await w.get("/ddl");
    assert.equal((await w.saved()).exec("SELECT name FROM sqlite_master WHERE name = 'ddl_only'").length, 1);
    // reads every 100 ms don't push a pending save back
    await w.get("/touch");
    for (let i = 0; i < 8 && !w.saving(); i++) {
      await w.get("/poll");
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(w.saving(), "saved while reads kept coming");
    await w.saved();
    // a save keeps foreign_keys as the app set it
    await w.get("/fk-off");
    await w.saved();
    assert.deepEqual((await w.get("/fk")).json, { foreign_keys: 0 });
    // PRAGMAs by name: reads don't save (a save reopens the connection), others do
    assert.equal((await w.get("/table-info")).json, 1);
    await w.get("/rowid"); // a read-only batch
    await new Promise((r) => setTimeout(r, 700));
    assert.ok(!w.saving(), "a PRAGMA read or a read-only batch doesn't save");
    await w.get("/vacuum-inc");
    await w.saved();
    await w.get("/version");
    assert.deepEqual((await w.saved()).exec("PRAGMA user_version")[0].values, [[7]]);
    await w.get("/version-call");
    assert.deepEqual((await w.saved()).exec("PRAGMA user_version")[0].values, [[8]]);
    await w.get("/version-comment");
    assert.deepEqual((await w.saved()).exec("PRAGMA user_version")[0].values, [[9]]);
    assert.match((await w.get("/big")).json, /can't store the integer 9007199254740993 exactly/);
    assert.deepEqual((await w.get("/safe")).json, { x: 5 });
    // results as on the platform: an integer past 2^53 fails the batch (rolled back); __proto__ is a column like any
    assert.deepEqual((await w.get("/big-row")).json, {
      e: "batch statement 1: Value is too large to be represented as a JavaScript number: 9007199254740993",
      rows: [{ n: 0 }],
    });
    assert.deepEqual((await w.get("/proto")).json, ["__proto__"]);
    assert.deepEqual((await w.get("/first-big")).json, { v: 1 }); // first reads one row, as node:sqlite's get()
  } finally {
    await w.close();
  }
});

// TanStack Start apps (studio/start-build.ts): AsyncLocalStorage is a one-store shim in the preview, so the worker
// handles one request at a time, each to the end of its response body.
test("studio worker: `serial` handles one request at a time", async () => {
  const app = `let current = null;
export default {
  async fetch(req) {
    current = new URL(req.url).pathname;
    await new Promise((r) => setTimeout(r, 30));
    const body = new ReadableStream({
      async pull(c) {
        await new Promise((r) => setTimeout(r, 30));
        c.enqueue(new TextEncoder().encode(JSON.stringify(current)));
        c.close();
      },
    });
    return new Response(body);
  },
};`;
  for (const serial of [false, true]) {
    const w = await startWorker(app, { serial });
    try {
      const got = await Promise.all(["/a", "/b", "/c"].map((p) => w.get(p)));
      const own = got.every((r, i) => r.json === ["/a", "/b", "/c"][i]);
      assert.equal(own, serial, serial ? "each request saw its own state" : "without serial, requests interleave");
    } finally {
      await w.close();
    }
  }
});

// The workspace's Database view runs scripts on the app's own connection: the app sees them, and they're saved.
test("studio preview worker: Database view scripts read and write the app's database", async () => {
  const w = await startWorker(withSdk(`import { db } from "cresslet";
export default { async fetch(req) {
  const p = new URL(req.url).pathname;
  if (p === "/begin" || p === "/rollback") return Response.json(await db.exec(p === "/begin" ? "BEGIN" : "ROLLBACK") ?? null);
  return Response.json(await db.query("SELECT v FROM t ORDER BY v"));
} };`));
  try {
    const made = await w.sql("CREATE TABLE t (v, b); INSERT INTO t VALUES (1, x'0102'), (2, NULL) RETURNING v; -- done");
    assert.deepEqual(made, { columns: ["v"], rows: [[1], [2]], truncated: false, changes: 2, statements: 2, transaction: false });
    assert.equal(w.saving(), true, "saved before the result came back (no 300 ms wait)");
    assert.deepEqual((await w.get("/")).json, [{ v: 1 }, { v: 2 }], "the app sees the view's writes");
    assert.deepEqual((await w.saved()).exec("SELECT count(*) FROM t")[0].values, [[2]], "and they're saved");
    // blobs as their size, unsafe integers as digits, an empty result keeps its columns
    assert.deepEqual(await w.sql("SELECT b, 9007199254740993 AS big FROM t WHERE v = 1"), {
      columns: ["b", "big"], rows: [[{ blob: 2 }, "9007199254740993"]], truncated: false, changes: 0, statements: 1, transaction: false,
    });
    assert.deepEqual((await w.sql("SELECT v FROM t WHERE 0")).columns, ["v"]);
    // a read stops at the cap, an endless one too
    const endless = await w.sql("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT i FROM n");
    assert.equal(endless.rows.length, 1000);
    assert.equal(endless.truncated, true);
    assert.equal(w.saving(), false, "reads don't ask for a save");
    const quoted = await w.sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT i AS "update" FROM n`);
    assert.equal(quoted.rows.length, 1000, "a read that looks like a write stops too");
    await w.saved(); // (it looks like one to the save check too: saved)
    // at most 1,000 rows
    const many = await w.sql("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500) SELECT i FROM n");
    assert.equal(many.rows.length, 1000);
    assert.equal(many.truncated, true);
    // a failing statement stops the script: what ran before it stays done
    const bad = await w.sql("DELETE FROM t WHERE v = 2; SELECT nope FROM t; DELETE FROM t");
    assert.match(bad.error, /no such column: nope/);
    assert.deepEqual((await w.get("/")).json, [{ v: 1 }]);
    assert.deepEqual((await w.saved()).exec("SELECT v FROM t")[0].values, [[1]]);
    // a write past the row cap still runs to its end: its error isn't cut off with its rows
    const fk = await w.sql(`CREATE TABLE p (id INTEGER PRIMARY KEY);
      CREATE TABLE c (p REFERENCES p DEFERRABLE INITIALLY DEFERRED);
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1001) INSERT INTO c SELECT i FROM n RETURNING p`);
    assert.match(fk.error, /FOREIGN KEY constraint failed/);
    assert.deepEqual((await w.sql("SELECT count(*) AS n FROM c")).rows, [[0]]);
    await w.saved();
    // a transaction left open is reported (saves wait for it); one a failing script began is rolled back
    const open = await w.sql("BEGIN; INSERT INTO t VALUES (5, NULL)");
    assert.equal(open.transaction, true);
    assert.equal((await w.sql("SELECT 1")).transaction, true, "still open on the next script");
    assert.match((await w.sql("SELECT nope")).error, /still open/);
    assert.equal((await w.sql("COMMIT")).transaction, false);
    assert.deepEqual((await w.saved()).exec("SELECT v FROM t ORDER BY v")[0].values, [[1], [5]]);
    const rolled = await w.sql("BEGIN; INSERT INTO t VALUES (6, NULL); SELECT nope");
    assert.match(rolled.error, /no such column: nope.*rolled back/);
    assert.deepEqual((await w.sql("SELECT v FROM t ORDER BY v")).rows, [[1], [5]]);
    assert.equal((await w.sql("INSERT INTO t VALUES (7, NULL)")).transaction, false, "no transaction left open");
    // the app's own transaction (a request mid-way): scripts wait for it, its ROLLBACK can't undo theirs
    await w.get("/begin");
    assert.match((await w.sql("INSERT INTO t VALUES (8, NULL)")).error, /the app has a transaction open/);
    await w.get("/rollback");
    assert.equal((await w.sql("INSERT INTO t VALUES (8, NULL)")).changes, 1);
  } finally {
    await w.close();
  }
});
