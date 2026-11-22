// The studio's build (docs/typescript.md): a TanStack Start app in SPA mode, built by Vite into dist/client
// (a prerendered shell, _shell.html, plus content-hashed assets) and served by the server (server/studio.ts).
// Files the container, the preview origin and the page load by URL at runtime stay at stable URLs, as they are:
// cresslet-container (its workers resolve beside it), the SDK source, and the preview server worker and Start
// compiler service (their types stripped, nothing else). See STATIC below.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { stripTypes } from "../server/strip.ts";

const ROOT = import.meta.dirname;
const CONTAINER = "vendor/cresslet-container";
const CONTAINER_URL = `/${CONTAINER}/cresslet-container.js`;

/** A file served as is at a stable URL (`url`), from `src` (types stripped if it's TypeScript). */
interface StaticFile {
  url: string;
  src: string;
}

/** Every stable-URL file: the container's dist (no .d.ts, no types/), the SDK, the two TypeScript workers. */
async function staticFiles(): Promise<StaticFile[]> {
  const container = (await readdir(join(ROOT, CONTAINER))).filter((f) => /\.(?:js|map|html)$/.test(f));
  return [
    ...container.map((f) => ({ url: `/${CONTAINER}/${f}`, src: join(ROOT, CONTAINER, f) })),
    { url: "/vendor/cresslet-sdk.js", src: join(ROOT, "vendor/cresslet-sdk.js") },
    { url: "/server-worker.js", src: join(ROOT, "server-worker.ts") },
    { url: "/start-service.js", src: join(ROOT, "start-service.ts") },
  ];
}
const contents = async (f: StaticFile) => {
  const text = await readFile(f.src, "utf8");
  return f.src.endsWith(".ts") ? stripTypes(text) : text;
};
const TYPES: Record<string, string> = { js: "text/javascript", map: "application/json", html: "text/html" };

/**
 * The stable-URL files: served before Vite's own middleware in dev (so it doesn't rewrite them), emitted as is into
 * the client build.
 */
function studioStatic(): Plugin {
  return {
    name: "cresslet-studio-static",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = new URL(req.url ?? "/", "http://x").pathname;
        const f = (await staticFiles()).find((s) => s.url === path);
        if (!f) return next();
        try {
          const body = await contents(f);
          res.setHeader("content-type", `${TYPES[path.split(".").pop()!] ?? "text/plain"}; charset=utf-8`); // a url has an extension
          res.end(body);
        } catch (e) {
          next(e);
        }
      });
    },
    async generateBundle() {
      if (this.environment.name !== "client") return;
      for (const f of await staticFiles()) this.emitFile({ type: "asset", fileName: f.url.slice(1), source: await contents(f) });
    },
  };
}

/** A hash of every stable-URL file: their URLs carry it (`?v=`), so each build's page asks for its own. */
async function staticVersion() {
  const h = createHash("sha256");
  for (const f of await staticFiles()) h.update(f.url).update("\0").update(await contents(f)).update("\0");
  return h.digest("hex").slice(0, 12);
}

export default defineConfig(async ({ command }) => {
  const version = command === "build" ? await staticVersion() : "dev";
  const containerUrl = `${CONTAINER_URL}?v=${version}`;
  return {
    root: ROOT,
    define: { __STUDIO_STATIC__: JSON.stringify(version) },
    publicDir: "public",
    plugins: [
      studioStatic(),
      // Rendered in the browser only (IndexedDB, the token in localStorage, the container): the root route
      // is ssr: false, so the prerendered shell is the document and nothing else.
      // installDevServerMiddleware: in dev, Vite runs in middleware mode inside the server (server/studio.ts).
      tanstackStart({ spa: { enabled: true }, vite: { installDevServerMiddleware: true } }),
      react(),
    ],
    resolve: {
      // The page imports cresslet-container by its stable URL, so it isn't bundled either: one copy, whose
      // `new URL("./node-worker.js", import.meta.url)` finds its worker.
      alias: [{ find: /^(?:\.\.?\/)+vendor\/cresslet-container\/cresslet-container\.js$/, replacement: containerUrl }],
    },
    // Start prerenders the shell through a preview server it fetches by its URL: an address, not `localhost`, which
    // some hosts (Docker) resolve to ::1 for one and 127.0.0.1 for the other.
    preview: { host: "127.0.0.1" },
    build: {
      chunkSizeWarningLimit: 4096, // the editor and terminal bundles
      rolldownOptions: { external: [containerUrl] },
    },
  };
});
