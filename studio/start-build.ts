// TanStack Start apps in the studio: their build without Vite (which can't run in cresslet-container). esbuild (c.bundle,
// on this page) bundles the client and the server; TanStack's own compilers (route generation, server functions, the
// client's route options) run in a `node` process in the container (start-service.ts), since they come from the
// project's node_modules. Output as the CLI's `vite build` writes it: dist/client (static files, under /assets) and a
// server bundle (`export default { fetch }`).
// Covers Start apps like templates/tanstack-start: no Vite plugins beyond Start's and React's, one client bundle
// (no route code splitting), stylesheets through `?url` imports or imported CSS. No HMR: a save rebuilds and reloads.
import type { BundleResult, Container, ContainerProcess } from "./vendor/cresslet-container/cresslet-container.js";
import { staticUrl } from "./static-url.js";
import type { BuildOptions, Loader, Message, Metafile, OnLoadResult, Plugin } from "./vendor/cresslet-container/types/vendor/esbuild-wasm.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const MARK = "\u0001tss\u0001";
const SERVER_FN_SPLIT = "tss-serverfn-split";

/** A Start app: depends on @tanstack/react-start. */
export function isStartApp(pkg: PackageJson | null | undefined) {
  return !!(pkg?.dependencies?.["@tanstack/react-start"] || pkg?.devDependencies?.["@tanstack/react-start"]);
}

/** The package.json fields read here (from JSON: anything may be missing). */
export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: unknown;
}

/** Start's build-time constants (as @tanstack/start-plugin-core's createViteDefineConfig sets them for `vite build`). */
export function startDefines() {
  const tss = {
    TSS_SERVER_FN_BASE: "/_serverFn/",
    TSS_ROUTER_BASEPATH: "/",
    TSS_DEV_SERVER: "false",
    TSS_DEV_SSR_STYLES_ENABLED: "false",
    TSS_DEV_SSR_STYLES_BASEPATH: "/",
    TSS_INLINE_CSS_ENABLED: "false",
    TSS_DISABLE_CSRF_MIDDLEWARE_WARNING: "false",
    TSS_PRERENDERING: "false",
    TSS_SHELL: "false",
  };
  const env = { MODE: "production", PROD: true, DEV: false, BASE_URL: "/" };
  const d: Record<string, string> = { "process.env.NODE_ENV": '"production"', "import.meta.env": JSON.stringify({ ...env, ...tss }) };
  for (const [k, v] of Object.entries(env)) d[`import.meta.env.${k}`] = JSON.stringify(v);
  for (const [k, v] of Object.entries(tss)) d[`process.env.${k}`] = d[`import.meta.env.${k}`] = JSON.stringify(v);
  return d;
}

/** The SSR manifest module (tanstack-start-manifest:v): the client entry and its stylesheet, on the root route. */
export function manifestModule({ entry, css }: { entry: string; css: string[] }) {
  const root: { preloads: string[]; scripts: { attrs: Record<string, unknown> }[]; css?: string[] } = { preloads: [entry], scripts: [{ attrs: { type: "module", async: true, src: entry } }] };
  if (css.length) root.css = css;
  return `export const tsrStartManifest = () => (${JSON.stringify({ routes: { __root__: root } })})`;
}

/** #tanstack-start-server-fn-resolver: every server function by id (generateServerFnResolverModule, static imports). */
/** A server function as Start's compiler reports it (start-service.ts `serverFns`). */
export interface ServerFn {
  extractedFilename: string;
  functionName: string;
  isClientReferenced?: boolean;
}

export function serverFnResolverModule(serverFns: Record<string, ServerFn>) {
  const entries = Object.entries(serverFns).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const imports = entries.map(([, fn], i) => `import * as m${i} from ${JSON.stringify(fn.extractedFilename)};`);
  const rows = entries.map(([id, fn], i) =>
    `${JSON.stringify(id)}: { functionName: ${JSON.stringify(fn.functionName)}, module: m${i}, isClientReferenced: ${fn.isClientReferenced ?? true} }`);
  return `${imports.join("\n")}
const manifest = {
  ${rows.join(",\n  ")}
};
export async function getServerFnById(id, access) {
  const info = manifest[id];
  if (!info) throw new Error("Server function info not found for " + id);
  if (access.origin === "client" && !info.isClientReferenced) throw new Error("Server function not accessible from client: " + id);
  const action = info.module[info.functionName];
  if (!action) throw new Error("Server function module export not resolved for serverFn ID: " + id);
  return action;
}
`;
}

