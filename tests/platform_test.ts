import { assert, assertEquals, assertMatch } from "@std/assert";
import { createServer } from "../server/main.ts";
import { loadConfig } from "../server/config.ts";

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
      let net = "ok", fs = "leak";
      try { await fetch("https://example.com", { signal: AbortSignal.timeout(5000) }); } catch (e) { net = e.name; }
      try { Deno.readTextFileSync("/etc/hosts"); } catch (e) { fs = e.name; }
      return Response.json({ net, fs, secrets: env.secrets, url: req.url });
    }
    if (u.pathname === "/api/files") {
      await env.files.put("a/b.txt", "hello", { contentType: "text/plain" });
      return (await env.files.get("a/b.txt")) ?? new Response("missing", { status: 500 });
    }
    if (u.pathname === "/api/spin") { while (true) {} }
    return new Response("v" + (env.app.deployId.length > 0 ? "1" : "0"));
  },
};`;

async function setup() {
  const dataDir = await Deno.makeTempDir({ prefix: "clover-test-" });
  const srv = createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80, limits: { requestMs: 1500 } as never }));
  const call = (path: string, init: RequestInit & { host?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", init.host ?? "test.local");
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return srv.handler(new Request(`http://${init.host ?? "test.local"}${path}`, { ...init, headers }));
  };
  const json = async (path: string, init: RequestInit & { host?: string } = {}) => {
    const r = await call(path, init);
    return { status: r.status, body: await r.json() };
  };
  return {
    srv,
    call,
    json,
    async [Symbol.asyncDispose]() {
      srv.close();
      await Deno.remove(dataDir, { recursive: true });
    },
  };
}

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

Deno.test("anonymous deploy, static + server routes, sandbox limits, claim, secrets, rollback", async () => {
  await using t = await setup();
  const d = await t.json("/v1/deploys", { method: "POST", body: deployBody() });
  assertEquals(d.status, 201);
  const { app, deployKey } = d.body;
  assertMatch(app.name, /^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  assertEquals(app.claimed, false);
  assert(app.expiresAt);
  const host = `${app.name}.test.local`;

  // static
  assertEquals(await (await t.call("/", { host })).text(), "<h1>home</h1>");
  assertEquals(await (await t.call("/about", { host })).text(), "about");
  const asset = await t.call("/assets/app.js", { host });
  await asset.body?.cancel();
  assertMatch(asset.headers.get("cache-control")!, /immutable/);
  assertEquals(await (await t.call("/deep/link", { host })).text(), "<h1>home</h1>"); // SPA fallback
  const missing = await t.call("/nope.png", { host });
  await missing.body?.cancel();
  assertEquals(missing.status, 404);

  // server + db persistence
  assertEquals((await t.json("/api/count", { host })).body.n, 1);
  assertEquals((await t.json("/api/count", { host })).body.n, 2);
  assertEquals(await (await t.call("/api/files", { host })).text(), "hello");

  // sandbox: unclaimed → no outbound net, no fs outside the app
  const probe = (await t.json("/api/probe", { host })).body;
  assertEquals(probe.net, "NotCapable");
  assertEquals(probe.fs, "NotCapable");
  assertEquals(probe.url, `http://${host}/api/probe`);

  // runaway handler is killed and the app recovers
  const spin = await t.call("/api/spin", { host });
  await spin.body?.cancel();
  assertEquals(spin.status, 504);
  assertEquals((await t.json("/api/count", { host })).body.n, 3);

  // auth
  const keyH = { "x-clover-deploy-key": deployKey };
  assertEquals((await t.json(`/v1/apps/${app.name}`)).status, 401);
  assertEquals((await t.json(`/v1/apps/${app.name}`, { headers: keyH })).status, 200);
  const redeployNoKey = await t.json("/v1/deploys", { method: "POST", body: deployBody({ app: app.name }) });
  assertEquals(redeployNoKey.status, 401);

  // secrets need claim
  const s1 = await t.json(`/v1/apps/${app.name}/secrets`, { method: "PUT", headers: keyH, body: '{"FOO":"bar"}' });
  assertEquals(s1.status, 403);

  const acct = await t.json("/v1/accounts", { method: "POST", body: '{"email":"a@b.co"}' });
  const auth = { authorization: `Bearer ${acct.body.token}` };
  const claim = await t.json(`/v1/apps/${app.name}/claim`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ deployKey }),
  });
  assertEquals(claim.body.app.claimed, true);
  assertEquals(claim.body.app.expiresAt, null);
  const s2 = await t.json(`/v1/apps/${app.name}/secrets`, { method: "PUT", headers: auth, body: '{"FOO":"bar"}' });
  assertEquals(s2.body.keys, ["FOO"]);
  const probe2 = (await t.json("/api/probe", { host })).body;
  assertEquals(probe2.secrets, { FOO: "bar" });
  assert(probe2.net !== "NotCapable", `claimed app should have net, got ${probe2.net}`);
  assertEquals(probe2.fs, "NotCapable");

  // redeploy (static only) then rollback
  const d2 = await t.json("/v1/deploys", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ app: app.name, files: [{ path: "index.html", data: "v2" }] }),
  });
  assertEquals(d2.status, 201);
  assertEquals(await (await t.call("/", { host })).text(), "v2");
  const nope = await t.call("/api/count", { host });
  assertEquals(nope.status, 200); // no server → SPA fallback
  assertEquals(await nope.text(), "v2");
  await t.json(`/v1/apps/${app.name}/rollback`, { method: "POST", headers: auth, body: "{}" });
  assertEquals(await (await t.call("/", { host })).text(), "<h1>home</h1>");
  assertEquals((await t.json("/api/count", { host })).body.n, 4); // data survives deploys

  // db inspection
  const db = await t.json(`/v1/apps/${app.name}/db`, { headers: auth });
  assertEquals(db.body.tables.c.count, 4);
  const q = await t.json(`/v1/apps/${app.name}/db/query`, { method: "POST", headers: auth, body: '{"sql":"SELECT count(*) n FROM c"}' });
  assertEquals(q.body.rows[0].n, 4);
  const w = await t.json(`/v1/apps/${app.name}/db/query`, { method: "POST", headers: auth, body: '{"sql":"DELETE FROM c"}' });
  assertEquals(w.status, 400); // read-only

  // logs
  const logs = await (await t.call(`/v1/apps/${app.name}/logs`, { headers: auth })).text();
  assertMatch(logs, /GET \/api\/count 200/);

  // list + delete
  assertEquals((await t.json("/v1/apps", { headers: auth })).body.apps.length, 1);
  assertEquals((await t.json(`/v1/apps/${app.name}`, { method: "DELETE", headers: auth })).status, 200);
  const gone = await t.call("/", { host });
  await gone.body?.cancel();
  assertEquals(gone.status, 404);
});

