// Runs an app's server bundle in the browser with the Cresslet Env API.
// Protocol (postMessage):
//   in:  {type:"init", code, app, secrets, db: Uint8Array|null, serial?}  → out: {type:"ready"} | {type:"fatal", message}
//        serial: one request at a time (each to its whole response body): the app's AsyncLocalStorage is a one-store
//        shim here (TanStack Start, start-build.ts)
//   in:  {type:"request", id, url, method, headers, body}        → out: {type:"response", id, status, headers, body}
//   in:  {type:"sql", id, sql} (the studio's Database view)       → out: {type:"sql-result", id, result | error}
//   out: {type:"log", level, msg}  {type:"db", bytes}  {type:"files", id, op, ...} ← in: {type:"files-result", id, ...}
//   WebSockets: a 101 response is {type:"response", id, status: 101, headers, body: null, protocol}; then
//   in:  {type:"socket", id} + a MessagePort to the preview's socket (no port: the preview gave up)
import initSqlJs from "https://esm.sh/sql.js@1.13.0";
import type { Database, SqlJsStatic, SqlValue } from "https://esm.sh/sql.js@1.13.0";
import type { AppInfo, FileItem, FileOp, FileResult, FileResults, FromWorker, SqlCell, SqlResult, ToWorker } from "./server-worker-protocol.ts";

/** This worker's postMessage, typed to the protocol (the global one). */
declare function postMessage(message: FromWorker, transfer?: Transferable[]): void;

/** The app's `env` (docs/app-format.md), as this preview implements it. */
interface Env {
  db: ReturnType<typeof createDb>["binding"];
  files: {
    put(key: string, body: BodyInit | null, opts?: { contentType?: string }): Promise<void>;
    get(key: string): Promise<Response | null>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<FileItem[]>;
  };
  secrets: Readonly<Record<string, string>>;
  app: Readonly<AppInfo>;
}
/** The app's fetch handler (the server bundle's default export, or its `fetch`). */
type Handler = (req: Request, env: Env, ctx: { waitUntil(p: unknown): void }) => unknown;

const SQL_WASM = "https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/sql-wasm.wasm";
let handler: Handler | undefined;
let env: Env;
let studioSql: ((sql: string) => SqlResult) | undefined; // the Database view's runner (init sets it)
let snapshotsPosted = 0; // database snapshots posted (a Database view result says whether it posted one)
let serial: Promise<unknown> | null = null; // with init's `serial`: the request being handled (a promise), the next one waits for it
// Where the `cresslet` SDK (`import { db } from "cresslet"`, cresslet-cli sdk/index.js) finds the env: published once
// the app's module has loaded (bindings exist only once a handler runs). Contract: runtime/cresslet-runtime.ts.
const runtime: { contract: number; runtime: string; paramStyle: string; env: Env | null } = { contract: 2, runtime: "studio preview", paramStyle: "?", env: null };
(globalThis as unknown as Record<symbol, unknown>)[Symbol.for("cresslet.runtime")] = runtime;

const fmt = (args: unknown[]) =>
  args.map((a) => (typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : safeJson(a))).join(" ");
const safeJson = (v: unknown) => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    postMessage({ type: "log", level, msg: fmt(args) });
    orig(...args);
  };
}

// Uncaught errors in app code (timers, listeners) are logged and the server keeps running: an error that
// reaches the studio's onerror means the worker is gone.
addEventListener("error", (e) => {
  e.preventDefault();
  console.error(e.error ?? e.message);
});
addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  console.error(e.reason);
});

