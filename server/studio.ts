// The studio's pages and files on the root host: its Vite build (studio/dist/client, `npm run build`), or, in dev
// (CRESSLET_STUDIO_DEV=1, `npm run dev`), Vite itself in middleware mode on this server, so /v1, the app hosts and the
// preview host stay where they are. docs/typescript.md has the build.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { serveDir } from "./static.ts";

export const STUDIO_SRC = join(import.meta.dirname, "../studio");
export const STUDIO_DIST = join(STUDIO_SRC, "dist/client");
/** The prerendered SPA shell (TanStack Start `spa.prerender`): the document for every studio page (`/`, `/p/<id>`, …). */
const SHELL = "_shell.html";

/** Cross-origin isolation is required by cresslet-container (SharedArrayBuffer). */
export const ISOLATION = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
};
/** Nothing frames the studio: an app's page could otherwise overlay it (e.g. its CLI login). */
const NO_FRAMING = "frame-ancestors 'none'";

/**
 * What a page from an earlier release gets for a script that's gone (its entry under the old `/_v/<hash>/`
 * scheme, or a hashed asset a later build replaced): a reload into the current release. A CDN can keep serving the
 * old document past the origin's `no-cache` (Cloudflare's Browser Cache TTL rewrites it to `max-age=14400`), so the
 * reload goes to `/?_r=<release>`, a URL the old document never had; the new one drops `_r` again (src/router.tsx).
 * Once at that URL it stops, rather than loop on a cache that ignores the query too.
 */
const reloadModule = (release: string) => `// This page is from an earlier release of the studio: load the current one.
const u = new URL(location.href);
if (u.searchParams.get("_r") !== ${JSON.stringify(release)}) {
  u.searchParams.set("_r", ${JSON.stringify(release)});
  location.replace(u.pathname + u.search + u.hash);
} else console.error("cresslet: this page is from an earlier release and reloading didn't get the current one; clear the cache and reload");
`;
/** The pre-build scheme's release prefix (each release's modules lived under its own `/_v/<hash>/`). */
const VERSIONED = /^\/_v\/[0-9a-f]+\//;

export interface Studio {
  /**
   * A studio request. `node`: the raw request and response, for Vite in dev; given that, it may answer through them
   * and resolve to null.
   */
  serve(req: Request, node?: { incoming: IncomingMessage; outgoing: ServerResponse }): Promise<Response | null>;
  close(): Promise<void>;
}

/** `dev`: serve through Vite (needs the devDependencies; `host`: the studio's hostname); else the build in `dist`. */
export async function studio({ dev = false, dist = STUDIO_DIST, host = "localhost" } = {}): Promise<Studio> {
  return dev ? devStudio(host) : builtStudio(dist);
}

