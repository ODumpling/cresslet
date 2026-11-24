// Live Link v2, the Studio's side (#153): this browser's installation identity and the projects paused with
// Disconnect (IndexedDB, a database of their own: not the projects' snapshots), and the owning tab's *presence*: a
// socket to /v1/workspace/relay (session cookie + the installation's secret) that remembered agents bind to and send
// their tool calls through, one at a time. Reconnects with jittered backoff (1 s → 30 s) and stops on terminal errors.
// No DOM beyond IndexedDB and WebSocket (passed in under Node: tests/live_link_studio_test.ts).
import type { createBridgeDispatcher, SocketLike } from "./mcp-bridge.ts";

/** This browser profile's identity to the relay: the id appears in project handles, the secret never leaves it. */
export interface Install {
  id: string;
  secret: string;
}

const DB = "cresslet-live-link";

function openDb(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("install");
      req.result.createObjectStore("pauses");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
let dbp: Promise<IDBDatabase> | undefined;
const db = (idb?: IDBFactory) => idb ? openDb(idb) : (dbp ??= openDb(indexedDB));

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** Runs `fn` in one transaction on `store`; resolves to what it set in `out` once that commits. */
async function tx<T>(store: "install" | "pauses", mode: IDBTransactionMode, fn: (s: IDBObjectStore, done: (v: T) => void) => void, idb?: IDBFactory): Promise<T> {
  const d = await db(idb);
  return new Promise<T>((resolve, reject) => {
    const t = d.transaction(store, mode);
    let out: T;
    fn(t.objectStore(store), (v) => (out = v));
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new DOMException("transaction aborted", "AbortError"));
  });
}

/**
 * This browser's installation, made on first use: read and (if missing) written in one read-write transaction, so
 * tabs opening together end up with the same one (IndexedDB runs overlapping read-write transactions one at a time).
 */
export function installIdentity(idb?: IDBFactory): Promise<Install> {
  return tx<Install>("install", "readwrite", (s, done) => {
    const r: IDBRequest<Install | undefined> = s.get("self");
    r.onsuccess = () => {
      if (r.result?.id && r.result.secret) return done(r.result);
      const made = { id: b64url(random(12)), secret: b64url(random(32)) };
      s.put(made, "self");
      done(made);
    };
  }, idb);
}

/** Projects paused with Disconnect, this browser's record (the server keeps its own: paused if either says so). */
export const pauses = {
  get: (projectId: string, idb?: IDBFactory) => tx<boolean>("pauses", "readonly", (s, done) => {
    const r = s.get(projectId);
    r.onsuccess = () => done(!!r.result);
  }, idb),
  set: (projectId: string, paused: boolean, idb?: IDBFactory) => tx<void>("pauses", "readwrite", (s, done) => {
    if (paused) s.put(Date.now(), projectId);
    else s.delete(projectId);
    done();
  }, idb),
};

export interface PresenceAgent {
  agent: string;
  credentialId: string;
  instanceId: string;
}

export interface PresenceState {
  /** online: the relay knows this tab owns the project; offline: reconnecting; stopped: won't (logged out, replaced). */
  phase: "connecting" | "online" | "offline" | "stopped";
  paused: boolean;
  /** The remembered agent driving this project now. */
  binding: PresenceAgent | null;
  /** Agents refused because another one is bound: Take over. */
  waiting: { agent: string; instanceId: string }[];
  /** Agents asking to switch to this project: Use with <agent>. */
  switches: { id: string; agent: string; credentialId: string; from: string | null }[];
  error?: string;
}

export interface PresenceOptions {
  wsUrl: string;
  install: Install;
  projectId: string;
  projectName: string;
  app?: string | null;
  /** Paused (Disconnect) as this browser recorded it: loaded before the socket opens. */
  paused: boolean;
  /** The tab's own driver (built-in builder, a code-paired agent): agents can't bind meanwhile. */
  occupiedBy?: string | null;
  dispatcher: ReturnType<typeof createBridgeDispatcher>;
  onState: (state: PresenceState) => void;
  onNotice?: (text: string) => void;
  createSocket?: (url: string) => SocketLike;
  /** Backoff's jitter (tests pass a fixed one). */
  random?: () => number;
  minDelayMs?: number;
  maxDelayMs?: number;
}

