// Process manager: one workerd sandbox process per app with a server, spawned on demand,
// reaped when idle. Proxies requests over a unix socket. The sandbox reaches its db/files
// through a per-app bindings socket served here (server/bindings.ts).
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { type IncomingMessage, request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { getRequestListener } from "@hono/node-server";
import { Client } from "undici";
import { type Config, paths } from "./config.ts";
import type { Logs } from "./logs.ts";
import { createBindings } from "./bindings.ts";
import { createEgressProxy } from "./egress.ts";

const WORKER = join(import.meta.dirname, "../runtime/worker.js");
/** Pinned so a workerd upgrade doesn't silently change app semantics. */
const COMPAT_DATE = "2026-11-01";

export interface AppSpec {
  appId: string;
  appName: string;
  appUrl: string;
  deployId: string;
  /** Read at sandbox start; served over the HOST binding, never written to disk. */
  secrets: () => Record<string, string>;
  net: boolean;
  /** Outbound allowlist (only with `net`); null = any public host. */
  egress: string[] | null;
}

interface Proc {
  spec: AppSpec;
  sockPath: string;
  child: ChildProcess;
  client: Client;
  bindings: { server: Server; egress: Server | null; close(): void };
  ready: Promise<void>;
  lastUsed: number;
  inflight: number;
  exited: boolean;
}

const HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "expect"];
const NULL_BODY = new Set([101, 204, 205, 304]);