function builtStudio(dist: string): Studio {
  if (!existsSync(join(dist, SHELL))) {
    console.warn(`cresslet: the studio isn't built (no ${join(dist, SHELL)}): run npm run build, or npm run dev`);
  }
  let shell: Promise<{ html: string; release: string }> | undefined;
  const load = () => shell ??= readFile(join(dist, SHELL), "utf8").then((html) => ({
    html,
    release: createHash("sha256").update(html).digest("hex").slice(0, 12),
  }), (e) => {
    shell = undefined; // built later: try again
    throw e;
  });

  const page = async (req: Request) => {
    let html;
    try {
      ({ html } = await load());
    } catch {
      return new Response("The studio isn't built: run npm run build.", { status: 503, headers: { "content-type": "text/plain", ...ISOLATION } });
    }
    return new Response(req.method === "HEAD" ? null : html, {
      // vary: a route's path (`/settings`) is the shell for a page load, a 404 for anything else that asks for it.
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "content-security-policy": NO_FRAMING, vary: "accept", ...ISOLATION },
    });
  };

  return {
    async serve(req) {
      const url = new URL(req.url);
      let path = url.pathname;
      if (path === "/" || path === "/index.html") return page(req);
      const old = VERSIONED.exec(path);
      if (old) {
        path = path.slice(old[0].length - 1);
        // The old entry module: reload into this release. Anything else it asks for (an old page still open loads its
        // workers and vendored files lazily) is served from this release if it's still at that URL.
        if (path === "/app.js") return reload(req, (await load().catch(() => ({ release: "" }))).release);
      }
      const res = await serveDir(path === url.pathname ? req : new Request(new URL(path + url.search, url), req), dist);
      if (res.status === 404 && /^\/assets\/.+\.js$/.test(path)) return reload(req, (await load().catch(() => ({ release: "" }))).release);
      // Not a file: a page load of a studio route (`/artifacts`, `/p/<id>`) gets the shell, whose router shows it (or
      // goes home, for a path that's no route). Anything else (a script, an image, fetch) gets the 404.
      if (res.status === 404 && !old && isPageLoad(req)) return page(req);
      const h = new Headers(res.headers);
      if (res.status === 404) h.set("vary", "accept");
      for (const [k, v] of Object.entries(ISOLATION)) h.set(k, v);
      // Content-hashed: a new build never reuses the URL. The rest (stable URLs) revalidate every time.
      h.set("cache-control", (res.ok || res.status === 304) && path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
      if (h.get("content-type")?.startsWith("text/html")) h.set("content-security-policy", NO_FRAMING);
      return new Response(res.body, { status: res.status, headers: h });
    },
    async close() {},
  };
}

/** A browser loading a page (a navigation asks for HTML), not a script, an image or a fetch asking for a file. */
const isPageLoad = (req: Request) =>
  (req.method === "GET" || req.method === "HEAD") && (req.headers.get("accept") ?? "").includes("text/html");

function reload(req: Request, release: string): Response {
  return new Response(req.method === "HEAD" ? null : reloadModule(release), {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", ...ISOLATION },
  });
}

async function devStudio(host: string): Promise<Studio> {
  // A devDependency: only loaded here.
  const { createServer } = await import("vite");
  const hmrPort = Number(process.env.CRESSLET_HMR_PORT) || 24678;
  const vite = await createServer({
    configFile: join(STUDIO_SRC, "vite.config.ts"),
    root: STUDIO_SRC,
    // HMR on Vite's own WebSocket port (CRESSLET_HMR_PORT, default 24678), not this server's; a cache per port, so
    // two dev servers (say, two checkouts' e2e runs) don't share one.
    // Files Vite may serve (/@fs/…): the studio's own and its dependencies, never the data dir or the server.
    // The studio's own host (the server redirects others to it before they get here; this covers the HMR socket too).
    server: { middlewareMode: true, allowedHosts: [host], hmr: { port: hmrPort }, fs: { strict: true, allow: [STUDIO_SRC, join(STUDIO_SRC, "../node_modules")] } },
    cacheDir: join(STUDIO_SRC, `../node_modules/.vite/studio-${hmrPort}`),
    appType: "custom",
  });
  return {
    async serve(req, node) {
      if (!node) return new Response("The studio's dev server needs the Node request", { status: 500 });
      // Under Vite, the shell is at / (Start renders it); the pre-build entry reloads into it.
      if (VERSIONED.test(new URL(req.url).pathname)) {
        return new Response(reloadModule("dev"), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", ...ISOLATION } });
      }
      const { incoming, outgoing } = node;
      for (const [k, v] of Object.entries(ISOLATION)) outgoing.setHeader(k, v);
      outgoing.setHeader("cache-control", "no-cache");
      outgoing.setHeader("content-security-policy", NO_FRAMING);
      await new Promise<void>((resolve) => {
        outgoing.once("finish", resolve).once("close", resolve);
        vite.middlewares(incoming, outgoing, () => {
          outgoing.statusCode = 404;
          outgoing.end("Not Found");
        });
      });
      return null;
    },
    close: () => vite.close(),
  };
}