Deno.test("deploy validation", async () => {
  await using t = await setup();
  const bad = async (body: unknown) => (await t.json("/v1/deploys", { method: "POST", body: JSON.stringify(body) })).status;
  assertEquals(await bad({ files: [{ path: "../x", data: "" }] }), 400);
  assertEquals(await bad({ files: [{ path: "a", data: "" }, { path: "./a", data: "" }] }), 400);
  assertEquals(await bad({ app: "Bad_Name", files: [] }), 400);
  assertEquals(await bad({ app: "api", files: [] }), 400);
  assertEquals(await bad({ files: [], config: { routes: ["nope"] } }), 400);
  // named anonymous deploy works and the name is then taken
  assertEquals(await bad({ app: "my-app", files: [{ path: "index.html", data: "x" }] }), 201);
  assertEquals(await bad({ app: "my-app", files: [] }), 401);
});

Deno.test("templates are served", async () => {
  await using t = await setup();
  const list = await t.json("/v1/templates");
  const names = list.body.templates.map((x: { name: string }) => x.name);
  assert(names.includes("react") && names.includes("vanilla"));
  const react = await t.json("/v1/templates/react");
  const paths = react.body.files.map((f: { path: string }) => f.path);
  for (const p of ["clover.json", "index.html", "server/index.ts", "AGENTS.md", "package.json"]) {
    assert(paths.includes(p), `missing ${p}`);
  }
  assertEquals((await t.json("/v1/templates/..%2Fserver")).status, 404);
});

Deno.test("studio is cross-origin isolated", async () => {
  await using t = await setup();
  const r = await t.call("/");
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("cross-origin-opener-policy"), "same-origin");
  assertEquals(r.headers.get("cross-origin-embedder-policy"), "require-corp");
  assertMatch(await r.text(), /Clover Studio/);
  const llms = await t.call("/llms.txt");
  assertMatch(await llms.text(), /POST \/v1\/deploys/);
});
