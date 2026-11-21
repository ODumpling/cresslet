import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/main.ts";
import { type Config, loadConfig } from "../server/config.ts";

const SERVER = `
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/api/count") {
      await env.db.exec("CREATE TABLE IF NOT EXISTS c (id INTEGER PRIMARY KEY)");
      await env.db.run("INSERT INTO c DEFAULT VALUES");
      return Response.json(await env.db.first("SELECT count(*) n FROM c"));
    }
    if (u.pathname === "/api/probe") {
      // A denial is an error from workerd's network, or a 403 from the egress proxy (gVisor).
      const tryFetch = (url) => fetch(url, { signal: AbortSignal.timeout(5000) }).then(
        async (r) => (r.status === 403 && (await r.text()).startsWith("Cresslet egress blocked") ? "blocked" : "ok"), (e) => e.name);
      let fs = "leak";
      try { (await import("node:fs")).readFileSync("/etc/hosts"); } catch (e) { fs = "blocked"; }
      return Response.json({
        net: await tryFetch("https://example.com"),
        local: await tryFetch("http://127.0.0.1:9/"),
        fs, secrets: env.secrets, url: req.url,
      });
    }
    if (u.pathname === "/api/files") {
      await env.files.put("a/b.txt", "hello", { contentType: "text/plain" });
      return (await env.files.get("a/b.txt")) ?? new Response("missing", { status: 500 });
    }
    if (u.pathname === "/api/spin") { while (true) {} }
    return new Response("v" + (env.app.deployId.length > 0 ? "1" : "0"));
  },
};`;

