// Registers the `clover` command inside clover-container so `clover dev|build|deploy`
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

function toBase64(bytes) {
  if (bytes.toBase64) return bytes.toBase64();
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * @param {import("./vendor/clover-container/index").Container} c
 * @param {{ auth: () => { token?: string|null }, project: () => any, onDeployed?: (r: any) => void }} opts
 */
export function createClover(c, opts) {
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
    const raw = await readText("clover.json");
    try {
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      throw new Error(`invalid clover.json: ${e.message}`);
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
      outfile: p(".clover/build/server.js"),
      write: false,
    });
    const out = r.outputFiles.find((f) => f.path.endsWith(".js")) ?? r.outputFiles[0];
    return out.text ?? dec.decode(out.contents);
  }

  async function build(log = () => {}) {
    const t = performance.now();
    const r = await c.build({ root: wd, outDir: "dist" });
    const server = await bundleServer();
    if (server) await c.fs.writeFile(p(".clover/build/server.js"), server);
    log(`built ${r.files.length} files${server ? " + server" : ""} in ${Math.round(performance.now() - t)}ms`);
    return { files: r.files, server };
  }

  async function deploy(log = () => {}) {
    const cfg = await config();
    const { files: built, server } = await build(log);
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
    if (project?.deploy?.deployKey) headers["x-clover-deploy-key"] = project.deploy.deployKey;
    log(`uploading ${files.length} files…`);
    const res = await fetch("/v1/deploys", {
      method: "POST",
      headers,
      body: JSON.stringify({
        app: project?.deploy?.name ?? (cfg.name || undefined),
        files,
        server,
        config: { routes: cfg.routes },
        source: "studio",
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.message ?? `deploy failed (${res.status})`);
    if (!cfg.name) {
      await c.fs.writeFile(p("clover.json"), JSON.stringify({ ...cfg, name: body.app.name }, null, 2) + "\n");
    }
    log(`deployed ${body.app.name} → ${body.app.url}`);
    if (!body.app.claimed) log(`unclaimed: expires ${new Date(body.app.expiresAt).toLocaleString()}. Log in to keep it.`);
    opts.onDeployed?.(body);
    return body;
  }

  // ---- dev: container dev server for the client, a Worker for the server handler
  async function dev(ctx, port) {
    const out = (s) => ctx.stdout.write(s.replace(/\n/g, "\r\n") + "\r\n");
    const cfg = await config();
    const routes = cfg.routes ?? ["/api/*"];
    const dbPath = p(".clover/dev/db.sqlite");
    const filesDir = p(".clover/dev/files");
    let worker = null;
    let workerError = null;
    let reqId = 0;
    const waiting = new Map();

    async function fileOp(m) {
      const indexPath = `${filesDir}/index.json`;
      const index = JSON.parse((await readText(".clover/dev/files/index.json")) ?? "{}");
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

    async function startWorker() {
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
      const secrets = parseDotenv((await readText(".env.clover")) ?? "");
      const w = new Worker(new URL("./server-worker.js", import.meta.url), { type: "module" });
      const ready = new Promise((resolve, reject) => {
        w.onmessage = async ({ data: m }) => {
          if (m.type === "ready") resolve();
          else if (m.type === "fatal") reject(new Error(m.message));
          else if (m.type === "log") out(`${m.level === "error" ? "\x1b[31m" : "\x1b[2m"}[server] ${m.msg}\x1b[0m`);
          else if (m.type === "db") c.fs.writeFile(dbPath, m.bytes);
          else if (m.type === "response") {
            waiting.get(m.id)?.(m);
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
        worker?.terminate();
        worker = w;
        workerError = null;
        out("\x1b[32m✔\x1b[0m server ready");
      } catch (e) {
        w.terminate();
        workerError = `server failed to start:\n${e.message}`;
        out(`\x1b[31m${workerError}\x1b[0m`);
      }
    }

    async function middleware(req) {
      const url = new URL(req.url);
      // Preview URLs are prefixed (/__clover__/<id>/<port>/…); match on the app-relative path.
      const path = url.pathname.replace(/^\/__clover__\/[^/]+\/\d+/, "") || "/";
      if (!routes.some((r) => matchRoute(r, path)) || !(await serverEntry())) return undefined;
      if (!worker) {
        return new Response(workerError ?? "server is starting", { status: 503, headers: { "content-type": "text/plain" } });
      }
      const id = ++reqId;
      const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
      const appUrl = new URL(path + url.search, cfg.name ? `https://${cfg.name}.preview` : location.origin);
      const res = await new Promise((resolve) => {
        waiting.set(id, resolve);
        worker.postMessage(
          { type: "request", id, url: appUrl.href, method: req.method, headers: [...req.headers], body },
          body ? [body] : [],
        );
      });
      out(`\x1b[2m${req.method} ${path} ${res.status}\x1b[0m`);
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
    watcher.close();
    server.close();
    worker?.terminate();
    return 0;
  }

  c.registerCommand("clover", async (ctx) => {
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
        await deploy(out);
        return 0;
      }
      out("usage: clover dev [--port 3000] | build | deploy\r\n(other commands: use the real CLI, npx github:ODumpling/clover-cli)");
      return sub ? 1 : 0;
    } catch (e) {
      err(e.message ?? String(e));
      return 1;
    }
  });

  return { build, deploy, config };
}
