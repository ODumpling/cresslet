// Registers the `cresslet` command inside cresslet-container so `cresslet dev|build|deploy`
// behave like the real CLI, entirely in the browser.
import { createStartBuilder, isStartApp } from "./start-build.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

export function matchRoute(pattern, p) {
  if (pattern === "*" || pattern === "/*") return true;
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2);
    return p === base || p.startsWith(base + "/");
  }
  return p === pattern;
}

/** Same as server/host.ts serverRoute: a `routes` match and no `!pattern` exclusion. */
export function serverRoute(routes, p) {
  let hit = false;
  for (const r of routes ?? ["/api/*"]) {
    if (r.startsWith("!")) {
      if (matchRoute(r.slice(1), p)) return false;
    } else if (!hit) hit = matchRoute(r, p);
  }
  return hit;
}

export function parseDotenv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = /^(['"]).*\1$/.test(m[2]) ? m[2].slice(1, -1) : m[2];
  }
  return out;
}

// Keep in sync with server/deploys.ts (NOT_SOURCE, DOTENV, publicDotenv).
const NOT_SOURCE = /(?:^|\/)(?:node_modules|\.git|\.cresslet|\.env[^/]*)\/|^dist\/|(?:^|\/)\.env[^/]*(?:local|cresslet)[^/]*$|(?:^|\/)(?:\.envrc[^/]*|\.dev\.vars(?:[._-][^/]*)?)$/i;
// Any .env-prefixed file (sanitized: only public entries kept).
const DOTENV = /(?:^|\/)\.env[^/]*$/i;
/**
 * Same as server/deploys.ts publicDotenvText. Fail closed: dotenv parsers differ (multi-line quotes, escapes, values starting on the next line, `KEY: v`), so
 * only lines that every parser reads as one complete single-line entry are understood: `NAME=value`, a non-empty
 * unquoted value or a backslash-free single-line '…' / "…", optional `# comment`. Public ones (CRESSLET_PUBLIC_*,
 * VITE_*) are kept verbatim, comments are dropped, and the first line not understood ends the file.
 */
