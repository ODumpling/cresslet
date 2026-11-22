// Serves deployed apps on `<name>.<domain>`: static assets, then the app's server for matching routes.
import { stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { serveFile } from "./static.ts";
import { appUrl, type Config, paths, rootUrl } from "./config.ts";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { App, Store } from "./store.ts";
import type { AppSpec, Runtime } from "./runtime.ts";
import { pausedCrons, type RunCron } from "./cron.ts";

export function matchRoute(pattern: string, path: string): boolean {
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2);
    return path === base || path.startsWith(base + "/");
  }
  if (pattern === "*" || pattern === "/*") return true;
  return path === pattern;
}

/**
 * Whether a path goes to the app's server: it matches a `routes` pattern and no `!pattern` exclusion
 * (`["/*", "!/assets/*"]`: everything but built assets, as SSR frameworks need).
 */
export function serverRoute(routes: string[] | undefined, path: string): boolean {
  let hit = false;
  for (const r of routes ?? ["/api/*"]) {
    if (r.startsWith("!")) {
      if (matchRoute(r.slice(1), path)) return false;
    } else if (!hit) hit = matchRoute(r, path);
  }
  return hit;
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
  return async (req: IncomingMessage, socket: Duplex, head: Buffer, appName: string, app?: App) => {
    app ??= await store.appByName(appName);
    const target = req.url ?? "/";
    if (!target.startsWith("/") || target.startsWith("//")) {
      socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const url = new URL(`${cfg.scheme}://${req.headers.host ?? appName}${target}`);
    const config = app ? JSON.parse(app.config) as { routes?: string[]; server?: boolean } : {};
    if (!app?.current_deploy_id || !config.server || !serverRoute(config.routes, url.pathname)) {
      socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const status = await runtime.upgrade(appSpec(cfg, store, app), req, socket, head, url.href);
    runtime.logs.push(app.id, "request", `WS ${url.pathname} ${status}`);
  };
}

/**
 * One cron invocation: an internal request the sandbox entry routes to `scheduled()` (runtime/worker.ts).
 * `manual`: Run now (from the studio), which runs a paused cron too.
 */
export function scheduled(cfg: Config, store: Store, runtime: Runtime): RunCron {
  return async (appId, cron, at, manual = false) => {
    const app = await store.appById(appId);
    // Checked at dispatch: a run queued behind another may outlive a redeploy that dropped the cron, or a pause.
    if (!app?.current_deploy_id || !app.account_id || !(JSON.parse(app.config).crons ?? []).includes(cron)) return;
    if (!manual && pausedCrons(app).has(cron)) return;
    const startedAt = Date.now(), started = performance.now();
    let status = 0;
    try {
      const res = await runtime.fetch(
        appSpec(cfg, store, app),
        new Request(`${appUrl(cfg, app.name)}/`, {
          method: "POST",
          headers: { "x-cresslet-scheduled": JSON.stringify({ cron, scheduledTime: at.getTime() }) },
        }),
        { internal: true },
      );
      status = res.status;
      await res.body?.cancel();
    } finally {
      const ms = Math.round(performance.now() - started);
      const ok = status >= 200 && status < 300;
      // Nothing for an app deleted meanwhile (its logs and history are gone). null: deleted; undefined: couldn't tell.
      const now = await store.appById(app.id).then((a) => a ?? null, () => undefined);
      if (now !== null) runtime.logs.push(app.id, "system", `cron "${cron}"${manual ? " (run now)" : ""} ${ok ? "ok" : `failed (${status || "error"})`} ${ms}ms`);
      if (now) runtime.cronRuns.record(app.id, { cron, at: at.getTime(), startedAt, ms, status, manual }, JSON.parse(now.config).crons ?? []);
    }
  };
}

/** Query parameter carrying a private page's one-time ticket (from `POST /v1/pages/:name/view`). */
export const PAGE_TICKET_PARAM = "cresslet_view";
export const PAGE_TICKET_MS = 2 * 60_000;
const PAGE_SESSION_MS = 24 * 3600_000;
/** `__Host-`: a cookie no other host (another app or page under the domain) can set for this one. */
const pageCookie = (cfg: Config) => cfg.scheme === "https" ? "__Host-cresslet_page" : "cresslet_page";

function cookies(req: Request, name: string): string[] {
  const out: string[] = [];
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) out.push(part.slice(i + 1).trim());
  }
  return out;
}

