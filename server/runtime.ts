// Process manager: one workerd sandbox process per app with a server, spawned on demand,
// reaped when idle. Proxies requests over a unix socket. The sandbox reaches its db/files
// through a per-app bindings socket served from a worker thread (server/bindings.ts).
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { type IncomingMessage, request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";
import { join } from "node:path";
import { finished, Readable } from "node:stream";
import { Client } from "undici";
import { type Config, paths } from "./config.ts";
import type { Logs } from "./logs.ts";
import { Metrics } from "./metrics.ts";
import { CronRuns } from "./cron.ts";
import { serveBindings } from "./bindings.ts";
import { createEgressProxy } from "./egress.ts";
import { adoptListener, instanceId, jail, prepareHost, sweep } from "./sandbox.ts";
import { stripTypes } from "./strip.ts";

/** The sandbox entry (runtime/*.ts) as the JavaScript workerd runs (worker.js, cresslet-runtime.js): stripped once per process. */
const ENTRY = ["worker", "cresslet-runtime"];
const entryCode = new Map<string, string>();
async function entryJs(name: string): Promise<string> {
  let code = entryCode.get(name);
  if (code === undefined) {
    code = stripTypes(await readFile(join(import.meta.dirname, `../runtime/${name}.ts`), "utf8"));
    entryCode.set(name, code);
  }
  return code;
}
/** Pinned so a workerd upgrade doesn't silently change app semantics. */
const COMPAT_DATE = "2026-11-01";

export interface AppSpec {
  appId: string;
  /** Never-reused per-app number (store.uidSeq): uid = CRESSLET_SANDBOX_UID_BASE + seq. Only read with per-app uids. */
  seq: () => Promise<number>;
  appName: string;
  appUrl: string;
  deployId: string;
  /** Read at sandbox start; served over the HOST binding, never written to disk. */
  secrets: () => Promise<Record<string, string>>;
  net: boolean;
  /** Outbound allowlist (only with `net`); null = any public host. */
  egress: string[] | null;
}

interface Proc {
  spec: AppSpec;
  sockPath: string;
  child: ChildProcess;
  client: Client;
  bindings: { egress: Server | null; close(): void };
  /** Kills whatever is left in the sandbox's cgroup and removes it (synchronous kill). */
  release(): void;
  ready: Promise<void>;
  lastUsed: number;
  inflight: number;
  exited: boolean;
}

/** Every sandbox slot (CRESSLET_MAX_RUNNING_SANDBOXES) is taken by one that's serving: the caller answers 503. */
class SandboxesBusy extends Error {
  constructor() {
    super("all sandbox slots are busy");
  }
}

const busy = () => new Response("Server busy, try again shortly.", { status: 503, headers: { "retry-after": "5" } });
const BUSY_RAW = "HTTP/1.1 503 Service Unavailable\r\nretry-after: 5\r\nconnection: close\r\ncontent-length: 0\r\n\r\n";

const HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "expect"];
const NULL_BODY = new Set([101, 204, 205, 304]);

