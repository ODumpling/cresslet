// TanStack Start's own compilers for the studio's Start build (start-build.js), as a long-lived `node` process in
// cresslet-container: they come from the project's node_modules, so they run where project code runs (the preview
// origin), never on the studio's page. start-build.js bundles this file with esbuild (CJS, the `@tanstack/...dist`
// imports resolved to the project's packages) and talks to it in JSON lines over stdin/stdout:
//   in:  {id, op: "routes"}                      → {id, ok, clientRouteTree, routeFiles}  (writes src/routeTree.gen.ts)
//   in:  {id, op: "compile", env, file, code}     → {id, ok, code|null, serverFns}  (env: "client" | "server";
//        file may end in `?tss-serverfn-split`: the server function's own module)
//   out: lines starting with MARK are replies; anything else is the compilers' own logging.
import fs from "node:fs";
import path from "node:path";
import { Generator, getConfig } from "@tanstack/router-generator";
import { createStartCompiler } from "@tanstack/start-plugin-core/dist/esm/start-compiler/host.js";
import { detectKindsInCode } from "@tanstack/start-plugin-core/dist/esm/start-compiler/compiler.js";
import { getTransformCodeFilterForEnv } from "@tanstack/start-plugin-core/dist/esm/start-compiler/config.js";
import { pruneServerOnlySubtrees } from "@tanstack/start-plugin-core/dist/esm/start-router-plugin/pruneServerOnlySubtrees.js";
import { compileCodeSplitReferenceRoute } from "@tanstack/router-plugin/dist/esm/core/code-splitter/compilers.js";

const MARK = "\u0001tss\u0001";
const root = process.cwd();
const src = path.join(root, "src");

// The route generator names a temp file after an MD5 of its path; cresslet's `node` has no MD5 (any hash will do).
// eslint-disable-next-line no-undef
const nodeCrypto = require("node:crypto");
const createHash = nodeCrypto.createHash;
nodeCrypto.createHash = (alg, ...rest) => createHash(alg === "md5" ? "sha256" : alg, ...rest);

const exists = (f) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};
const EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"];
const resolveFile = (base) => EXTS.map((e) => base + e).find(exists) ?? null;

// ---- routes: the same generator config as @tanstack/start-plugin-core (start-router-plugin/generator-config.js)
function routeTreeFooter() {
  const rel = (f) => `./${path.relative(src, f)}`;
  const router = resolveFile(path.join(src, "router"));
  const start = resolveFile(path.join(src, "start"));
  const lines = [];
  if (router) lines.push(`import type { getRouter } from '${rel(router)}'`);
  lines.push(start ? `import type { startInstance } from '${rel(start)}'` : `import type { createStart } from '@tanstack/react-start'`);
  lines.push(`declare module '@tanstack/react-start' {
  interface Register {
    ssr: true
    router: Awaited<ReturnType<typeof getRouter>>${start ? "\n    config: Awaited<ReturnType<typeof startInstance.getOptions>>" : ""}
  }
}`);
  return [lines.join("\n")];
}

async function routes() {
  const config = getConfig(
    {
      target: "react",
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
      routeTreeFileFooter: routeTreeFooter(),
      tmpDir: path.join(root, ".cresslet/start/tmp"),
    },
    root,
  );
  const generator = new Generator({ config, root });
  await generator.run();
  const crawl = await generator.getCrawlingResult();
  if (!crawl) throw new Error("route generation failed (see the log above)");
  // The client's tree leaves out server-only routes (only `server` handlers), as Start's Vite plugin does.
  const acc = { ...crawl.acc, ...pruneServerOnlySubtrees(crawl) };
  const clientRouteTree = generator.buildRouteTree({
    ...crawl,
    acc,
    config: { disableTypes: true, enableRouteTreeFormatting: false, routeTreeFileHeader: [], routeTreeFileFooter: [] },
  }).routeTreeContent;
  return { clientRouteTree, routeFiles: [...generator.getRoutesByFileMap().keys()] };
}

// ---- compile: Start's compiler (server functions, middleware, isomorphic/server-only/client-only functions)
let serverFns = {};
let reported = new Set();
const compilers = {};
function compilerFor(env) {
  return (compilers[env] ??= createStartCompiler({
    env,
    envName: env === "client" ? "client" : "ssr",
    root,
    mode: "build",
    framework: "react",
    providerEnvName: "ssr",
    compilerPlugins: [],
    onServerFnsById: (fns) => {
      for (const [id, fn] of Object.entries(fns)) {
        const had = serverFns[id];
        serverFns[id] = had ? { ...fn, isClientReferenced: had.isClientReferenced || fn.isClientReferenced } : fn;
      }
    },
    getKnownServerFns: () => serverFns,
    loadModule: async (id) => {
      const file = id.split("?")[0];
      compilers[env].ingestModule({ id, code: fs.readFileSync(file, "utf8") });
    },
    resolveId: async (source, importer) => {
      if (!source.startsWith(".") && !source.startsWith("/")) return null; // packages: known by name
      const base = source.startsWith("/") ? source : path.resolve(path.dirname(importer.split("?")[0]), source);
      return resolveFile(base);
    },
    warn: (m) => console.warn(m),
  }));
}
const filters = { client: getTransformCodeFilterForEnv("client", {}), server: getTransformCodeFilterForEnv("server", {}) };
const routeFactory = /\bcreate(?:File|Root|RootRouteWith\w*|LazyFile)Route\b|\bcreateRootRouteWithContext\b/;
let routeFiles = new Set();

async function compile({ env, file, code }) {
  const clean = file.split("?")[0];
  let out = null;
  // The client gets no route `server` / `ssr` / `headers` options (code that only runs on the server), as Start's
  // router plugin does. No code splitting: one client bundle.
  if (env === "client" && routeFiles.has(clean) && routeFactory.test(code)) {
    const r = compileCodeSplitReferenceRoute({
      code,
      codeSplitGroupings: [],
      targetFramework: "react",
      filename: clean,
      id: clean,
      isProduction: true,
      deleteNodes: new Set(["ssr", "server", "headers"]),
      addHmr: false,
    });
    if (r) out = code = r.code;
  }
  if (filters[env].some((re) => ((re.lastIndex = 0), re.test(code)))) {
    const r = await compilerFor(env).compile({ id: file, code, detectedKinds: detectKindsInCode(code, env, {}) });
    if (r) out = r.code;
  }
  const fresh = {};
  for (const [id, fn] of Object.entries(serverFns)) {
    const key = `${id}:${fn.isClientReferenced}`;
    if (!reported.has(key)) (reported.add(key), (fresh[id] = fn));
  }
  return { code: out, serverFns: fresh };
}

async function handle(msg) {
  if (msg.op === "routes") {
    // a new build: compilers and server functions start over (files changed)
    for (const k of Object.keys(compilers)) delete compilers[k];
    serverFns = {};
    reported = new Set();
    const r = await routes();
    routeFiles = new Set(r.routeFiles);
    return r;
  }
  if (msg.op === "compile") return compile(msg);
  throw new Error(`unknown op ${msg.op}`);
}

let buf = "";
let queue = Promise.resolve();
const reply = (m) => process.stdout.write(MARK + JSON.stringify(m) + "\n");
process.stdin.on("data", (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    queue = queue.then(() =>
      handle(msg).then(
        (r) => reply({ id: msg.id, ok: true, ...r }),
        (e) => reply({ id: msg.id, ok: false, error: e?.stack ?? String(e) }),
      ),
    );
  }
});
process.stdin.resume();
reply({ id: 0, ok: true, ready: true });