/** Errors the relay won't change its mind about: stop reconnecting. */
const TERMINAL = new Set(["unauthorized", "forbidden", "replaced", "bad_frame"]);

/** The backoff before reconnect attempt `n` (0-based): 1 s doubling to 30 s, each between half and all of that. */
export const backoff = (n: number, rand = Math.random, min = 1000, max = 30_000) => Math.min(max, min * 2 ** n) * (0.5 + rand() / 2);

export function connectPresence({
  wsUrl, install, projectId, projectName, app = null, paused: pausedAtStart, occupiedBy = null, dispatcher, onState,
  onNotice = () => {}, createSocket = (url) => new WebSocket(url) as unknown as SocketLike, random: rand = Math.random,
  minDelayMs = 1000, maxDelayMs = 30_000,
}: PresenceOptions) {
  let ws: SocketLike | null = null;
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let name = projectName, appName = app, occupied = occupiedBy;
  /** Paused here: true from Disconnect's first write until Resume's last. No call runs meanwhile. */
  let paused = pausedAtStart;
  let state: PresenceState = { phase: "connecting", paused, binding: null, waiting: [], switches: [] };
  const calls = new Set<string>(); // this presence's calls the dispatcher has
  const waiters = new Map<string, (msg: Record<string, unknown>) => void>(); // "paused", "resumed", "granted:<id>"…

  const emit = (next: Partial<PresenceState>) => {
    state = { ...state, ...next, paused: next.paused ?? paused };
    onState(state);
  };
  const send = (msg: Record<string, unknown>) => {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ v: 1, ...msg }));
    return true;
  };
  const cancelCalls = () => {
    for (const id of calls) dispatcher.cancel(id);
    calls.clear();
  };
  /** Sends `msg` and resolves with the relay's `ack` frame (rejects offline, or after 10 s). */
  const ask = (msg: Record<string, unknown>, ack: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    if (!send(msg)) return reject(new Error("Not connected to the Cresslet server: try again in a moment."));
    const t = setTimeout(() => {
      waiters.delete(ack);
      reject(new Error("The Cresslet server didn't answer: try again."));
    }, 10_000);
    waiters.set(ack, (m) => {
      clearTimeout(t);
      resolve(m);
    });
  });

  function connect() {
    if (stopped) return;
    let lastError: { code?: string; message?: string } | undefined;
    const sock = createSocket(wsUrl);
    ws = sock;
    sock.addEventListener("open", () => {
      if (ws !== sock) return;
      send({ type: "hello", role: "presence", install, projectId, projectName: name, app: appName, paused, occupiedBy: occupied });
    });
    sock.addEventListener("message", (ev) => {
      if (ws !== sock || typeof ev.data !== "string") return;
      let msg: Record<string, unknown>;
      try {
        const parsed = JSON.parse(ev.data);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
        msg = parsed as Record<string, unknown>;
      } catch {
        return;
      }
      switch (msg.type) {
        case "presence_ok":
          attempt = 0;
          // Paused on the server (another reload's Disconnect): paused here too, until Resume.
          if (msg.paused === true) paused = true;
          return emit({ phase: "online", error: undefined });
        case "state": {
          const binding = msg.binding && typeof msg.binding === "object" ? msg.binding as PresenceAgent : null;
          if (msg.paused === true) paused = true;
          return emit({
            binding,
            waiting: Array.isArray(msg.waiting) ? msg.waiting as PresenceState["waiting"] : [],
            switches: Array.isArray(msg.switches) ? msg.switches as PresenceState["switches"] : [],
          });
        }
        case "tool_call": {
          const id = typeof msg.id === "string" ? msg.id : "", tool = typeof msg.name === "string" ? msg.name : "";
          if (!id || !tool) return;
          if (paused || occupied) {
            send({ type: "tool_result", id, error: true, text: paused ? "Disconnected in Cresslet Studio: not run." : `The project is in use by ${occupied}: not run.` });
            return;
          }
          calls.add(id);
          void dispatcher.call(id, tool, msg.arguments ?? {}).then((reply) => {
            calls.delete(id);
            if (ws === sock) send({ type: "tool_result", ...reply });
          });
          return;
        }
        case "tool_cancel":
          if (typeof msg.id === "string" && calls.has(msg.id)) dispatcher.cancel(msg.id);
          return;
        case "notice":
          if (typeof msg.text === "string") onNotice(msg.text);
          return;
        case "paused":
        case "resumed":
          waiters.get(msg.type)?.(msg);
          waiters.delete(msg.type);
          return;
        case "granted":
        case "forgotten": {
          const key = `${msg.type}:${String(msg.credentialId)}`;
          waiters.get(key)?.(msg);
          waiters.delete(key);
          return;
        }
        case "error":
          lastError = { code: typeof msg.code === "string" ? msg.code : undefined, message: typeof msg.message === "string" ? msg.message : undefined };
          for (const [k, w] of [...waiters]) if (k.startsWith("granted:") || k.startsWith("forgotten:")) {
            waiters.delete(k);
            w({ ok: false, error: lastError.message });
          }
          return;
      }
    });
    sock.addEventListener("error", () => {
      lastError ??= { message: "Couldn't reach the Cresslet server." };
    });
    sock.addEventListener("close", () => {
      if (ws !== sock) return;
      ws = null;
      cancelCalls();
      for (const w of waiters.values()) w({ ok: false, error: "disconnected" });
      waiters.clear();
      if (stopped || (lastError?.code && TERMINAL.has(lastError.code))) {
        stopped = true;
        return emit({ phase: "stopped", binding: null, waiting: [], switches: [], error: lastError?.message });
      }
      emit({ phase: "offline", binding: null, waiting: [], switches: [], error: lastError?.message });
      timer = setTimeout(connect, backoff(attempt++, rand, minDelayMs, maxDelayMs));
    });
  }
  connect();

  return {
    get state() {
      return state;
    },
    /**
     * Disconnect (the caller has written this browser's record first): local execution stops at once, then the
     * server records the pause, ends the binding and fences calls made before it. Offline, the next hello carries it.
     */
    async pause() {
      paused = true;
      dispatcher.cancelAll("Disconnected in Cresslet Studio.");
      calls.clear();
      emit({ binding: null });
      if (ws?.readyState === 1) await ask({ type: "pause" }, "paused");
    },
    /** Resume: the server first (acked), then `clearLocal` (this browser's record); calls run again only after both. */
    async resume(clearLocal: () => Promise<void>) {
      await ask({ type: "resume" }, "resumed");
      await clearLocal();
      paused = false;
      emit({});
    },
    /** Connect agent → Allow, for a remembered agent of this browser: this project is approved for it. */
    async grant(credentialId: string) {
      const r = await ask({ type: "grant", credentialId }, `granted:${credentialId}`);
      if (r.ok === false) throw new Error(String(r.error ?? "Couldn't approve that agent."));
    },
    /** Forget agent: its credential is revoked (sockets closed, calls cancelled). */
    async forget(credentialId: string) {
      const r = await ask({ type: "forget", credentialId }, `forgotten:${credentialId}`);
      return r.ok === true;
    },
    acceptSwitch: (id: string) => void send({ type: "switch_accept", id }),
    declineSwitch: (id: string) => void send({ type: "switch_decline", id }),
    takeOver: (instanceId: string) => void send({ type: "take_over", instanceId }),
    /** The built-in builder (or a code-paired agent) is driving the project, or not (null). */
    setOccupied(by: string | null) {
      if (by === occupied) return;
      occupied = by;
      send({ type: "occupied", by });
    },
    rename(projectName: string, app: string | null = appName) {
      name = projectName;
      appName = app;
      send({ type: "rename", projectName, app: app ?? "" });
    },
    /** Logged out, the tab left the project, or lost its lock: no more presence. */
    close() {
      stopped = true;
      clearTimeout(timer);
      cancelCalls();
      const s = ws;
      ws = null;
      try {
        s?.close(1000, "closed");
      } catch { /* already closed */ }
      emit({ phase: "stopped", binding: null, waiting: [], switches: [] });
    },
  };
}

export type Presence = ReturnType<typeof connectPresence>;
