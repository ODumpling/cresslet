// Serves deployed apps on `<name>.<domain>`: static assets, then the app's server for matching routes.
import { stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { serveFile } from "./static.ts";
import { appUrl, type Config, paths } from "./config.ts";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { App, Store } from "./store.ts";
import type { AppSpec, Runtime } from "./runtime.ts";

export function matchRoute(pattern: string, path: string): boolean {
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2);
    return path === base || path.startsWith(base + "/");
  }
  if (pattern === "*" || pattern === "/*") return true;
  return path === pattern;
}

async function isFile(p: string) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export function appSpec(cfg: Config, store: Store, app: App): AppSpec {
  return {
    appId: app.id,
    seq: () => store.uidSeq(app.id),
    appName: app.name,
    appUrl: appUrl(cfg, app.name),
    deployId: app.current_deploy_id!,
    secrets: () => store.secrets(app.id),
    // Outbound network is only for claimed apps (enforced by the sandbox).
    net: !!app.account_id,
    egress: app.egress ? JSON.parse(app.egress) : null,
  };
}

/** HTTP upgrades (WebSockets) on server routes go to the sandbox; anything else is refused. */
export function upgrader(cfg: Config, store: Store, runtime: Runtime) {
  return async (req: IncomingMessage, socket: Duplex, head: Buffer, appName: string, app = store.appByName(appName)) => {
    const target = req.url ?? "/";
    if (!target.startsWith("/") || target.startsWith("//")) {
      socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const url = new URL(`${cfg.scheme}://${req.headers.host ?? appName}${target}`);
    const config = app ? JSON.parse(app.config) as { routes?: string[]; server?: boolean } : {};
    if (!app?.current_deploy_id || !config.server || !(config.routes ?? ["/api/*"]).some((r) => matchRoute(r, url.pathname))) {
      socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const status = await runtime.upgrade(appSpec(cfg, store, app), req, socket, head, url.href);
    runtime.logs.push(app.id, "request", `WS ${url.pathname} ${status}`);
  };
}

/** One cron invocation: an internal request the sandbox entry routes to `scheduled()` (runtime/worker.js). */
export function scheduled(cfg: Config, store: Store, runtime: Runtime) {
  return async (appId: string, cron: string, at: Date) => {
    const app = store.appById(appId);
    // Checked at dispatch: a run queued behind another may outlive a redeploy that dropped the cron.
    if (!app?.current_deploy_id || !app.account_id || !(JSON.parse(app.config).crons ?? []).includes(cron)) return;
    const started = performance.now();
    const res = await runtime.fetch(
      appSpec(cfg, store, app),
      new Request(`${appUrl(cfg, app.name)}/`, {
        method: "POST",
        headers: { "x-cresslet-scheduled": JSON.stringify({ cron, scheduledTime: at.getTime() }) },
      }),
      { internal: true },
    );
    await res.body?.cancel();
    runtime.logs.push(app.id, "system", `cron "${cron}" ${res.ok ? "ok" : `failed (${res.status})`} ${Math.round(performance.now() - started)}ms`);
  };
}

export function host(cfg: Config, store: Store, runtime: Runtime) {
  return async (req: Request, appName: string, app = store.appByName(appName)): Promise<Response> => {
    if (!app || !app.current_deploy_id) {
      return new Response(`No app named "${appName}" is deployed here.`, {
        status: 404,
        headers: { "content-type": "text/plain" },
      });
    }
    const url = new URL(req.url);
    const config = JSON.parse(app.config) as { routes?: string[]; server?: boolean };
    const started = performance.now();
    const p = paths(cfg, app.id);

    if (config.server && (config.routes ?? ["/api/*"]).some((r) => matchRoute(r, url.pathname))) {
      const res = await runtime.fetch(appSpec(cfg, store, app), req);
      runtime.logs.push(
        app.id,
        "request",
        `${req.method} ${url.pathname} ${res.status} ${Math.round(performance.now() - started)}ms`,
      );
      return res;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const pub = join(p.deploy(app.current_deploy_id), "public");
    let rel: string;
    try {
      rel = posix.normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, "");
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    if (rel.startsWith("..")) return new Response("Not Found", { status: 404 });

    const candidates = rel === "" || rel.endsWith("/")
      ? [join(pub, rel, "index.html")]
      : [join(pub, rel), join(pub, rel + ".html"), join(pub, rel, "index.html")];
    for (const file of candidates) {
      if (await isFile(file)) return withCache(await serveFile(req, file), rel);
    }
    // SPA fallback for navigation requests (no extension).
    const last = rel.split("/").pop() ?? "";
    if (!last.includes(".") && await isFile(join(pub, "index.html"))) {
      return withCache(await serveFile(req, join(pub, "index.html")), "index.html");
    }
    if (await isFile(join(pub, "404.html"))) {
      const r = await serveFile(req, join(pub, "404.html"));
      return new Response(r.body, { status: 404, headers: r.headers });
    }
    return new Response("Not Found", { status: 404 });
  };
}

function withCache(res: Response, rel: string): Response {
  const h = new Headers(res.headers);
  h.set(
    "cache-control",
    rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
  );
  h.set("x-content-type-options", "nosniff");
  return new Response(res.body, { status: res.status, headers: h });
}
