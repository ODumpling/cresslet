// The studio preview's server worker (studio/server-worker.js) under Node: the shared SDK contract cases
// (tests/fixtures/sdk-contract.js) and its sql.js database, with the sql.js version the studio pins (a devDependency
// here). The worker runs in a worker thread: it patches globals (Response, console, WebSocketPair) as in the browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const ROOT = join(import.meta.dirname, "..");
const SDK = await readFile(join(ROOT, "studio/vendor/cresslet-sdk.js"), "utf8");
const CONTRACT = await readFile(join(ROOT, "tests/fixtures/sdk-contract.js"), "utf8");

/** studio/server-worker.js with sql.js from node_modules and the worker-thread port as its postMessage/onmessage. */
async function workerSource() {
  const src = await readFile(join(ROOT, "studio/server-worker.js"), "utf8");
  const sqlJs = import.meta.resolve("sql.js");
  const wasm = fileURLToPath(new URL("sql-wasm.wasm", sqlJs));
  const swap = (s: string, from: string | RegExp, to: string) => {
    const out = s.replace(from, to);
    assert.notEqual(out, s, `server-worker.js changed: ${from}`);
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
async function startWorker(code: string) {
  const dir = await mkdtemp(join(tmpdir(), "cresslet-studio-worker-"));
  const file = join(dir, "server-worker.mjs");
  await writeFile(file, await workerSource());
  const w = new Worker(file);
  const files = new Map<string, { bytes: Uint8Array; contentType: string; updatedAt: number }>();
  const responses = new Map<number, (m: { status: number; body: ArrayBuffer }) => void>();
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
    else if (m.type === "files") {
      // the studio keeps these in the project's VFS (cresslet-plugin.js fileOp); a Map does here
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
  w.postMessage({
    type: "init",
    code,
    app: { id: "studio", name: "preview", url: "https://app.preview", deployId: "dev" },
    secrets: { CONTRACT_SECRET: "s3cret" },
    db: null,
  });
  await started;
  const sqlJs = "sql.js"; // untyped package
  const SQL = await ((await import(sqlJs)).default as () => Promise<{
    Database: new (b: Uint8Array) => { exec(sql: string): { values: unknown[][] }[] };
  }>)();
  return {
    get,
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
  if (p === "/mk-u") return db.exec("CREATE TABLE u (k INTEGER PRIMARY KEY)").then(() => json("ok"));
  if (p === "/partial") {
    return db.query("INSERT OR FAIL INTO u VALUES (1), (2), (1) RETURNING k").then(() => json("no error"), (e) => json(e.message));
  }
  if (p === "/big") return db.batch([db.sql\`SELECT \${9007199254740993n}\`]).then(() => json("stored"), (e) => json(e.message));
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
    assert.match((await w.get("/big")).json, /can't store the integer 9007199254740993 exactly/);
    assert.deepEqual((await w.get("/safe")).json, { x: 5 });
  } finally {
    await w.close();
  }
});
