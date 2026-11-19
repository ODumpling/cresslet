// Process manager: one sandboxed Deno process per app with a server, spawned on demand,
// reaped when idle. Proxies requests over a unix socket.
import { fromFileUrl, join } from "@std/path";
import { type Config, paths } from "./config.ts";
import { Logs } from "./logs.ts";

const RUNNER = fromFileUrl(new URL("../runtime/runner.ts", import.meta.url));
const RUNTIME_DIR = fromFileUrl(new URL("../runtime/", import.meta.url));
const READY = "__CRESSLET_READY__";

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
  child: Deno.ChildProcess;
  client: Deno.HttpClient;
  ready: Promise<void>;
  lastUsed: number;
  inflight: number;
  exited: boolean;
}

export class Runtime {
  procs = new Map<string, Proc>();
  #starting = new Map<string, Promise<Proc>>();
  #timer: ReturnType<typeof setInterval>;

  constructor(private cfg: Config, public logs: Logs) {
    Deno.mkdirSync(cfg.sockDir, { recursive: true });
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
    const timeout = AbortSignal.timeout(this.cfg.limits.requestMs);
    const signal = AbortSignal.any([timeout, req.signal]);
    try {
      const headers = new Headers(req.headers);
      headers.set("x-cresslet-url", req.url);
      const res = await fetch("http://app" + new URL(req.url).pathname, {
        method: req.method,
        headers,
        body: req.body,
        signal,
        client: proc.client,
        redirect: "manual",
      });
      return res;
    } catch (e) {
      if (timeout.aborted) {
        // Likely a runaway handler; restart the sandbox.
        this.logs.push(spec.appId, "system", `request timed out after ${this.cfg.limits.requestMs}ms; restarting`);
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
    const p = paths(this.cfg, spec.appId);
    await Deno.mkdir(p.data, { recursive: true });
    await Deno.mkdir(p.run, { recursive: true });
    const configPath = join(p.run, "config.json");
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        appId: spec.appId,
        appName: spec.appName,
        appUrl: spec.appUrl,
        deployId: spec.deployId,
        serverPath: join(p.deploy(spec.deployId), "server.js"),
        dataDir: p.data,
        sock: p.sock,
        secrets: spec.secrets,
      }),
      { mode: 0o600 },
    );
    const args = [
      "run",
      "--no-prompt",
      "--no-remote",
      "--no-npm",
      "--no-config",
      "--no-lock",
      `--v8-flags=--max-old-space-size=${this.cfg.limits.memoryMb}`,
      `--allow-read=${p.app},${RUNTIME_DIR},${p.sock}`,
      `--allow-write=${p.data},${p.sock}`,
      // Deno treats unix sockets as net resources; unclaimed apps get only their socket.
      spec.net ? "--allow-net" : `--allow-net=unix:${p.sock}`,
      RUNNER,
      configPath,
    ];
    const child = new Deno.Command(this.cfg.denoPath, {
      args,
      cwd: p.app,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: { NO_COLOR: "1", DENO_NO_UPDATE_CHECK: "1", HOME: p.run, DENO_DIR: join(p.run, "deno") },
    }).spawn();

    let markReady!: () => void;
    let fail!: (e: Error) => void;
    const ready = new Promise<void>((res, rej) => {
      markReady = res;
      fail = rej;
    });
    const proc: Proc = {
      spec,
      child,
      client: Deno.createHttpClient({ proxy: { transport: "unix", path: p.sock } }),
      ready,
      lastUsed: Date.now(),
      inflight: 0,
      exited: false,
    };
    this.procs.set(spec.appId, proc);

    const pipe = async (stream: ReadableStream<Uint8Array>, kind: "stdout" | "stderr") => {
      let buf = "";
      for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line === READY) markReady();
          else this.logs.push(spec.appId, kind, line);
        }
      }
      if (buf) this.logs.push(spec.appId, kind, buf);
    };
    pipe(child.stdout, "stdout");
    pipe(child.stderr, "stderr");
    child.status.then((s) => {
      proc.exited = true;
      proc.client.close();
      if (this.procs.get(spec.appId) === proc) this.procs.delete(spec.appId);
      fail(new Error(`sandbox exited with code ${s.code}`));
      if (s.code !== 0 && s.signal !== "SIGTERM" && s.signal !== "SIGKILL") {
        this.logs.push(spec.appId, "system", `sandbox exited (code ${s.code})`);
      }
    });
    const startTimeout = setTimeout(() => fail(new Error("start timeout")), 10_000);
    try {
      await ready;
    } catch (e) {
      this.stop(spec.appId);
      throw e;
    } finally {
      clearTimeout(startTimeout);
    }
    return proc;
  }

  stop(appId: string) {
    const proc = this.procs.get(appId);
    if (!proc) return;
    this.procs.delete(appId);
    try {
      proc.child.kill("SIGKILL");
    } catch { /* already gone */ }
  }

  reapIdle() {
    const now = Date.now();
    for (const [appId, p] of this.procs) {
      if (p.inflight === 0 && now - p.lastUsed > this.cfg.limits.idleMs) this.stop(appId);
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