/**
 * AsyncLocalStorage for the preview's server worker (a browser Worker has no node:async_hooks). One store at a time:
 * the worker handles one request at a time for Start apps (server-worker.ts `serial`), and the outermost store stays
 * after its callback resolves (until the next request's), so a streamed response's rest still sees its request.
 */
export const ASYNC_HOOKS_SHIM = `export class AsyncLocalStorage {
  #store;
  #depth = 0;
  getStore() { return this.#store; }
  run(store, fn, ...args) {
    const prev = this.#store;
    const nested = this.#depth++ > 0;
    this.#store = store;
    const restore = () => { this.#depth--; if (nested) this.#store = prev; };
    try {
      const r = fn(...args);
      if (r && typeof r.then === "function") return Promise.resolve(r).finally(restore);
      restore();
      return r;
    } catch (e) {
      restore();
      throw e;
    }
  }
  enterWith(store) { this.#store = store; }
  exit(fn, ...args) { return fn(...args); }
  disable() { this.#store = undefined; }
}
export class AsyncResource {
  constructor(type) { this.type = type; }
  runInAsyncScope(fn, thisArg, ...args) { return fn.apply(thisArg, args); }
  bind(fn) { return fn; }
  static bind(fn) { return fn; }
  emitDestroy() { return this; }
}
export default { AsyncLocalStorage, AsyncResource };
`;

// node:stream in the preview: TanStack's Node stream helpers import it at the top; the web streams path is the one used.
export const NODE_STREAM_STUB = `const no = (n) => class { constructor() { throw new Error(\`node:stream \${n} isn't available in the studio preview\`); } static from() { new this(); } static fromWeb() { new this(); } static toWeb() { new this(); } };
export const Readable = no("Readable"), Writable = no("Writable"), Duplex = no("Duplex"), Transform = no("Transform"), PassThrough = no("PassThrough");
export default { Readable, Writable, Duplex, Transform, PassThrough };`;

// In client code, `cresslet` (the server SDK) is a mistake: say so where it's used, not with a confusing bundle error.
// What Start's compiler rewrites (a superset of its per-environment filters, which the service applies).
const START_CALLS = /\bcreate(?:ServerFn|IsomorphicFn|ServerOnlyFn|ClientOnlyFn|Middleware|Start)\b|\bClientOnly\b/;

const CLIENT_SDK_STUB = `const no = (name) => new Proxy({}, { get(_, k) { if (typeof k === "symbol") return undefined; throw new Error(\`cresslet: \${name}.\${String(k)} is server-only (use it in a server function or server route)\`); } });
export const db = no("db"), kv = no("kv"), files = no("files"), secrets = no("secrets"), app = no("app");
export class CressletError extends Error {}
export const VERSION = "", CONTRACT = 0;`;

/**
 * The file a package's `exports` maps `sub` ("." or "./x") to under `conditions` (in package order, as Node and esbuild
 * match them), or null. cresslet-container's bundler resolves with fixed conditions (`development` in the browser,
 * deno/node for servers), and Start's packages pick their server or client code by condition (router-core's isServer,
 * react-dom/server's Web-streams build): each Start bundle resolves packages with its own.
 */
export function exportsTarget(exp: unknown, sub: string, conditions: readonly string[]): string | null {
  const pick = (t: unknown, star?: string): string | null => {
    if (typeof t === "string") return star === undefined ? t : t.replaceAll("*", star);
    if (Array.isArray(t)) {
      for (const x of t) {
        const r = pick(x, star);
        if (r) return r;
      }
      return null;
    }
    if (t && typeof t === "object") {
      for (const [k, v] of Object.entries(t)) {
        if (k === "default" || conditions.includes(k)) {
          const r = pick(v, star);
          if (r) return r;
        }
      }
    }
    return null;
  };
  if (exp == null) return null;
  const isMap = typeof exp === "object" && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith("."));
  if (!isMap) return sub === "." ? pick(exp) : null;
  const map = exp as Record<string, unknown>; // an object whose keys start with "."
  if (sub in map) return pick(map[sub]);
  let best: { k: string; pre: string; star: string } | null = null;
  for (const k of Object.keys(map)) {
    const i = k.indexOf("*");
    if (i < 0) continue;
    const [pre, post] = [k.slice(0, i), k.slice(i + 1)];
    if (sub.startsWith(pre) && sub.endsWith(post) && sub.length >= pre.length + post.length && (!best || pre.length > best.pre.length)) {
      best = { k, pre, star: sub.slice(pre.length, sub.length - post.length) };
    }
  }
  return best ? pick(map[best.k], best.star) : null;
}

