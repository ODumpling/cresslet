import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/main.ts";
import { loadConfig, paths } from "../server/config.ts";

const SERVER = `
export default {
  async fetch(req, env) {
    await env.db.exec("CREATE TABLE IF NOT EXISTS c (id INTEGER PRIMARY KEY)");
    await env.db.run("INSERT INTO c DEFAULT VALUES");
    return Response.json(await env.db.first("SELECT count(*) n FROM c"));
  },
};`;

test("site admins list every site with usage, delete (soft), restore and purge", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-admin-"));
  const srv = createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80, adminToken: "adm", siteAdmins: ["boss@example.com"] }));
  const call = (path: string, init: RequestInit & { host?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", init.host ?? "test.local");
    if (init.body) headers.set("content-type", "application/json");
    return srv.handler(new Request(`http://${init.host ?? "test.local"}${path}`, { ...init, headers }));
  };
  const json = async (path: string, init: RequestInit & { host?: string } = {}) => {
    const r = await call(path, init);
    return { status: r.status, body: await r.json() };
  };
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const account = async (email: string) =>
    (await json("/v1/accounts", { method: "POST", headers: bearer("adm"), body: JSON.stringify({ email }) })).body.token as string;
  try {
    const owner = await account("dev@example.com");
    const boss = await account("boss@example.com");
    const deploy = (name: string) =>
      json("/v1/deploys", {
        method: "POST",
        headers: bearer(owner),
        body: JSON.stringify({ app: name, files: [{ path: "index.html", data: "<h1>hi</h1>" }], server: SERVER, config: { routes: ["/api/*"] } }),
      });
    assert.equal((await deploy("shop")).status, 201);
    const host = "shop.test.local";
    assert.equal((await json("/api/n", { host })).body.n, 1);

    // access: anonymous 401, plain account 403, SiteAdmin (env list) and the operator token ok
    assert.equal((await json("/v1/admin/sites")).status, 401);
    assert.equal((await json("/v1/admin/sites", { headers: bearer(owner) })).status, 403);
    assert.equal((await json("/v1/me", { headers: bearer(owner) })).body.account.role, null);
    assert.equal((await json("/v1/me", { headers: bearer(boss) })).body.account.role, "SiteAdmin");
    assert.equal((await json("/v1/admin/sites", { headers: bearer("adm") })).status, 200);

    const list = await json("/v1/admin/sites", { headers: bearer(boss) });
    assert.equal(list.status, 200);
    const site = list.body.sites.find((s: { name: string }) => s.name === "shop");
    assert.equal(site.owner.email, "dev@example.com");
    assert.equal(site.status, "running");
    assert.ok(site.usage.deploys > 0 && site.usage.database > 0, JSON.stringify(site.usage));
    assert.equal(site.usage.total, site.usage.deploys + site.usage.database + site.usage.files);
    assert.equal(list.body.totals.live, 1);

    // a site admin sees the site but not its database tables unless they own it
    const detail = await json("/v1/admin/sites/shop", { headers: bearer(boss) });
    assert.equal(detail.body.database, null);
    assert.equal((await json("/v1/admin/sites/shop", { headers: bearer("adm") })).body.database, null);
    assert.equal((await json("/v1/deploys", {
      method: "POST",
      headers: bearer(boss),
      body: JSON.stringify({ app: "mine", files: [{ path: "index.html", data: "hi" }], server: SERVER, config: { routes: ["/api/*"] } }),
    })).status, 201);
    await json("/api/n", { host: "mine.test.local" });
    assert.deepEqual((await json("/v1/admin/sites/mine", { headers: bearer(boss) })).body.database.tables, [{ name: "c", rows: 1 }]);
    assert.equal(detail.body.deploys.length, 1);

    // soft delete: offline, hidden from the owner, name stays taken, data kept
    const del = await json("/v1/admin/sites/shop", { method: "DELETE", headers: bearer(boss) });
    assert.equal(del.body.site.status, "deleted");
    assert.ok(del.body.site.purgeAt);
    assert.equal((await call("/", { host })).status, 404);
    assert.equal((await json("/v1/apps/shop", { headers: bearer(owner) })).status, 404);
    assert.deepEqual((await json("/v1/apps", { headers: bearer(owner) })).body.apps, []);
    assert.equal((await deploy("shop")).status, 409);
    assert.equal((await json("/v1/admin/sites", { headers: bearer(boss) })).body.totals.deleted, 1);
    const appId = del.body.site.id;
    assert.ok(existsSync(paths(srv.cfg, appId).db));
    assert.deepEqual(srv.store.deletedBefore(Date.now() + 1).map((a) => a.id), [appId]);

    // restore: back online with its data
    const res = await json("/v1/admin/sites/shop/restore", { method: "POST", headers: bearer(boss) });
    assert.equal(res.body.site.deletedAt, null);
    assert.equal((await json("/api/n", { host })).body.n, 2);
    assert.equal((await json("/v1/apps/shop", { headers: bearer(owner) })).status, 200);

    // purge: gone for good
    assert.equal((await json("/v1/admin/sites/shop?purge=1", { method: "DELETE", headers: bearer(boss) })).body.purged, "shop");
    assert.equal((await json("/v1/admin/sites/shop", { headers: bearer(boss) })).status, 404);
    assert.ok(!existsSync(paths(srv.cfg, appId).app));
    assert.equal((await deploy("shop")).status, 201);

    // roles: a SiteAdmin grants and revokes, not their own
    const role = (email: string, r: string | null, as = boss) =>
      json("/v1/admin/accounts/role", { method: "PUT", headers: bearer(as), body: JSON.stringify({ email, role: r }) });
    assert.equal((await role("dev@example.com", "SiteAdmin", owner)).status, 403);
    assert.equal((await role("dev@example.com", "Root")).status, 400);
    assert.equal((await role("dev@example.com", "SiteAdmin")).body.account.role, "SiteAdmin");
    assert.equal((await json("/v1/admin/sites", { headers: bearer(owner) })).status, 200);
    assert.equal((await role("dev@example.com", null)).status, 200);
    assert.equal((await json("/v1/admin/sites", { headers: bearer(owner) })).status, 403);
  } finally {
    srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
