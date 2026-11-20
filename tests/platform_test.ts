import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
      const tryFetch = (url) => fetch(url, { signal: AbortSignal.timeout(5000) }).then(() => "ok", (e) => e.name);
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
const denied = (logs: string, target: string) => logs.includes(`connecting to ${target} is not allowed`);

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
  assert.match(await r.text(), /Cresslet Studio/);
  const js = await t.call("/app.js");
  await js.body?.cancel();
  assert.equal(js.headers.get("cache-control"), "no-cache");
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