const SAFE_ENTRY = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][\w.-]*)[ \t]*=[ \t]*(?:[^\s"'\x60\\#][^"'\x60\\\r\n#]*|"[^"\\\r\n]*"|'[^'\\\r\n]*')[ \t]*(?:#[^"'\x60\\\r\n]*)?$/;
export function publicDotenv(text) {
  const out = [];
  for (const l of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (/[\r\u2028\u2029]/.test(l)) break; // a line break to some parsers, not to others
    if (/^[ \t]*$/.test(l)) out.push(l);
    else if (!/^[ \t]*#/.test(l)) {
      const m = SAFE_ENTRY.exec(l);
      if (!m) break; // anything else may open a value that runs on: drop it and the rest
      if (/^(?:CRESSLET_PUBLIC_|VITE_)/.test(m[1])) out.push(l);
    }
  }
  return out.join("\n");
}

/**
 * `import ... from "cresslet"` in server code: the SDK the studio ships (vendor/cresslet-sdk.js, `npm run vendor:sdk`),
 * as a virtual module, not the project's node_modules/cresslet (the CLI package: esbuild & co., maybe not installed
 * yet, maybe another version than this studio's preview and platform).
 */
let sdkSource;
const sdkPlugin = {
  name: "cresslet-sdk",
  setup(b) {
    b.onResolve({ filter: /^cresslet$/ }, () => ({ path: "cresslet", namespace: "cresslet-sdk" }));
    b.onLoad({ filter: /.*/, namespace: "cresslet-sdk" }, async () => {
      sdkSource ??= fetch(new URL("./vendor/cresslet-sdk.js", import.meta.url)).then((r) => {
        if (!r.ok) throw new Error(`cresslet SDK: ${r.status}`);
        return r.text();
      });
      try {
        return { contents: await sdkSource, loader: "js" };
      } catch (e) {
        sdkSource = undefined; // retry on the next build
        throw e;
      }
    });
  },
};

const CONTENT_TYPES = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8", json: "application/json", map: "application/json", txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", wasm: "application/wasm",
};

function toBase64(bytes) {
  if (bytes.toBase64) return bytes.toBase64();
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * @param {import("./vendor/cresslet-container/index").Container} c
 * @param {{ auth: () => { token?: string|null }, project: () => any, onDeployed?: (r: any) => void,
 *   builderRunning?: () => boolean, approveDeploy?: (target: string|null, signal: AbortSignal) => Promise<boolean> }} opts
 *   approveDeploy: asked before `cresslet deploy` runs while the AI builder runs a command (builderRunning), or in a
 *   process it started (CRESSLET_AI_BUILDER set); without it, such deploys are refused. target: the app it deploys
 *   to, null for a new one.
 */
export function createCresslet(c, opts) {
  const wd = c.workdir;
  const p = (rel) => `${wd}/${rel}`;

  async function readText(rel) {
    try {
      return await c.fs.readFile(p(rel), "utf8");
    } catch {
      return null;
    }
  }

  async function config() {
    const raw = await readText("cresslet.json");
    try {
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      throw new Error(`invalid cresslet.json: ${e.message}`);
    }
  }

  /** A TanStack Start app (start-build.js): its own client and server build. */
  async function startApp() {
    try {
      return isStartApp(JSON.parse((await readText("package.json")) ?? "{}"));
    } catch {
      return false;
    }
  }

  async function serverEntry() {
    for (const f of ["server/index.ts", "server/index.tsx", "server/index.js", "server/index.mjs"]) {
      if (await c.fs.exists(p(f))) return p(f);
    }
    return null;
  }

  async function bundleServer() {
    const entry = await serverEntry();
    if (!entry) return null;
    const r = await c.bundle({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      mainFields: ["module", "main"],
      conditions: ["worker", "browser", "import", "default"],
      external: ["node:*"],
      outfile: p(".cresslet/build/server.js"),
      write: false,
      plugins: [sdkPlugin],
    });
    const out = r.outputFiles.find((f) => f.path.endsWith(".js")) ?? r.outputFiles[0];
    return out.text ?? dec.decode(out.contents);
  }

  /** → { files: absolute paths, outDir: where the static files are (relative), server: code|null } */
  async function build(log = () => {}) {
    const t = performance.now();
    if (await startApp()) {
      const builder = createStartBuilder(c, { sdkPlugin });
      try {
        const r = await builder.build();
        await c.fs.writeFile(p(".cresslet/build/server.js"), r.server);
        log(`built ${r.files.length} files + server (TanStack Start) in ${Math.round(performance.now() - t)}ms`);
        return { files: r.files, outDir: r.outDir, server: r.server };
      } finally {
        builder.close();
      }
    }
    const r = await c.build({ root: wd, outDir: "dist" });
    const server = await bundleServer();
    if (server) await c.fs.writeFile(p(".cresslet/build/server.js"), server);
    log(`built ${r.files.length} files${server ? " + server" : ""} in ${Math.round(performance.now() - t)}ms`);
    return { files: r.files, outDir: "dist", server };
  }

  /** Where a deploy goes: the project's app (and its deploy key), else cresslet.json's name, else a new app. */
  const targetOf = (cfg) => {
    const d = opts.project()?.deploy;
    return { app: d?.name ?? (cfg.name || undefined), deployKey: d?.deployKey };
  };

  /** `cfg`, `target`: read before an approval, so the app it named is the one deployed to. */
  async function deploy(log = () => {}, signal = undefined, cfg = undefined, target = undefined) {
    cfg ??= await config();
    target ??= targetOf(cfg);
    const { files: built, outDir, server } = await build(log);
    signal?.throwIfAborted();
    const files = [];
    const out = p(`${outDir}/`);
    for (const f of built) {
      const abs = f.startsWith("/") ? f : out + f;
      const rel = abs.startsWith(out) ? abs.slice(out.length) : f;
      const bytes = await c.fs.readFile(abs);
      files.push({ path: rel, data: toBase64(typeof bytes === "string" ? enc.encode(bytes) : bytes), encoding: "base64" });
    }
    const headers = { "content-type": "application/json" };
    const token = opts.auth().token;
    if (token) headers.authorization = `Bearer ${token}`;
    if (target.deployKey) headers["x-cresslet-deploy-key"] = target.deployKey;
    // Project source too, so the CLI (`cresslet pull`) or another browser can open it. Never local secrets.
    const sources = [];
    const walk = (tree, prefix) => {
      for (const [name, node] of Object.entries(tree)) {
        // Same path form as the server's check (it normalizes "\\" to "/").
        const rel = (prefix ? `${prefix}/${name}` : name).replace(/\\/g, "/");
        if (node.directory) walk(node.directory, rel);
        // Regular files only (symlinks have no contents); same secret rules as the server, applied here
        // so local secrets never leave the browser.
        else if (node.file && "contents" in node.file && !NOT_SOURCE.test(rel)) {
          let v = node.file.contents;
          if (DOTENV.test(rel)) v = publicDotenv(typeof v === "string" ? v : dec.decode(v));
          sources.push(typeof v === "string" ? { path: rel, data: v } : { path: rel, data: toBase64(v), encoding: "base64" });
        }
      }
    };
    walk(await c.export(wd, { excludes: ["node_modules/**", "dist/**", ".cresslet/**", ".git/**"] }), "");
    log(`uploading ${files.length} files…`);
    const payload = {
      app: target.app,
      ...(target.create ? { create: true } : {}), // a new app only: never a deploy over one that took the name meanwhile
      files,
      server,
      config: { routes: cfg.routes, crons: cfg.crons },
      source: "studio",
      sources,
    };
    let res = await fetch("/v1/deploys", { method: "POST", headers, body: JSON.stringify(payload), signal });
    let body = await res.json();
    if (res.status === 413 && body?.error === "body_too_large" && sources.length) {
      log("warning: project source omitted (request exceeded server upload limit)");
      res = await fetch("/v1/deploys", { method: "POST", headers, body: JSON.stringify({ ...payload, sources: undefined }), signal });
      body = await res.json();
    }
    if (!res.ok) throw new Error(body.message ?? `deploy failed (${res.status})`);
    // A new app's name into cresslet.json as it is now (it may have been edited since it was read); a name the user
    // removed meanwhile isn't put back.
    const now = await config().catch(() => null);
    if (!cfg.name && now && !now.name) await c.fs.writeFile(p("cresslet.json"), JSON.stringify({ ...now, name: body.app.name }, null, 2) + "\n");
    log(`deployed ${body.app.name} → ${body.app.url}`);
    if (body.deploy?.warning) log(`warning: ${body.deploy.warning}`);
    if (!body.app.claimed) log(`unclaimed: expires ${new Date(body.app.expiresAt).toLocaleString()}. Log in to keep it.`);
    opts.onDeployed?.(body);
    return body;
  }

  // ---- dev: container dev server for the client, a project Worker (on the preview origin) for the server handler.
  // TanStack Start apps: their production build (start-build.js), rebuilt on save (the preview then reloads itself).
  async function dev(ctx, port) {
    const out = (s) => ctx.stdout.write(s.replace(/\n/g, "\r\n") + "\r\n");
    const cfg = await config();
    const routes = cfg.routes ?? ["/api/*"];
    const start = await startApp();
    const builder = start ? createStartBuilder(c, { sdkPlugin }) : null;
    let building = Promise.resolve(); // one Start build at a time (each rewrites dist/)
    const serverCode = start
      ? () => {
        const t = performance.now();
        // the serving worker's pages load its build's bundles: they stay until another worker serves
        const run = building.catch(() => {}).then(() => builder.build({ preview: true, keep: activeBundles }));
        building = run;
        return run.then((r) => (out(`\x1b[2mbuilt in ${Math.round(performance.now() - t)}ms\x1b[0m`), (lastBundles = r.bundles), r.server));
      }
      : bundleServer;
    let activeBundles = new Set(); // Start: the bundles of the build the serving worker runs
    let lastBundles = new Set();
    const hasServer = start ? async () => true : serverEntry;
    // Start apps have no HMR: their pages reload when a rebuild is ready (keeping the page they're on)
    const reloadChannel = `cresslet:${c.instanceId}:${port}`;
    const reloads = start ? c.previewChannel(reloadChannel) : null;
    const RELOAD_SCRIPT = `<script>new BroadcastChannel(${JSON.stringify(reloadChannel)}).onmessage = (e) => e.data?.type === "cresslet-start-reload" && location.reload();</script>`;
    const withReload = (html) => (html.includes("</head>") ? html.replace("</head>", `${RELOAD_SCRIPT}</head>`) : html + RELOAD_SCRIPT);
    const dbPath = p(".cresslet/dev/db.sqlite");
    const filesDir = p(".cresslet/dev/files");
    let worker = null;
    const initializing = new Set(); // workers not ready yet (stopped with dev too)
    // (stopped while it started: the signal may have fired already)
    const aborted = new Promise((resolve) => (ctx.signal.aborted ? resolve() : ctx.signal.addEventListener("abort", resolve, { once: true })));
    let workerError = null;
    let reqId = 0;
    let starts = 0; // startWorker calls
    let readySeq = 0; // the start whose worker serves now
    let stopped = false; // `cresslet dev` ended
    const waiting = new Map(); // request id → { w, done }

    async function fileOp(m) {
      const indexPath = `${filesDir}/index.json`;
      const index = JSON.parse((await readText(".cresslet/dev/files/index.json")) ?? "{}");
      const key = String(m.key ?? "").replace(/^\/+/, "");
      if (m.op !== "list" && (!key || key.split("/").includes(".."))) throw new Error(`invalid file key: ${m.key}`);
      if (m.op === "put") {
        await c.fs.writeFile(`${filesDir}/blobs/${key}`, m.bytes);
        index[key] = { size: m.bytes.byteLength, contentType: m.contentType, updatedAt: Date.now() };
        await c.fs.writeFile(indexPath, JSON.stringify(index));
        return {};
      }
      if (m.op === "get") {
        if (!index[key]) return { found: false };
        const bytes = await c.fs.readFile(`${filesDir}/blobs/${key}`);
        return { found: true, bytes, contentType: index[key].contentType };
      }
      if (m.op === "delete") {
        delete index[key];
        await c.fs.rm(`${filesDir}/blobs/${key}`, { force: true });
        await c.fs.writeFile(indexPath, JSON.stringify(index));
        return {};
      }
      if (m.op === "list") {
        const prefix = m.prefix ?? "";
        return {
          items: Object.entries(index).filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => ({ key: k, ...v })),
        };
      }
      throw new Error(`unknown op ${m.op}`);
    }

    // Preview WebSockets stay here, bridged to the worker over a channel, so they can be closed even when their
    // worker can't do it (restarted, crashed, stuck in app code): clients then reconnect as after a redeploy.
    // Protocol (cresslet-container's upgradeWebSocket): whoever sends `close` is done with the port; whoever gets it closes it.
    const sockets = new Map(); // worker → Set of functions that close one of its sockets
    function bridge(w, socket) {
      const { port1, port2 } = new MessageChannel();
      const own = sockets.get(w) ?? sockets.set(w, new Set()).get(w);
      const end = (code, reason) => {
        own.delete(end);
        port1.close();
        socket.postMessage({ type: "close", code, reason });
      };
      own.add(end);
      // Messages from the preview and the app are untrusted: pass on only well-formed ones.
      const pipe = (from, to) => (from.onmessage = ({ data: d }) => {
        if (d?.type === "message" && (typeof d.data === "string" || d.data instanceof ArrayBuffer)) {
          to.postMessage({ type: "message", data: d.data }, typeof d.data === "string" ? [] : [d.data]);
        } else if (d?.type === "close") {
          own.delete(end);
          from.close();
          to.postMessage({ type: "close", code: Number.isInteger(d.code) ? d.code : undefined, reason: typeof d.reason === "string" ? d.reason : undefined });
        }
      });
      pipe(socket, port1);
      pipe(port1, socket);
      return port2;
    }

    // Terminates a worker: its WebSockets get `close` and its unanswered requests a 503.
    function retire(w, code, reason, message) {
      if (!w) return;
      for (const end of sockets.get(w) ?? []) end(code, reason);
      sockets.delete(w);
      const body = () => new TextEncoder().encode(message).buffer;
      for (const [id, r] of waiting) {
        if (r.w === w) (waiting.delete(id), r.done({ status: 503, headers: [["content-type", "text/plain"]], body: body() }));
      }
      w.terminate();
    }

    async function startWorker() {
      const seq = ++starts;
      let code;
      try {
        code = await serverCode();
      } catch (e) {
        workerError = `server build failed:\n${e.message}`;
        out(`\x1b[31m${workerError}\x1b[0m`);
        return;
      }
      if (!code) return;
      const bundles = lastBundles;
      let db = null;
      try {
        db = await c.fs.readFile(dbPath);
      } catch { /* fresh db */ }
      const secrets = parseDotenv((await readText(".env.cresslet")) ?? "");
      // On the preview origin (cresslet-container runs project workers there), so server code can't open the
      // studio's IndexedDB (every local project's files).
      let w;
      try {
        w = await c.projectWorker(new URL("./server-worker.js", import.meta.url), { name: "cresslet-server" });
        if (stopped) return w.terminate(); // dev ended meanwhile
      } catch (e) {
        workerError = `server failed to start:\n${e.message}`;
        out(`\x1b[31m${workerError}\x1b[0m`);
        return;
      }
      const ready = new Promise((resolve, reject) => {
        // The worker catches and logs its own errors (server-worker.js): one that gets here means it's gone (e.g.
        // the preview relay restarted). Fail its requests and the next ones until a server file is saved or
        // `cresslet dev` is rerun (both start a new worker).
        w.onerror = (e) => {
          reject(new Error(e.message));
          if (worker !== w) return;
          worker = null;
          workerError = `server stopped: ${e.message} (save a server file or rerun \`cresslet dev\`)`;
          out(`\x1b[31m${workerError}\x1b[0m`);
          retire(w, 1011, "server stopped", workerError);
        };
        w.onmessage = async ({ data: m }) => {
          if (m.type === "ready") resolve();
          else if (m.type === "fatal") reject(new Error(m.message));
          else if (m.type === "log") out(`${m.level === "error" ? "\x1b[31m" : "\x1b[2m"}[server] ${m.msg}\x1b[0m`);
          else if (m.type === "db") c.fs.writeFile(dbPath, m.bytes);
          else if (m.type === "response") {
            waiting.get(m.id)?.done(m);
            waiting.delete(m.id);
          } else if (m.type === "files") {
            try {
              const r = await fileOp(m);
              w.postMessage({ type: "files-result", id: m.id, ...r });
            } catch (e) {
              w.postMessage({ type: "files-result", id: m.id, error: e.message });
            }
          }
        };
      });
      initializing.add(w);
      w.postMessage({
        type: "init",
        code,
        serial: start, // Start keeps each request's state in AsyncLocalStorage: the preview's has one store at a time
        secrets,
        db,
        app: { id: "studio", name: cfg.name || "preview", url: location.origin, deployId: "dev" },
      });
      try {
        await ready.finally(() => initializing.delete(w));
        if (stopped || seq < readySeq) return w.terminate(); // dev ended, or a later save's worker got ready first
        readySeq = seq;
        retire(worker, 1012, "server restarting", "server restarted");
        worker = w;
        activeBundles = bundles;
        workerError = null;
        out("\x1b[32m✔\x1b[0m server ready");
        reloads?.postMessage({ type: "cresslet-start-reload" }); // a new client build too
      } catch (e) {
        w.terminate();
        if (seq < readySeq) return; // a later save's worker serves already
        workerError = `server failed to start:\n${e.message}`;
        out(`\x1b[31m${workerError}\x1b[0m`);
      }
    }

    // The preview's cookies (an app's session): responses made in its service worker can't set them and its requests
    // don't carry them, so they're kept here for this `cresslet dev` and sent with each request. One jar per preview:
    // name → { value, none: SameSite=None } (Path/Domain don't matter on one origin; Max-Age=0 or a past Expires
    // removes one).
    const jar = new Map();
    function keepCookies(headers) {
      for (const [k, v] of headers) {
        if (k.toLowerCase() !== "set-cookie") continue;
        const [pair, ...attrs] = v.split(";");
        const i = pair.indexOf("=");
        if (i < 1) continue;
        const name = pair.slice(0, i).trim();
        const gone = attrs.some((a) => {
          const [ak, av = ""] = a.split("=").map((x) => x.trim());
          return (/^max-age$/i.test(ak) && /^-?\d+$/.test(av) && Number(av) <= 0) || (/^expires$/i.test(ak) && Date.parse(av) <= Date.now());
        });
        if (gone) jar.delete(name);
        else jar.set(name, { value: pair.slice(i + 1).trim(), none: attrs.some((a) => /^\s*samesite\s*=\s*none\s*$/i.test(a)) });
      }
      return headers.filter(([k]) => k.toLowerCase() !== "set-cookie");
    }

    // Preview URLs are prefixed (/__cresslet__/<id>/<port>/…); match on the app-relative path.
    const appPath = (url) => url.pathname.replace(/^\/__cresslet__\/[^/]+\/\d+/, "") || "/";

    async function middleware(req) {
      const url = new URL(req.url);
      const path = appPath(url);
      if (!serverRoute(routes, path) || !(await hasServer())) return undefined;
      const id = ++reqId;
      const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
      // after reading the body: the worker may have stopped meanwhile
      const w = worker;
      const unavailable = () => {
        const text = workerError ?? "server is starting";
        if (!start) return new Response(text, { status: 503, headers: { "content-type": "text/plain" } });
        const esc = text.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]);
        return new Response(withReload(`<!doctype html><pre>${esc}</pre>`), { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });
      };
      if (!w) return unavailable();
      const appUrl = new URL(path + url.search, cfg.name ? `https://${cfg.name}.preview` : location.origin);
      // A WebSocket's `req.headers` (from cresslet-container) has Upgrade and the Sec-WebSocket-* headers.
      // The preview page's own Origin reads as the app's, as it does deployed, so `Origin === new URL(req.url).origin`
      // checks (against cross-site WebSocket hijacking) pass here too.
      const page = c.previewOrigin ?? location.origin; // where preview pages run
      const headers = [...req.headers].map(([k, v]) => (k.toLowerCase() === "origin" && v === page ? [k, appUrl.origin] : [k, v]));
      // Other requests reach this handler as a `Request` cresslet-container made on this page, which drops the
      // browser's Origin (and Sec-Fetch-Site, Referer). The preview's service worker takes fetches only from preview
      // pages, but also navigations: a page elsewhere (another app on this site, framing the preview's URL) can submit
      // a form here. So the page's own fetches get the app's Origin, as they have deployed, and CSRF checks (TanStack
      // Start's createCsrfMiddleware, `Origin === new URL(req.url).origin`) pass; navigations (Accept: text/html, as
      // browsers send them) that change state get no Origin and only SameSite=None cookies, as a cross-site one would.
      // (The preview's own HTML forms then fail such checks here: use fetch, as server functions do.)
      const unsafe = req.method !== "GET" && req.method !== "HEAD";
      const navigation = unsafe && /^\s*text\/html/i.test(req.headers.get("accept") ?? "");
      if (unsafe && !navigation && !req.headers.has("origin")) headers.push(["origin", appUrl.origin]);
      const cookies = [...jar].filter(([, c]) => !navigation || c.none);
      if (cookies.length && !req.headers.has("cookie")) headers.push(["cookie", cookies.map(([k, c]) => `${k}=${c.value}`).join("; ")]);
      const res = await new Promise((resolve) => {
        waiting.set(id, { w, done: resolve });
        w.postMessage(
          { type: "request", id, url: appUrl.href, method: req.method, headers, body },
          body ? [body] : [],
        );
      });
      out(`\x1b[2m${req.method} ${path} ${res.status}\x1b[0m`);
      if (navigation && res.status >= 400) out(`\x1b[33m${req.method} ${path}: a form submission; in this preview it has no Origin and only SameSite=None cookies (CSRF checks refuse it). Send it with fetch, as server functions do.\x1b[0m`);
      res.headers = keepCookies(res.headers);
      if (res.status === 101) {
        // The app accepted a WebSocket (WebSocketPair): connect the preview's socket to the worker that holds its end.
        if (w !== worker) {
          // replaced meanwhile: refuse, so the client reconnects to the new one
          w.postMessage({ type: "socket", id });
          return unavailable();
        }
        let upgrade;
        try {
          upgrade = c.upgradeWebSocket(req, { protocol: res.protocol });
        } catch (e) {
          w.postMessage({ type: "socket", id }); // the preview gave up meanwhile: the app's end gets `close`
          throw e;
        }
        const port = bridge(w, upgrade.socket);
        w.postMessage({ type: "socket", id }, [port]);
        return upgrade.response;
      }
      if (start && res.body && /^text\/html/i.test(new Headers(res.headers).get("content-type") ?? "")) {
        res.body = enc.encode(withReload(dec.decode(res.body)));
        res.headers = res.headers.filter(([k]) => k.toLowerCase() !== "content-length");
      }
      return new Response(res.status === 204 || res.status === 304 ? null : res.body, { status: res.status, headers: res.headers });
    }

    // Start apps: what isn't a server route is a file of the client build (or public/).
    async function staticFile(req) {
      let rel;
      try {
        rel = decodeURIComponent(appPath(new URL(req.url)));
      } catch {
        return new Response("Bad request", { status: 400 });
      }
      if (rel.split("/").includes("..")) return new Response("Not found", { status: 404 });
      let bytes;
      try {
        bytes = await c.fs.readFile(p(`.cresslet/start/preview${rel}`)); // start-build.js: the preview's build
      } catch {
        return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
      }
      const type = CONTENT_TYPES[rel.split(".").pop().toLowerCase()] ?? "application/octet-stream";
      return new Response(bytes, { headers: { "content-type": type, "cache-control": "no-cache" } });
    }

    await Promise.race([startWorker(), aborted]); // the first build and server (a stuck one doesn't hold up Ctrl+C)
    let timer;
    const rebuild = (_e, f) => {
      if (f && /(?:^|\/)routeTree\.gen\.ts$/.test(f)) return; // the build writes it
      clearTimeout(timer);
      timer = setTimeout(() => startWorker(), start ? 300 : 150);
    };
    const watchers = [];
    for (const dir of start ? ["src", "public"] : ["server"]) {
      try {
        watchers.push(c.fs.watch(p(dir), { recursive: true }, rebuild));
      } catch { /* no such directory */ }
    }
    let server = null;
    if (!ctx.signal.aborted) {
      server = start
        ? c.servePort(port, async (req) => (await middleware(req)) ?? staticFile(req))
        : await c.createDevServer({ root: wd, port, middleware });
      out(`\x1b[32m✔\x1b[0m dev server on port ${port}`);
    }
    await aborted;
    stopped = true;
    clearTimeout(timer);
    for (const w of watchers) w.close();
    for (const w of initializing) w.terminate();
    server?.close();
    builder?.close();
    reloads?.close();
    retire(worker, 1001, "server stopped", "server stopped");
    worker = null;
    return 0;
  }

  c.registerCommand("cresslet", async (ctx) => {
    const [sub, ...args] = ctx.args;
    const out = (s) => ctx.stdout.write(s.replace(/\n/g, "\r\n") + "\r\n");
    const err = (s) => ctx.stderr.write(`\x1b[31m${s.replace(/\n/g, "\r\n")}\x1b[0m\r\n`);
    try {
      if (sub === "dev") {
        const i = args.findIndex((a) => a === "--port" || a === "-p");
        return await dev(ctx, i >= 0 ? Number(args[i + 1]) : 3000);
      }
      if (sub === "build") {
        await build(out);
        return 0;
      }
      if (sub === "deploy") {
        // Started by the AI builder (directly or through a script): the user approves each deploy.
        // (Its own running count, not just the env var: a command can unset that.) The app named is the one deployed
        // to: cresslet.json is read once, before asking.
        const cfg = await config();
        const target = targetOf(cfg);
        if ((opts.builderRunning?.() || ctx.env.CRESSLET_AI_BUILDER) && !(await opts.approveDeploy?.(target.app ?? null, ctx.signal))) {
          err("deploy not approved by the user");
          return 1;
        }
        await deploy(out, ctx.signal, cfg, target);
        return 0;
      }
      out("usage: cresslet dev [--port 3000] | build | deploy\r\n(other commands: use the real CLI: npx cresslet, or npm i -g cresslet)");
      return sub ? 1 : 0;
    } catch (e) {
      err(e.message ?? String(e));
      return 1;
    }
  });

  return { build, deploy, config };
}