/** Cap'n Proto text string literal. */
function capStr(s: string): string {
  if (/[\0-\x1f]/.test(s)) throw new Error(`invalid path for sandbox config: ${s}`);
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function workerdConfig(
  spec: AppSpec,
  hostSock: string,
  egressSock: string | null,
  memoryMb: number,
  /** gVisor: workerd binds this path itself; otherwise its listener is fd 3. */
  listenSock: string | null,
) {
  const outbound = !spec.net
    ? `(name = "outbound", network = (allow = []))`
    : egressSock
    // Allowlist: every outbound request goes through the control plane's egress proxy (egress.ts).
    ? `(name = "outbound", external = (address = ${capStr("unix:" + egressSock)}, http = (style = proxy)))`
    // "public" excludes loopback/private ranges, so apps can't reach the control plane or LAN.
    : `(name = "outbound", network = (allow = ["public"], tlsOptions = (trustBrowserCas = true)))`;
  return `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "app", worker = (
      modules = [
        (name = "worker.js", esModule = embed "worker.js"),
        (name = "cresslet-runtime", esModule = embed "cresslet-runtime.js"),
        (name = "app", esModule = embed "app.js"),
      ],
      compatibilityDate = "${COMPAT_DATE}",
      bindings = [
        (name = "HOST", service = "host"),
        (name = "APP", json = embed "app.json"),
      ],
      globalOutbound = "outbound",
    )),
    (name = "host", external = (address = ${capStr("unix:" + hostSock)}, http = ())),
    ${outbound},
  ],
  # Listener created by the control plane, passed as fd 3 (--socket-fd http=3); gVisor: bound by workerd.
  sockets = [(name = "http", ${listenSock ? `address = ${capStr("unix:" + listenSock)}, ` : ""}http = (), service = "app")],
  v8Flags = ["--max-old-space-size=${memoryMb}"],
);
`;
}

const samePolicy = (a: AppSpec, b: AppSpec) => a.net === b.net && JSON.stringify(a.egress) === JSON.stringify(b.egress);

/**
 * Ready = the sandbox entry answers an internal probe (not just "socket accepts": the listener is ours
 * and queues connections before workerd runs). Fails while the app module can't load.
 */
const probe = (path: string) =>
  new Promise<boolean>((res) => {
    const r = httpRequest({ socketPath: path, path: "/", method: "HEAD", headers: { "x-cresslet-probe": "1" }, timeout: 2000, agent: false }, (resp) => {
      resp.resume();
      res(resp.statusCode === 204);
    });
    r.on("error", () => res(false)).on("timeout", () => r.destroy());
    r.end();
  });

export class Runtime {
  procs = new Map<string, Proc>();
  logs: Logs;
  /** Requests per app over the last 24h (host.ts records them). */
  metrics = new Metrics();
  cronRuns = new CronRuns();
  #cfg: Config;
  #starting = new Map<string, { spec: AppSpec; p: Promise<Proc> }>();
  #timer: ReturnType<typeof setInterval>;
  #instance: string;
  /** After close(): no new sandboxes (a cold start in flight must not spawn during shutdown). */
  #closed = false;
  /** Open (or handshaking) WebSockets: on the instance, and per app. */
  #wsTotal = 0;
  #ws = new Map<string, number>();

  constructor(cfg: Config, logs: Logs) {
    this.#cfg = cfg;
    this.logs = logs;
    prepareHost(cfg);
    this.#instance = instanceId(cfg.dataDir);
    mkdirSync(cfg.sockDir, { recursive: true });
    sweep(cfg, this.#instance);
    // Older versions kept run dirs (with plaintext secrets) under each app's data dir.
    const apps = join(cfg.dataDir, "apps");
    for (const app of existsSync(apps) ? readdirSync(apps, { withFileTypes: true }) : []) {
      if (app.isDirectory()) rmSync(join(apps, app.name, "run"), { recursive: true, force: true });
    }
    this.#timer = setInterval(() => this.reapIdle(), 15_000);
  }

  /** `internal`: a control-plane request (cron) that may carry x-cresslet-* headers. */
  async fetch(spec: AppSpec, req: Request, { internal = false } = {}): Promise<Response> {
    let proc: Proc;
    try {
      proc = await this.#get(spec);
    } catch (e) {
      if (e instanceof SandboxesBusy) return busy();
      this.logs.push(spec.appId, "system", `failed to start: ${(e as Error).message}`);
      return new Response("App failed to start. See `cresslet logs`.", { status: 502 });
    }
    let streaming = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      proc.inflight--;
      proc.lastUsed = Date.now();
    };
    let timeout: AbortSignal | undefined;
    try {
      timeout = AbortSignal.timeout(this.#cfg.limits.requestMs);
      const signal = AbortSignal.any([timeout, req.signal]);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        // Clients can't forge control-plane headers (x-cresslet-url, -probe, -scheduled, …).
        if (!HOP.includes(k) && (internal || !k.startsWith("x-cresslet-"))) headers[k] = v;
      });
      headers["x-cresslet-url"] = req.url;
      const u = new URL(req.url);
      const res = await proc.client.request({
        path: u.pathname + u.search,
        method: req.method as "GET",
        headers,
        body: req.body ? Readable.fromWeb(req.body as import("node:stream/web").ReadableStream) : null,
        signal,
      });
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined || HOP.includes(k)) continue;
        for (const x of Array.isArray(v) ? v : [v]) h.append(k, x);
      }
      if (NULL_BODY.has(res.statusCode) || req.method === "HEAD") {
        await res.body.dump();
        return new Response(null, { status: res.statusCode, headers: h });
      }
      // Still in flight until the body is done (ended, failed, cancelled or timed out), so it isn't evicted mid-response.
      const out = new Response(Readable.toWeb(res.body) as ReadableStream, { status: res.statusCode, headers: h });
      streaming = true;
      finished(res.body, release);
      return out;
    } catch (e) {
      if (timeout?.aborted) {
        // Likely a runaway handler; restart the sandbox.
        this.logs.push(spec.appId, "system", `request timed out after ${this.#cfg.limits.requestMs}ms; restarting`);
        this.stop(spec.appId);
        return new Response("Gateway Timeout", { status: 504 });
      }
      if (req.signal.aborted) return new Response(null, { status: 499 });
      this.logs.push(spec.appId, "system", `proxy error: ${(e as Error).message}`);
      return new Response("Bad Gateway", { status: 502 });
    } finally {
      if (!streaming) release();
    }
  }

  /**
   * WebSocket (HTTP upgrade): forward the handshake to the sandbox; only a 101 gets the two sockets
   * spliced. Any other answer is relayed once and the connection closed, so a client can't reuse it
   * to talk to the sandbox directly. Open sockets count as in-flight (the idle reaper keeps it up),
   * so they're capped (per app and per instance) and closed after wsIdleMs without traffic or wsMaxMs in all.
   */
  async upgrade(spec: AppSpec, req: IncomingMessage, client: Duplex, head: Buffer, url: string): Promise<number> {
    const lim = this.#cfg.limits;
    const appWs = this.#ws.get(spec.appId) ?? 0;
    if ((lim.maxWebSockets && this.#wsTotal >= lim.maxWebSockets) || (lim.maxWebSocketsPerApp && appWs >= lim.maxWebSocketsPerApp)) {
      client.end(BUSY_RAW);
      return 503;
    }
    // Counted from the handshake on, so a flood of slow handshakes is capped too.
    this.#wsTotal++;
    this.#ws.set(spec.appId, appWs + 1);
    let counted = true;
    const uncount = () => {
      if (!counted) return;
      counted = false;
      this.#wsTotal--;
      const n = (this.#ws.get(spec.appId) ?? 1) - 1;
      if (n > 0) this.#ws.set(spec.appId, n);
      else this.#ws.delete(spec.appId);
    };
    // A client gone during a cold start frees its slot right away. Upgraded sockets allow half-open,
    // so a FIN alone doesn't close it: destroy it then (nothing has been sent yet).
    const gone = () => client.destroy();
    client.once("close", uncount).once("end", gone);
    // The FIN may have come while the app was being looked up (an await on the database), before this listener.
    if (client.readableEnded) gone();
    let proc: Proc;
    try {
      proc = await this.#get(spec);
    } catch (e) {
      client.off("end", gone);
      uncount();
      if (e instanceof SandboxesBusy) {
        client.end(BUSY_RAW);
        return 503;
      }
      this.logs.push(spec.appId, "system", `failed to start: ${(e as Error).message}`);
      client.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      return 502;
    }
    client.off("end", gone);
    if (client.destroyed) {
      uncount();
      proc.inflight--;
      proc.lastUsed = Date.now();
      return 0;
    }
    const headers: string[] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      // Clients can't forge control-plane headers.
      if (!req.rawHeaders[i].toLowerCase().startsWith("x-cresslet-")) headers.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
    }
    headers.push("x-cresslet-url", url);
    const u = new URL(url);
    const started = Date.now();
    let done = false;
    let responded = false;
    let upstream: Duplex | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let maxAge: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(idle);
      clearTimeout(maxAge);
      uncount();
      proc.inflight--;
      proc.lastUsed = Date.now();
      client.destroy();
      upstream?.destroy();
      up.destroy();
    };
    const up = httpRequest({ socketPath: proc.sockPath, method: req.method, path: u.pathname + u.search, headers, setHost: false });
    client.on("error", close).on("close", close);
    return await new Promise<number>((resolve) => {
      timer = setTimeout(() => {
        // A handler that never answers the handshake (same limit as HTTP requests).
        if (!client.destroyed) client.end("HTTP/1.1 504 Gateway Timeout\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
        resolve(504);
        close();
      }, this.#cfg.limits.requestMs);
      timer.unref?.();
      up.on("upgrade", (res, socket, upHead) => {
        clearTimeout(timer);
        responded = true;
        upstream = socket;
        let raw = `HTTP/1.1 101 ${res.statusMessage ?? "Switching Protocols"}\r\n`;
        for (let i = 0; i < res.rawHeaders.length; i += 2) raw += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
        client.write(raw + "\r\n", "latin1");
        if (upHead.length) client.write(upHead);
        if (head.length) socket.write(head);
        socket.on("error", close).on("close", close);
        socket.pipe(client);
        client.pipe(socket);
        const expire = (why: string) => () => {
          if (done) return;
          this.logs.push(spec.appId, "system", `websocket ${u.pathname} closed: ${why}`);
          close();
        };
        if (lim.wsIdleMs) {
          const t = idle = setTimeout(expire(`no traffic for ${lim.wsIdleMs}ms`), lim.wsIdleMs);
          t.unref?.();
          // After pipe(): these listeners don't change the streams' flow (pipe already made them flowing).
          const bump = () => done || t.refresh();
          socket.on("data", bump);
          client.on("data", bump);
        }
        if (lim.wsMaxMs) {
          maxAge = setTimeout(expire(`open for ${lim.wsMaxMs}ms (the most allowed)`), lim.wsMaxMs);
          maxAge.unref?.();
        }
        resolve(101);
      });
      up.on("response", (res) => {
        clearTimeout(timer);
        responded = true;
        // Not a WebSocket: frees its slot now, and the body still has to finish within the request deadline.
        uncount();
        timer = setTimeout(close, Math.max(0, started + this.#cfg.limits.requestMs - Date.now()));
        timer.unref?.();
        let raw = `HTTP/1.1 ${res.statusCode} ${res.statusMessage ?? ""}\r\n`;
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          if (!/^(connection|keep-alive|transfer-encoding)$/i.test(res.rawHeaders[i])) raw += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
        }
        client.write(raw + "connection: close\r\n\r\n", "latin1");
        // pipe: backpressure, and end() only after the body is flushed; then tear down.
        res.pipe(client);
        client.once("finish", close);
        res.on("error", close);
        resolve(res.statusCode ?? 0);
      });
      up.on("error", () => {
        if (!client.destroyed && !responded) client.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
        resolve(502);
        close();
      });
      up.end();
    });
  }

  /** A running sandbox for `spec`, with this caller counted in-flight (it must decrement `inflight`). */
  async #get(spec: AppSpec): Promise<Proc> {
    const cur = this.procs.get(spec.appId);
    // Network policy is part of the identity: a sandbox started under an old policy (e.g. a cold
    // start racing a PUT /egress) is replaced on the next request.
    if (cur && !cur.exited && cur.spec.deployId === spec.deployId && samePolicy(cur.spec, spec)) {
      await cur.ready;
      // It may have been evicted (#makeRoom) or stopped while we waited: then start over.
      if (cur.exited || this.procs.get(spec.appId) !== cur) return this.#get(spec);
      // Counted before returning (synchronously with the check), so it can't be evicted once handed out.
      cur.inflight++;
      cur.lastUsed = Date.now();
      return cur;
    }
    if (cur) this.stop(spec.appId);
    const starting = this.#starting.get(spec.appId);
    if (starting) {
      // Re-check once it's up: it may have been started for another deploy or policy. A failed start
      // is shared by waiters that wanted the same sandbox (no serial retries of a crashing app).
      const ok = await starting.p.then(() => true, () => false);
      const same = starting.spec.deployId === spec.deployId && samePolicy(starting.spec, spec);
      if (!ok && same) return starting.p;
      return this.#get(spec);
    }
    this.#makeRoom();
    const p = this.#spawn(spec).finally(() => this.#starting.delete(spec.appId));
    this.#starting.set(spec.appId, { spec, p });
    return p;
  }

  /**
   * Before a new sandbox starts: at CRESSLET_MAX_RUNNING_SANDBOXES, stop the least recently used idle
   * one (nothing in flight, not starting). Throws SandboxesBusy if every slot is serving. Synchronous
   * with the #starting.set that follows, so two cold starts can't both take the last slot.
   */
  #makeRoom() {
    const max = this.#cfg.limits.maxRunningSandboxes;
    if (!max) return;
    const live = new Set([...this.procs.keys(), ...this.#starting.keys()]);
    while (live.size >= max) {
      let lru: [string, Proc] | undefined;
      for (const e of this.procs) {
        if (e[1].inflight === 0 && !this.#starting.has(e[0]) && (!lru || e[1].lastUsed < lru[1].lastUsed)) lru = e;
      }
      if (!lru) throw new SandboxesBusy();
      this.logs.push(lru[0], "system", `sandbox stopped while idle: ${max} running (CRESSLET_MAX_RUNNING_SANDBOXES), another app needed one`);
      this.stop(lru[0]);
      live.delete(lru[0]);
    }
  }

  async #spawn(spec: AppSpec): Promise<Proc> {
    const cfg = this.#cfg;
    const p = paths(cfg, spec.appId);
    await mkdir(p.data, { recursive: true });
    // Fresh dir per spawn: a dying predecessor's cleanup must not touch ours. It holds everything
    // the sandbox can see (config, code, sockets), and nothing under dataDir.
    const tag = `${this.#instance}-${spec.appId}-${randomBytes(3).toString("hex")}`; // see RUN_DIR_RE
    const run = join(cfg.sockDir, tag);
    await mkdir(run, { mode: 0o700 });
    // The control plane creates workerd's listening socket and hands it over as fd 3: nothing a
    // sandbox (or anyone else) could bind first, and the path we connect to sits in a dir it can't write.
    // Short names: unix socket paths are capped at ~104 bytes (macOS). a = app (workerd's listener),
    // h = host bindings, e = egress proxy, b = bind name (unlinked once workerd has the fd).
    const sock = join(run, "a.sock");
    const hostSock = join(run, "h.sock");
    // gVisor sandboxes have no network at all: their outbound always goes through the egress proxy.
    const gvisor = !!cfg.sandbox.runsc;
    const egressSock = spec.net && (spec.egress || gvisor) ? join(run, "e.sock") : null;

    // Everything acquired so far is undone by one path if the start fails before the child runs.
    let bindings: Awaited<ReturnType<typeof serveBindings>> | undefined;
    let egress: Server | null = null;
    let j: ReturnType<typeof jail> | undefined;
    let listener: NetServer | undefined;
    /** This spawn's proc once it exists; `lost`: its bindings thread died. */
    let self: Proc | undefined;
    let lost = false;
    const abort = () => {
      listener?.close();
      egress?.close();
      bindings?.close();
      j?.release();
      rmSync(run, { recursive: true, force: true });
    };
    let child: ChildProcess;
    try {
      // Bindings socket: the sandbox's only way to its data. One per app, so identity = socket. Served
      // from the app's own thread: its SQL can't stall the control plane. If that thread dies, so does the sandbox.
      bindings = await serveBindings(p.data, hostSock, {
        secrets: await spec.secrets(),
        maxDbBytes: cfg.limits.appDbBytes,
        maxFilesBytes: cfg.limits.appFilesBytes,
      }, () => {
        lost = true;
        this.logs.push(spec.appId, "system", "bindings thread crashed; sandbox stopped");
        if (self && this.procs.get(spec.appId) === self) this.stop(spec.appId);
      });
      if (egressSock) {
        const eg = egress = createEgressProxy(spec.egress, (l) => this.logs.push(spec.appId, "system", l));
        await new Promise<void>((res, rej) => eg.once("error", rej).listen(egressSock, res));
      }
      for (const name of ENTRY) await writeFile(join(run, `${name}.js`), await entryJs(name));
      await copyFile(join(p.deploy(spec.deployId), "server.js"), join(run, "app.js"));
      await writeFile(
        join(run, "app.json"),
        JSON.stringify({ id: spec.appId, name: spec.appName, url: spec.appUrl, deployId: spec.deployId }),
      );
      const listen = gvisor ? join(run, "l", "a.sock") : null;
      await writeFile(join(run, "config.capnp"), workerdConfig(spec, hostSock, egressSock, cfg.limits.memoryMb, listen));
      let fd: number | undefined;
      if (!gvisor) {
        const lst = listener = createNetServer();
        await new Promise<void>((res, rej) => lst.once("error", rej).listen(join(run, "b.sock"), res));
        // Closing our copy below unlinks b.sock (libuv); a.sock is a second name for the same socket.
        linkSync(join(run, "b.sock"), sock);
        fd = (lst as unknown as { _handle?: { fd?: number } })._handle?.fd;
        if (typeof fd !== "number" || fd < 0) throw new Error("can't get the listening socket's fd");
      }
      const seq = cfg.sandbox.uidBase === null ? 0 : await spec.seq();
      if (this.#closed) throw new Error("shutting down");
      j = jail(cfg, tag, () => seq, run);
      const cmd = j.command(cfg.workerdPath, ["serve", join(run, "config.capnp"), ...(gvisor ? [] : ["--socket-fd", "http=3"])]);
      child = spawn(cmd.file, cmd.args, { cwd: run, stdio: ["ignore", "pipe", "pipe", ...(fd === undefined ? [] : [fd])], env: { HOME: run } });
      listener?.close();
    } catch (e) {
      abort();
      throw e;
    }
    const jl = j;
    const egressServer = egress;
    const binds = bindings;
    let bindingsOpen = true;

    let fail!: (e: Error) => void;
    const failed = new Promise<never>((_, rej) => (fail = rej));
    failed.catch(() => {});
    const proc: Proc = {
      spec,
      sockPath: sock,
      release: () => jl.release(),
      child,
      client: new Client("http://app", { socketPath: sock }),
      bindings: {
        egress: egressServer,
        close() {
          if (egressServer?.listening) {
            egressServer.close();
            egressServer.closeAllConnections();
          }
          if (!bindingsOpen) return;
          bindingsOpen = false;
          binds.close();
          // gVisor: the sandbox can write to l/, so its run dir goes only once it's reaped (jail release).
          if (!gvisor) rmSync(run, { recursive: true, force: true });
        },
      },
      ready: Promise.resolve(),
      lastUsed: Date.now(),
      inflight: 0,
      exited: false,
    };
    this.procs.set(spec.appId, proc);
    self = proc;
    if (lost) fail(new Error("bindings thread exited during start"));

    const pipe = (stream: NodeJS.ReadableStream, kind: "stdout" | "stderr") => {
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          // workerd follows internal errors with native stack addresses; not useful to app authors.
          if (!line.startsWith("stack: ")) this.logs.push(spec.appId, kind, line);
        }
      });
      stream.on("end", () => buf && this.logs.push(spec.appId, kind, buf));
    };
    pipe(child.stdout!, "stdout");
    pipe(child.stderr!, "stderr");
    child.once("error", (e) => {
      // e.g. spawn failure: no `exit` follows.
      proc.exited = true;
      proc.client.close().catch(() => {});
      proc.bindings.close();
      jl.release();
      if (this.procs.get(spec.appId) === proc) this.procs.delete(spec.appId);
      fail(e);
    });
    child.once("exit", (code, sig) => {
      proc.exited = true;
      proc.client.close().catch(() => {});
      proc.bindings.close();
      if (this.procs.get(spec.appId) === proc) this.procs.delete(spec.appId);
      fail(new Error(`sandbox exited with code ${code}`));
      if (jl.oomKilled()) this.logs.push(spec.appId, "system", "sandbox killed: out of memory");
      // Kills anything the sandbox forked that outlived it, then removes the cgroup.
      jl.release();
      if (code === 97) this.logs.push(spec.appId, "system", "sandbox couldn't join its cgroup");
      else if (code !== 0 && sig !== "SIGTERM" && sig !== "SIGKILL") {
        this.logs.push(spec.appId, "system", `sandbox exited (code ${code})`);
      }
    });

    proc.ready = (async () => {
      const deadline = Date.now() + 10_000;
      while (!((!gvisor || adoptListener(run)) && (await probe(sock)))) {
        if (proc.exited) throw new Error("sandbox exited during start");
        if (Date.now() > deadline) throw new Error("start timeout");
        await new Promise((r) => setTimeout(r, 25));
      }
    })();
    try {
      await Promise.race([proc.ready, failed]);
    } catch (e) {
      this.stop(spec.appId);
      throw e;
    }
    // The request that started it is in flight from here (while it's still in #starting: never evictable in between).
    proc.inflight++;
    proc.lastUsed = Date.now();
    return proc;
  }

  stop(appId: string) {
    const proc = this.procs.get(appId);
    if (!proc) return;
    this.procs.delete(appId);
    proc.child.kill("SIGKILL");
    proc.bindings.close();
    // Synchronously, so a shutdown that exits right after still kills forked processes.
    proc.release();
  }

  /** stop(), after a start in flight for the app is done (it would serve, and recreate files of, a purged app). */
  async stopSettled(appId: string) {
    for (let s; (s = this.#starting.get(appId));) {
      await s.p.catch(() => {});
      await new Promise((r) => setImmediate(r)); // requests waiting on it may retry (another deploy or policy)
    }
    this.stop(appId);
  }

  reapIdle() {
    const now = Date.now();
    for (const [appId, p] of this.procs) {
      if (p.inflight === 0 && now - p.lastUsed > this.#cfg.limits.idleMs) this.stop(appId);
    }
  }

  status(appId: string) {
    const p = this.procs.get(appId);
    return p
      ? { running: !p.exited, deployId: p.spec.deployId, pid: p.child.pid, lastUsed: p.lastUsed }
      : { running: false };
  }

  close() {
    this.#closed = true;
    clearInterval(this.#timer);
    for (const id of [...this.procs.keys()]) this.stop(id);
  }
}
