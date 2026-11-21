// Host side of the app `env` bindings (db, files). Runs in the control plane, one worker thread per
// app (serveBindings, server/bindings-thread.ts) so app SQL never blocks the main thread; each sandbox
// reaches its own instance over a per-app unix socket (see runtime/worker.js for the client side).
// Same shape is implemented by cresslet-cli (local dev) and the studio (in-browser preview).
// Keep in sync with docs/app-format.md.
import { constants, DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";

const num = (v: number | bigint) => (typeof v === "bigint" ? Number(v) : v);

/**
 * App SQL runs in the control plane with its file access, so it must stay inside its own database:
 * no ATTACH of a file (other apps' databases, cresslet.db; also covers VACUUM INTO), no process-wide
 * temp-dir pragmas, no fts3_tokenizer (native pointers). No temp tables or `ATTACH ''` either: temp
 * databases sit outside the size cap. Plain VACUUM attaches an unnamed temp db (as big as the main
 * one), so `vacuum()` says when the statement running is exactly that.
 */
const DENIED_PRAGMAS = new Set(["temp_store_directory", "data_store_directory"]);
/**
 * Settable only by the host: the quota (max_page_count × page_size) and what keeps the WAL file from
 * growing past it (WAL mode, automatic checkpoints, journal_size_limit).
 */
const SIZE_PRAGMAS = new Set(["max_page_count", "page_size", "journal_mode", "wal_autocheckpoint", "journal_size_limit"]);
const TEMP_CREATE = new Set([
  constants.SQLITE_CREATE_TEMP_TABLE,
  constants.SQLITE_CREATE_TEMP_INDEX,
  constants.SQLITE_CREATE_TEMP_TRIGGER,
  constants.SQLITE_CREATE_TEMP_VIEW,
]);
/** True if `sql` is one plain VACUUM (comments allowed). Any quote: no (strings can hide comment marks). */
function isVacuum(sql: string): boolean {
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 1;
      out += " ";
    } else if (`'"\`[`.includes(c)) return false;
    else out += c;
  }
  return /^\s*vacuum(\s+main)?\s*;?\s*$/i.test(out);
}
/**
 * True if `sql` starts with transaction control, after comments and empty statements (SQLite skips a leading `;`). A batch refuses those: one could commit or drop the
 * batch's savepoint and leave a failing batch half applied. Same as cresslet-cli lib/bindings.js isTxControl.
 */
export function isTxControl(sql: string): boolean {
  const rest = sql.replace(/^(?:[\s;]+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?(?:\*\/|$))*/, "");
  return /^(?:begin|commit|end|rollback|savepoint|release)\b/i.test(rest);
}

export function confine(db: DatabaseSync, vacuum: () => boolean = () => false) {
  db.enableDefensive(true); // no writable_schema tricks on its own file either
  db.setAuthorizer((action, arg1, arg2) => {
    const { SQLITE_ATTACH, SQLITE_PRAGMA, SQLITE_FUNCTION, SQLITE_DENY, SQLITE_OK } = constants;
    if (action === SQLITE_ATTACH) return arg1 === "" && vacuum() ? SQLITE_OK : SQLITE_DENY;
    if (TEMP_CREATE.has(action)) return SQLITE_DENY;
    if (action === SQLITE_PRAGMA && DENIED_PRAGMAS.has(String(arg1).toLowerCase())) return SQLITE_DENY;
    if (action === SQLITE_PRAGMA && arg2 !== null && SIZE_PRAGMAS.has(String(arg1).toLowerCase())) return SQLITE_DENY;
    if (action === SQLITE_FUNCTION && String(arg2).toLowerCase() === "fts3_tokenizer") return SQLITE_DENY;
    return SQLITE_OK;
  });
  return db;
}

/**
 * Lock waits: a restarted app's bindings thread opens its files while the previous thread may still
 * be finishing a write (it runs on its own thread, so only that app waits).
 */
const BUSY_MS = 5000;