/** Cap'n Proto text string literal. */
function capStr(s: string): string {
  if (/[\0-\x1f]/.test(s)) throw new Error(`invalid path for sandbox config: ${s}`);
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function workerdConfig(
  spec: AppSpec,
  sock: string,
  hostSock: string,
  egressSock: string | null,
  serverRel: string,
  memoryMb: number,
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
        (name = "app", esModule = embed ${capStr(serverRel)}),
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
  sockets = [(name = "http", address = ${capStr("unix:" + sock)}, http = (), service = "app")],
  v8Flags = ["--max-old-space-size=${memoryMb}"],
);
`;
}

const samePolicy = (a: AppSpec, b: AppSpec) => a.net === b.net && JSON.stringify(a.egress) === JSON.stringify(b.egress);

const canConnect = (path: string) =>
  new Promise<boolean>((res) => {
    const s = connect(path);
    s.once("connect", () => (s.destroy(), res(true)));
    s.once("error", () => res(false));
  });

export class Runtime {
  procs = new Map<string, Proc>();
  logs: Logs;
  #cfg: Config;
  #starting = new Map<string, { spec: AppSpec; p: Promise<Proc> }>();
  #timer: ReturnType<typeof setInterval>;

  constructor(cfg: Config, logs: Logs) {
    this.#cfg = cfg;
    this.logs = logs;
    mkdirSync(cfg.sockDir, { recursive: true });
    // Older versions left plaintext secrets in each app's run dir.
    const apps = join(cfg.dataDir, "apps");
    for (const app of existsSync(apps) ? readdirSync(apps, { withFileTypes: true }) : []) {
      if (app.isDirectory()) rmSync(join(apps, app.name, "run", "secrets.json"), { force: true });
    }
    this.#timer = setInterval(() => this.reapIdle(), 15_000);
  }

  /** `internal`: a control-plane request (cron) that may carry x-cresslet-* headers. */
  async fetch(spec: AppSpec, req: Request, { internal = false } = {}): Promise<Response> {
    let proc: Proc;
    try {
      proc = await this.#get(spec);
    } catch (e) {
      this.logs.push(spec.appId, "system", `failed to start: ${(e as Error).message}`);
      return new Response("App failed to start. See `cresslet logs`.", { status: 502 });
    }
    proc.inflight++;
    proc.lastUsed = Date.now();
    const timeout = AbortSignal.timeout(this.#cfg.limits.requestMs);
    const signal = AbortSignal.any([timeout, req.signal]);
    try {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        // Clients can't forge control-plane headers.
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
      return new Response(Readable.toWeb(res.body) as ReadableStream, { status: res.statusCode, headers: h });
    } catch (e) {
      if (timeout.aborted) {
        // Likely a runaway handler; restart the sandbox.
        this.logs.push(spec.appId, "system", `request timed out after ${this.#cfg.limits.requestMs}ms; restarting`);
        this.stop(spec.appId);
        return new Response("Gateway Timeout", { status: 504 });
      }
      if (req.signal.aborted) return new Response(null, { status: 499 });
      this.logs.push(spec.appId, "system", `proxy error: ${(e as Error).message}`);
      return new Response("Bad Gateway", { status: 502 });
    } finally {
      proc.inflight--;
      proc.lastUsed = Date.now();
    }
  }

  /**
   * WebSocket (HTTP upgrade): forward the handshake to the sandbox; only a 101 gets the two sockets
   * spliced. Any other answer is relayed once and the connection closed, so a client can't reuse it
   * to talk to the sandbox directly. Open sockets count as in-flight (the idle reaper keeps it up).
   */
  async upgrade(spec: AppSpec, req: IncomingMessage, client: Duplex, head: Buffer, url: string): Promise<number> {
    let proc: Proc;
    try {
      proc = await this.#get(spec);
    } catch (e) {
      this.logs.push(spec.appId, "system", `failed to start: ${(e as Error).message}`);
      client.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      return 502;
    }
    if (client.destroyed) return 0;
    const headers: string[] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      // Clients can't forge control-plane headers.
      if (!req.rawHeaders[i].toLowerCase().startsWith("x-cresslet-")) headers.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
    }
    headers.push("x-cresslet-url", url);
    const u = new URL(url);
    let done = false;
    let responded = false;
    let upstream: Duplex | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      proc.inflight--;
      proc.lastUsed = Date.now();
      client.destroy();
      upstream?.destroy();
      up.destroy();
    };
    const up = httpRequest({ socketPath: proc.sockPath, method: req.method, path: u.pathname + u.search, headers, setHost: false });
    proc.inflight++;
    proc.lastUsed = Date.now();
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
        resolve(101);
      });
      up.on("response", (res) => {
        clearTimeout(timer);
        responded = true;
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

  async #get(spec: AppSpec): Promise<Proc> {
    const cur = this.procs.get(spec.appId);
    // Network policy is part of the identity: a sandbox started under an old policy (e.g. a cold
    // start racing a PUT /egress) is replaced on the next request.
    if (cur && !cur.exited && cur.spec.deployId === spec.deployId && samePolicy(cur.spec, spec)) {
      await cur.ready;
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
    const p = this.#spawn(spec).finally(() => this.#starting.delete(spec.appId));
    this.#starting.set(spec.appId, { spec, p });
    return p;
  }

  async #spawn(spec: AppSpec): Promise<Proc> {
    const cfg = this.#cfg;
    const p = paths(cfg, spec.appId);
    await mkdir(p.data, { recursive: true });
    await mkdir(p.run, { recursive: true });
    // Fresh socket names per spawn: a dying predecessor's cleanup must not unlink ours.
    const tag = `${spec.appId}-${randomBytes(4).toString("hex")}`;
    const sock = join(cfg.sockDir, `${tag}.sock`);
    const hostSock = join(cfg.sockDir, `${tag}.host.sock`);
    const egressSock = spec.net && spec.egress ? join(cfg.sockDir, `${tag}.egress.sock`) : null;

    // Bindings socket: the sandbox's only way to its data. One per app, so identity = socket.
    const bindings = createBindings(p.data, { secrets: spec.secrets() });
    const server = createServer(getRequestListener(bindings.fetch));
    await new Promise<void>((res, rej) => server.once("error", rej).listen(hostSock, res));
    const egress = egressSock
      ? createEgressProxy(spec.egress!, (l) => this.logs.push(spec.appId, "system", l))
      : null;
    if (egress) {
      await new Promise<void>((res, rej) => egress.once("error", rej).listen(egressSock!, res)).catch((e) => {
        server.close();
        bindings.close();
        throw e;
      });
    }

    await copyFile(WORKER, join(p.run, "worker.js"));
    // Older versions wrote secrets here in plaintext.
    rmSync(join(p.run, "secrets.json"), { force: true });
    await writeFile(
      join(p.run, "app.json"),
      JSON.stringify({ id: spec.appId, name: spec.appName, url: spec.appUrl, deployId: spec.deployId }),
    );
    const serverRel = relative(p.run, join(p.deploy(spec.deployId), "server.js"));
    const configPath = join(p.run, "config.capnp");
    await writeFile(configPath, workerdConfig(spec, sock, hostSock, egressSock, serverRel, cfg.limits.memoryMb));

    const child = spawn(cfg.workerdPath, ["serve", configPath], {
      cwd: p.run,
      stdio: ["ignore", "pipe", "pipe"],
      env: { HOME: p.run },
    });

    let fail!: (e: Error) => void;
    const failed = new Promise<never>((_, rej) => (fail = rej));
    failed.catch(() => {});
    const proc: Proc = {
      spec,
      sockPath: sock,
      child,
      client: new Client("http://app", { socketPath: sock }),
      bindings: {
        server,
        egress,
        close() {
          if (egress?.listening) {
            egress.close();
            egress.closeAllConnections();
          }
          if (!server.listening) return;
          server.close();
          server.closeAllConnections();
          bindings.close();
          rmSync(sock, { force: true });
        },
      },
      ready: Promise.resolve(),
      lastUsed: Date.now(),
      inflight: 0,
      exited: false,
    };
    this.procs.set(spec.appId, proc);

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
    child.once("error", (e) => fail(e));
    child.once("exit", (code, sig) => {
      proc.exited = true;
      proc.client.close().catch(() => {});
      proc.bindings.close();
      if (this.procs.get(spec.appId) === proc) this.procs.delete(spec.appId);
      fail(new Error(`sandbox exited with code ${code}`));
      if (code !== 0 && sig !== "SIGTERM" && sig !== "SIGKILL") {
        this.logs.push(spec.appId, "system", `sandbox exited (code ${code})`);
      }
    });

    proc.ready = (async () => {
      const deadline = Date.now() + 10_000;
      while (!(await canConnect(sock))) {
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
    return proc;
  }

  stop(appId: string) {
    const proc = this.procs.get(appId);
    if (!proc) return;
    this.procs.delete(appId);
    proc.child.kill("SIGKILL");
    proc.bindings.close();
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
    clearInterval(this.#timer);
    for (const id of [...this.procs.keys()]) this.stop(id);
  }
}
