import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Http2Bindings, type HttpBindings, serve } from "@hono/node-server";
import { serveFile } from "./static.ts";
import { ISOLATION, STUDIO_DIST, STUDIO_SRC, studio } from "./studio.ts";
import { type Config, isolationWarnings, loadConfig, previewAppName, rootUrl } from "./config.ts";
import { type App, Store } from "./store.ts";
import { Runtime } from "./runtime.ts";
import { Logs } from "./logs.ts";
import { api, normDomain } from "./api.ts";
import { host, scheduled, upgrader } from "./host.ts";
import { Scheduler } from "./cron.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { Duplex } from "node:stream";
import { purgeApp } from "./admin.ts";
import { pruneOldPageVersions } from "./deploys.ts";
import { settled as sandboxSettled } from "./sandbox.ts";
import { bindingsSettled } from "./bindings.ts";
import { type Cluster, singleNode } from "./cluster.ts";
import { createRelay } from "./relay.ts";

const RETIRE_SW = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url);
})()));
`;
/** Files cresslet-container needs at the preview origin's root. */
const PREVIEW_FILES = new Set(["cresslet-sw.js", "cresslet-relay.html", "cresslet-relay.js"]);

/** `cluster`: which apps this node owns (docs/architecture.md#scaling-out); by default all of them. */
export async function createServer(cfg: Config = loadConfig(), cluster: Cluster = singleNode) {
  const store = await Store.open(cfg.dataDir, cfg.database);
  const logs = new Logs(cfg.limits.logLines);
  let runtime: Runtime;
  try {
    runtime = new Runtime(cfg, logs);
  } catch (e) {
    await store.close();
    throw e;
  }
  // Each app's crons fire on the node that owns it (checked again at dispatch: runs queue).
  const run = scheduled(cfg, store, runtime);
  const scheduler = new Scheduler(
    { appsWithCrons: async () => (await store.appsWithCrons()).filter((a) => cluster.local(a.id)) },
    async (appId, cron, at, manual) => cluster.local(appId) ? run(appId, cron, at, manual) : undefined,
  );
  const control = api(cfg, store, runtime, cluster, scheduler);
  const serveApp = host(cfg, store, runtime);
  const upgradeApp = upgrader(cfg, store, runtime);
  const relay = createRelay(cfg, store);
  const suffix = "." + cfg.domain;
  const shadowed = previewAppName(cfg);
  if ((shadowed && await store.appByName(shadowed)) || await store.appByDomain(cfg.previewHost)) {
    console.warn(`cresslet: ${cfg.previewHost} is the studio preview host; the app using that name/domain is no longer reachable`);
  }
  // The studio's pages: its build, or Vite in dev (CRESSLET_STUDIO_DEV=1, npm run dev).
  const studioDev = process.env.CRESSLET_STUDIO_DEV === "1";
  const ui = await studio({ dev: studioDev, host: new URL(rootUrl(cfg)).hostname });
  scheduler.start();

  /**
   * Purges expired apps (pages past their retention, and anonymous apps from before they were removed), and sites a site admin deleted longer
   * ago than the retention period (owned here), and pages' old versions.
   */
  async function reap() {
    await store.prunePageSessions();
    await store.pruneRateHits();
    for (const a of [...await store.expiredApps(), ...await store.deletedBefore(Date.now() - cfg.limits.deletedRetentionMs)]) {
      if (cluster.local(a.id)) await purgeApp(cfg, store, runtime, a);
    }
    await pruneOldPageVersions(cfg, store, (id) => cluster.local(id));
  }
  // A failed pass (the database unreachable, say) is logged; the next one tries again.
  const reaper = setInterval(() => void reap().catch((e) => console.error("cresslet: reaping failed:", e)), 10 * 60_000);

  /** An app host's request: served here, or by the node that owns the app. */
  const appHost = async (req: Request, name: string, app?: App) => {
    app ??= await store.appByName(name);
    return app && !cluster.local(app.id) ? cluster.forward(app.id, req) : serveApp(req, name, app);
  };

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
    // As built (copied as is), or the vendored files themselves under Vite.
    const res = await serveFile(req, join(studioDev ? STUDIO_SRC : STUDIO_DIST, "vendor/cresslet-container", name));
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
      const custom = await store.appByDomain(hostname);
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
    const res = await ui.serve(req, env && "outgoing" in env ? { incoming: env.incoming as IncomingMessage, outgoing: env.outgoing as ServerResponse } : undefined);
    return res ?? RESPONSE_ALREADY_SENT;
  }

  /** `upgrade` event of the HTTP server: workspace relay on the root host, and WebSockets to app servers. */
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    // Node detaches its own error handler before emitting `upgrade`: install ours first.
    socket.on("error", () => socket.destroy());
    const hostname = normDomain((req.headers.host ?? "").replace(/:\d+$/, ""));
    if (hostname === cfg.previewHost) return void socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    if (hostname === cfg.domain) {
      let pathname = "";
      try {
        pathname = new URL(req.url ?? "/", "http://x").pathname;
      } catch {
        return void socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      }
      if (pathname === "/v1/workspace/relay") return relay.upgrade(req, socket, head);
      return void socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    }
    void (async () => {
      let name = hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : "";
      const custom = !name && hostname !== cfg.domain ? await store.appByDomain(hostname) : undefined;
      if (custom) name = custom.name;
      if (!name || name.includes(".")) return void socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      const app = custom ?? await store.appByName(name);
      if (app && !cluster.local(app.id)) return cluster.forwardUpgrade(app.id, req, socket, head);
      await upgradeApp(req, socket, head, name, app);
    })().catch(() => socket.destroy());
  }

  return {
    cfg,
    upgrade,
    relay,
    store,
    runtime,
    scheduler,
    reap,
    handler,
    async close() {
      clearInterval(reaper);
      relay.close();
      await ui.close();
      scheduler.stop();
      runtime.close();
      await store.close();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const srv = await createServer();
  for (const w of isolationWarnings(srv.cfg)) console.warn(w);
  const http = serve({ fetch: srv.handler, port: srv.cfg.port }, () =>
    console.log(`cresslet listening on ${rootUrl(srv.cfg)}  (apps: *.${srv.cfg.domain})`));
  http.on("upgrade", srv.upgrade);
  const shutdown = async () => {
    // Stop taking requests first and let those in flight finish (bounded: a long poll or a WebSocket never
    // does), then close the sandboxes and the database they use.
    const drained = new Promise((r) => http.close(r));
    if ("closeIdleConnections" in http) http.closeIdleConnections();
    await Promise.race([drained, new Promise((r) => setTimeout(r, 5000).unref())]);
    await srv.close().catch((e) => console.error("cresslet: closing the database:", e));
    await sandboxSettled(); // cgroup kills on older kernels finish on timers
    // Bindings threads finish the file writes they accepted (bounded: a runaway query never yields).
    await Promise.race([bindingsSettled(), new Promise((r) => setTimeout(r, 5000).unref())]);
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