/** `maxBytes`: size cap (writes past it fail with SQLITE_FULL, "database or disk is full"). */
export function createDb(path: string, maxBytes?: number) {
  const db = new DatabaseSync(path, { timeout: BUSY_MS });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA journal_size_limit = 67108864;");
  if (maxBytes) {
    const { page_size } = db.prepare("PRAGMA page_size").get() as { page_size: number };
    db.exec(`PRAGMA max_page_count = ${Math.max(1, Math.floor(maxBytes / page_size))}`);
  }
  let vacuuming = false;
  confine(db, () => vacuuming);
  /** Runs `fn` for `sql`, letting VACUUM's own temp attach through only when `sql` is just VACUUM. */
  const guard = <T>(sql: string, fn: () => T): T => {
    vacuuming = isVacuum(sql);
    try {
      return fn();
    } finally {
      vacuuming = false;
    }
  };
  return {
    query(sql: string, ...params: SQLInputValue[]) {
      return guard(sql, () => db.prepare(sql).all(...params));
    },
    first(sql: string, ...params: SQLInputValue[]) {
      return guard(sql, () => db.prepare(sql).get(...params) ?? null);
    },
    run(sql: string, ...params: SQLInputValue[]) {
      const r = guard(sql, () => db.prepare(sql).run(...params));
      return { changes: num(r.changes), lastInsertRowid: num(r.lastInsertRowid) };
    },
    exec(sql: string) {
      guard(sql, () => db.exec(sql));
      return null;
    },
    /**
     * The statements in one transaction (a savepoint, so it also nests in one the app opened with exec), all run
     * before anything else on this thread: atomic, and no other request's statement in between. Each result: rows
     * (statements that return any), changes, lastInsertRowid. Same in cresslet-cli lib/bindings.js and
     * studio/server-worker.js.
     */
    batch(statements: { sql: string; params?: SQLInputValue[] }[]) {
      const total = db.prepare("SELECT total_changes() n");
      const counts = db.prepare("SELECT changes() changes, last_insert_rowid() id");
      db.exec("SAVEPOINT cresslet_batch");
      try {
        const out = statements.map(({ sql, params = [] }, i) => {
          try {
            return guard(sql, () => {
              const before = (total.get() as { n: number }).n;
              const rows = db.prepare(sql).all(...params); // runs any statement; [] when it returns no rows
              const c = counts.get() as { changes: number; id: number | bigint };
              return { rows, changes: (total.get() as { n: number }).n === before ? 0 : num(c.changes), lastInsertRowid: num(c.id) };
            });
          } catch (e) {
            (e as Error).message = `batch statement ${i + 1}: ${(e as Error).message}`;
            throw e;
          }
        });
        db.exec("RELEASE cresslet_batch");
        return out;
      } catch (e) {
        try {
          db.exec("ROLLBACK TO cresslet_batch; RELEASE cresslet_batch");
        } catch { /* SQLite already rolled back (e.g. SQLITE_FULL): report the statement's error */ }
        throw e;
      }
    },
    close: () => db.close(),
  };
}

export function safeKey(key: string): string {
  const k = normalize(key).replace(/^\/+/, "");
  if (!k || k.startsWith("..") || k.includes("\0") || k.length > 512) {
    throw new Error(`invalid file key: ${key}`);
  }
  return k;
}