async function setup(overrides: Partial<Config> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-test-"));
  const srv = createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80, limits: { requestMs: 1500 } as never, ...overrides }));
  const call = (path: string, init: RequestInit & { host?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", init.host ?? "test.local");
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return srv.handler(new Request(`http://${init.host ?? "test.local"}${path}`, { ...init, headers }));
  };
  const json = async (path: string, init: RequestInit & { host?: string } = {}) => {
    const r = await call(path, init);
    const text = await r.text();
    try {
      return { status: r.status, body: JSON.parse(text) };
    } catch {
      throw new Error(`${path}: ${r.status} ${text}`);
    }
  };
  return {
    srv,
    call,
    json,
    async dispose() {
      srv.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

type T = Awaited<ReturnType<typeof setup>>;
const withServer = (fn: (t: T) => Promise<void>, overrides: Partial<Config> = {}) => async () => {
  const t = await setup(overrides);
  try {
    await fn(t);
  } finally {
    await t.dispose();
  }
};
// Under gVisor (CRESSLET_RUNSC) the sandbox has no network at all: no DNS for unclaimed apps, and
// claimed apps' outbound goes through the control plane's egress proxy.
const gvisor = !!process.env.CRESSLET_RUNSC;
const denied = (logs: string, target: string) =>
  logs.includes(`connecting to ${target} is not allowed`) ||
  (gvisor && (logs.includes(`egress blocked: ${target.replace(/:\d+$/, "")} (not a public`) || logs.includes("failure in name resolution")));

const deployBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    files: [
      { path: "index.html", data: "<h1>home</h1>" },
      { path: "assets/app.js", data: "console.log(1)" },
      { path: "about.html", data: "about" },
    ],
    server: SERVER,
    ...extra,
  });

test("anonymous deploy, static + server routes, sandbox limits, claim, secrets, rollback", withServer(async (t) => {
  const d = await t.json("/v1/deploys", { method: "POST", body: deployBody() });
  assert.deepEqual(d.status, 201);
  const { app, deployKey } = d.body;
  assert.match(app.name, /^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  assert.deepEqual(app.claimed, false);
  assert.ok(app.expiresAt);
  const host = `${app.name}.test.local`;

  // static
  assert.deepEqual(await (await t.call("/", { host })).text(), "<h1>home</h1>");
  assert.deepEqual(await (await t.call("/about", { host })).text(), "about");
  const asset = await t.call("/assets/app.js", { host });
  await asset.body?.cancel();
  assert.match(asset.headers.get("cache-control")!, /immutable/);
  assert.deepEqual(await (await t.call("/deep/link", { host })).text(), "<h1>home</h1>"); // SPA fallback
  const missing = await t.call("/nope.png", { host });
  await missing.body?.cancel();
  assert.deepEqual(missing.status, 404);

  // server + db persistence
  assert.deepEqual((await t.json("/api/count", { host })).body.n, 1);
  assert.deepEqual((await t.json("/api/count", { host })).body.n, 2);
  assert.deepEqual(await (await t.call("/api/files", { host })).text(), "hello");

  // sandbox: unclaimed → no outbound net, no host fs
  const probe = (await t.json("/api/probe", { host })).body;
  assert.notEqual(probe.net, "ok");
  assert.notEqual(probe.local, "ok");
  assert.equal(probe.fs, "blocked");
  assert.equal(probe.url, `http://${host}/api/probe`);
  const logs1 = t.srv.runtime.logs.recent(app.id, 1000).map((l) => l.msg).join("\n");
  assert.ok(denied(logs1, "example.com:443"), logs1);

  // runaway handler is killed and the app recovers
  const spin = await t.call("/api/spin", { host });
  await spin.body?.cancel();
  assert.deepEqual(spin.status, 504);
  assert.deepEqual((await t.json("/api/count", { host })).body.n, 3);

  // auth
  const keyH = { "x-cresslet-deploy-key": deployKey };
  assert.deepEqual((await t.json(`/v1/apps/${app.name}`)).status, 401);
  assert.deepEqual((await t.json(`/v1/apps/${app.name}`, { headers: keyH })).status, 200);
  const redeployNoKey = await t.json("/v1/deploys", { method: "POST", body: deployBody({ app: app.name }) });
  assert.deepEqual(redeployNoKey.status, 401);

  // secrets need claim
  const s1 = await t.json(`/v1/apps/${app.name}/secrets`, { method: "PUT", headers: keyH, body: '{"FOO":"bar"}' });
  assert.deepEqual(s1.status, 403);

  const acct = await t.json("/v1/accounts", {
    method: "POST",
    headers: { authorization: "Bearer adm" },
    body: '{"email":"a@b.co"}',
  });
  const auth = { authorization: `Bearer ${acct.body.token}` };
  const claim = await t.json(`/v1/apps/${app.name}/claim`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ deployKey }),
  });
  assert.deepEqual(claim.body.app.claimed, true);
  assert.deepEqual(claim.body.app.expiresAt, null);
  const s2 = await t.json(`/v1/apps/${app.name}/secrets`, { method: "PUT", headers: auth, body: '{"FOO":"bar"}' });
  assert.deepEqual(s2.body.keys, ["FOO"]);
  const before = t.srv.runtime.logs.recent(app.id, 1000).length;
  const probe2 = (await t.json("/api/probe", { host })).body;
  assert.deepEqual(probe2.secrets, { FOO: "bar" });
  assert.equal(probe2.fs, "blocked");
  assert.notEqual(probe2.local, "ok"); // public internet only: no loopback/LAN
  const logs2 = t.srv.runtime.logs.recent(app.id, 1000).slice(before).map((l) => l.msg).join("\n");
  assert.ok(!denied(logs2, "example.com:443"), `claimed app should have net:\n${logs2}`);
  assert.ok(denied(logs2, "127.0.0.1:9"), logs2);

  // redeploy (static only) then rollback
  const d2 = await t.json("/v1/deploys", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ app: app.name, files: [{ path: "index.html", data: "v2" }] }),
  });
  assert.deepEqual(d2.status, 201);
  assert.deepEqual(await (await t.call("/", { host })).text(), "v2");
  const nope = await t.call("/api/count", { host });
  assert.deepEqual(nope.status, 200); // no server → SPA fallback
  assert.deepEqual(await nope.text(), "v2");
  await t.json(`/v1/apps/${app.name}/rollback`, { method: "POST", headers: auth, body: "{}" });
  assert.deepEqual(await (await t.call("/", { host })).text(), "<h1>home</h1>");
  assert.deepEqual((await t.json("/api/count", { host })).body.n, 4); // data survives deploys

  // db inspection
  const db = await t.json(`/v1/apps/${app.name}/db`, { headers: auth });
  assert.deepEqual(db.body.tables.c.count, 4);
  const q = await t.json(`/v1/apps/${app.name}/db/query`, { method: "POST", headers: auth, body: '{"sql":"SELECT count(*) n FROM c"}' });
  assert.deepEqual(q.body.rows[0].n, 4);
  const w = await t.json(`/v1/apps/${app.name}/db/query`, { method: "POST", headers: auth, body: '{"sql":"DELETE FROM c"}' });
  assert.deepEqual(w.status, 400); // read-only

  // logs
  const logs = await (await t.call(`/v1/apps/${app.name}/logs`, { headers: auth })).text();
  assert.match(logs, /GET \/api\/count 200/);

  // list + delete
  assert.deepEqual((await t.json("/v1/apps", { headers: auth })).body.apps.length, 1);
  assert.deepEqual((await t.json(`/v1/apps/${app.name}`, { method: "DELETE", headers: auth })).status, 200);
  const gone = await t.call("/", { host });
  await gone.body?.cancel();
  assert.equal(gone.status, 404);
}, { adminToken: "adm" }));

