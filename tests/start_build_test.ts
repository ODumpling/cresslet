// studio/start-build.js: the TanStack Start build's pure parts (the browser build itself: tests/e2e/start.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";

const mod = "../studio/start-build.js"; // untyped browser module
const { exportsTarget, CONDITIONS, serverFnResolverModule, manifestModule, startDefines, ASYNC_HOOKS_SHIM } = await import(mod);

test("start build: package exports under each environment's conditions", () => {
  // router-core's isServer: the server build must get the server one, the client the client one, never development
  const isServer = {
    "./isServer": {
      development: { import: "./dist/esm/isServer/development.js" },
      workerd: { import: "./dist/esm/isServer/server.js" },
      browser: { import: "./dist/esm/isServer/client.js" },
      node: { import: "./dist/esm/isServer/server.js" },
      import: "./dist/esm/isServer/server.js",
    },
  };
  assert.equal(exportsTarget(isServer, "./isServer", CONDITIONS.server), "./dist/esm/isServer/server.js");
  assert.equal(exportsTarget(isServer, "./isServer", CONDITIONS.client), "./dist/esm/isServer/client.js");
  // react-dom/server: deno and node come before browser in the package; the server build takes the Web-streams one
  const rd = { "./server": { "react-server": "./a.js", workerd: "./server.edge.js", deno: "./server.node.js", worker: "./server.browser.js", node: "./server.node.js", browser: "./server.browser.js", default: "./server.node.js" } };
  assert.equal(exportsTarget(rd, "./server", CONDITIONS.server), "./server.edge.js");
  assert.equal(exportsTarget(rd, "./server", CONDITIONS.client), "./server.browser.js");
  // sugar, patterns, arrays, misses
  assert.equal(exportsTarget("./index.js", ".", CONDITIONS.client), "./index.js");
  assert.equal(exportsTarget({ import: "./m.js", require: "./c.cjs" }, ".", CONDITIONS.client), "./m.js");
  assert.equal(exportsTarget({ "./*": "./dist/*.js", "./x/*": "./x/*.mjs" }, "./x/y", CONDITIONS.client), "./x/y.mjs");
  assert.equal(exportsTarget({ ".": [{ import: "./a.js" }, "./b.js"] }, ".", CONDITIONS.client), "./a.js");
  assert.equal(exportsTarget({ ".": "./a.js" }, "./missing", CONDITIONS.client), null);
  assert.equal(exportsTarget({ ".": { require: "./c.cjs" } }, ".", CONDITIONS.client), null);
});

test("start build: server function resolver and manifest modules", async () => {
  const src = serverFnResolverModule({
    b: { functionName: "two", extractedFilename: "/p/src/b.ts?tss-serverfn-split", isClientReferenced: false },
    a: { functionName: "one", extractedFilename: "/p/src/a.ts?tss-serverfn-split", isClientReferenced: true },
  });
  assert.match(src, /import \* as m0 from "\/p\/src\/a\.ts\?tss-serverfn-split";\nimport \* as m1 from "\/p\/src\/b\.ts\?tss-serverfn-split";/);
  // run it with the imports replaced by modules
  const body = src.replace(/^import \* as (m\d) from .*$/gm, "");
  const getServerFnById = new Function("m0", "m1", `${body.replace("export async function", "return async function")}`)(
    { one: "fn-one" },
    { two: "fn-two" },
  );
  assert.equal(await getServerFnById("a", { origin: "client" }), "fn-one");
  assert.equal(await getServerFnById("b", { origin: "server" }), "fn-two");
  await assert.rejects(getServerFnById("b", { origin: "client" }), /not accessible from client/);
  await assert.rejects(getServerFnById("zzz", { origin: "server" }), /not found/);

  const manifest = manifestModule({ entry: "/assets/client-X.js", css: ["/assets/client-X.css"] });
  const m = new Function(manifest.replace("export const tsrStartManifest =", "return"))()();
  assert.deepEqual(m.routes.__root__, {
    preloads: ["/assets/client-X.js"],
    scripts: [{ attrs: { type: "module", async: true, src: "/assets/client-X.js" } }],
    css: ["/assets/client-X.css"],
  });
  const d = startDefines();
  assert.equal(d["process.env.TSS_SERVER_FN_BASE"], '"/_serverFn/"');
  assert.equal(d["import.meta.env.TSS_DEV_SERVER"], '"false"');
  assert.equal(d["process.env.NODE_ENV"], '"production"');
});

test("start build: the preview's AsyncLocalStorage shim", async () => {
  const { AsyncLocalStorage } = await import(`data:text/javascript,${encodeURIComponent(ASYNC_HOOKS_SHIM)}`);
  const als = new AsyncLocalStorage();
  assert.equal(als.getStore(), undefined);
  // nested runs restore the outer store, sync and async
  const r = await als.run("outer", async () => {
    assert.equal(als.run("inner", () => als.getStore()), "inner");
    assert.equal(als.getStore(), "outer");
    await als.run("inner2", async () => {
      await new Promise((res) => setTimeout(res, 5));
      assert.equal(als.getStore(), "inner2");
    });
    assert.equal(als.getStore(), "outer");
    return "done";
  });
  assert.equal(r, "done");
  // the outermost store stays after its callback: a streamed response's rest still runs with it
  assert.equal(als.getStore(), "outer");
  // the next request's, too (not the previous request's, restored over it)
  await als.run("request 2", async () => {
    await als.run("nested", async () => {});
    assert.equal(als.getStore(), "request 2");
  });
  assert.equal(als.getStore(), "request 2");
  await new Promise((res) => setTimeout(res, 5)); // its body streams on
  assert.equal(als.getStore(), "request 2");
  assert.throws(() => als.run("outer 3", () => als.run("x", () => { throw new Error("boom"); })), /boom/);
  assert.equal(als.getStore(), "outer 3");
});
