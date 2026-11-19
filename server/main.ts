import { serveDir } from "@std/http/file-server";
import { fromFileUrl } from "@std/path";
import { type Config, loadConfig, rootUrl } from "./config.ts";
import { Store } from "./store.ts";
import { Runtime } from "./runtime.ts";
import { Logs } from "./logs.ts";
import { api } from "./api.ts";
import { host } from "./host.ts";
import { removeAppFiles } from "./deploys.ts";

const STUDIO = fromFileUrl(new URL("../studio/", import.meta.url));

/** Cross-origin isolation is required by clover-container (SharedArrayBuffer). */
const ISOLATION = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
};

export function createServer(cfg: Config = loadConfig()) {
  const store = new Store(cfg.dataDir);
  const logs = new Logs(cfg.limits.logLines);
  const runtime = new Runtime(cfg, logs);
  const control = api(cfg, store, runtime);
  const serveApp = host(cfg, store, runtime);
  const suffix = "." + cfg.domain;

  const reap = setInterval(async () => {
    for (const a of store.expiredApps()) {
      runtime.stop(a.id);
      store.deleteApp(a.id);
      logs.drop(a.id);
      await removeAppFiles(cfg, a.id);
    }
  }, 10 * 60_000);

  async function handler(req: Request): Promise<Response> {
    const hostname = (req.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
    if (hostname.endsWith(suffix)) {
      const sub = hostname.slice(0, -suffix.length);
      if (sub && !sub.includes(".")) return serveApp(req, sub);
    }
    const url = new URL(req.url);
    if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) return control.fetch(req);
    if (url.pathname === "/healthz") return new Response("ok");
    const res = await serveDir(req, { fsRoot: STUDIO, quiet: true });
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(ISOLATION)) h.set(k, v);
    if (url.pathname.endsWith("clover-sw.js")) h.set("service-worker-allowed", "/");
    return new Response(res.body, { status: res.status, headers: h });
  }

  return {
    cfg,
    store,
    runtime,
    handler,
    close() {
      clearInterval(reap);
      runtime.close();
      store.db.close();
    },
  };
}

if (import.meta.main) {
  const srv = createServer();
  Deno.serve({
    port: srv.cfg.port,
    onListen: () => console.log(`clover listening on ${rootUrl(srv.cfg)}  (apps: *.${srv.cfg.domain})`),
  }, srv.handler);
}
