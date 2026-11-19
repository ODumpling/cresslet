// Serves deployed apps on `<name>.<domain>`: static assets, then the app's server for matching routes.
import { stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { serveFile } from "./static.ts";
import { appUrl, type Config, paths } from "./config.ts";
import type { Store } from "./store.ts";
import type { Runtime } from "./runtime.ts";

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

export function host(cfg: Config, store: Store, runtime: Runtime) {
  return async (req: Request, appName: string): Promise<Response> => {
    const app = store.appByName(appName);
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
      const res = await runtime.fetch({
        appId: app.id,
        appName: app.name,
        appUrl: appUrl(cfg, app.name),
        deployId: app.current_deploy_id,
        secrets: () => store.secrets(app.id),
        // Outbound network is only for claimed apps (enforced by the sandbox).
        net: !!app.account_id,
        egress: app.egress ? JSON.parse(app.egress) : null,
      }, req);
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
