// Runs an app's server bundle in the browser with the Cresslet Env API.
// Protocol (postMessage):
//   in:  {type:"init", code, app, secrets, db: Uint8Array|null}  → out: {type:"ready"} | {type:"fatal", message}
//   in:  {type:"request", id, url, method, headers, body}        → out: {type:"response", id, status, headers, body}
//   out: {type:"log", level, msg}  {type:"db", bytes}  {type:"files", id, op, ...} ← in: {type:"files-result", id, ...}
import initSqlJs from "https://esm.sh/sql.js@1.13.0";

const SQL_WASM = "https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/sql-wasm.wasm";
let handler;
let env;

const fmt = (args) =>
  args.map((a) => (typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : safeJson(a))).join(" ");
const safeJson = (v) => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};
for (const level of ["log", "info", "warn", "error", "debug"]) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    postMessage({ type: "log", level, msg: fmt(args) });
    orig(...args);
  };
}

// ---- files RPC to the main thread (stored in the VFS)
let rpcId = 0;
const pending = new Map();
function files(op, payload, transfer = []) {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    postMessage({ type: "files", id, op, ...payload }, transfer);
  });
}

function createDb(SQL, bytes) {
  const db = bytes ? new SQL.Database(bytes) : new SQL.Database();
  let timer;
  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const out = db.export();
      postMessage({ type: "db", bytes: out }, [out.buffer]);
    }, 300);
  };
  const norm = (params) => params.map((p) => (typeof p === "bigint" ? Number(p) : p === undefined ? null : p));
  const all = (sql, params) => {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(norm(params));
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  };
  db.exec("PRAGMA foreign_keys = ON;");
  return {
    query: async (sql, ...params) => all(sql, params),
    first: async (sql, ...params) => all(sql, params)[0] ?? null,
    run: async (sql, ...params) => {
      db.run(sql, norm(params));
      const changes = db.getRowsModified();
      const lastInsertRowid = Number(db.exec("SELECT last_insert_rowid()")[0]?.values[0][0] ?? 0);
      persist();
      return { changes, lastInsertRowid };
    },
    exec: async (sql) => {
      db.exec(sql);
      persist();
    },
  };
}

onmessage = async ({ data: m }) => {
  if (m.type === "files-result") {
    const p = pending.get(m.id);
    pending.delete(m.id);
    return m.error ? p?.reject(new Error(m.error)) : p?.resolve(m);
  }
  if (m.type === "init") {
    try {
      const SQL = await initSqlJs({ locateFile: () => SQL_WASM });
      env = {
        db: createDb(SQL, m.db),
        files: {
          async put(key, body, opts = {}) {
            const bytes = new Uint8Array(await new Response(body).arrayBuffer());
            const contentType = opts.contentType ?? (body instanceof Blob && body.type) ?? "application/octet-stream";
            await files("put", { key, bytes, contentType }, [bytes.buffer]);
          },
          async get(key) {
            const r = await files("get", { key });
            if (!r.found) return null;
            return new Response(r.bytes, { headers: { "content-type": r.contentType, "content-length": String(r.bytes.byteLength) } });
          },
          async delete(key) {
            await files("delete", { key });
          },
          async list(prefix = "") {
            return (await files("list", { prefix })).items;
          },
        },
        secrets: Object.freeze({ ...m.secrets }),
        app: Object.freeze(m.app),
      };
      const url = URL.createObjectURL(new Blob([m.code], { type: "text/javascript" }));
      const mod = await import(url);
      URL.revokeObjectURL(url);
      const exp = mod.default ?? mod;
      handler = typeof exp === "function" ? exp : exp?.fetch?.bind(exp);
      if (!handler) throw new Error("server/index must `export default { fetch(req, env) {} }`");
      postMessage({ type: "ready" });
    } catch (e) {
      postMessage({ type: "fatal", message: e?.stack ?? String(e) });
    }
    return;
  }
  if (m.type === "request") {
    try {
      const req = new Request(m.url, {
        method: m.method,
        headers: m.headers,
        body: m.body && m.method !== "GET" && m.method !== "HEAD" ? m.body : undefined,
      });
      const res = await handler(req, env, { waitUntil() {} });
      if (!(res instanceof Response)) throw new Error("fetch handler must return a Response");
      const body = await res.arrayBuffer();
      postMessage({ type: "response", id: m.id, status: res.status, headers: [...res.headers], body }, [body]);
    } catch (e) {
      console.error(e);
      const body = new TextEncoder().encode(`Internal Server Error\n\n${e?.stack ?? e}`).buffer;
      postMessage({ type: "response", id: m.id, status: 500, headers: [["content-type", "text/plain"]], body }, [body]);
    }
  }
};
