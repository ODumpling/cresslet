// Host side of the app `env` bindings (db, files). Runs in the control plane; each sandbox reaches
// its own instance over a per-app unix socket (see runtime/worker.js for the client side).
// Same shape is implemented by cresslet-cli (local dev) and the studio (in-browser preview).
// Keep in sync with docs/app-format.md.
import { constants, DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";

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

/** `maxBytes`: size cap (writes past it fail with SQLITE_FULL, "database or disk is full"). */
export function createDb(path: string, maxBytes?: number) {
  const db = new DatabaseSync(path);
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
  const meta = new DatabaseSync(join(dir, "index.sqlite"));
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

/** Resolves once the file writes queued for the files dir `dir` are done (before deleting it). */
export const filesSettled = (dir: string) => (fileQueues.get(resolve(dir)) ?? Promise.resolve()).then(() => {});

/** One app's bindings, served as a fetch handler for its sandbox. */
export function createBindings(
  dataDir: string,
  { secrets = {}, maxFileBytes = 25 * 1024 * 1024, maxDbBytes, maxFilesBytes }: {
    secrets?: Record<string, string>;
    maxFileBytes?: number;
    /** Size cap of the app's database. */
    maxDbBytes?: number;
    /** Total size cap of the app's files. */
    maxFilesBytes?: number;
  } = {},
) {
  const db = createDb(join(dataDir, "db.sqlite"), maxDbBytes);
  // File writes and deletes run one at a time, so the quota check sees every earlier write.
  const filesDir = resolve(dataDir, "files");
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
        const { sql, params = [] } = JSON.parse(await req.text(), reviver) as {
          sql: string;
          params?: SQLInputValue[];
        };
        if (typeof sql !== "string") return text("sql required", 400);
        let result: unknown;
        if (op === "query") result = db.query(sql, ...params);
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
    close() {
      closed = true;
      db.close();
      // Writes already accepted finish first (they're in the app's queue, which outlives us).
      void serialized(filesDir, async () => files.close());
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
