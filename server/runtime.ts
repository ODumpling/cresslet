// Process manager: one workerd sandbox process per app with a server, spawned on demand,
// reaped when idle. Proxies requests over a unix socket. The sandbox reaches its db/files
// through a per-app bindings socket served here (server/bindings.ts).
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { getRequestListener } from "@hono/node-server";
import { Client } from "undici";
import { type Config, paths } from "./config.ts";
import type { Logs } from "./logs.ts";
import { createBindings } from "./bindings.ts";

const WORKER = join(import.meta.dirname, "../runtime/worker.js");
/** Pinned so a workerd upgrade doesn't silently change app semantics. */
const COMPAT_DATE = "2026-11-01";

export interface AppSpec {
  appId: string;
  appName: string;
  appUrl: string;
  deployId: string;
  secrets: Record<string, string>;
  net: boolean;
}

interface Proc {
  spec: AppSpec;
  child: ChildProcess;
  client: Client;
  bindings: { server: Server; close(): void };
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

function workerdConfig(spec: AppSpec, sock: string, hostSock: string, serverRel: string, memoryMb: number) {
  const outbound = spec.net
    // "public" excludes loopback/private ranges, so apps can't reach the control plane or LAN.
    ? `(name = "outbound", network = (allow = ["public"], tlsOptions = (trustBrowserCas = true)))`
    : `(name = "outbound", network = (allow = []))`;
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
        (name = "SECRETS", json = embed "secrets.json"),
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
  #starting = new Map<string, Promise<Proc>>();
  #timer: ReturnType<typeof setInterval>;

  constructor(cfg: Config, logs: Logs) {
    this.#cfg = cfg;
    this.logs = logs;
    mkdirSync(cfg.sockDir, { recursive: true });
    this.#timer = setInterval(() => this.reapIdle(), 15_000);
  }

  async fetch(spec: AppSpec, req: Request): Promise<Response> {
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
        if (!HOP.includes(k)) headers[k] = v;
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

  async #get(spec: AppSpec): Promise<Proc> {
    const cur = this.procs.get(spec.appId);
    if (cur && !cur.exited && cur.spec.deployId === spec.deployId) {
      await cur.ready;
      return cur;
    }
    if (cur) this.stop(spec.appId);
    const starting = this.#starting.get(spec.appId);
    if (starting) return starting;
    const p = this.#spawn(spec).finally(() => this.#starting.delete(spec.appId));
    this.#starting.set(spec.appId, p);
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

    // Bindings socket: the sandbox's only way to its data. One per app, so identity = socket.
    const bindings = createBindings(p.data);
    const server = createServer(getRequestListener(bindings.fetch));
    await new Promise<void>((res, rej) => server.once("error", rej).listen(hostSock, res));

    await copyFile(WORKER, join(p.run, "worker.js"));
    await writeFile(join(p.run, "secrets.json"), JSON.stringify(spec.secrets), { mode: 0o600 });
    await writeFile(
      join(p.run, "app.json"),
      JSON.stringify({ id: spec.appId, name: spec.appName, url: spec.appUrl, deployId: spec.deployId }),
    );
    const serverRel = relative(p.run, join(p.deploy(spec.deployId), "server.js"));
    const configPath = join(p.run, "config.capnp");
    await writeFile(configPath, workerdConfig(spec, sock, hostSock, serverRel, cfg.limits.memoryMb));

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
      child,
      client: new Client("http://app", { socketPath: sock }),
      bindings: {
        server,
        close() {
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