/** A bundle's environment. */
export type Env = "client" | "server";

export const CONDITIONS: Record<Env, string[]> = {
  client: ["browser", "import", "module"],
  server: ["workerd", "worker", "browser", "import", "module"],
};

/** 8 hex chars of SHA-256: asset names. */
async function hash8(bytes: Uint8Array) {
  // VFS and esbuild bytes are never on a SharedArrayBuffer (digest would reject them).
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return [...d.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** esbuild's messages (cresslet-container's BundleResult leaves them `unknown`). */
const messages = (r: BundleResult) => r.errors as Message[];

/** The running compiler service (start-service.ts). */
interface Service {
  proc: ContainerProcess;
  pending: Map<number, { resolve: (m: Reply) => void; reject: (e: unknown) => void }>; // by request id
  nextId: number;
  input: WritableStreamDefaultWriter<string>;
  log: string;
  ready?: Promise<void>;
}
/** A JSON line from start-service.ts: `ok` with the fields of its op's reply (Replies), else `error`. */
interface Reply {
  id: number;
  ok: boolean;
  error?: string;
}
type Request = { op: "routes" } | { op: "compile"; env: Env; file: string; code: string };
interface Replies {
  routes: { clientRouteTree: string; routeFiles: string[] };
  compile: { code: string | null; serverFns: Record<string, ServerFn> };
}

export interface StartBuild {
  /** Absolute paths. */
  files: string[];
  outDir: string;
  server: string | undefined;
  entry: string;
  bundles: Set<string>;
}

/** `sdkPlugin`: `cresslet` in server code (cresslet-plugin.ts). */
export function createStartBuilder(c: Container, { sdkPlugin, serviceUrl = staticUrl("start-service.js") }: { sdkPlugin: Plugin; serviceUrl?: URL }) {
  const wd = c.workdir;
  const p = (rel: string) => `${wd}/${rel}`;
  let svc: Service | null = null;

  async function startService() {
    const source = await fetch(serviceUrl).then((r) => {
      if (!r.ok) throw new Error(`start-service.js: ${r.status}`);
      return r.text();
    });
    await c.fs.writeFile(p(".cresslet/start/service.mjs"), source);
    const nm = p("node_modules");
    // TanStack's compilers by file (their packages don't export them); @babel/* default imports as Node gives them
    // (module.exports), since esbuild can't tell these files are ESM-in-Node here.
    const deep: Plugin = {
      name: "tss-service",
      setup(b) {
        b.onResolve({ filter: /^@tanstack\/[^/]+\/dist\// }, (a) => ({ path: `${nm}/${a.path}`, namespace: "cresslet-vfs" }));
        b.onResolve({ filter: /^@babel\/(core|traverse|generator|template)$/ }, async (a) => {
          if (a.kind !== "import-statement" || a.pluginData === "real") return undefined;
          const r = await b.resolve(a.path, { resolveDir: a.resolveDir, kind: a.kind, pluginData: "real" });
          if (r.errors.length) return { errors: r.errors };
          return { path: r.path, namespace: "tss-cjs-default" };
        });
        b.onLoad({ filter: /.*/, namespace: "tss-cjs-default" }, (a) => ({
          contents: `import * as m from ${JSON.stringify(a.path)}; export * from ${JSON.stringify(a.path)}; export default m;`,
          loader: "js",
          resolveDir: "/",
        }));
      },
    };
    const r = await c.bundle({
      entryPoints: [p(".cresslet/start/service.mjs")],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "es2022",
      outfile: p(".cresslet/start/service.cjs"),
      write: false,
      define: { "import.meta.url": JSON.stringify(`file://${p(".cresslet/start/service.cjs")}`) },
      // optional at runtime (babel config files, debug colors), not needed here
      external: ["@babel/preset-typescript", "@babel/preset-typescript/*", "supports-color"],
      plugins: [deep],
    });
    if (r.errors?.length) throw new Error(messages(r).map((e) => e.text).join("\n"));
    const out = r.outputFiles.find((f) => f.path.endsWith(".cjs")) ?? r.outputFiles[0]!; // write: false, one entry
    await c.fs.writeFile(p(".cresslet/start/service.cjs"), out.text ?? dec.decode(out.contents));
    if (closed) throw new Error("TanStack Start build closed");
    const proc = await c.spawn("node", [p(".cresslet/start/service.cjs")], { cwd: wd });
    booting = proc; // close() kills it while it starts
    const me: Service = { proc, pending: new Map(), nextId: 0, input: proc.input.getWriter(), log: "" };
    let resolveReady = () => {}, rejectReady: (e: unknown) => void = () => {};
    me.ready = new Promise<void>((res, rej) => ((resolveReady = res), (rejectReady = rej)));
    let buf = "";
    proc.output.pipeTo(new WritableStream({
      write(s) {
        buf += s;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const k = line.indexOf(MARK);
          if (k < 0) {
            me.log = (me.log + line + "\n").slice(-4000);
            continue;
          }
          const m: Reply = JSON.parse(line.slice(k + MARK.length));
          if (m.id === 0) resolveReady();
          const job = me.pending.get(m.id);
          if (!job) continue;
          me.pending.delete(m.id);
          if (m.ok) job.resolve(m);
          else job.reject(new Error(m.error));
        }
      },
    })).catch(() => {});
    proc.exit.then((code) => {
      if (svc === me) svc = null;
      const e = new Error(`TanStack Start compiler exited (${code})${me.log.trim() ? `:\n${me.log.trim()}` : ""}`);
      rejectReady(e);
      for (const j of me.pending.values()) j.reject(e);
      me.pending.clear();
    });
    try {
      await me.ready;
    } finally {
      booting = null;
    }
    if (closed) {
      proc.kill(); // closed while it started
      throw new Error("TanStack Start build closed");
    }
    return me;
  }

  let starting: Promise<Service> | null = null;
  let booting: ContainerProcess | null = null; // the service's process until it's ready
  let closed = false;
  async function rpc<R extends Request>(msg: R): Promise<Replies[R["op"]]> {
    if (!svc) {
      starting ??= startService().finally(() => (starting = null));
      svc = await starting;
    }
    const me = svc;
    const id = ++me.nextId;
    return new Promise((resolve, reject) => {
      me.pending.set(id, { resolve: (m) => resolve(m as Reply & Replies[R["op"]]), reject });
      me.input.write(JSON.stringify({ id, ...msg }) + "\n").catch(reject);
    });
  }

  const loaderFor = (file: string): Loader => (/\.tsx$/.test(file) ? "tsx" : /\.ts$|\.mts$/.test(file) ? "ts" : /\.jsx$/.test(file) ? "jsx" : "js");
  const isSource = (file: string) => file.startsWith(p("src/")) && /\.[cm]?[jt]sx?$/.test(file);

  const readText = async (file: string) => {
    const v = await c.fs.readFile(file);
    return typeof v === "string" ? v : dec.decode(v);
  };

  async function firstFile(...rels: string[]) {
    for (const r of rels) if (await c.fs.exists(p(r))) return p(r);
    return null;
  }

  /**
   * One build. `preview`: for the studio's server worker (node:async_hooks shimmed, see ASYNC_HOOKS_SHIM), else for
   * deploying (node:* left to the platform). Static files go to dist/client, or for the preview to their own
   * directory (a deploy's build doesn't touch what the preview serves). `keep`: files of an earlier build to leave
   * (the bundles a preview's pages still load). → { files: absolute paths, outDir, server, entry, bundles }
   */
  async function build({ preview = false, keep: alsoKeep = new Set<string>() } = {}): Promise<StartBuild> {
    const outDir = preview ? ".cresslet/start/preview" : "dist/client";
    const { clientRouteTree } = await rpc({ op: "routes" }); // also writes src/routeTree.gen.ts if routes changed
    const routeTreeFile = p("src/routeTree.gen.ts");
    const serverFns: Record<string, ServerFn> = {};
    const assetUrls = new Map<string, string>(); // absolute file → its /assets URL (`?url` imports, the same in both builds)
    const outFiles = new Map<string, Uint8Array>(); // absolute path under outDir → bytes
    const defines = startDefines();
    const startEntry = await firstFile("src/start.ts", "src/start.tsx", "src/start.js");
    const routerEntry = await firstFile("src/router.tsx", "src/router.ts", "src/router.js");
    if (!routerEntry) throw new Error("TanStack Start: no src/router.tsx (it exports getRouter)");
    const routerFile: string = routerEntry;

    async function assetUrl(file: string): Promise<string> {
      const known = assetUrls.get(file);
      if (known !== undefined) return known;
      const name = file.split("/").pop()!.replace(/\.[^.]+$/, ""); // split: at least one part
      const ext = file.split(".").pop();
      let bytes: Uint8Array | string | undefined;
      if (ext === "css") {
        // a stylesheet with its @imports, minified
        const r = await c.bundle({ entryPoints: [file], bundle: true, minify: true, write: false, outfile: p(".cresslet/start/css.css"), loader: { ".woff2": "file", ".woff": "file", ".png": "file", ".svg": "file", ".jpg": "file" }, assetNames: "[name]-[hash]", publicPath: "/assets" });
        if (r.errors?.length) throw new Error(messages(r).map((e) => e.text).join("\n"));
        for (const f of r.outputFiles) {
          if (f.path.endsWith(".css")) bytes = f.contents ?? enc.encode(f.text);
          else outFiles.set(p(`${outDir}/assets/${f.path.split("/").pop()}`), f.contents);
        }
      } else bytes = await c.fs.readFile(file);
      if (typeof bytes === "string") bytes = enc.encode(bytes);
      // (digest threw a TypeError here before this check)
      if (bytes === undefined) throw new TypeError(`${file}: the CSS build wrote no stylesheet`);
      const url = `/assets/${name}-${await hash8(bytes)}.${ext}`;
      outFiles.set(p(`${outDir}${url}`), bytes);
      assetUrls.set(file, url);
      return url;
    }

    /** Start's virtual modules, entries and compilers for one environment's bundle. */
    function startPlugin(env: Env, own: Record<string, string | (() => string)>): Plugin {
      const virtuals: Record<string, string | (() => string)> = {
        "#tanstack-start-entry": "export const startInstance = undefined;", // no src/start.ts
        "#tanstack-start-plugin-adapters": "export const pluginSerializationAdapters = [];\nexport const hasPluginAdapters = false;",
        "#tanstack-start-server-fn-resolver": "export async function getServerFnById() {}",
        ...own,
      };
      return {
        name: `tanstack-start-${env}`,
        setup(b) {
          // Start's `#` imports (package.json `imports` defaults, replaced by the app's files as its plugins do)
          b.onResolve({ filter: /^(?:#tanstack-start-entry|#tanstack-router-entry)$/ }, (a) => {
            if (a.path === "#tanstack-router-entry") return { path: routerFile, namespace: "cresslet-vfs" };
            return startEntry ? { path: startEntry, namespace: "cresslet-vfs" } : { path: a.path, namespace: "tss-virtual" };
          });
          for (const id of Object.keys(virtuals)) {
            if (id === "#tanstack-start-entry") continue; // above
            const filter = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
            b.onResolve({ filter }, () => ({ path: id, namespace: "tss-virtual" }));
          }
          b.onLoad({ filter: /.*/, namespace: "tss-virtual" }, async (a) => {
            const v = virtuals[a.path];
            return {
            contents: typeof v === "function" ? await v() : v,
            loader: "tsx",
            resolveDir: p("src"),
          };
          });
          b.onResolve({ filter: /\?url$/ }, async (a) => {
            const r = await b.resolve(a.path.slice(0, -4), { resolveDir: a.resolveDir, kind: a.kind, importer: a.importer });
            if (r.errors.length) return { errors: r.errors };
            return { path: r.path, namespace: "tss-url" };
          });
          b.onLoad({ filter: /.*/, namespace: "tss-url" }, async (a) => ({ contents: `export default ${JSON.stringify(await assetUrl(a.path))};`, loader: "js" }));
          b.onResolve({ filter: new RegExp(`\\?${SERVER_FN_SPLIT}$`) }, (a) => ({ path: a.path.split("?")[0], namespace: "tss-split" }));
          if (env === "client") {
            b.onResolve({ filter: /^cresslet$/ }, () => ({ path: "cresslet", namespace: "tss-client-sdk" }));
            b.onLoad({ filter: /.*/, namespace: "tss-client-sdk" }, () => ({ contents: CLIENT_SDK_STUB, loader: "js" }));
          }
          // packages: their `exports` under this environment's conditions (no exports: cresslet-container resolves)
          b.onResolve({ filter: /^(?:@[^/:]+\/)?[^./:#@][^:]*$/ }, async (a) => {
            if (a.path === "cresslet") return undefined; // the SDK plugin's
            const m = /^((?:@[^/]+\/)?[^/]+)(\/.*)?$/.exec(a.path);
            if (!m) return undefined;
            for (let dir = a.resolveDir || p("src"); ; dir = dir.slice(0, dir.lastIndexOf("/")) || "/") {
              const pkgDir = `${dir === "/" ? "" : dir}/node_modules/${m[1]}`;
              const pkgFile = `${pkgDir}/package.json`;
              if (await c.fs.exists(pkgFile)) {
                const pkg = JSON.parse(await readText(pkgFile));
                if (pkg.exports === undefined) return undefined;
                const t = exportsTarget(pkg.exports, `.${m[2] ?? ""}`, CONDITIONS[env]);
                if (!t) return { errors: [{ text: `${a.path}: not exported by ${m[1]} (conditions ${CONDITIONS[env].join(", ")})` }] };
                const real = `${pkgDir}/${t.replace(/^\.\//, "")}`;
                return { path: real, namespace: "cresslet-vfs" };
              }
              if (dir === "/" || !dir) return undefined;
            }
          });
          const transform = async (file: string, id: string): Promise<OnLoadResult> => {
            const code = file === routeTreeFile && env === "client" ? clientRouteTree : await readText(file);
            if (file === routeTreeFile) return { contents: code, loader: env === "client" ? "js" : "ts", resolveDir: p("src") };
            const r = await rpc({ op: "compile", env, file: id, code });
            Object.assign(serverFns, r.serverFns);
            // Code that is server-only by name must not end up in the client bundle.
            if (env === "client" && /\.server\.[cm]?[jt]sx?$/.test(file)) {
              return { errors: [{ text: `${file.slice(wd.length + 1)} is server-only (*.server.*) but client code imports it: use it from a server function` }] };
            }
            return { contents: r.code ?? code, loader: loaderFor(file), resolveDir: file.slice(0, file.lastIndexOf("/")) };
          };
          b.onLoad({ filter: /.*/, namespace: "tss-split" }, (a) => transform(a.path, `${a.path}?${SERVER_FN_SPLIT}`));
          b.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: "cresslet-vfs" }, async (a) => {
            if (isSource(a.path)) return transform(a.path, a.path);
            // packages too (Start's own use createIsomorphicFn, …), when they use what the compiler rewrites
            const code = await readText(a.path);
            if (!START_CALLS.test(code)) return undefined;
            const r = await rpc({ op: "compile", env, file: a.path, code });
            Object.assign(serverFns, r.serverFns);
            return r.code == null ? undefined : { contents: r.code, loader: loaderFor(a.path), resolveDir: a.path.slice(0, a.path.lastIndexOf("/")) };
          });
        },
      };
    }

    const common: BuildOptions = { bundle: true, format: "esm", target: "es2022", write: false, metafile: true, jsx: "automatic", define: defines, logLevel: "silent" };
    const fail = (what: string, r: BundleResult) => {
      if (r.errors?.length) throw new Error(`${what} build failed:\n${messages(r).map((e) => (e.location ? `${e.location.file}:${e.location.line}:${e.location.column}: ${e.text}` : e.text)).join("\n")}`);
    };

    // ---- client
    const clientEntry = await firstFile("src/client.tsx", "src/client.ts", "src/client.jsx", "src/client.js");
    const client = await c.bundle({
      ...common,
      entryPoints: { client: "tss:client-entry" },
      platform: "browser",
      define: { ...defines, "process.env": "{}" }, // other process.env reads in client code: undefined, not a crash
      outdir: p(`${outDir}/assets`),
      entryNames: "[name]-[hash]",
      assetNames: "[name]-[hash]",
      publicPath: "/assets",
      minify: true,
      loader: { ".woff2": "file", ".woff": "file", ".png": "file", ".svg": "file", ".jpg": "file", ".jpeg": "file", ".gif": "file", ".webp": "file" },
      plugins: [startPlugin("client", {
        // Node built-ins server code of Start's packages imports (unused in the browser, as Vite stubs them there)
        "node:async_hooks": ASYNC_HOOKS_SHIM,
        "node:stream": NODE_STREAM_STUB,
        "tss:client-entry": clientEntry
          ? `import ${JSON.stringify(clientEntry)};`
          : `import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { StartClient } from "@tanstack/react-start/client";
startTransition(() => { hydrateRoot(document, <StrictMode><StartClient /></StrictMode>); });`,
      })],
    });
    fail("client", client);
    let entry: string | null | undefined = null;
    const css: string[] = [];
    const metafile = client.metafile as Metafile | undefined; // esbuild's (cresslet-container types it unknown)
    for (const f of client.outputFiles) {
      outFiles.set(f.path, f.contents ?? enc.encode(f.text));
      const url = f.path.slice(p(outDir).length);
      const meta = metafile?.outputs?.[Object.keys(metafile.outputs).find((k) => f.path.endsWith(k)) ?? ""];
      if (meta?.entryPoint) entry = url;
      if (f.path.endsWith(".css")) css.push(url);
    }
    entry ??= [...outFiles.keys()].map((f) => f.slice(p(outDir).length)).find((u) => /^\/assets\/client-[^/]*\.js$/.test(u));
    if (!entry) throw new Error("client build: no entry chunk");

    // ---- server: its compile may find server functions only the server calls; then once more with those in the resolver
    let server: string | undefined;
    const serverEntry = await firstFile("src/server.ts", "src/server.tsx", "src/server.js");
    for (let pass = 0; ; pass++) {
      if (pass === 5) throw new Error("server build: server functions still changing after 5 passes");
      const known = JSON.stringify(Object.keys(serverFns).sort());
      const fnsNow = { ...serverFns };
      const virtuals = {
        "tss:server-entry": serverEntry
          ? `export { default } from ${JSON.stringify(serverEntry)};`
          : `export { default } from "@tanstack/react-start/server-entry";`,
        "tanstack-start-manifest:v": manifestModule({ entry, css }),
        "#tanstack-start-server-fn-resolver": () => serverFnResolverModule(fnsNow),
      };
      if (preview) Object.assign(virtuals, { "node:async_hooks": ASYNC_HOOKS_SHIM, "node:stream": NODE_STREAM_STUB });
      const r = await c.bundle({
        ...common,
        entryPoints: ["tss:server-entry"],
        // browser conditions: react-dom/server's Web-streams build, as workerd gets (cresslet-container resolves
        // `neutral` with deno/node conditions first: react-dom's Node build)
        platform: "browser",
        outfile: p(".cresslet/build/server.js"),
        external: preview ? [] : ["node:*"], // preview: node:async_hooks is the shim
        define: preview ? { ...defines, "process.env": "{}" } : defines, // a browser Worker has no `process`
        // stylesheets reach pages through `?url` and the manifest, not the server bundle; `.sql` imports are their text
        // (drizzle-kit's drizzle/migrations.js), as in cresslet-cli's build
        loader: { ".css": "empty", ".sql": "text" },
        plugins: [startPlugin("server", virtuals), sdkPlugin],
      });
      fail("server", r);
      server = r.outputFiles.find((f) => f.path.endsWith(".js"))?.text;
      if (JSON.stringify(Object.keys(serverFns).sort()) === known) break;
    }

    // ---- outDir: public/ files, then the bundles; then earlier builds' files go
    const files: string[] = [];
    const copyPublic = async (dir: string) => {
      let entries;
      try {
        entries = await c.fs.readdir(p(dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) await copyPublic(rel);
        else {
          const to = p(`${outDir}/${rel.slice("public/".length)}`);
          await c.fs.writeFile(to, await c.fs.readFile(p(rel)));
          files.push(to);
        }
      }
    };
    await copyPublic("public");
    for (const [f, bytes] of outFiles) {
      await c.fs.writeFile(f, bytes);
      files.push(f);
    }
    const keep = new Set([...files, ...alsoKeep]);
    const prune = async (dir: string) => {
      let entries;
      try {
        entries = await c.fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const f = `${dir}/${e.name}`;
        if (e.isDirectory()) await prune(f);
        else if (!keep.has(f)) await c.fs.rm(f, { force: true });
      }
    };
    await prune(p(outDir));
    return { files, outDir, server, entry, bundles: new Set(outFiles.keys()) };
  }

  function close() {
    closed = true;
    booting?.kill();
    const me = svc;
    svc = null;
    me?.proc.kill();
  }

  return { build, close };
}