export function createFiles(dir: string) {
  const root = resolve(dir, "blobs");
  mkdirSync(root, { recursive: true });
  const meta = new DatabaseSync(join(dir, "index.sqlite"), { timeout: BUSY_MS });
  meta.exec(`PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS files (
    key TEXT PRIMARY KEY, size INTEGER NOT NULL, content_type TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
  const blob = (k: string) => {
    const p = resolve(root, k);
    if (!p.startsWith(root + sep)) throw new Error(`invalid file key: ${k}`);
    return p;
  };
  return {
    async put(key: string, bytes: Uint8Array, contentType: string) {
      const k = safeKey(key);
      await mkdir(dirname(blob(k)), { recursive: true });
      await writeFile(blob(k), bytes);
      meta.prepare(
        `INSERT INTO files (key, size, content_type, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET size = excluded.size, content_type = excluded.content_type, updated_at = excluded.updated_at`,
      ).run(k, bytes.byteLength, contentType || "application/octet-stream", Date.now());
    },
    async get(key: string): Promise<Response | null> {
      const k = safeKey(key);
      const row = meta.prepare("SELECT * FROM files WHERE key = ?").get(k) as
        | { size: number; content_type: string }
        | undefined;
      if (!row) return null;
      const data = await readFile(blob(k));
      return new Response(data, {
        headers: { "content-type": row.content_type, "content-length": String(row.size) },
      });
    },
    async delete(key: string) {
      const k = safeKey(key);
      meta.prepare("DELETE FROM files WHERE key = ?").run(k);
      await rm(blob(k), { force: true });
    },
    /** Bytes stored, not counting `except` (a key about to be replaced). */
    usage(except = "") {
      return (meta.prepare("SELECT coalesce(sum(size), 0) n FROM files WHERE key != ?").get(except ? safeKey(except) : "") as { n: number }).n;
    },
    list(prefix = "") {
      const rows = meta.prepare(
        "SELECT key, size, content_type, updated_at FROM files WHERE key LIKE ? ESCAPE '\\' ORDER BY key LIMIT 1000",
      ).all(prefix.replace(/[\\%_]/g, (c) => "\\" + c) + "%") as {
        key: string;
        size: number;
        content_type: string;
        updated_at: number;
      }[];
      return rows.map((r) => ({
        key: r.key,
        size: r.size,
        contentType: r.content_type,
        updatedAt: r.updated_at,
      }));
    },
    close: () => meta.close(),
  };
}

// SQL values cross the binding as JSON; bigints and blobs are tagged (mirrors runtime/worker.js).
const reviver = (_k: string, v: unknown) => {
  if (v && typeof v === "object") {
    const o = v as { $bytes?: unknown; $bigint?: unknown };
    if (typeof o.$bytes === "string") return new Uint8Array(Buffer.from(o.$bytes, "base64"));
    if (typeof o.$bigint === "string") return BigInt(o.$bigint);
  }
  return v;
};
const replacer = (_k: string, v: unknown) =>
  typeof v === "bigint"
    ? Number(v)
    : v instanceof Uint8Array
    ? { $bytes: Buffer.from(v).toString("base64") }
    : v;

/**
 * One queue per app's files, shared by every bindings instance of it (a redeploy opens new ones while
 * the old one's requests finish): writes and deletes run one at a time, in order, each quota check
 * seeing every earlier write.
 */
const fileQueues = new Map<string, Promise<unknown>>();
function serialized<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const run = (fileQueues.get(dir) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  fileQueues.set(dir, tail);
  void tail.then(() => fileQueues.get(dir) === tail && fileQueues.delete(dir));
  return run;
}

/**
 * Bindings threads that were closed but haven't exited yet (their accepted file writes are still
 * landing), by files dir. The app's next thread serves at once but holds its file writes until they're
 * gone, so its writes and quota checks still come after every earlier one.
 */
const exiting = new Map<string, Promise<void>>();

/**
 * Resolves once the file writes queued for the files dir `dir` are done (before deleting it): this
 * thread's queue, and closed bindings threads of the app.
 */
export const filesSettled = (dir: string) =>
  Promise.all([fileQueues.get(resolve(dir)), exiting.get(resolve(dir))]).then(() => {});

/** Resolves once every closed bindings thread has exited (shutdown). */
export const bindingsSettled = () => Promise.all(exiting.values()).then(() => {});

export interface BindingsOptions {
  secrets?: Record<string, string>;
  maxFileBytes?: number;
  /** Size cap of the app's database. */
  maxDbBytes?: number;
  /** Total size cap of the app's files. */
  maxFilesBytes?: number;
}

const THREAD = new URL("./bindings-thread.ts", import.meta.url);
/**
 * A thread booted ahead of the next cold start: booting one (isolate + imports) takes ~40 ms, which
 * would otherwise land on the app's first request. Unref'd while spare.
 */
let spare: Worker | undefined;
function bootSpare() {
  if (spare) return; // overlapping cold starts: one spare is enough
  try {
    const w = spare = new Worker(THREAD);
    w.unref();
    w.on("error", () => {}); // a dead spare is dropped below, and the next start boots its own
    w.once("exit", () => spare === w && (spare = undefined));
  } catch {
    // Best effort: the next start boots its own.
  }
}

/**
 * Serves one app's bindings on the unix socket `sockPath` from a worker thread of its own. Resolves
 * once it listens. `onExit`: the thread died without close() (the sandbox has lost its data).
 */
export async function serveBindings(dataDir: string, sockPath: string, opts: BindingsOptions, onExit?: () => void) {
  const filesDir = resolve(dataDir, "files");
  const before = exiting.get(filesDir);
  const worker = spare ?? new Worker(THREAD);
  spare = undefined;
  worker.ref();
  worker.postMessage({ dataDir, sockPath, opts, gated: !!before });
  void before?.then(() => worker.postMessage("go")); // its file writes may start
  let closing = false;
  const exited = new Promise<void>((res) => worker.once("exit", () => res()));
  const close = () => {
    if (closing) return;
    closing = true;
    worker.postMessage("close");
    const p = Promise.all([exiting.get(filesDir), exited]).then(() => {});
    exiting.set(filesDir, p);
    void p.then(() => exiting.get(filesDir) === p && exiting.delete(filesDir));
  };
  try {
    await new Promise<void>((res, rej) => {
      // Other messages may come first (`node --watch` reports the thread's imports this way).
      worker.on("message", (m: { ready?: true; error?: string }) => (m.ready ? res() : m.error !== undefined && rej(new Error(m.error))));
      worker.once("error", rej);
      worker.once("exit", (code) => rej(new Error(`bindings thread exited (${code})`)));
    });
  } catch (e) {
    close();
    throw e;
  }
  bootSpare();
  worker.on("error", () => {}); // reported by "exit" below
  void exited.then(() => {
    if (!closing) {
      close();
      onExit?.();
    }
  });
  return { close };
}

/** One app's bindings, served as a fetch handler for its sandbox. */
export function createBindings(
  dataDir: string,
  { secrets = {}, maxFileBytes = 25 * 1024 * 1024, maxDbBytes, maxFilesBytes }: BindingsOptions = {},
  /** File writes and deletes wait for this (the app's previous bindings thread exiting). */
  after?: Promise<unknown>,
) {
  const db = createDb(join(dataDir, "db.sqlite"), maxDbBytes);
  // File writes and deletes run one at a time, so the quota check sees every earlier write.
  const filesDir = resolve(dataDir, "files");
  if (after) void serialized(filesDir, () => after);
  let closed = false;
  /** Queues a file mutation, or refuses it once these bindings are closing (a redeploy or delete). */
  const serial = <T>(fn: () => Promise<T>): Promise<T | Response> =>
    closed ? Promise.resolve(text("app is restarting, try again", 503)) : serialized(filesDir, fn);
  const files = createFiles(filesDir);
  const text = (s: string, status: number) => new Response(s, { status });

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/secrets") return Response.json(secrets);
      if (req.method === "POST" && url.pathname.startsWith("/db/")) {
        const op = url.pathname.slice(4);
        const body = JSON.parse(await req.text(), reviver) as {
          sql: string;
          params?: SQLInputValue[];
          statements?: { sql: string; params?: SQLInputValue[] }[];
        };
        const { sql, params = [] } = body;
        let result: unknown;
        if (op === "batch") {
          const list = body.statements;
          if (!Array.isArray(list)) return text("statements required", 400);
          for (const [i, s] of list.entries()) {
            if (typeof s?.sql !== "string") return text(`batch statement ${i + 1}: sql required`, 400);
            if (s.params !== undefined && !Array.isArray(s.params)) return text(`batch statement ${i + 1}: params must be an array`, 400);
            if (isTxControl(s.sql)) {
              return text(`batch statement ${i + 1}: transaction control isn't allowed in a batch (it is one transaction)`, 400);
            }
          }
          result = db.batch(list);
        } else if (typeof sql !== "string") return text("sql required", 400);
        else if (op === "query") result = db.query(sql, ...params);
        else if (op === "first") result = db.first(sql, ...params);
        else if (op === "run") result = db.run(sql, ...params);
        else if (op === "exec") result = db.exec(sql);
        else return text("unknown op", 404);
        return new Response(JSON.stringify(result, replacer), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/files/list") return Response.json(files.list(url.searchParams.get("prefix") ?? ""));
      if (url.pathname === "/files") {
        const key = url.searchParams.get("key") ?? "";
        if (req.method === "GET") return (await files.get(key)) ?? text("not found", 404);
        if (req.method === "PUT") {
          const bytes = await readCapped(req, maxFileBytes);
          if (!bytes) return text(`file exceeds ${maxFileBytes} bytes`, 413);
          return await serial(async () => {
            if (maxFilesBytes && files.usage(key) + bytes.byteLength > maxFilesBytes) {
              return text(`storage quota exceeded (${maxFilesBytes} bytes of files per app)`, 413);
            }
            await files.put(key, bytes, req.headers.get("content-type") ?? "");
            return new Response(null, { status: 204 });
          });
        }
        if (req.method === "DELETE") {
          return await serial(async () => {
            await files.delete(key);
            return new Response(null, { status: 204 });
          });
        }
      }
      return text("not found", 404);
    } catch (e) {
      return text((e as Error).message, 400);
    }
  }

  return {
    fetch,
    /** Resolves once the writes already accepted have landed (they're in the app's queue, which outlives us). */
    close(): Promise<void> {
      closed = true;
      db.close();
      return serialized(filesDir, async () => files.close());
    },
  };
}

async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const c of req.body ?? []) {
    n += c.byteLength;
    if (n > max) return null;
    chunks.push(c);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