// ---- WebSockets: Workers' WebSocketPair and `new Response(null, { status: 101, webSocket })`, which browsers lack
// (their Response rejects 101). The pair's client end is glued to a MessagePort to the preview's socket
// (cresslet-container's upgradeWebSocket): {type:"message", data: string|ArrayBuffer} and {type:"close", code, reason}.
class PairSocket extends EventTarget {
  peer: PairSocket | null = null; // the other end: set by WebSocketPair right after both are made
  readyState = 1; // OPEN
  binaryType: BinaryType = "blob"; // binary messages arrive as Blobs unless "arraybuffer", as on the platform (its compat date)
  protocol = "";
  extensions = "";
  url = null;
  #accepted = false;
  #queue: Event[] = [];
  #handlers: Record<string, Function | null> = {};
  constructor() {
    super();
    for (const type of ["message", "close", "error"]) {
      this.addEventListener(type, (e) => this.#handlers[type]?.call(this, e));
      Object.defineProperty(this, `on${type}`, {
        get: () => this.#handlers[type] ?? null,
        set: (f: unknown) => (this.#handlers[type] = typeof f === "function" ? f : null),
      });
    }
  }
  accept() {
    if (this.#accepted) return;
    this.#accepted = true;
    for (const e of this.#queue.splice(0)) this.#emit(e);
  }
  deliver(e: Event) {
    if (this.#accepted) this.#emit(e);
    else this.#queue.push(e);
  }
  #emit(e: Event) {
    if (e.type === "message" && (e as MessageEvent).data instanceof ArrayBuffer && this.binaryType !== "arraybuffer") {
      e = new MessageEvent("message", { data: new Blob([(e as MessageEvent).data]) });
    }
    this.dispatchEvent(e);
  }
  send(data: unknown) {
    if (this.readyState !== 1) throw new TypeError("Can't call WebSocket send() after close().");
    if (data instanceof ArrayBuffer) data = data.slice(0);
    else if (ArrayBuffer.isView(data)) data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    else if (typeof data !== "string") throw new TypeError("WebSocket send() takes a string, ArrayBuffer or ArrayBufferView");
    this.peer!.deliver(new MessageEvent("message", { data }));
  }
  close(code?: number, reason: unknown = "") {
    if (this.readyState !== 1) return;
    this.readyState = 2; // CLOSING
    this.peer!.readyState = 3; // CLOSED
    const event = () => new CloseEvent("close", { code: code ?? 1005, reason: String(reason), wasClean: true });
    this.peer!.deliver(event());
    // and this end, later, as when the peer's close frame comes back
    setTimeout(() => ((this.readyState = 3), this.deliver(event())));
  }
}
(globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = class WebSocketPair {
  declare 0: PairSocket;
  declare 1: PairSocket;
  constructor() {
    const a = new PairSocket();
    const b = new PairSocket();
    a.peer = b;
    b.peer = a;
    this[0] = a;
    this[1] = b;
  }
};
const NativeResponse = Response;
const ownHeaders = <R extends Response>(res: R, headers: HeadersInit): R => Object.defineProperty(res, "headers", { value: new Headers(headers), configurable: true });
globalThis.Response = class Response extends NativeResponse {
  // fetch(), Response.json(), clone()… return native ones: still `instanceof Response` (Hono checks). Apps' own
  // subclasses keep the usual check.
  static override [Symbol.hasInstance](v: unknown) {
    return this === globalThis.Response ? v instanceof NativeResponse : Function.prototype[Symbol.hasInstance].call(this, v);
  }
  // Browsers drop Set-Cookie from a Response's headers (a forbidden response header): an app's cookies (sessions)
  // would never reach the studio. Responses made here keep all their headers, Set-Cookie included, on a Headers of
  // their own (later appends too), which the studio reads.
  static override json(data: unknown, init?: ResponseInit) {
    const body = JSON.stringify(data);
    if (body === undefined) throw new TypeError("Value is not JSON serializable");
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new this(body, { ...init, headers });
  }
  override clone() {
    return ownHeaders(super.clone(), this.headers);
  }
  declare webSocket?: PairSocket;
  constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: PairSocket }) {
    if (init?.status !== 101) {
      super(body, init);
      const headers = new Headers(super.headers); // with the defaults the body gave (content-type)
      headers.delete("set-cookie"); // where Response keeps them (not browsers), they're added once below
      for (const v of new Headers(init?.headers).getSetCookie()) headers.append("set-cookie", v);
      ownHeaders(this, headers);
      return;
    }
    // `init` may be a 101 Response being re-wrapped (`new Response(res.body, res)`, as Hono middleware does).
    super(null, { status: 200, statusText: init.statusText, headers: init.headers });
    // as in workerd: not ok, and not clonable (a clone couldn't carry the socket)
    Object.defineProperties(this, {
      status: { value: 101 },
      ok: { value: false },
      clone: { value: () => { throw new TypeError("Cannot clone a response to a WebSocket handshake."); } },
    });
    this.webSocket = init.webSocket;
  }
};
const accepted = new Map<number, PairSocket>(); // request id → the pair's client end, until its port arrives

// Whoever sends `close` is done with the port; whoever gets it closes it.
function connect(client: PairSocket, port: MessagePort) {
  client.binaryType = "arraybuffer";
  client.addEventListener("message", (e) => port.postMessage({ type: "message", data: (e as MessageEvent).data }));
  client.addEventListener("close", (e) => port.postMessage({ type: "close", code: (e as CloseEvent).code, reason: (e as CloseEvent).reason }));
  port.onmessage = ({ data: d }) => {
    // From the preview (untrusted, like its requests).
    if (d?.type === "message" && (typeof d.data === "string" || d.data instanceof ArrayBuffer)) {
      if (client.readyState === 1) client.send(d.data);
    } else if (d?.type === "close") {
      port.close();
      if (client.readyState !== 1) return; // the app closed it too
      client.readyState = client.peer!.readyState = 3;
      const code = Number.isInteger(d.code) ? d.code : 1005;
      client.peer!.deliver(new CloseEvent("close", { code, reason: String(d.reason ?? ""), wasClean: true }));
    }
  };
  client.accept();
}

// ---- files RPC to the main thread (stored in the VFS)
let rpcId = 0;
const pending = new Map<number, { resolve: (r: FileResult) => void; reject: (e: unknown) => void }>();
function files<O extends FileOp>(msg: O, transfer: Transferable[] = []) {
  const id = ++rpcId;
  return new Promise<FileResults[O["op"]]>((resolve, reject) => {
    pending.set(id, { resolve: (r) => resolve(r as FileResults[O["op"]]), reject }); // the page answers `op` with its fields
    postMessage({ type: "files", id, ...msg }, transfer);
  });
}

/**
 * PRAGMAs that only report when they have no `=` or `(…)`. Any other PRAGMA, or one with `=`, or `(…)` outside
 * READ_PRAGMAS_WITH_ARG, may change the database (incremental_vacuum, optimize, user_version = 7, user_version(7)): the
 * preview saves after it.
 */
const READ_PRAGMAS = new Set([
  "application_id", "auto_vacuum", "cache_size", "collation_list", "compile_options", "data_version", "database_list",
  "encoding", "foreign_key_check", "foreign_key_list", "foreign_keys", "freelist_count", "function_list", "index_info",
  "index_list", "index_xinfo", "integrity_check", "journal_mode", "module_list", "page_count", "page_size",
  "pragma_list", "quick_check", "recursive_triggers", "schema_version", "table_info", "table_list", "table_xinfo",
  "user_version",
]);

/** Report-only PRAGMAs whose argument names what to report on (`table_info(t)`), not a value to set. */
const READ_PRAGMAS_WITH_ARG = new Set([
  "foreign_key_check", "foreign_key_list", "index_info", "index_list", "index_xinfo", "integrity_check", "quick_check",
  "table_info", "table_list", "table_xinfo",
]);

/** What apps bind: JS values sql.js can store (bigints within ±2^53, undefined as null). */
type Param = SqlValue | undefined;
type Row = Record<string, SqlValue>;
const SQL_MAX_ROWS = 1000; // a Database view result's rows (protocol: SqlResult)

function createDb(SQL: SqlJsStatic, bytes: Uint8Array | null) {
  const db: Database = bytes ? new SQL.Database(bytes) : new SQL.Database();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let savedRowid = 0;
  let reopened = false;
  const inTransaction = () => {
    // (an empty transaction's COMMIT ends defer_foreign_keys: set again as the app left it, for its next one)
    const defer = one("PRAGMA defer_foreign_keys");
    try {
      db.exec("BEGIN; COMMIT;");
      if (defer) db.exec("PRAGMA defer_foreign_keys = ON;");
      return false;
    } catch {
      return true;
    }
  };
  // Posts a snapshot; false (nothing saved) while a transaction is open.
  const save = () => {
    // export() closes and reopens the database: not while the app holds a transaction open (exec("BEGIN") across
    // awaits) or its writes would be lost; and connection settings (foreign_keys) need setting again after.
    if (inTransaction()) return false;
    savedRowid = rowid(); // the live value, or the one kept from before an earlier save
    const foreignKeys = one("PRAGMA foreign_keys");
    const out = db.export();
    reopened = true; // last_insert_rowid() is 0 on the new connection until its next insert
    db.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"};`); // as the app left it
    postMessage({ type: "db", bytes: out }, [out.buffer]);
    snapshotsPosted++;
    return true;
  };
  // One save at a time, 300 ms after the first change that asked for it: later changes don't push it back (steady
  // traffic would otherwise keep a write from ever being saved). `now`: save at once (the Database view's writes,
  // saved before it hears they're done), or later as usual while a transaction is open.
  const persist = (now = false): void => {
    if (now && save()) {
      clearTimeout(timer);
      timer = undefined;
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!save()) persist(); // in a transaction: try again later
    }, 300);
  };
  // sql.js binds numbers as doubles: a bigint it can't hold exactly is refused, not rounded.
  const norm = (params: Param[]) =>
    params.map((p) => {
      if (typeof p !== "bigint") return p === undefined ? null : p;
      if (p > BigInt(Number.MAX_SAFE_INTEGER) || p < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new RangeError(`the studio preview (sql.js) can't store the integer ${p} exactly (beyond ±2^53); the platform and cresslet dev can`);
      }
      return Number(p);
    });
  /**
   * `max`: stop after that many rows (first(): one, as node:sqlite's get() steps once). `raw`: rows as arrays of values
   * in column order (env.db.raw, `raw` batch statements; contract 2).
   */
  const all = (sql: string, params: Param[], max = Infinity, raw = false) => {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(norm(params));
      const rows: (Row | unknown[])[] = [];
      const cols = stmt.getColumnNames();
      // As node:sqlite (the platform, cresslet dev) does: an integer past 2^53 is an error, not a rounded number, and
      // every column (`__proto__` too) is an own property.
      const cell = (v: SqlValue) => {
        if (typeof v !== "bigint") return v;
        if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
          throw new RangeError(`Value is too large to be represented as a JavaScript number: ${v}`);
        }
        return Number(v);
      };
      while (rows.length < max && stmt.step()) {
        const vals = stmt.get(null, { useBigInt: true });
        rows.push(raw ? vals.map(cell) : Object.fromEntries(cols.map((c, i) => [c, cell(vals[i])])));
      }
      return rows;
    } finally {
      stmt.free();
    }
  };
  const one = (sql: string) => db.exec(sql)[0]?.values[0][0] ?? 0;
  // last_insert_rowid(), kept across snapshots: export() reopens the connection, which resets it to 0
  const rowid = () => {
    const v = Number(one("SELECT last_insert_rowid()"));
    if (!reopened) return v;
    if (v !== 0) {
      reopened = false; // an insert on the new connection
      return v;
    }
    return savedRowid;
  };
  // Statements that may change the database without changing total_changes() (DDL, PRAGMA, …): not a plain read.
  // (A save reopens the connection, so plain reads, PRAGMA reads included, don't ask for one.)
  const mayWrite = (sql: string) => {
    const s = sql.replace(/^(?:[\s;(]+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?(?:\*\/|$))*/, "");
    if (/^(?:select|values|explain)\b/i.test(s)) return false;
    if (/^with\b/i.test(s)) return /\b(?:insert|update|delete|replace)\b/i.test(s);
    if (/^pragma\b/i.test(s)) {
      // comments anywhere in it out (`PRAGMA main.user_version /* x */ = 7`), then name and what follows
      const p = /^pragma\s+(?:\w+\s*\.\s*)?(\w+)\s*([=(])?/i.exec(s.replace(/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, " "));
      if (!p) return true; // unsure: save
      const name = p[1]!.toLowerCase(); // the regex's (\w+) matched
      if (p[2] === "=") return true;
      if (p[2] === "(") return !READ_PRAGMAS_WITH_ARG.has(name); // user_version(7) sets it; table_info(t) reports
      return !READ_PRAGMAS.has(name);
    }
    return true;
  };
  // Same as server/bindings.ts batch: a savepoint, run synchronously (nothing else runs in between).
  // Same as server/bindings.ts notInBatch: a batch is one transaction, so no BEGIN/COMMIT/SAVEPOINT/…, PRAGMA, ATTACH or
  // DETACH in it (after comments and an EXPLAIN prefix).
  const notInBatch = (sql: string) =>
    /^(?:begin|commit|end|rollback|savepoint|release|pragma|attach|detach)\b/i.test(sql.replace(/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, " ").replace(/^[\s;]+/, "").replace(/^explain\s+(?:query\s+plan\s+)?/i, ""));
  const batch = (statements: { sql: string; params?: Param[]; raw?: boolean }[]) => {
    if (!Array.isArray(statements)) throw new TypeError("batch takes an array of { sql, params }");
    statements.forEach((s, i) => {
      const { sql, params } = s ?? {};
      if (typeof sql !== "string") throw new TypeError(`batch statement ${i + 1}: sql required`);
      if (params !== undefined && !Array.isArray(params)) throw new TypeError(`batch statement ${i + 1}: params must be an array`);
      if (notInBatch(sql)) throw new TypeError(`batch statement ${i + 1}: transaction control, PRAGMA, ATTACH and DETACH aren't allowed in a batch (it is one transaction; the others aren't rolled back with it)`);
    });
    const changesBefore = one("SELECT total_changes()");
    db.exec("SAVEPOINT cresslet_batch");
    try {
      const out = statements.map(({ sql, params = [], raw }, i) => {
        try {
          const before = one("SELECT total_changes()");
          const rows = all(sql, params, Infinity, raw === true);
          const changed = one("SELECT total_changes()") !== before;
          return { rows, changes: changed ? db.getRowsModified() : 0, lastInsertRowid: rowid() };
        } catch (e) {
          throw new Error(`batch statement ${i + 1}: ${(e as { message?: string } | null)?.message ?? e}`);
        }
      });
      db.exec("RELEASE cresslet_batch");
      return out;
    } catch (e) {
      try {
        db.exec("ROLLBACK TO cresslet_batch; RELEASE cresslet_batch");
      } catch { /* SQLite already rolled back: report the statement's error */ }
      throw e;
    } finally {
      // a read-only batch doesn't ask for a save (one reopens the connection)
      if (one("SELECT total_changes()") !== changesBefore || statements.some((st) => mayWrite(st.sql))) persist();
    }
  };
  db.exec("PRAGMA foreign_keys = ON;");
  // query/first can write too (INSERT … RETURNING): save when they changed anything
  const reading = (sql: string, params: Param[], max?: number, raw = false) => {
    const before = one("SELECT total_changes()");
    try {
      return all(sql, params, max, raw);
    } finally {
      // a statement that failed part-way may still have written (INSERT OR FAIL … RETURNING)
      if (one("SELECT total_changes()") !== before || mayWrite(sql)) persist();
    }
  };
  // The studio's Database view: each statement of a script in turn, on this same connection (so the app sees the
  // change at once), saved before the result goes back. Its result: the last statement with columns, its first
  // SQL_MAX_ROWS rows (a write still runs to its end, so its error isn't cut off with its rows). A statement that
  // fails stops the script: those before it stay done, as in sqlite3, unless they opened a transaction (rolled back
  // then: one left open would hold every later save).
  let viewTransaction = false; // a view script left a transaction open (until one ends with none)
  // Whether a statement writes to a table: its program opens one for writing (a recursive CTE's queue is an
  // ephemeral table, opened otherwise). Not sure (it won't EXPLAIN): no.
  const writesTables = (sql: string) => {
    try {
      return db.exec(`EXPLAIN ${sql}`)[0]?.values.some((op) => op[1] === "OpenWrite" || op[1] === "VUpdate") ?? false;
    } catch {
      return false;
    }
  };
  const studio = (sql: string): SqlResult => {
    const changesBefore = one("SELECT total_changes()");
    const openBefore = inTransaction();
    // The app's own (exec("BEGIN") across awaits, a request mid-way): the script would join it, and its ROLLBACK
    // would undo the script's writes too.
    if (openBefore && !viewTransaction) throw new Error("the app has a transaction open (a request is mid-way): try again in a moment");
    let out: Pick<SqlResult, "columns" | "rows" | "truncated"> = { columns: [], rows: [], truncated: false };
    let statements = 0, written = false, changes = 0;
    const cell = (v: SqlValue): SqlCell =>
      v instanceof Uint8Array ? { blob: v.byteLength }
        : typeof v === "bigint" ? (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER) ? String(v) : Number(v))
        : v;
    try {
      // (A statement that fails as it runs leaves the iterator's copy of the script in the wasm heap: sql.js's
      // finalize() isn't exported. Bytes per failed run, and the worker is replaced on every server change.)
      for (const stmt of db.iterateStatements(sql)) {
        try {
          statements++;
          written ||= mayWrite(stmt.getSQL());
          const columns = stmt.getColumnNames();
          const rows: SqlCell[][] = [];
          let truncated = false;
          while (stmt.step()) {
            if (rows.length < SQL_MAX_ROWS) rows.push(stmt.get(null, { useBigInt: true }).map(cell));
            else if (!truncated) {
              truncated = true;
              // A read stops there (an endless one too); a write … RETURNING runs to its end, where its errors (a
              // deferred foreign key) are.
              if (!writesTables(stmt.getSQL())) break;
            }
          }
          if (columns.length) out = { columns, rows, truncated };
        } finally {
          stmt.free(); // (the iterator frees it too, on to the next: a no-op then)
        }
      }
    } catch (e) {
      const msg = (e as { message?: string } | null)?.message ?? String(e);
      if (!openBefore && inTransaction()) {
        db.exec("ROLLBACK");
        throw new Error(`${msg} (the transaction the script began was rolled back)`);
      }
      if (viewTransaction && inTransaction()) throw new Error(`${msg} (a transaction is still open: nothing is saved until COMMIT or ROLLBACK)`);
      throw e;
    } finally {
      viewTransaction = inTransaction(); // (one open before was the view's: above)
      changes = Number(one("SELECT total_changes()")) - Number(changesBefore); // before a save (it reopens: total 0)
      if (changes || written) persist(true);
    }
    return { ...out, changes, statements, transaction: viewTransaction };
  };
  const binding = {
    batch: async (statements: { sql: string; params?: Param[]; raw?: boolean }[]) => batch(statements),
    query: async (sql: string, ...params: Param[]) => reading(sql, params),
    raw: async (sql: string, ...params: Param[]) => reading(sql, params, Infinity, true),
    first: async (sql: string, ...params: Param[]) => reading(sql, params, 1)[0] ?? null,
    // persist in finally: a statement (or script) that failed part-way may still have written
    run: async (sql: string, ...params: Param[]) => {
      try {
        db.run(sql, norm(params));
        return { changes: db.getRowsModified(), lastInsertRowid: rowid() };
      } finally {
        persist();
      }
    },
    exec: async (sql: string) => {
      try {
        db.exec(sql);
      } finally {
        persist();
      }
    },
  };
  return { binding, studio };
}

