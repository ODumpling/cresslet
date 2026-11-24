// Environments inside an app (docs/architecture.md#environments): deploy to staging, its private host, its own data,
// sandbox and secret overrides, promote to production (the same bundle), rollback per environment, seed, delete.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/main.ts";
import { loadConfig, paths } from "../server/config.ts";
import "./studio-imports.ts";
import { ownerAuth } from "./owner.ts";

const server = (mark: string) => `
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/api/env") {
      await env.db.exec("CREATE TABLE IF NOT EXISTS c (id INTEGER PRIMARY KEY)");
      if (req.method === "POST") await env.db.run("INSERT INTO c DEFAULT VALUES");
      const { n } = await env.db.first("SELECT count(*) n FROM c");
      return Response.json({ mark: ${JSON.stringify(mark)}, env: env.app.env, deployId: env.app.deployId, url: env.app.url, n, secrets: env.secrets, cookie: req.headers.get("cookie") });
    }
    return new Response("no", { status: 404 });
  },
  async scheduled() {},
};`;

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-env-test-"));
  const srv = await createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80 }));
  const call = (path: string, init: RequestInit & { host?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", init.host ?? "test.local");
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return srv.handler(new Request(`http://${init.host ?? "test.local"}${path}`, { ...init, headers }));
  };
  const auth = await ownerAuth(srv.store);
  const send = async (method: string, path: string, input?: unknown, headers: Record<string, string> = auth) => {
    const r = await call(path, { method, headers, body: input === undefined ? undefined : JSON.stringify(input) });
    const text = await r.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch { /* not JSON */ }
    return { status: r.status, body, text, headers: r.headers };
  };
  const files = (html: string) => [{ path: "index.html", data: html }];
  const deployProd = (html: string, mark: string) =>
    send("POST", "/v1/deploys", { app: "shop", files: files(html), server: server(mark), config: { routes: ["/api/*"], crons: ["0 0 * * *"] } });
  const deployStaging = (html: string, mark: string, extra: Record<string, unknown> = {}) =>
    send("POST", "/v1/apps/shop/envs/staging/deploys", { files: files(html), server: server(mark), config: { routes: ["/api/*"], crons: ["0 0 * * *"] }, ...extra });
  return {
    srv, call, send, auth, dataDir, deployProd, deployStaging,
    async dispose() {
      await srv.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
type T = Awaited<ReturnType<typeof setup>>;
const withServer = (fn: (t: T) => Promise<void>) => async () => {
  const t = await setup();
  try {
    await fn(t);
  } finally {
    await t.dispose();
  }
};
const STAGING = "shop--staging.test.local";

/** Signs in to staging as the owner (the studio's /view flow): the session cookie. */
async function signIn(t: T, path = "/") {
  const v = await t.send("POST", "/v1/apps/shop/envs/staging/view", { path });
  assert.equal(v.status, 200, v.text);
  const url = new URL(v.body.url);
  assert.equal(url.host, STAGING);
  const r = await t.call(url.pathname + url.search, { host: STAGING });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), path);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  assert.match(cookie, /^cresslet_page=pvs_/);
  // Spent: the same link again is refused.
  assert.equal((await t.call(url.pathname + url.search, { host: STAGING })).status, 403);
  return cookie;
}

test("staging: its own deploy, private host, data, sandbox and secrets; promote moves production to the same bundle", withServer(async (t) => {
  const p1 = await t.deployProd("prod 1", "p1");
  assert.equal(p1.status, 201, p1.text);
  // Nothing deployed to staging yet.
  assert.equal((await t.call("/", { host: STAGING })).status, 404);
  assert.equal((await t.send("GET", "/v1/apps/shop?env=staging")).body.error, "env_not_found");
  // An environment's deploy never goes through /v1/deploys (an older server would publish it to production).
  assert.equal((await t.send("POST", "/v1/deploys", { app: "shop", env: "staging", files: [{ path: "index.html", data: "x" }] })).status, 400);
  assert.equal((await t.send("POST", "/v1/apps/shop/envs/qa/deploys", { files: [{ path: "index.html", data: "x" }] })).status, 400);

  const s1 = await t.deployStaging("staged 1", "s1");
  assert.equal(s1.status, 201, s1.text);
  assert.equal(s1.body.environment.url, `http://${STAGING}`);
  assert.equal(s1.body.app.currentDeployId, p1.body.deploy.id); // production untouched
  const envs = await t.send("GET", "/v1/apps/shop/envs");
  assert.deepEqual(envs.body.environments.map((e: { name: string; currentDeployId: string; private: boolean }) => [e.name, e.currentDeployId, e.private]),
    [["production", p1.body.deploy.id, false], ["staging", s1.body.deploy.id, true]]);

  // Production is public; staging asks a browser to sign in through the studio, and refuses anything else.
  assert.equal(await (await t.call("/", { host: "shop.test.local" })).text(), "prod 1");
  const page = await t.call("/a/b?x=1", { host: STAGING, headers: { accept: "text/html" } });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), `http://test.local/view/shop--staging?path=${encodeURIComponent("/a/b?x=1")}`);
  assert.equal((await t.call("/api/env", { host: STAGING })).status, 401);
  assert.equal((await t.call("/api/env", { host: STAGING, method: "POST" })).status, 401);

  const cookie = await signIn(t, "/api/env");
  const get = (init: RequestInit & { host?: string } = {}) => t.call("/api/env", { host: STAGING, ...init, headers: { cookie: `a=1; ${cookie}`, ...init.headers as Record<string, string> } });
  const r = await get();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.equal(r.headers.get("x-frame-options"), "SAMEORIGIN"); // not framed by another app (browsers without Sec-Fetch-*)
  const seen = await r.json();
  // The app never sees the platform's cookie, only its own.
  assert.deepEqual({ mark: seen.mark, env: seen.env, deployId: seen.deployId, url: seen.url, n: seen.n, cookie: seen.cookie },
    { mark: "s1", env: "staging", deployId: s1.body.deploy.id, url: `http://${STAGING}`, n: 0, cookie: "a=1" });
  assert.equal(await (await t.call("/", { host: STAGING, headers: { cookie } })).text(), "staged 1");
  // Another app under the domain is the same site: its pages' requests carry the cookie, which doesn't count from there.
  assert.equal((await get({ method: "POST", headers: { origin: "http://evil.test.local" } })).status, 401);
  assert.equal((await get({ method: "POST", headers: { "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" } })).status, 401);
  // A link from elsewhere (a top-level navigation) reads.
  assert.equal((await get({ headers: { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate" } })).status, 200);
  // A frame on another app's page is a navigation too, not a top-level one: sent to sign in, never served.
  assert.equal((await get({ headers: { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" } })).status, 302);
  // Its own pages write: to staging's database, not production's.
  assert.equal((await (await get({ method: "POST", headers: { origin: `http://${STAGING}` } })).json()).n, 1);
  assert.equal((await (await t.call("/api/env", { host: "shop.test.local" })).json()).n, 0);
  assert.ok(existsSync(paths(t.srv.cfg, s1.body.app.id).env("staging").db));
  // Its own sandbox.
  const envId = (await t.srv.store.environment(s1.body.app.id, "staging"))!.id;
  assert.ok(t.srv.runtime.procs.has(envId) && t.srv.runtime.procs.has(s1.body.app.id));

  // Someone without access to the app gets no link, and a stranger's cookie is nothing.
  const stranger = await ownerAuth(t.srv.store, "stranger@test.local");
  assert.equal((await t.send("POST", "/v1/apps/shop/envs/staging/view", {}, stranger)).status, 403);
  assert.equal((await t.call("/api/env", { host: STAGING, headers: { cookie: "cresslet_page=pvs_forged" } })).status, 401);
  // Two cookies of that name (over http another host under the domain can add one): neither counts.
  assert.equal((await t.call("/api/env", { host: STAGING, headers: { cookie: `${cookie}; cresslet_page=pvs_other` } })).status, 401);

  // Secrets: staging sees production's, its own overriding them; production doesn't see staging's.
  assert.equal((await t.send("PUT", "/v1/apps/shop/secrets", { A: "prod-a", B: "prod-b" })).status, 200);
  const own = await t.send("PUT", "/v1/apps/shop/secrets?env=staging", { B: "stage-b", C: "stage-c" });
  assert.deepEqual(own.body.keys, ["B", "C"]);
  assert.deepEqual(own.body.secrets, [{ key: "A", source: "production" }, { key: "B", source: "staging" }, { key: "C", source: "staging" }]);
  assert.deepEqual((await (await get()).json()).secrets, { A: "prod-a", B: "stage-b", C: "stage-c" });
  assert.deepEqual((await (await t.call("/api/env", { host: "shop.test.local" })).json()).secrets, { A: "prod-a", B: "prod-b" });
  // A production change reaches staging (it inherits).
  await t.send("PUT", "/v1/apps/shop/secrets", { A: "prod-a2" });
  assert.equal((await (await get()).json()).secrets.A, "prod-a2");
  await t.send("DELETE", "/v1/apps/shop/secrets/B?env=staging");
  assert.equal((await (await get()).json()).secrets.B, "prod-b");

  // Logs and metrics per environment.
  const logs = (await t.send("GET", "/v1/apps/shop/logs?env=staging")).text;
  assert.match(logs, /deployed .* to staging/);
  assert.doesNotMatch((await t.send("GET", "/v1/apps/shop/logs")).text, /to staging/);
  assert.ok((await t.send("GET", "/v1/apps/shop/metrics?env=staging")).body.database.tables.some((x: { name: string; rows: number }) => x.name === "c" && x.rows === 1));
  assert.equal((await t.send("POST", "/v1/apps/shop/db/query?env=staging", { sql: "SELECT count(*) n FROM c" })).body.rows[0].n, 1);

  // Crons: listed, never on schedule in staging (Run now only).
  const crons = await t.send("GET", "/v1/apps/shop/crons?env=staging");
  assert.equal(crons.body.scheduled, false);
  assert.deepEqual(crons.body.crons.map((c: { cron: string; paused: boolean; next: string[] }) => [c.cron, c.paused, c.next.length]), [["0 0 * * *", true, 0]]);
  assert.equal((await t.send("POST", "/v1/apps/shop/crons/resume?env=staging", { cron: "0 0 * * *" })).body.error, "not_scheduled");
  assert.equal((await t.send("POST", "/v1/apps/shop/crons/run?env=staging", { cron: "0 0 * * *" })).status, 202);
  assert.equal((await t.srv.store.appsWithCrons()).length, 1); // production's

  // Promote: the deploy the caller saw staging serve, else 409.
  const stale = await t.send("POST", "/v1/apps/shop/promote", { deployId: p1.body.deploy.id });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.currentDeployId, s1.body.deploy.id);
  // Production isn't what the caller saw (another deploy since): refused, nothing changed.
  const unseen = await t.send("POST", "/v1/apps/shop/promote", { deployId: s1.body.deploy.id, expectProduction: "dep_other" });
  assert.equal(unseen.status, 409);
  assert.equal(unseen.body.productionDeployId, p1.body.deploy.id);
  const pr = await t.send("POST", "/v1/apps/shop/promote", { from: "staging", deployId: s1.body.deploy.id, expectProduction: p1.body.deploy.id });
  assert.equal(pr.status, 200, pr.text);
  assert.equal(pr.body.promoted, true);
  assert.equal(pr.body.app.currentDeployId, s1.body.deploy.id);
  assert.equal(await (await t.call("/", { host: "shop.test.local" })).text(), "staged 1");
  const prod = await (await t.call("/api/env", { host: "shop.test.local" })).json();
  // The same bundle, production's own environment, data and secrets.
  assert.deepEqual([prod.mark, prod.env, prod.deployId, prod.n, prod.secrets.B], ["s1", "production", s1.body.deploy.id, 0, "prod-b"]);
  // Again: nothing to do.
  assert.equal((await t.send("POST", "/v1/apps/shop/promote", { deployId: s1.body.deploy.id })).body.promoted, false);
  const detail = await t.send("GET", "/v1/apps/shop");
  assert.deepEqual(detail.body.deploys.map((d: { id: string; env: string; current: boolean; promotedAt: string | null }) => [d.id, d.env, d.current, !!d.promotedAt]),
    [[s1.body.deploy.id, "staging", true, true], [p1.body.deploy.id, "production", false, false]]);

  // Rollback per environment: production goes back to its previous deploy, never to a staging deploy it didn't serve.
  const s2 = await t.deployStaging("staged 2", "s2");
  assert.equal((await t.send("POST", "/v1/apps/shop/rollback", { deployId: s2.body.deploy.id })).status, 404);
  const back = await t.send("POST", "/v1/apps/shop/rollback", {});
  assert.equal(back.body.app.currentDeployId, p1.body.deploy.id);
  assert.equal(await (await t.call("/", { host: "shop.test.local" })).text(), "prod 1");
  const sback = await t.send("POST", "/v1/apps/shop/rollback", { env: "staging" });
  assert.equal(sback.status, 200, sback.text);
  assert.equal(sback.body.environment.currentDeployId, s1.body.deploy.id);
  assert.equal(await (await t.call("/", { host: STAGING, headers: { cookie } })).text(), "staged 1");
  assert.equal((await t.send("POST", "/v1/apps/shop/rollback", { env: "staging", deployId: p1.body.deploy.id })).status, 404);

  // Seed: staging's database replaced by a snapshot of production's.
  await t.call("/api/env", { host: "shop.test.local", method: "POST" });
  await t.call("/api/env", { host: "shop.test.local", method: "POST" });
  assert.equal((await t.send("POST", "/v1/apps/shop/envs/staging/seed", { from: "elsewhere" })).status, 400);
  const seeded = await t.send("POST", "/v1/apps/shop/envs/staging/seed", { from: "production" });
  assert.equal(seeded.status, 200, seeded.text);
  assert.equal((await (await get()).json()).n, 2);

  // Deleting it: its sandbox, data and host go; production stays. A second delete queued behind it finds it gone.
  assert.equal((await t.send("DELETE", "/v1/apps/shop/envs/staging", undefined, stranger)).status, 403);
  const [del, again] = await Promise.all([t.send("DELETE", "/v1/apps/shop/envs/staging"), t.send("DELETE", "/v1/apps/shop/envs/staging")]);
  assert.equal(again.status, 404);
  assert.equal(del.status, 200, del.text);
  assert.deepEqual(del.body.environments.map((e: { name: string }) => e.name), ["production"]);
  assert.ok(!t.srv.runtime.procs.has(envId));
  assert.ok(!existsSync(paths(t.srv.cfg, s1.body.app.id).env("staging").data));
  // A request that resolved staging just before the delete starts no sandbox (nor data dir) after it.
  const gone = { key: envId, appId: s1.body.app.id, env: "staging", dataDir: paths(t.srv.cfg, s1.body.app.id).env("staging").data, live: async () => false };
  const late = await t.srv.runtime.fetch({ ...gone, seq: async () => 0, appName: "shop", appUrl: "http://x", deployId: s1.body.deploy.id, secrets: async () => ({}), net: false, egress: null }, new Request("http://x/api/env"));
  assert.equal(late.status, 502);
  assert.ok(!t.srv.runtime.procs.has(envId) && !existsSync(gone.dataDir));
  assert.equal((await t.call("/", { host: STAGING })).status, 404);
  assert.equal(await (await t.call("/", { host: "shop.test.local" })).text(), "prod 1");
  // The promoted deploy is still in production's history (rollback can reach it); staging's other one is gone.
  const ids = (await t.srv.store.deploys(s1.body.app.id)).map((d) => d.id);
  assert.ok(ids.includes(s1.body.deploy.id) && !ids.includes(s2.body.deploy.id), JSON.stringify(ids));
  assert.equal((await t.srv.store.deploy(s1.body.deploy.id))?.env, null); // production's alone now (not a new staging's history)
}));

test("staging: keeps its own deploys for rollback, without pushing production's out; purging the app stops both", withServer(async (t) => {
  const p1 = await t.deployProd("prod 1", "p1");
  const app = p1.body.app.id as string;
  for (let i = 0; i < 7; i++) assert.equal((await t.deployStaging(`staged ${i}`, `s${i}`)).status, 201);
  const all = await t.srv.store.deploys(app, 100);
  assert.equal(all.filter((d) => d.env === "staging").length, 5);
  assert.ok(all.some((d) => d.id === p1.body.deploy.id));
  // Pages and apps without an owner have no environments; names with `--` are never app names.
  assert.equal((await t.send("GET", "/v1/names/shop--staging")).body.available, false);
  const cookie = await signIn(t);
  await t.call("/api/env", { host: STAGING, headers: { cookie } });
  const envId = (await t.srv.store.environment(app, "staging"))!.id;
  assert.ok(t.srv.runtime.procs.has(envId));
  assert.equal((await t.send("DELETE", "/v1/apps/shop")).status, 200);
  assert.ok(!t.srv.runtime.procs.has(envId));
  assert.ok(!existsSync(paths(t.srv.cfg, app).app));
  assert.equal(await t.srv.store.environmentById(envId), undefined);
}));

test("staging: WebSockets need a viewer's session from its own origin, and never see the platform's cookie", async () => {
  const { randomBytes } = await import("node:crypto");
  const { request } = await import("node:http");
  const { serve } = await import("@hono/node-server");
  const t = await setup();
  const http = serve({ fetch: t.srv.handler, port: 0 });
  http.on("upgrade", t.srv.upgrade);
  await new Promise((r) => http.once("listening", r));
  const port = (http.address() as { port: number }).port;
  const WS = `export default { async fetch(req) {
    if (req.headers.get("upgrade") !== "websocket") return new Response("plain");
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", () => server.send("cookie=" + (req.headers.get("cookie") ?? "none")));
    return new Response(null, { status: 101, webSocket: client });
  } };`;
  /** Upgrade, send one frame, read one: the status, and the app's reply. */
  const ws = (headers: Record<string, string>) => new Promise<{ status: number; reply?: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/ws", headers: {
      host: STAGING, upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": randomBytes(16).toString("base64"), "sec-websocket-version": "13", ...headers,
    } });
    req.on("response", (res) => (res.resume(), resolve({ status: res.statusCode! })));
    req.on("upgrade", (res, socket) => {
      const mask = randomBytes(4), payload = Buffer.from("hi");
      socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, payload.map((b, i) => b ^ mask[i % 4])]));
      socket.once("data", (d: Buffer) => (resolve({ status: res.statusCode!, reply: d.subarray(2, 2 + (d[1] & 0x7f)).toString() }), socket.destroy()));
    });
    req.on("error", reject);
    req.end();
  });
  try {
    await t.deployProd("prod", "p");
    assert.equal((await t.send("POST", "/v1/apps/shop/envs/staging/deploys", { files: [{ path: "index.html", data: "s" }], server: WS, config: { routes: ["/api/*"] } })).status, 201);
    const cookie = await signIn(t);
    const own = `http://${STAGING}`;
    assert.equal((await ws({ origin: own })).status, 401); // no session
    assert.equal((await ws({ cookie, origin: "http://evil.test.local" })).status, 401); // another app's page
    assert.equal((await ws({ cookie })).status, 401); // no origin: not a page of its own
    assert.deepEqual(await ws({ cookie: `${cookie}; a=1`, origin: own }), { status: 101, reply: "cookie=a=1" });
    assert.deepEqual(await ws({ cookie, origin: own }), { status: 101, reply: "cookie=none" }); // the header goes when that's all it held
  } finally {
    await new Promise((r) => http.close(r));
    await t.dispose();
  }
});

test("staging: a refused first deploy leaves no environment behind", withServer(async (t) => {
  await t.deployProd("prod", "p");
  const bad = await t.send("POST", "/v1/apps/shop/envs/staging/deploys", { files: [{ path: "../x", data: "x" }] });
  assert.equal(bad.status, 400);
  assert.deepEqual((await t.send("GET", "/v1/apps/shop/envs")).body.environments.map((e: { name: string }) => e.name), ["production"]);
  // Once it has a deploy, a refused one changes nothing.
  const ok = await t.deployStaging("s", "s");
  assert.equal((await t.send("POST", "/v1/apps/shop/envs/staging/deploys", { files: [{ path: "../x", data: "x" }] })).status, 400);
  assert.equal((await t.send("GET", "/v1/apps/shop/envs")).body.environments[1].currentDeployId, ok.body.deploy.id);
}));