test("deploy validation", withServer(async (t) => {
  const bad = async (body: unknown) => (await t.json("/v1/deploys", { method: "POST", body: JSON.stringify(body) })).status;
  assert.deepEqual(await bad({ files: [{ path: "../x", data: "" }] }), 400);
  assert.deepEqual(await bad({ files: [{ path: "a", data: "" }, { path: "./a", data: "" }] }), 400);
  assert.deepEqual(await bad({ app: "Bad_Name", files: [] }), 400);
  assert.deepEqual(await bad({ app: "api", files: [] }), 400);
  assert.deepEqual(await bad({ files: [], config: { routes: ["nope"] } }), 400);
  // named anonymous deploy works and the name is then taken
  assert.deepEqual(await bad({ app: "my-app", files: [{ path: "index.html", data: "x" }] }), 201);
  assert.equal(await bad({ app: "my-app", files: [] }), 401);
}));

test("templates are served", withServer(async (t) => {
  const list = await t.json("/v1/templates");
  const names = list.body.templates.map((x: { name: string }) => x.name);
  assert.ok(names.includes("react") && names.includes("vanilla"));
  const react = await t.json("/v1/templates/react");
  const paths = react.body.files.map((f: { path: string }) => f.path);
  for (const p of ["cresslet.json", "index.html", "server/index.ts", "AGENTS.md", "package.json"]) {
    assert.ok(paths.includes(p), `missing ${p}`);
  }
  assert.equal((await t.json("/v1/templates/..%2Fserver")).status, 404);
}));

