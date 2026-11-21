import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type Http2Bindings, type HttpBindings, serve } from "@hono/node-server";
import { serveDir, serveFile } from "./static.ts";
import { type Config, isolationWarnings, loadConfig, previewAppName, rootUrl } from "./config.ts";
import { Store } from "./store.ts";
import { Runtime } from "./runtime.ts";
import { Logs } from "./logs.ts";
import { api, normDomain } from "./api.ts";
import { host, scheduled, upgrader } from "./host.ts";
import { Scheduler } from "./cron.ts";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { purgeApp } from "./admin.ts";
import { settled as sandboxSettled } from "./sandbox.ts";
import { bindingsSettled } from "./bindings.ts";
import { type Cluster, singleNode } from "./cluster.ts";

const STUDIO = join(import.meta.dirname, "../studio");
const RETIRE_SW = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url);
})()));
`;
/** Files cresslet-container needs at the preview origin's root. */
const PREVIEW_FILES = new Set(["cresslet-sw.js", "cresslet-relay.html", "cresslet-relay.js"]);

/**
 * Studio files aren't content-hashed, and a CDN can cache them past the origin's `no-cache`
 * (Cloudflare's Browser Cache TTL rewrites it to `max-age=14400`): new HTML then runs stale JS.
 * So index.html loads them from `/_v/<hash of the studio>/` and app.js imports relatively: each
 * release's modules (and workers, via import.meta.url) have URLs no earlier release used.
 */
async function studioRelease(): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) hash.update(relative(STUDIO, p)).update("\0").update(await readFile(p)).update("\0");
    }
  };
  await walk(STUDIO);
  const version = hash.digest("hex").slice(0, 12);
  return (await readFile(join(STUDIO, "index.html"), "utf8"))
    .replace(/\b(src|href)="\/([^"?#]+\.(?:js|css|svg))(?:\?[^"]*)?"/g, `$1="/_v/${version}/$2"`);
}
const VERSIONED = /^\/_v\/[0-9a-f]+(?=\/)/;

/** Cross-origin isolation is required by cresslet-container (SharedArrayBuffer). */
const ISOLATION = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
};

/** `cluster`: which apps this node owns (docs/architecture.md#scaling-out); by default all of them. */
export function createServer(cfg: Config = loadConfig(), cluster: Cluster = singleNode) {
  const store = new Store(cfg.dataDir);
  const logs = new Logs(cfg.limits.logLines);
  const runtime = new Runtime(cfg, logs);
  const control = api(cfg, store, runtime, cluster);
  const serveApp = host(cfg, store, runtime);
  const upgradeApp = upgrader(cfg, store, runtime);
  const suffix = "." + cfg.domain;
  const shadowed = previewAppName(cfg);
  if ((shadowed && store.appByName(shadowed)) || store.appByDomain(cfg.previewHost)) {
    console.warn(`cresslet: ${cfg.previewHost} is the studio preview host; the app using that name/domain is no longer reachable`);
  }
  let studioHtml: Promise<string> | undefined;
  // Each app's crons fire on the node that owns it (checked again at dispatch: runs queue).
  const run = scheduled(cfg, store, runtime);
  const scheduler = new Scheduler(
    { appsWithCrons: () => store.appsWithCrons().filter((a) => cluster.local(a.id)) },
    async (appId, cron, at) => cluster.local(appId) ? run(appId, cron, at) : undefined,
  );
  scheduler.start();

  /**
   * Purges expired anonymous apps and pages past their retention, and sites a site admin deleted longer
   * ago than the retention period (owned here).
   */
  async function reap() {
    store.prunePageSessions();
    for (const a of [...store.expiredApps(), ...store.deletedBefore(Date.now() - cfg.limits.deletedRetentionMs)]) {
      if (cluster.local(a.id)) await purgeApp(cfg, store, runtime, a);
    }
  }
  const reaper = setInterval(reap, 10 * 60_000);

  /** An app host's request: served here, or by the node that owns the app. */
  const appHost = (req: Request, name: string, app = store.appByName(name)) =>
    app && !cluster.local(app.id) ? cluster.forward(app.id, req) : serveApp(req, name, app);

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

  /** `env`: @hono/node-server's bindings; its TCP peer feeds per-IP limits (`CRESSLET_CLIENT_IP_HEADER` overrides it). */
  async function handler(req: Request, env?: HttpBindings | Http2Bindings): Promise<Response> {
    const hostname = normDomain((req.headers.get("host") ?? "").replace(/:\d+$/, ""));
    if (hostname === cfg.previewHost) return servePreviewHost(req);
    if (hostname.endsWith(suffix)) {
      const sub = hostname.slice(0, -suffix.length);
      if (sub && !sub.includes(".")) return appHost(req, sub);
    } else if (hostname !== cfg.domain) {
      const custom = store.appByDomain(hostname);
      if (custom) return appHost(req, custom.name, custom);
    }
    const url = new URL(req.url);
    if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) return control.fetch(req, { remoteAddr: env?.incoming?.socket?.remoteAddress });
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
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await (studioHtml ??= studioRelease());
      return new Response(req.method === "HEAD" ? null : html, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...ISOLATION },
      });
    }
    const path = url.pathname.replace(VERSIONED, "");
    const res = await serveDir(path === url.pathname ? req : new Request(new URL(path + url.search, url), req), STUDIO);
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
    const custom = !name && hostname !== cfg.domain ? store.appByDomain(hostname) : undefined;
    if (custom) name = custom.name;
    if (!name || name.includes(".")) return void socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    const app = custom ?? store.appByName(name);
    if (app && !cluster.local(app.id)) return void cluster.forwardUpgrade(app.id, req, socket, head).catch(() => socket.destroy());
    void upgradeApp(req, socket, head, name, app).catch(() => socket.destroy());
  }

  return {
    cfg,
    upgrade,
    store,
    runtime,
    scheduler,
    reap,
    handler,
    close() {
      clearInterval(reaper);
      scheduler.stop();
      runtime.close();
      store.close();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const srv = createServer();
  for (const w of isolationWarnings(srv.cfg)) console.warn(w);
  const http = serve({ fetch: srv.handler, port: srv.cfg.port }, () =>
    console.log(`cresslet listening on ${rootUrl(srv.cfg)}  (apps: *.${srv.cfg.domain})`));
  http.on("upgrade", srv.upgrade);
  const shutdown = async () => {
    srv.close();
    http.close();
    await sandboxSettled(); // cgroup kills on older kernels finish on timers
    // Bindings threads finish the file writes they accepted (bounded: a runaway query never yields).
    await Promise.race([bindingsSettled(), new Promise((r) => setTimeout(r, 5000).unref())]);
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