/** Where a private page sends a visitor without a session: the studio, which signs them in and back. */
export function pageLoginUrl(cfg: Config, name: string, path = "/") {
  return `${rootUrl(cfg)}/view/${encodeURIComponent(name)}?${new URLSearchParams({ path })}`;
}

function pages(cfg: Config, store: Store) {
  const notFound = () =>
    new Response("This page doesn't exist, or it expired.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  /** The account behind one of the request's session cookies, if it can still see the page. */
  const viewer = async (req: Request, app: App) => {
    for (const token of cookies(req, pageCookie(cfg))) {
      const acct = await store.pageSession(app.id, token);
      if (acct && await store.access(app, acct)) return acct;
    }
  };
  return async (req: Request, app: App): Promise<Response> => {
    if (!app.page_deploy_id || (app.expires_at !== null && app.expires_at <= Date.now())) return notFound();
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
    const url = new URL(req.url);
    const extra: Record<string, string> = app.visibility === "public"
      ? {}
      // Not for search engines, and the URL doesn't leak to the sites the page links to.
      : { "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" };
    if (app.visibility === "private") {
      const ticket = url.searchParams.get(PAGE_TICKET_PARAM);
      if (ticket !== null) {
        url.searchParams.delete(PAGE_TICKET_PARAM);
        const s = await store.redeemPageTicket(app.id, ticket, PAGE_SESSION_MS);
        if (!s || !await store.access(app, s.account_id)) {
          return new Response("This sign-in link expired or was already used. Open the page again.", {
            status: 403,
            headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra },
          });
        }
        const secure = cfg.scheme === "https" ? "; Secure" : "";
        // One leading slash: `//other.host/` would be a redirect to another site.
        const back = "/" + url.pathname.replace(/^[/\\]+/, "") + url.search;
        return new Response(null, {
          status: 303,
          headers: {
            location: back,
            "set-cookie": `${pageCookie(cfg)}=${s.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PAGE_SESSION_MS / 1000}${secure}`,
            "cache-control": "no-store",
            ...extra,
          },
        });
      }
      if (!await viewer(req, app)) {
        return new Response(null, {
          status: 302,
          headers: { location: pageLoginUrl(cfg, app.name, url.pathname + url.search), "cache-control": "no-store", ...extra },
        });
      }
      // Never in a shared cache (a CDN would serve it to anyone).
      extra["cache-control"] = "private, no-store";
    }
    // No SPA fallback: a page is plain HTML files, so a broken link gets its 404.html (or a 404), not index.html.
    const res = await serveStatic(req, join(paths(cfg, app.id).deploy(app.page_deploy_id), "public"), url, { spa: false });
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(extra)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  };
}

export function host(cfg: Config, store: Store, runtime: Runtime) {
  const servePage = pages(cfg, store);
  return async (req: Request, appName: string, app?: App): Promise<Response> => {
    app ??= await store.appByName(appName);
    if (app?.kind === "page") return servePage(req, app);
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

    if (config.server && serverRoute(config.routes, url.pathname)) {
      const res = await runtime.fetch(appSpec(cfg, store, app), req);
      runtime.logs.push(
        app.id,
        "request",
        `${req.method} ${url.pathname} ${res.status} ${Math.round(performance.now() - started)}ms`,
      );
      runtime.metrics.record(app.id, res.status, performance.now() - started);
      return res;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      runtime.metrics.record(app.id, 405);
      return new Response("Method Not Allowed", { status: 405 });
    }
    const res = await serveStatic(req, join(p.deploy(app.current_deploy_id), "public"), url);
    runtime.metrics.record(app.id, res.status);
    return res;
  };
}

/** A deploy's static files: exact path, `.html`, directory index, SPA fallback (unless `spa: false`), then 404.html. */
async function serveStatic(req: Request, pub: string, url: URL, { spa = true } = {}): Promise<Response> {
  {
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
    if (spa && !last.includes(".") && await isFile(join(pub, "index.html"))) {
      return withCache(await serveFile(req, join(pub, "index.html")), "index.html");
    }
    if (await isFile(join(pub, "404.html"))) {
      const r = await serveFile(req, join(pub, "404.html"));
      return new Response(r.body, { status: 404, headers: r.headers });
    }
    return new Response("Not Found", { status: 404 });
  }
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
