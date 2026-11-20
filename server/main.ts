import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveDir, serveFile } from "./static.ts";
import { type Config, loadConfig, previewAppName, rootUrl } from "./config.ts";
import { Store } from "./store.ts";
import { Runtime } from "./runtime.ts";
import { Logs } from "./logs.ts";
import { api, normDomain } from "./api.ts";
import { host, scheduled, upgrader } from "./host.ts";
import { Scheduler } from "./cron.ts";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { removeAppFiles } from "./deploys.ts";
import { settled as sandboxSettled } from "./sandbox.ts";

const STUDIO = join(import.meta.dirname, "../studio");
const RETIRE_SW = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url);
})()));
`;
/** Files cresslet-container needs at the preview origin's root. */
const PREVIEW_FILES = new Set(["cresslet-sw.js", "cresslet-relay.html", "cresslet-relay.js"]);

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
  const shadowed = previewAppName(cfg);
  if ((shadowed && store.appByName(shadowed)) || store.appByDomain(cfg.previewHost)) {
    console.warn(`cresslet: ${cfg.previewHost} is the studio preview host; the app using that name/domain is no longer reachable`);
  }
  const scheduler = new Scheduler(store, scheduled(cfg, store, runtime));
  scheduler.start();

  const reap = setInterval(async () => {
    for (const a of store.expiredApps()) {
      runtime.stop(a.id);
      store.deleteApp(a.id);
      logs.drop(a.id);
      await removeAppFiles(cfg, a.id);
    }
  }, 10 * 60_000);

  /**
   * The studio's previews run on their own origin (cresslet-container `previewOrigin`), so preview
   * code can't read the studio's storage (API token). This host serves only the container's relay
   * page and service worker; the SW serves the previews themselves from the studio tab.
   */
  async function servePreviewHost(req: Request): Promise<Response> {
    const name = new URL(req.url).pathname.slice(1);
    const h = new Headers({
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": "cross-origin",
      "cache-control": "no-cache",
    });
    if (!PREVIEW_FILES.has(name)) {
      h.set("content-type", "text/plain");
      return new Response("Not Found", { status: 404, headers: h });
    }
    const res = await serveFile(req, join(STUDIO, "vendor/cresslet-container", name));
    res.headers.forEach((v, k) => h.has(k) || h.set(k, v));
    if (name === "cresslet-sw.js") h.set("service-worker-allowed", "/");
    // Only the studio may frame the relay (it bridges the SW to the studio's container).
    if (name.endsWith(".html")) h.set("content-security-policy", `frame-ancestors ${rootUrl(cfg)}`);
    return new Response(res.body, { status: res.status, headers: h });
  }

  async function handler(req: Request): Promise<Response> {
    const hostname = normDomain((req.headers.get("host") ?? "").replace(/:\d+$/, ""));
    if (hostname === cfg.previewHost) return servePreviewHost(req);
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
    // Previews moved to the preview host: browsers that registered the old studio-origin worker get
    // one that unregisters itself (and reloads the pages it controlled).
    if (url.pathname === "/cresslet-sw.js") {
      return new Response(RETIRE_SW, {
        headers: { "content-type": "text/javascript", "cache-control": "no-cache", "service-worker-allowed": "/", ...ISOLATION },
      });
    }
    // The relay only lets the configured studio origin frame it: serve the studio's pages there.
    const pub = new URL(rootUrl(cfg));
    // Exact (lowercased) host: `example.com.` is a different origin from `example.com` for the relay's CSP.
    const reqHost = (req.headers.get("host") ?? "").toLowerCase().replace(cfg.scheme === "https" ? /:443$/ : /:80$/, "");
    if (reqHost !== pub.host) {
      return Response.redirect(pub.origin + url.pathname + url.search, 302);
    }
    const res = await serveDir(req, STUDIO);
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(ISOLATION)) h.set(k, v);
    // Studio files aren't content-hashed: always revalidate (ETag), or a CDN/browser can pair new HTML
    // with stale JS.
    h.set("cache-control", "no-cache");
    return new Response(res.body, { status: res.status, headers: h });
  }

  /** `upgrade` event of the HTTP server: WebSockets to app servers. */
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    // Node detaches its own error handler before emitting `upgrade`: install ours first.
    socket.on("error", () => socket.destroy());
    const hostname = normDomain((req.headers.host ?? "").replace(/:\d+$/, ""));
    if (hostname === cfg.previewHost) return void socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
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
    scheduler,
    handler,
    close() {
      clearInterval(reap);
      scheduler.stop();
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
  const shutdown = async () => {
    srv.close();
    http.close();
    await sandboxSettled(); // cgroup kills on older kernels finish on timers
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