test("studio is cross-origin isolated", withServer(async (t) => {
  const r = await t.call("/");
  assert.deepEqual(r.status, 200);
  assert.deepEqual(r.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.deepEqual(r.headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.equal(r.headers.get("content-security-policy"), "frame-ancestors 'none'"); // apps can't overlay it
  assert.match(await r.text(), /Cresslet Studio/);
  const js = await t.call("/app.js");
  await js.body?.cancel();
  assert.equal(js.headers.get("cache-control"), "no-cache");
  // Assets load from a per-release path, so a CDN-cached copy from an older release can't be used.
  const html = await (await t.call("/")).text();
  const src = html.match(/<script type="module" src="(\/_v\/[0-9a-f]{12}\/app\.js)"/)?.[1];
  assert.ok(src, "versioned app.js");
  assert.match(html, /href="\/_v\/[0-9a-f]{12}\/styles\.css"/);
  const versioned = await t.call(src);
  assert.equal(versioned.status, 200);
  assert.equal(await versioned.text(), await (await t.call("/app.js")).text());
  assert.equal((await t.call(src.replace("app.js", "vendor/editor.js"))).status, 200);
  const llms = await t.call("/llms.txt");
  assert.match(await llms.text(), /POST \/v1\/deploys/);
}));

test("closed instance: no anonymous deploys, admin-only accounts", withServer(async (t) => {
  const files = [{ path: "index.html", data: "x" }];
  const anon = await t.json("/v1/deploys", { method: "POST", body: JSON.stringify({ files }) });
  assert.equal(anon.status, 401);
  const signup = await t.json("/v1/accounts", { method: "POST", body: '{"email":"a@b.co"}' });
  assert.equal(signup.status, 403);
  const wrong = await t.json("/v1/accounts", {
    method: "POST",
    headers: { authorization: "Bearer nope" },
    body: '{"email":"a@b.co"}',
  });
  assert.equal(wrong.status, 403);
  const acct = await t.json("/v1/accounts", {
    method: "POST",
    headers: { authorization: "Bearer s3cret-admin" },
    body: '{"email":"a@b.co"}',
  });
  assert.equal(acct.status, 201);
  const d = await t.json("/v1/deploys", {
    method: "POST",
    headers: { authorization: `Bearer ${acct.body.token}` },
    body: JSON.stringify({ files }),
  });
  assert.equal(d.status, 201);
  assert.equal(d.body.app.claimed, true);
}, { openSignup: false, anonDeploys: false, adminToken: "s3cret-admin" }));

test("preview host serves only the container's relay + service worker, framable by the studio only", withServer(async (t) => {
  const info = await t.json("/v1");
  assert.equal(info.body.previewOrigin, "http://preview.test.local");
  const sw = await t.call("/cresslet-sw.js", { host: "preview.test.local" });
  await sw.body?.cancel();
  assert.equal(sw.status, 200);
  assert.equal(sw.headers.get("service-worker-allowed"), "/");
  assert.equal(sw.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(sw.headers.get("cross-origin-embedder-policy"), "require-corp");
  const relay = await t.call("/cresslet-relay.html", { host: "preview.test.local" });
  await relay.body?.cancel();
  assert.equal(relay.status, 200);
  assert.equal(relay.headers.get("content-security-policy"), "frame-ancestors http://test.local");
  for (const p of ["/", "/index.html", "/app.js", "/v1", "/%2e%2e/server/main.ts", "/cresslet-relay.js.map"]) {
    const r = await t.call(p, { host: "preview.test.local" });
    await r.body?.cancel();
    assert.equal(r.status, 404, p);
  }
  // "preview" can't be an app name.
  const d = await t.json("/v1/deploys", { method: "POST", body: JSON.stringify({ app: "preview", files: [] }) });
  assert.equal(d.status, 400);
  // The old studio-origin worker is replaced by one that unregisters itself.
  const sw2 = await t.call("/cresslet-sw.js");
  assert.match(await sw2.text(), /registration\.unregister\(\)/);
  // Studio pages on another hostname go to the configured origin (the relay only trusts that one).
  const other = await t.call("/", { host: "127.0.0.1" });
  await other.body?.cancel();
  assert.equal(other.status, 302);
  assert.equal(other.headers.get("location"), "http://test.local/");
  assert.equal((await t.call("/healthz", { host: "127.0.0.1" })).status, 200);
}));

test("a configured preview host is normalized and its name reserved", withServer(async (t) => {
  assert.equal(t.srv.cfg.previewHost, "sandbox.test.local");
  const d = await t.json("/v1/deploys", { method: "POST", body: JSON.stringify({ app: "sandbox", files: [] }) });
  assert.equal(d.status, 400);
  const sw = await t.call("/cresslet-sw.js", { host: "SANDBOX.test.local." });
  await sw.body?.cancel();
  assert.equal(sw.headers.get("service-worker-allowed"), "/");
}, { previewHost: "Sandbox.Test.Local." } as never));

test("the studio's dotenv filter matches the server's", async () => {
  const studioPlugin = "../studio/cresslet-plugin.js"; // untyped browser module
  const { publicDotenv } = await import(studioPlugin);
  const { publicDotenvText } = await import("../server/deploys.ts");
  const cases = [
    "# c\nCRESSLET_PUBLIC_API=https://x\nDB=1\nVITE_X=1\nKEY=\"-----BEGIN\nVITE_FAKE=leak\n-----END\"",
    "VITE_A=1\nSECRET=\n\"multi\nVITE_N=leak\n\"", "S=\"abc\" # c\nVITE_Z='q r'\n\nT=x#y\nVITE_A=1\nSECRET: \"x\nVITE_C=leak\n\"",
    "VITE_A=1\nSECRET=\"abc\\\\\"\nVITE_X=leak", "PEM=\"a\u2028b\nVITE_LS=leak\n\"", "\uFEFFVITE_A=1\r\nB=2\rVITE_C=3",
  ];
  for (const c of cases) assert.equal(publicDotenv(c), publicDotenvText(c), JSON.stringify(c));
});

test("deploys can carry project source; local secrets and build output are never stored", withServer(async (t) => {
  const d = await t.json("/v1/deploys", {
    method: "POST",
    body: JSON.stringify({
      files: [{ path: "index.html", data: "built" }],
      sources: [
        { path: "src/main.ts", data: "console.log('hi')" },
        { path: "public/logo.bin", data: Buffer.from([0, 255, 1]).toString("base64"), encoding: "base64" },
        { path: ".env.cresslet", data: "SECRET=1" },
        { path: "node_modules/x/index.js", data: "x" },
        { path: ".cresslet/app.json", data: "{}" },
        { path: ".env.cresslet-backup", data: "SECRET=1" },
        { path: ".env.local", data: "SECRET=1" },
        { path: "apps/web/.env.production.local", data: "SECRET=1" },
        { path: "pkg/node_modules/y.js", data: "y" },
        { path: "apps/sub/.cresslet/app.json", data: '{"deployKey":"clv_app_x"}' },
        { path: ".envrc", data: "export SECRET=1" },
        { path: "worker/.dev.vars", data: "SECRET=1" },
        { path: "worker/.dev.vars.staging", data: "SECRET=1" },
        { path: "worker/.dev.vars-backup", data: "SECRET=1" },
        { path: ".env-test.local", data: "SECRET=1" },
        { path: ".envbackup.local", data: "SECRET=1" },
        { path: "sub/.envrc.bak", data: "SECRET=1\nVITE_E=1" },
        { path: "sub/.env.next", data: "VITE_A=1\nSECRET=\n\"multi\nVITE_N=leak\n\"\nVITE_K=1" },
        { path: "sub/.env.mix", data: "S=\"abc\" # c\nVITE_Z='q r'\n\nT=x#y\nVITE_A=1\nSECRET: \"x\nVITE_C=leak\n\"" },
        { path: "sub/.env.esc", data: "VITE_A=1\nSECRET=\"abc\\\\\"\nVITE_X=leak\nC=\"y\"" },
        { path: "sub/.env.ls", data: "PEM=\"a\u2028b\nVITE_LS=leak\n\"\nVITE_ESC=\"x\\\\\"\nVITE_AFTER=1" },
        { path: "sub/.env.extra", data: "my.key=\"a\nVITE_DOT=leak\n\"\nVITE_OK=1\nVITE_OPEN=\"never closed\nSECRET=after" },
        { path: "sub/.ENV.LOCAL", data: "SECRET=1" },
        { path: ".env/secrets", data: "SECRET=1" },
        { path: ".env", data: "# public\nCRESSLET_PUBLIC_API=https://x\nDB_PASSWORD=hunter2\n# STRIPE_SECRET=sk_live_1\nVITE_X=1\nKEY=\"-----BEGIN\nVITE_FAKE=leak\n# fake\n-----END\"" },
        { path: "bom.txt", data: Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]).toString("base64"), encoding: "base64" },
      ],
    }),
  });
  assert.equal(d.status, 201);
  const keyH = { "x-cresslet-deploy-key": d.body.deployKey };
  assert.equal((await t.json(`/v1/apps/${d.body.app.name}/source`)).status, 401);
  const src = await t.json(`/v1/apps/${d.body.app.name}/source`, { headers: keyH });
  assert.equal(src.body.deployId, d.body.app.currentDeployId);
  const byPath = Object.fromEntries(src.body.files.map((f: { path: string }) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), [".env", "bom.txt", "public/logo.bin", "src/main.ts", "sub/.env.esc", "sub/.env.extra", "sub/.env.ls", "sub/.env.mix", "sub/.env.next"]);
  // Fail closed: the first line that isn't one complete single-line entry (a multi-line or escaped quote, a value
  // on the next line, `KEY: v`, U+2028) ends the file; comments are dropped.
  assert.equal(byPath[".env"].data, "CRESSLET_PUBLIC_API=https://x\nVITE_X=1");
  assert.equal(byPath["sub/.env.extra"].data, "");
  assert.equal(byPath["sub/.env.ls"].data, "");
  assert.equal(byPath["sub/.env.next"].data, "VITE_A=1");
  assert.equal(byPath["sub/.env.mix"].data, "VITE_Z='q r'\n\nVITE_A=1");
  assert.equal(byPath["sub/.env.esc"].data, "VITE_A=1");
  assert.deepEqual(byPath["public/logo.bin"], { path: "public/logo.bin", data: Buffer.from([0, 255, 1]).toString("base64"), encoding: "base64" });
  assert.equal(Buffer.from(byPath["bom.txt"].data, byPath["bom.txt"].encoding === "base64" ? "base64" : "utf8")[0], 0xef); // BOM kept

  // A later deploy without sources: current has none, the earlier one is still readable.
  await t.json("/v1/deploys", { method: "POST", headers: keyH, body: JSON.stringify({ app: d.body.app.name, files: [{ path: "index.html", data: "v2" }] }) });
  assert.equal((await t.json(`/v1/apps/${d.body.app.name}/source`, { headers: keyH })).body.error, "no_source");
  const old = await t.json(`/v1/apps/${d.body.app.name}/source?deploy=${src.body.deployId}`, { headers: keyH });
  assert.equal(old.body.files.length, 9);
  // One budget for built files + source; file/dir conflicts rejected before anything is written.
  // Source that doesn't fit the shared budget is dropped (with a warning), not the deploy.
  const big = await t.json("/v1/deploys", { method: "POST", headers: keyH, body: JSON.stringify({
    app: d.body.app.name, files: [{ path: "index.html", data: "x" }], sources: [{ path: "huge.bin", data: "x".repeat(t.srv.cfg.limits.deployBytes) }] }) });
  assert.equal(big.status, 201);
  assert.match(big.body.deploy.warning, /source not stored/);
  const conflict = await t.json("/v1/deploys", { method: "POST", headers: keyH, body: JSON.stringify({ app: d.body.app.name, files: [{ path: "index.html", data: "x" }], sources: [{ path: "a", data: "" }, { path: "a/b", data: "" }] }) });
  assert.equal(conflict.status, 400);
  const deploysDir = join(t.srv.cfg.dataDir, "apps", d.body.app.id, "deploys");
  assert.equal((await readdir(deploysDir)).length, 3);
  assert.equal((await t.json("/v1/deploys", { method: "POST", body: JSON.stringify({ files: [], sources: [{ path: "../x", data: "" }] }) })).status, 400);
}));
