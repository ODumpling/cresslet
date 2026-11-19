import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveDir, serveFile } from "./static.ts";
import { type Config, loadConfig, rootUrl } from "./config.ts";
import { Store } from "./store.ts";
import { Runtime } from "./runtime.ts";
import { Logs } from "./logs.ts";
import { api, normDomain } from "./api.ts";
import { host, upgrader } from "./host.ts";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { removeAppFiles } from "./deploys.ts";

const STUDIO = join(import.meta.dirname, "../studio");

/** Cross-origin isolation is required by cresslet-container (SharedArrayBuffer). */
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
  const upgradeApp = upgrader(cfg, store, runtime);
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
    const hostname = normDomain((req.headers.get("host") ?? "").replace(/:\d+$/, ""));
    if (hostname.endsWith(suffix)) {
      const sub = hostname.slice(0, -suffix.length);
      if (sub && !sub.includes(".")) return serveApp(req, sub);
    } else if (hostname !== cfg.domain) {
      const custom = store.appByDomain(hostname);
      if (custom) return serveApp(req, custom.name);
    }
    const url = new URL(req.url);
    if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) return control.fetch(req);
    if (url.pathname === "/healthz") return new Response("ok");
    // The container's service worker must be served from the root to control preview URLs.
    const res = url.pathname === "/cresslet-sw.js"
      ? await serveFile(req, join(STUDIO, "vendor/cresslet-container/cresslet-sw.js"))
      : await serveDir(req, STUDIO);
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(ISOLATION)) h.set(k, v);
    // Studio files aren't content-hashed: always revalidate (ETag), or a CDN/browser can pair new HTML
    // with stale JS.
    h.set("cache-control", "no-cache");
    if (url.pathname === "/cresslet-sw.js") h.set("service-worker-allowed", "/");
    return new Response(res.body, { status: res.status, headers: h });
  }

  /** `upgrade` event of the HTTP server: WebSockets to app servers. */
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    // Node detaches its own error handler before emitting `upgrade`: install ours first.
    socket.on("error", () => socket.destroy());
    const hostname = normDomain((req.headers.host ?? "").replace(/:\d+$/, ""));
    let name = hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : "";
    if (!name && hostname !== cfg.domain) name = store.appByDomain(hostname)?.name ?? ""; // custom domain
    if (!name || name.includes(".")) return void socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    void upgradeApp(req, socket, head, name).catch(() => socket.destroy());
  }

  return {
    cfg,
    upgrade,
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const srv = createServer();
  const http = serve({ fetch: srv.handler, port: srv.cfg.port }, () =>
    console.log(`cresslet listening on ${rootUrl(srv.cfg)}  (apps: *.${srv.cfg.domain})`));
  http.on("upgrade", srv.upgrade);
  const shutdown = () => {
    srv.close();
    http.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
