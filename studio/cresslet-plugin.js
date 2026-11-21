// Registers the `cresslet` command inside cresslet-container so `cresslet dev|build|deploy`
// behave like the real CLI, entirely in the browser.
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

function toBase64(bytes) {
  if (bytes.toBase64) return bytes.toBase64();
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * @param {import("./vendor/cresslet-container/index").Container} c
 * @param {{ auth: () => { token?: string|null }, project: () => any, onDeployed?: (r: any) => void,
 *   approveDeploy?: (signal: AbortSignal) => Promise<boolean> }} opts
 *   approveDeploy: asked before `cresslet deploy` runs in a command the AI builder started (CRESSLET_AI_BUILDER set);
 *   without it, such deploys are refused.
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
    });
    const out = r.outputFiles.find((f) => f.path.endsWith(".js")) ?? r.outputFiles[0];
    return out.text ?? dec.decode(out.contents);
  }

  async function build(log = () => {}) {
    const t = performance.now();
    const r = await c.build({ root: wd, outDir: "dist" });
    const server = await bundleServer();
    if (server) await c.fs.writeFile(p(".cresslet/build/server.js"), server);
    log(`built ${r.files.length} files${server ? " + server" : ""} in ${Math.round(performance.now() - t)}ms`);
    return { files: r.files, server };
  }

  async function deploy(log = () => {}, signal = undefined) {
    const cfg = await config();
    const { files: built, server } = await build(log);
    signal?.throwIfAborted();
    const files = [];
    for (const f of built) {
      const abs = f.startsWith("/") ? f : p(`dist/${f}`);
      const rel = abs.startsWith(p("dist/")) ? abs.slice(p("dist/").length) : f;
      const bytes = await c.fs.readFile(abs);
      files.push({ path: rel, data: toBase64(typeof bytes === "string" ? enc.encode(bytes) : bytes), encoding: "base64" });
    }
    const project = opts.project();
    const headers = { "content-type": "application/json" };
    const token = opts.auth().token;
    if (token) headers.authorization = `Bearer ${token}`;
    if (project?.deploy?.deployKey) headers["x-cresslet-deploy-key"] = project.deploy.deployKey;
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
      app: project?.deploy?.name ?? (cfg.name || undefined),
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
    if (!cfg.name) {
      await c.fs.writeFile(p("cresslet.json"), JSON.stringify({ ...cfg, name: body.app.name }, null, 2) + "\n");
    }
    log(`deployed ${body.app.name} → ${body.app.url}`);
    if (body.deploy?.warning) log(`warning: ${body.deploy.warning}`);
    if (!body.app.claimed) log(`unclaimed: expires ${new Date(body.app.expiresAt).toLocaleString()}. Log in to keep it.`);
    opts.onDeployed?.(body);
    return body;
  }

  // ---- dev: container dev server for the client, a project Worker (on the preview origin) for the server handler
  async function dev(ctx, port) {
    const out = (s) => ctx.stdout.write(s.replace(/\n/g, "\r\n") + "\r\n");
    const cfg = await config();
    const routes = cfg.routes ?? ["/api/*"];
    const dbPath = p(".cresslet/dev/db.sqlite");
    const filesDir = p(".cresslet/dev/files");
    let worker = null;
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
        code = await bundleServer();
      } catch (e) {
        workerError = `server build failed:\n${e.message}`;
        out(`\x1b[31m${workerError}\x1b[0m`);
        return;
      }
      if (!code) return;
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
      w.postMessage({
        type: "init",
        code,
        secrets,
        db,
        app: { id: "studio", name: cfg.name || "preview", url: location.origin, deployId: "dev" },
      });
      try {
        await ready;
        if (stopped || seq < readySeq) return w.terminate(); // dev ended, or a later save's worker got ready first
        readySeq = seq;
        retire(worker, 1012, "server restarting", "server restarted");
        worker = w;
        workerError = null;
        out("\x1b[32m✔\x1b[0m server ready");
      } catch (e) {
        w.terminate();
        if (seq < readySeq) return; // a later save's worker serves already
        workerError = `server failed to start:\n${e.message}`;
        out(`\x1b[31m${workerError}\x1b[0m`);
      }
    }

    async function middleware(req) {
      const url = new URL(req.url);
      // Preview URLs are prefixed (/__cresslet__/<id>/<port>/…); match on the app-relative path.
      const path = url.pathname.replace(/^\/__cresslet__\/[^/]+\/\d+/, "") || "/";
      if (!routes.some((r) => matchRoute(r, path)) || !(await serverEntry())) return undefined;
      const id = ++reqId;
      const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
      // after reading the body: the worker may have stopped meanwhile
      const w = worker;
      const unavailable = () =>
        new Response(workerError ?? "server is starting", { status: 503, headers: { "content-type": "text/plain" } });
      if (!w) return unavailable();
      const appUrl = new URL(path + url.search, cfg.name ? `https://${cfg.name}.preview` : location.origin);
      // A WebSocket's `req.headers` (from cresslet-container) has Upgrade and the Sec-WebSocket-* headers.
      const res = await new Promise((resolve) => {
        waiting.set(id, { w, done: resolve });
        w.postMessage(
          { type: "request", id, url: appUrl.href, method: req.method, headers: [...req.headers], body },
          body ? [body] : [],
        );
      });
      out(`\x1b[2m${req.method} ${path} ${res.status}\x1b[0m`);
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
      return new Response(res.status === 204 || res.status === 304 ? null : res.body, { status: res.status, headers: res.headers });
    }

    await startWorker();
    let timer;
    const watcher = c.fs.watch(p("server"), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => startWorker(), 150);
    });
    const server = await c.createDevServer({ root: wd, port, middleware });
    out(`\x1b[32m✔\x1b[0m dev server on port ${port}`);
    await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
    stopped = true;
    clearTimeout(timer);
    watcher.close();
    server.close();
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
        if (ctx.env.CRESSLET_AI_BUILDER && !(await opts.approveDeploy?.(ctx.signal))) {
          err("deploy not approved by the user");
          return 1;
        }
        await deploy(out, ctx.signal);
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