onmessage = async ({ data: m, ports }: MessageEvent<ToWorker>) => {
  if (m.type === "files-result") {
    const p = pending.get(m.id);
    pending.delete(m.id);
    return m.error ? p?.reject(new Error(m.error)) : p?.resolve(m);
  }
  if (m.type === "init") {
    try {
      const SQL = await initSqlJs({ locateFile: () => SQL_WASM });
      const database = createDb(SQL, m.db);
      studioSql = database.studio;
      env = {
        db: database.binding,
        files: {
          async put(key, body, opts = {}) {
            const bytes = new Uint8Array(await new Response(body).arrayBuffer());
            // `||`: not a Blob (or an untyped one) is octet-stream, as on the platform (runtime/worker.ts), not `false`
            const contentType = (opts.contentType ?? (body instanceof Blob && body.type)) || "application/octet-stream";
            await files({ op: "put", key, bytes, contentType }, [bytes.buffer]);
          },
          async get(key) {
            const r = await files({ op: "get", key });
            if (!r.found) return null;
            return new Response(r.bytes, { headers: { "content-type": r.contentType, "content-length": String(r.bytes.byteLength) } });
          },
          async delete(key) {
            await files({ op: "delete", key });
          },
          async list(prefix = "") {
            return (await files({ op: "list", prefix })).items;
          },
        },
        secrets: Object.freeze({ ...m.secrets }),
        app: Object.freeze(m.app),
      };
      const url = URL.createObjectURL(new Blob([m.code], { type: "text/javascript" }));
      let mod: { default?: unknown; fetch?: unknown };
      try {
        mod = await import(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const exp = (mod.default ?? mod) as Handler | { fetch?: Handler } | null | undefined; // the app's exports
      handler = typeof exp === "function" ? exp : exp?.fetch?.bind(exp);
      if (!handler) throw new Error("server/index must `export default { fetch(req, env) {} }`");
      runtime.env = env; // after the module's top level and reading its exports, as on the platform
      if (m.serial) serial = Promise.resolve();
      postMessage({ type: "ready" });
    } catch (e) {
      postMessage({ type: "fatal", message: (e as { stack?: string } | null)?.stack ?? String(e) });
    }
    return;
  }
  if (m.type === "sql") {
    // Synchronous: no request's code runs in between (a request awaiting something sees the change after).
    const posted = snapshotsPosted;
    try {
      if (!studioSql) throw new Error("the server isn't ready");
      const result = studioSql(String(m.sql));
      postMessage({ type: "sql-result", id: m.id, snapshot: snapshotsPosted !== posted, result });
    } catch (e) {
      postMessage({ type: "sql-result", id: m.id, snapshot: snapshotsPosted !== posted, error: (e as { message?: string } | null)?.message ?? String(e) });
    }
    return;
  }
  if (m.type === "socket") {
    const client = accepted.get(m.id);
    accepted.delete(m.id);
    if (!client) return ports[0]?.postMessage({ type: "close", code: 1011, reason: "" });
    if (ports[0]) connect(client, ports[0]);
    else client.close(1001, ""); // the preview gave up: the app's end hears it's gone
    return;
  }
  if (m.type === "request") {
    if (serial) {
      const turn = serial.then(() => handle(m));
      serial = turn.catch(() => {});
      return turn;
    }
    return handle(m);
  }
};

async function handle(m: Extract<ToWorker, { type: "request" }>) {
  try {
    const req = new Request(m.url, {
      method: m.method,
      headers: m.headers,
      body: m.body && m.method !== "GET" && m.method !== "HEAD" ? m.body : undefined,
    });
    const upgrade = new Headers(m.headers).get("upgrade")?.toLowerCase() === "websocket";
    // `Request` drops Upgrade, Connection, Sec-WebSocket-*, Origin, Cookie (which apps' sessions, CSRF and WebSocket
    // checks read).
    const shadow = (r: Request, headers: HeadersInit): Request => {
      const clone = r.clone.bind(r);
      return Object.defineProperties(r, {
        headers: { value: new Headers(headers) },
        clone: { value: () => shadow(clone(), r.headers) }, // with any edits made since
      });
    };
    if (m.headers.some(([k]) => !req.headers.has(k))) shadow(req, m.headers); // e.g. Origin, Cookie: dropped
    const res = await handler!(req, env, { waitUntil() {} }); // requests come after init (which sets it)
    if (!(res instanceof NativeResponse)) throw new Error("fetch handler must return a Response");
    if (res.status === 101) {
      const webSocket = (res as Response & { webSocket?: unknown }).webSocket; // our Response's, for a 101
      if (!upgrade || !(webSocket instanceof PairSocket)) {
        throw new Error("a 101 response needs `webSocket` (a WebSocketPair end) and a WebSocket upgrade request");
      }
      accepted.set(m.id, webSocket);
      const protocol = res.headers.get("sec-websocket-protocol") ?? undefined;
      postMessage({ type: "response", id: m.id, status: 101, headers: [...res.headers], body: null, protocol });
      return;
    }
    const body = await res.arrayBuffer();
    postMessage({ type: "response", id: m.id, status: res.status, headers: [...res.headers], body }, [body]);
  } catch (e) {
    console.error(e);
    const body = new TextEncoder().encode(`Internal Server Error\n\n${(e as { stack?: string } | null)?.stack ?? e}`).buffer;
    postMessage({ type: "response", id: m.id, status: 500, headers: [["content-type", "text/plain"]], body }, [body]);
  }
}
