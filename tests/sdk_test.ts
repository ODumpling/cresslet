// The `cresslet` SDK on the platform: the shared contract cases (tests/fixtures/sdk-contract.js, from cresslet-cli,
// `npm run vendor:sdk`) in a real sandbox, the host's /db/batch, and the studio's virtual `cresslet` module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/main.ts";
import { loadConfig } from "../server/config.ts";
import { createBindings } from "../server/bindings.ts";
import "./studio-imports.ts"; // studio modules' ./x.js imports → x.ts

const ROOT = join(import.meta.dirname, "..");
const SDK = await readFile(join(ROOT, "studio/vendor/cresslet-sdk.js"), "utf8");
const CONTRACT = await readFile(join(ROOT, "tests/fixtures/sdk-contract.js"), "utf8");

/**
 * `app` with its `import ... from "cresslet"` resolved to the vendored SDK, as one module (what a bundler makes of it;
 * the SDK has no imports of its own).
 */
function withSdk(app: string) {
  const re = /^import \{[^}]*\} from "cresslet";$/m;
  assert.match(app, re);
  return `${SDK}\n${app.replace(re, "")}`;
}

test("contract cases pass in the platform sandbox (SDK imports, env argument unchanged)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-sdk-"));
  const srv = await createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80, adminToken: "adm" }));
  srv.scheduler.stop(); // the test runs the cron itself
  const call = async (path: string, init: RequestInit & { host?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", init.host ?? "test.local");
    if (init.body) headers.set("content-type", "application/json");
    const r = await srv.handler(new Request(`http://${init.host ?? "test.local"}${path}`, { ...init, headers }));
    const text = await r.text();
    try {
      return { status: r.status, body: JSON.parse(text) };
    } catch {
      throw new Error(`${path}: ${r.status} ${text}`);
    }
  };
  try {
    const acct = await call("/v1/accounts", { method: "POST", headers: { authorization: "Bearer adm" }, body: '{"email":"a@b.co"}' });
    const auth = { authorization: `Bearer ${acct.body.token}` };
    const d = await call("/v1/deploys", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ files: [{ path: "index.html", data: "hi" }], server: withSdk(CONTRACT), config: { crons: ["*/5 * * * *"] } }),
    });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    const { app } = d.body;
    const s = await call(`/v1/apps/${app.name}/secrets`, { method: "PUT", headers: auth, body: '{"CONTRACT_SECRET":"s3cret"}' });
    assert.deepEqual(s.body.keys, ["CONTRACT_SECRET"]);
    const host = `${app.name}.test.local`;
    // a cron run first: the sandbox's first use of its bindings
    await srv.scheduler.tick(new Date("2026-11-19T10:05:00Z"));
    assert.deepEqual((await call("/api/contract/cron", { host })).body, [{ cron: "*/5 * * * *", secret: "s3cret" }]);
    const { status, body } = await call("/api/contract", { host });
    assert.equal(status, 200);
    assert.ok(body.results.length >= 14, `${body.results.length} cases`);
    for (const r of body.results) assert.ok(r.ok, `${r.name}: ${r.error}`);
    // the sandbox's logs carry no SDK errors
    const logs = srv.runtime.logs.recent(app.id, 1000).map((l) => l.msg).join("\n");
    assert.doesNotMatch(logs, /CressletError/);
  } finally {
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("host /db/batch: atomic, nests in an app transaction, validates its input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cresslet-batch-"));
  const b = createBindings(dir);
  const db = async (op: string, body: unknown) => {
    const r = await b.fetch(new Request(`http://host/db/${op}`, { method: "POST", body: JSON.stringify(body) }));
    return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() };
  };
  try {
    await db("exec", { sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)" });
    const ok = await db("batch", {
      statements: [
        { sql: "INSERT INTO t (v) VALUES (?)", params: ["a"] },
        { sql: "INSERT INTO t (v) VALUES (?) RETURNING id, v", params: ["b"] },
        { sql: "SELECT count(*) n FROM t" },
      ],
    });
    assert.deepEqual(ok.body, [
      { rows: [], changes: 1, lastInsertRowid: 1 },
      { rows: [{ id: 2, v: "b" }], changes: 1, lastInsertRowid: 2 },
      { rows: [{ n: 2 }], changes: 0, lastInsertRowid: 2 },
    ]);
    const bad = await db("batch", { statements: [{ sql: "DELETE FROM t" }, { sql: "INSERT INTO t (v) VALUES (NULL)" }] });
    assert.equal(bad.status, 400);
    assert.match(bad.body, /^batch statement 2: NOT NULL constraint failed/);
    assert.deepEqual((await db("first", { sql: "SELECT count(*) n FROM t" })).body, { n: 2 }); // DELETE rolled back
    // inside a transaction the app opened: part of it (rolled back with it)
    await db("exec", { sql: "BEGIN" });
    assert.equal((await db("batch", { statements: [{ sql: "DELETE FROM t" }] })).status, 200);
    await db("exec", { sql: "ROLLBACK" });
    assert.deepEqual((await db("first", { sql: "SELECT count(*) n FROM t" })).body, { n: 2 });
    // input checks
    assert.deepEqual(await db("batch", {}), { status: 400, body: "statements required" });
    assert.deepEqual(await db("batch", { statements: [{ sql: 1 }] }), { status: 400, body: "batch statement 1: sql required" });
    assert.deepEqual(await db("batch", { statements: [{ sql: "SELECT 1", params: 1 }] }), {
      status: 400,
      body: "batch statement 1: params must be an array",
    });
    // no transaction control inside a batch (a COMMIT would leave a failing batch half applied)
    const commit = await db("batch", { statements: [{ sql: "DELETE FROM t" }, { sql: "-- c\n COMMIT" }, { sql: "INSERT INTO t (v) VALUES (NULL)" }] });
    assert.deepEqual(commit, { status: 400, body: "batch statement 2: transaction control, PRAGMA, ATTACH and DETACH aren't allowed in a batch (it is one transaction; the others aren't rolled back with it)" });
    for (const sql of ["begin", "END", "ROLLBACK", "SAVEPOINT s", "/* x */ RELEASE s", ";COMMIT", " ; /*x*/ END"]) {
      assert.equal((await db("batch", { statements: [{ sql }] })).status, 400, sql);
    }
    assert.deepEqual((await db("first", { sql: "SELECT count(*) n FROM t" })).body, { n: 2 });
    // the confinement holds inside a batch too
    const temp = await db("batch", { statements: [{ sql: "CREATE TEMP TABLE x (a)" }] });
    assert.equal(temp.status, 400);
    assert.match(temp.body, /not authorized/);
  } finally {
    await b.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("studio: `cresslet` in server code is the vendored SDK (virtual module), not node_modules", async () => {
  const plugin = "../studio/cresslet-plugin.ts"; // browser module: typed by studio/tsconfig.json, not this program
  const { createCresslet } = await import(plugin);
  let options: { plugins: { name: string; setup(b: unknown): void }[]; loader?: Record<string, string> } | undefined;
  const c = {
    workdir: "/project",
    fs: { exists: async (p: string) => p === "/project/server/index.ts", readFile: async () => { throw new Error("none"); }, writeFile: async () => {} },
    registerCommand() {},
    build: async () => ({ files: [] }),
    bundle: async (o: typeof options) => ((options = o), { outputFiles: [{ path: "/project/.cresslet/build/server.js", text: "x" }] }),
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: URL) => new Response(await readFile(url, "utf8"))) as unknown as typeof fetch;
  try {
    await createCresslet(c, { project: () => null }).build();
    assert.equal(options!.loader?.[".sql"], "text", "`.sql` imports are text (drizzle-kit's drizzle/migrations.js)");
    const hooks: { resolve?: (a: { path: string }) => unknown; load?: () => Promise<{ contents: string }>; filter?: RegExp } = {};
    options!.plugins.find((p) => p.name === "cresslet-sdk")!.setup({
      onResolve: (o: { filter: RegExp }, f: typeof hooks.resolve) => ((hooks.filter = o.filter), (hooks.resolve = f)),
      onLoad: (_o: unknown, f: typeof hooks.load) => (hooks.load = f),
    });
    assert.ok(hooks.filter!.test("cresslet"));
    assert.ok(!hooks.filter!.test("cresslet-other") && !hooks.filter!.test("@x/cresslet"));
    assert.deepEqual(hooks.resolve!({ path: "cresslet" }), { path: "cresslet", namespace: "cresslet-sdk" });
    assert.equal((await hooks.load!()).contents, SDK);
  } finally {
    globalThis.fetch = realFetch;
  }
});
