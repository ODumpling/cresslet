// Runs an app's server bundle in the browser with the Cresslet Env API.
// Protocol (postMessage):
//   in:  {type:"init", code, app, secrets, db: Uint8Array|null}  → out: {type:"ready"} | {type:"fatal", message}
//   in:  {type:"request", id, url, method, headers, body}        → out: {type:"response", id, status, headers, body}
//   out: {type:"log", level, msg}  {type:"db", bytes}  {type:"files", id, op, ...} ← in: {type:"files-result", id, ...}
//   WebSockets: a 101 response is {type:"response", id, status: 101, headers, body: null, protocol}; then
//   in:  {type:"socket", id} + the preview socket's MessagePort (no port: the preview gave up)
//   in:  {type:"stop"} → out: {type:"stopped"}  (before terminating: `close` sent on every socket)
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
// (their Response rejects 101). The pair's client end is glued to the preview socket's MessagePort
// (cresslet-container's upgradeWebSocket): {type:"message", data: string|ArrayBuffer} and {type:"close", code, reason}.
class PairSocket extends EventTarget {
  peer = null;
  readyState = 1; // OPEN
  #accepted = false;
  #queue = [];
  accept() {
    if (this.#accepted) return;
    this.#accepted = true;
    for (const e of this.#queue.splice(0)) this.dispatchEvent(e);
  }
  deliver(e) {
    if (this.#accepted) this.dispatchEvent(e);
    else this.#queue.push(e);
  }
  send(data) {
    if (this.readyState !== 1) throw new TypeError("Can't call WebSocket send() after close().");
    if (data instanceof ArrayBuffer) data = data.slice(0);
    else if (ArrayBuffer.isView(data)) data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    else if (typeof data !== "string") throw new TypeError("WebSocket send() takes a string, ArrayBuffer or ArrayBufferView");
    this.peer.deliver(new MessageEvent("message", { data }));
  }
  close(code, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = this.peer.readyState = 3; // CLOSED
    this.peer.deliver(new CloseEvent("close", { code: code ?? 1005, reason: String(reason), wasClean: true }));
  }
}
globalThis.WebSocketPair = class WebSocketPair {
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
globalThis.Response = class Response extends NativeResponse {
  constructor(body, init) {
    if (init?.status !== 101) return super(body, init);
    super(null, { ...init, status: 200 });
    Object.defineProperty(this, "status", { value: 101 });
    this.webSocket = init.webSocket;
  }
};
const accepted = new Map(); // request id → the pair's client end, until its port arrives
const open = new Set(); // ports of connected sockets

function connect(client, port) {
  open.add(port);
  const done = () => (open.delete(port), port.close());
  client.addEventListener("message", (e) => port.postMessage({ type: "message", data: e.data }));
  client.addEventListener("close", (e) => (port.postMessage({ type: "close", code: e.code, reason: e.reason }), done()));
  port.onmessage = ({ data: d }) => {
    // From the preview (untrusted, like its requests).
    if (d?.type === "message" && (typeof d.data === "string" || d.data instanceof ArrayBuffer)) {
      if (client.readyState === 1) client.send(d.data);
    } else if (d?.type === "close") {
      if (client.readyState === 1) client.peer.readyState = client.readyState = 3;
      client.peer.deliver(new CloseEvent("close", { code: Number.isInteger(d.code) ? d.code : 1005, reason: String(d.reason ?? ""), wasClean: true }));
      done();
    }
  };
  client.accept();
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

onmessage = async ({ data: m, ports }) => {
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
  if (m.type === "socket") {
    const client = accepted.get(m.id);
    accepted.delete(m.id);
    if (!client) return ports[0]?.postMessage({ type: "close", code: 1011, reason: "" });
    if (ports[0]) connect(client, ports[0]);
    else client.close(1001, ""); // the preview gave up: the app's end hears it's gone
    return;
  }
  if (m.type === "stop") {
    // As a redeploy does: clients see the server go away and can reconnect.
    for (const port of open) port.postMessage({ type: "close", code: 1012, reason: "server restarting" }), port.close();
    open.clear();
    postMessage({ type: "stopped" });
    return;
  }
  if (m.type === "request") {
    try {
      const req = new Request(m.url, {
        method: m.method,
        headers: m.headers,
        body: m.body && m.method !== "GET" && m.method !== "HEAD" ? m.body : undefined,
      });
      const upgrade = new Headers(m.headers).get("upgrade")?.toLowerCase() === "websocket";
      // `Request` drops Upgrade, Connection, Sec-WebSocket-*, Origin.
      if (upgrade) Object.defineProperty(req, "headers", { value: new Headers(m.headers) });
      const res = await handler(req, env, { waitUntil() {} });
      if (!(res instanceof NativeResponse)) throw new Error("fetch handler must return a Response");
      if (res.status === 101) {
        if (!upgrade || !(res.webSocket instanceof PairSocket)) {
          throw new Error("a 101 response needs `webSocket` (a WebSocketPair end) and a WebSocket upgrade request");
        }
        accepted.set(m.id, res.webSocket);
        const protocol = res.headers.get("sec-websocket-protocol") ?? undefined;
        postMessage({ type: "response", id: m.id, status: 101, headers: [...res.headers], body: null, protocol });
        return;
      }
      const body = await res.arrayBuffer();
      postMessage({ type: "response", id: m.id, status: res.status, headers: [...res.headers], body }, [body]);
    } catch (e) {
      console.error(e);
      const body = new TextEncoder().encode(`Internal Server Error\n\n${e?.stack ?? e}`).buffer;
      postMessage({ type: "response", id: m.id, status: 500, headers: [["content-type", "text/plain"]], body }, [body]);
    }
  }
};
