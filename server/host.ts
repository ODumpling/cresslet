// Serves deployed apps on `<name>.<domain>`: static assets, then the app's server for matching routes.
import { stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { serveFile } from "./static.ts";
import { appUrl, type Config, paths, rootUrl } from "./config.ts";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { App, Store } from "./store.ts";
import type { Runtime } from "./runtime.ts";
import { pausedCrons, type RunCron } from "./cron.ts";
import { appSpec, ENV_SEP, envTarget, prodTarget, resolveKey, type Target } from "./envs.ts";

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

/**
 * The app (or environment) an app host names: production for `<app>`, the environment for `<app>--<env>` (only an
 * environment it has, deployed to).
 */
async function hostTarget(store: Store, appName: string, app: App | undefined, env: string | null): Promise<Target | undefined> {
  app ??= await store.appByName(appName);
  if (!app) return undefined;
  if (!env) return prodTarget(app);
  if (app.kind !== "app") return undefined;
  const e = await store.environment(app.id, env);
  return e && envTarget(app, e);
}

/** HTTP upgrades (WebSockets) on server routes go to the sandbox; anything else is refused. */
export function upgrader(cfg: Config, store: Store, runtime: Runtime) {
  const gate = envGate(cfg, store);
  return async (req: IncomingMessage, socket: Duplex, head: Buffer, appName: string, app?: App, env: string | null = null) => {
    const t = await hostTarget(store, appName, app, env);
    const target = req.url ?? "/";
    if (!target.startsWith("/") || target.startsWith("//")) {
      socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const url = new URL(`${cfg.scheme}://${req.headers.host ?? appName}${target}`);
    const config = t ? JSON.parse(t.config) as { routes?: string[]; server?: boolean } : {};
    if (!t?.deployId || !config.server || !serverRoute(config.routes, url.pathname)) {
      socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    if (t.env) {
      // A private environment: a viewer's session, from a page of its own origin (another app under the domain is the
      // same site, so its pages' sockets would carry the cookie too), which the app never sees.
      if (!await gate.socketViewer(t, req)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
        return;
      }
      stripRawCookie(cfg, req);
    }
    const status = await runtime.upgrade(appSpec(cfg, store, t), req, socket, head, url.href);
    runtime.logs.push(t.key, "request", `WS ${url.pathname} ${status}`);
  };
}

/**
 * One cron invocation: an internal request the sandbox entry routes to `scheduled()` (runtime/worker.ts).
 * `manual`: Run now (from the studio), which runs a paused cron too.
 */
export function scheduled(cfg: Config, store: Store, runtime: Runtime): RunCron {
  return async (key, cron, at, manual = false) => {
    // `key`: an app's id (production), or an environment's: its crons run on Run now only.
    const t = await resolveKey(store, key);
    // Checked at dispatch: a run queued behind another may outlive a redeploy that dropped the cron, or a pause.
    if (!t?.deployId || !t.app.account_id || !(JSON.parse(t.config).crons ?? []).includes(cron)) return;
    if (!manual && (t.env || pausedCrons(t.app).has(cron))) return;
    const url = appSpec(cfg, store, t).appUrl;
    const startedAt = Date.now(), started = performance.now();
    let status = 0;
    try {
      const res = await runtime.fetch(
        appSpec(cfg, store, t),
        new Request(`${url}/`, {
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
      const now = await resolveKey(store, key).then((a) => a ?? null, () => undefined);
      if (now !== null) runtime.logs.push(key, "system", `cron "${cron}"${manual ? " (run now)" : ""} ${ok ? "ok" : `failed (${status || "error"})`} ${ms}ms`);
      if (now) runtime.cronRuns.record(key, { cron, at: at.getTime(), startedAt, ms, status, manual }, JSON.parse(now.config).crons ?? []);
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

/** A private environment's session cookie value, if the header has it once (over http another host can add one). */
function oneCookie(req: Request, name: string): string | undefined {
  const all = cookies(req, name);
  return all.length === 1 ? all[0] : undefined;
}

/** The `Cookie` header without the platform's session cookies (the app never sees them). */
function withoutSessionCookie(cfg: Config, header: string): string {
  const names = new Set([pageCookie(cfg), "cresslet_page", "__Host-cresslet_page"]);
  return header.split(";").filter((part) => {
    const i = part.indexOf("=");
    return !(i > 0 && names.has(part.slice(0, i).trim()));
  }).join(";").trim();
}

function stripRawCookie(cfg: Config, req: IncomingMessage) {
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === "cookie") req.rawHeaders[i + 1] = withoutSessionCookie(cfg, req.rawHeaders[i + 1]);
  }
}

/**
 * Staging (any environment but production) is private: its owner, admins, viewers and organization members, signed in
 * through the studio as for a private artifact (a one-time ticket from `POST /v1/apps/:name/envs/:env/view`, then a
 * session cookie for that host only). Unlike an artifact it has a server: every method and WebSocket is gated, the
 * cookie only counts on requests its own pages (or a navigation) send, and it's taken out before the app sees the request.
 */
function envGate(cfg: Config, store: Store) {
  const own = (t: Target) => new URL(appSpec(cfg, store, t).appUrl).origin;
  const viewer = async (t: Target, token: string | undefined) => {
    if (!token) return undefined;
    const acct = await store.pageSession(t.app.id, token, t.env!.id);
    return acct && await store.access(t.app, acct) ? acct : undefined;
  };
  return {
    /** A WebSocket handshake: browsers always send its page's origin; only this environment's own counts. */
    async socketViewer(t: Target, req: IncomingMessage) {
      if (req.headers.origin !== own(t)) return undefined;
      const r = new Request("http://x/", { headers: { cookie: req.headers.cookie ?? "" } });
      return viewer(t, oneCookie(r, pageCookie(cfg)));
    },
    /** A denial (sign in, or not allowed), or the request to serve, its session cookie taken out. */
    async http(t: Target, req: Request): Promise<{ deny: Response } | { req: Request }> {
      const url = new URL(req.url);
      const extra = { "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer", "cache-control": "no-store" };
      const read = req.method === "GET" || req.method === "HEAD";
      const ticket = url.searchParams.get(PAGE_TICKET_PARAM);
      if (ticket !== null && read) {
        url.searchParams.delete(PAGE_TICKET_PARAM);
        const s = await store.redeemPageTicket(t.app.id, ticket, PAGE_SESSION_MS, t.env!.id);
        if (!s || !await store.access(t.app, s.account_id)) {
          return { deny: new Response("This sign-in link expired or was already used. Open the app again.", { status: 403, headers: { "content-type": "text/plain; charset=utf-8", ...extra } }) };
        }
        const secure = cfg.scheme === "https" ? "; Secure" : "";
        const back = "/" + url.pathname.replace(/^[/\\]+/, "") + url.search;
        return {
          deny: new Response(null, {
            status: 303,
            headers: { location: back, "set-cookie": `${pageCookie(cfg)}=${s.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PAGE_SESSION_MS / 1000}${secure}`, ...extra },
          }),
        };
      }
      // Other apps under the domain are the same site: their pages' requests carry the cookie (SameSite=Lax), so it
      // counts only from this origin's own pages, or on a top-level navigation (a link: it reads, it doesn't act).
      const origin = req.headers.get("origin"), site = req.headers.get("sec-fetch-site");
      const navigation = read && req.headers.get("sec-fetch-mode") === "navigate";
      const trusted = (!origin || origin === own(t)) && (!site || site === "same-origin" || site === "none" || navigation);
      if (!trusted || !await viewer(t, oneCookie(req, pageCookie(cfg)))) {
        const page = read && (req.headers.get("sec-fetch-mode") === "navigate" || (req.headers.get("accept") ?? "").includes("text/html"));
        if (page) {
          const login = pageLoginUrl(cfg, `${t.app.name}${ENV_SEP}${t.env!.name}`, url.pathname + url.search);
          return { deny: new Response(null, { status: 302, headers: { location: login, ...extra } }) };
        }
        return { deny: new Response(`${t.env!.name} is private: open it from the studio first.`, { status: 401, headers: { "content-type": "text/plain; charset=utf-8", ...extra } }) };
      }
      const headers = new Headers(req.headers);
      const rest = withoutSessionCookie(cfg, req.headers.get("cookie") ?? "");
      if (rest) headers.set("cookie", rest);
      else headers.delete("cookie");
      const body = read ? null : req.body;
      return { req: new Request(req.url, { method: req.method, headers, body, signal: req.signal, ...(body ? { duplex: "half" } : {}) } as RequestInit) };
    },
  };
}

/** A private environment's response: not cached by anything shared, not indexed. */
function privately(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("cache-control", "private, no-store");
  h.set("x-robots-tag", "noindex, nofollow");
  h.set("referrer-policy", "no-referrer");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

/** `env`: the environment the host names (`<app>--<env>`); null: production (or a custom domain). */
export function host(cfg: Config, store: Store, runtime: Runtime) {
  const servePage = pages(cfg, store);
  const gate = envGate(cfg, store);
  return async (req: Request, appName: string, app?: App, env: string | null = null): Promise<Response> => {
    app ??= await store.appByName(appName);
    if (app?.kind === "page" && !env) return servePage(req, app);
    const t = app && await hostTarget(store, appName, app, env);
    const label = env ? `${appName}${ENV_SEP}${env}` : appName;
    if (!t || !t.deployId) {
      return new Response(`No app named "${label}" is deployed here.`, {
        status: 404,
        headers: { "content-type": "text/plain" },
      });
    }
    if (t.env) {
      const g = await gate.http(t, req);
      if ("deny" in g) return g.deny;
      return privately(await serve(t, g.req));
    }
    return serve(t, req);
  };

  async function serve(t: Target, req: Request): Promise<Response> {
    const url = new URL(req.url);
    const config = JSON.parse(t.config) as { routes?: string[]; server?: boolean };
    const started = performance.now();
    const p = paths(cfg, t.app.id);

    if (config.server && serverRoute(config.routes, url.pathname)) {
      const res = await runtime.fetch(appSpec(cfg, store, t), req);
      runtime.logs.push(
        t.key,
        "request",
        `${req.method} ${url.pathname} ${res.status} ${Math.round(performance.now() - started)}ms`,
      );
      runtime.metrics.record(t.key, res.status, performance.now() - started);
      return res;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      runtime.metrics.record(t.key, 405);
      return new Response("Method Not Allowed", { status: 405 });
    }
    const res = await serveStatic(req, join(p.deploy(t.deployId!), "public"), url);
    runtime.metrics.record(t.key, res.status);
    return res;
  }
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
