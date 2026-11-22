// Site admin account management (invite, disable, roles) and organizations (members, org apps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/main.ts";
import { loadConfig } from "../server/config.ts";

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-orgs-"));
  const srv = await createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80, adminToken: "adm", siteAdmins: ["boss@b.co"] }));
  const raw = (path: string, init: RequestInit & { host?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", init.host ?? "test.local");
    if (init.body) headers.set("content-type", "application/json");
    return srv.handler(new Request(`http://${init.host ?? "test.local"}${path}`, { ...init, headers }));
  };
  const json = async (path: string, init: RequestInit & { host?: string } = {}) => {
    const r = await raw(path, init);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const account = async (email: string) => {
    const r = await json("/v1/accounts", { method: "POST", headers: bearer("adm"), body: JSON.stringify({ email }) });
    return { token: r.body.token as string, id: r.body.account.id as string };
  };
  const send = (method: string, path: string, token: string, input?: unknown) =>
    json(path, { method, headers: bearer(token), body: input === undefined ? undefined : JSON.stringify(input) });
  const deploy = (token: string, app: string, headers: Record<string, string> = bearer(token)) =>
    json("/v1/deploys", { method: "POST", headers, body: JSON.stringify({ app, files: [{ path: "index.html", data: "hi" }] }) });
  const visit = (name: string, path = "/", cookie?: string) =>
    raw(path, { host: `${name}.test.local`, headers: cookie ? { cookie } : {}, redirect: "manual" });
  return { dataDir, srv, json, account, send, deploy, visit, bearer };
}

test("site admins: list accounts, invite, withdraw, disable and enable, roles", async () => {
  const t = await setup();
  try {
    const boss = await t.account("boss@b.co");
    const dev = await t.account("dev@b.co");
    assert.equal((await t.deploy(dev.token, "shop")).status, 201);
    const page = (await t.send("POST", "/v1/pages", dev.token, { html: "secret", visibility: "private" })).body.page;
    const v = new URL((await t.send("POST", `/v1/pages/${page.name}/view`, dev.token, {})).body.url);
    const cookie = ((await t.visit(page.name, v.pathname + v.search)).headers.get("set-cookie") ?? "").split(";")[0];
    assert.equal((await t.visit(page.name, "/", cookie)).status, 200);

    // Site admins only, with a full-access token.
    assert.equal((await t.send("GET", "/v1/admin/accounts", dev.token)).status, 403);
    const readOnly = (await t.send("POST", "/v1/me/tokens", boss.token, { name: "ro", role: "read" })).body.token;
    assert.equal((await t.send("GET", "/v1/admin/accounts", readOnly)).status, 403);
    let list = await t.send("GET", "/v1/admin/accounts", boss.token);
    assert.equal(list.status, 200);
    const row = (email: string) => list.body.accounts.find((a: { email: string }) => a.email === email);
    assert.equal(row("dev@b.co").status, "active");
    assert.equal(row("dev@b.co").apps, 2, "an app and an artifact");
    assert.equal(row("boss@b.co").siteAdminFromConfig, true);

    // Invite: an account that hasn't signed in; withdrawn while it hasn't.
    const inv = await t.send("POST", "/v1/admin/accounts", boss.token, { email: "New@b.co" });
    assert.equal(inv.status, 201);
    assert.equal(inv.body.account.status, "invited");
    assert.equal(inv.body.account.invitedBy.email, "boss@b.co");
    assert.equal((await t.send("POST", "/v1/admin/accounts", boss.token, { email: "new@b.co" })).status, 409);
    assert.equal((await t.send("POST", "/v1/admin/accounts", boss.token, { email: "nope" })).status, 400);
    assert.equal((await t.send("DELETE", `/v1/admin/accounts/${dev.id}`, boss.token)).status, 409, "a real account isn't withdrawn");
    assert.equal((await t.send("DELETE", `/v1/admin/accounts/${inv.body.account.id}`, boss.token)).status, 200);
    assert.equal((await t.send("POST", "/v1/admin/accounts", boss.token, { email: "new@b.co", siteAdmin: true })).body.account.siteAdmin, true);

    // Guards: not yourself, not an admin from the server's config.
    assert.equal((await t.send("PATCH", `/v1/admin/accounts/${boss.id}`, boss.token, { disabled: true })).status, 400);
    assert.equal((await t.send("PATCH", `/v1/admin/accounts/${boss.id}`, "adm", { disabled: true })).body.error, "config_admin");
    assert.equal((await t.send("PATCH", `/v1/admin/accounts/${dev.id}`, boss.token, { disabled: "yes" })).status, 400);

    // Disable: tokens, private page sessions, deploys by its personal apps' deploy key, login by email all stop.
    const anon = await t.deploy("", "anon", {});
    assert.equal(anon.status, 201);
    const claimed = await t.json("/v1/apps/anon/claim", { method: "POST", headers: t.bearer(dev.token), body: JSON.stringify({ deployKey: anon.body.deployKey }) });
    assert.equal(claimed.status, 200);
    const dis = await t.send("PATCH", `/v1/admin/accounts/${dev.id}`, boss.token, { disabled: true });
    assert.equal(dis.status, 200);
    assert.equal(dis.body.account.status, "disabled");
    assert.equal(dis.body.account.email, "dev@b.co");
    assert.equal((await t.send("GET", "/v1/me", dev.token)).status, 401);
    assert.equal((await t.visit(page.name, "/", cookie)).status, 302);
    assert.equal((await t.deploy("", "anon", { "x-cresslet-deploy-key": anon.body.deployKey })).status, 403);
    assert.equal((await t.json("/", { host: "shop.test.local" })).status, 200, "its sites keep serving");
    // Its sign-in identity is moved aside: a server from before disabling (after a rollback) can't find it.
    const stored = (await t.srv.store.accountById(dev.id))!;
    assert.equal(stored.email, `disabled+${dev.id}@invalid`);
    assert.equal(stored.disabled_email, "dev@b.co");
    assert.equal((await t.json("/v1/accounts", { method: "POST", headers: t.bearer("adm"), body: '{"email":"dev@b.co"}' })).status, 409);
    assert.equal((await t.send("POST", "/v1/admin/accounts", boss.token, { email: "dev@b.co" })).status, 409);
    list = await t.send("GET", "/v1/admin/accounts", boss.token);
    assert.equal(list.body.totals.disabled, 1);

    // Enable: same account, signs in again.
    // Enabling is refused while another account has its email; nothing else changes then.
    await t.srv.store.db.run("UPDATE accounts SET email = 'dev@b.co' WHERE id = ?", boss.id);
    const clash = await t.send("PATCH", `/v1/admin/accounts/${dev.id}`, "adm", { disabled: false, siteAdmin: true });
    assert.equal(clash.status, 409);
    assert.equal((await t.srv.store.accountById(dev.id))!.role, null);
    await t.srv.store.db.run("UPDATE accounts SET email = 'boss@b.co' WHERE id = ?", boss.id);
    const en = await t.send("PATCH", `/v1/admin/accounts/${dev.id}`, boss.token, { disabled: false });
    assert.equal(en.body.account.status, "active");
    const again = await t.account("dev@b.co");
    assert.equal(again.id, dev.id);
    assert.deepEqual((await t.send("GET", "/v1/apps", again.token)).body.apps.map((a: { name: string }) => a.name).sort(), ["anon", "shop"]);

    // Roles by id: grant, remove; not your own.
    assert.equal((await t.send("PATCH", `/v1/admin/accounts/${dev.id}`, boss.token, { siteAdmin: true })).body.account.siteAdmin, true);
    assert.equal((await t.send("GET", "/v1/admin/accounts", again.token)).status, 200);
    assert.equal((await t.send("PATCH", `/v1/admin/accounts/${dev.id}`, again.token, { siteAdmin: false })).status, 400);
    assert.equal((await t.send("PATCH", `/v1/admin/accounts/${dev.id}`, boss.token, { siteAdmin: false })).body.account.siteAdmin, false);
  } finally {
    await t.srv.close();
    await rm(t.dataDir, { recursive: true, force: true });
  }
});

test("organizations: site admins create them; admins manage members; org apps belong to the org", async () => {
  const t = await setup();
  try {
    const boss = await t.account("boss@b.co");
    const alice = await t.account("alice@b.co");
    const bob = await t.account("bob@b.co");
    const carol = await t.account("carol@b.co");
    const dave = await t.account("dave@b.co");

    // Created by site admins only.
    assert.equal((await t.send("POST", "/v1/admin/orgs", alice.token, { name: "acme", admin: "alice@b.co" })).status, 403);
    assert.equal((await t.send("POST", "/v1/admin/orgs", boss.token, { name: "Bad Name", admin: "alice@b.co" })).status, 400);
    assert.equal((await t.send("POST", "/v1/admin/orgs", boss.token, { name: "acme", admin: "nobody@b.co" })).status, 404);
    assert.equal((await t.send("POST", "/v1/admin/orgs", boss.token, { name: "acme", title: "Acme", admin: "alice@b.co" })).status, 201);
    assert.equal((await t.send("POST", "/v1/admin/orgs", boss.token, { name: "acme", admin: "alice@b.co" })).status, 409);
    assert.equal((await t.send("POST", "/v1/admin/orgs", boss.token, { name: "solo" })).status, 400, "a first admin is required");
    assert.deepEqual((await t.send("GET", "/v1/orgs", alice.token)).body.orgs.map((o: { name: string; role: string }) => [o.name, o.role]), [["acme", "admin"]]);

    // Members: existing accounts, added by an org admin with a full-access token.
    const add = (token: string, email: string, role = "member") => t.send("POST", "/v1/orgs/acme/members", token, { email, role });
    assert.equal((await add(alice.token, "bob@b.co")).status, 201);
    assert.equal((await add(alice.token, "bob@b.co")).status, 409);
    assert.equal((await add(alice.token, "ghost@b.co")).body.error, "no_account");
    assert.equal((await add(bob.token, "carol@b.co")).status, 403, "members don't manage members");
    const aliceRead = (await t.send("POST", "/v1/me/tokens", alice.token, { name: "ro", role: "read" })).body.token;
    assert.equal((await add(aliceRead, "carol@b.co")).status, 403, "nor does a read-only token");
    assert.equal((await t.send("GET", "/v1/orgs/acme", dave.token)).status, 404, "outsiders don't see it");
    const org = await t.send("GET", "/v1/orgs/acme", boss.token);
    assert.equal(org.body.canManage, true);
    assert.deepEqual(org.body.members.map((m: { email: string; role: string }) => [m.email, m.role]), [["alice@b.co", "admin"], ["bob@b.co", "member"]]);

    // An app moves in: org admins own it, members get admin access, the old owner (a member) included.
    assert.equal((await t.deploy(bob.token, "bobapp")).status, 201);
    const move = (token: string, app: string, to: string | null) => t.send("PUT", `/v1/apps/${app}/org`, token, { org: to });
    assert.equal((await move(alice.token, "bobapp", "acme")).status, 403, "not the owner");
    assert.equal((await move(bob.token, "bobapp", "acme")).status, 200);
    const access = async (token: string, app = "bobapp") => (await t.send("GET", `/v1/apps/${app}`, token)).body?.app?.access ?? null;
    assert.equal(await access(bob.token), "admin");
    assert.equal(await access(alice.token), "owner");
    assert.equal(await access(carol.token), null);
    const listed = (await t.send("GET", "/v1/apps", alice.token)).body.apps;
    assert.deepEqual(listed.map((a: { name: string; access: string; org: { name: string } }) => [a.name, a.access, a.org.name]), [["bobapp", "owner", "acme"]]);
    assert.equal((await t.send("DELETE", "/v1/apps/bobapp", bob.token)).status, 403, "deleting is for owners");
    assert.equal((await t.deploy(bob.token, "bobapp")).status, 201, "members deploy");
    // Outsiders can't move apps in.
    assert.equal((await t.deploy(dave.token, "daveapp")).status, 201);
    assert.equal((await move(dave.token, "daveapp", "acme")).status, 404, "nor can they tell it exists");
    assert.equal((await add(dave.token, "dave@b.co")).status, 404);
    assert.equal((await t.json("/v1/orgs/acme")).status, 401);
    assert.equal((await t.json("/v1/orgs/nope")).status, 401);
    // Artifacts move in too; a member can open a private one.
    const pg = (await t.send("POST", "/v1/pages", alice.token, { html: "secret", visibility: "private" })).body.page;
    assert.equal((await move(alice.token, pg.name, "acme")).status, 200);
    assert.equal((await t.send("POST", `/v1/pages/${pg.name}/view`, bob.token, {})).status, 200);

    // Removing a member: their access goes, and the apps they held go to an org admin.
    const bobId = bob.id;
    assert.equal((await t.send("DELETE", `/v1/orgs/acme/members/${bobId}`, bob.token)).status, 200, "members can leave");
    assert.equal(await access(bob.token), null);
    assert.equal((await t.srv.store.appByName("bobapp"))!.account_id, alice.id);

    // The last enabled admin stays (for site admins too).
    assert.equal((await t.send("DELETE", `/v1/orgs/acme/members/${alice.id}`, alice.token)).body.error, "last_admin");
    assert.equal((await t.send("PUT", `/v1/orgs/acme/members/${alice.id}`, alice.token, { role: "member" })).body.error, "last_admin");
    assert.equal((await t.send("DELETE", `/v1/orgs/acme/members/${alice.id}`, boss.token)).body.error, "last_admin", "site admins promote another first");
    assert.equal((await add(alice.token, "carol@b.co", "admin")).status, 201);
    // Disabling an org admin hands its org apps to another one.
    assert.equal((await t.send("PATCH", `/v1/admin/accounts/${alice.id}`, boss.token, { disabled: true })).status, 200);
    assert.equal((await t.srv.store.appByName("bobapp"))!.account_id, carol.id);
    assert.equal((await t.send("DELETE", `/v1/orgs/acme/members/${carol.id}`, carol.token)).body.error, "last_admin", "a disabled admin doesn't count");
    await t.send("PATCH", `/v1/admin/accounts/${alice.id}`, boss.token, { disabled: false });

    // Out of the org: the caller's personal app (quota permitting); an org with apps isn't deleted.
    assert.equal((await t.send("DELETE", "/v1/admin/orgs/acme", boss.token)).body.error, "not_empty");
    assert.equal((await move(carol.token, "bobapp", null)).status, 200);
    assert.equal((await move(carol.token, pg.name, null)).status, 200);
    assert.equal(await access(carol.token), "owner");
    assert.equal((await t.send("GET", "/v1/admin/orgs", boss.token)).body.orgs[0].apps, 0);
    assert.equal((await t.send("DELETE", "/v1/admin/orgs/acme", boss.token)).status, 200);
    assert.deepEqual((await t.send("GET", "/v1/orgs", carol.token)).body.orgs, []);

    // An org whose only admin is disabled: its apps go to a member, who then can't leave holding them, and no
    // app moves in until it has an enabled admin again.
    assert.equal((await t.send("POST", "/v1/admin/orgs", boss.token, { name: "beta", admin: "dave@b.co" })).status, 201);
    assert.equal((await t.send("POST", "/v1/orgs/beta/members", dave.token, { email: "bob@b.co" })).status, 201);
    assert.equal((await move(dave.token, "daveapp", "beta")).status, 200);
    await t.send("PATCH", `/v1/admin/accounts/${dave.id}`, boss.token, { disabled: true });
    assert.equal((await t.srv.store.appByName("daveapp"))!.account_id, bob.id);
    assert.equal((await t.send("DELETE", `/v1/orgs/beta/members/${bob.id}`, bob.token)).body.error, "no_successor");
    assert.equal(await access(bob.token, "daveapp"), "admin", "still a member");
    assert.equal((await t.deploy(bob.token, "bob2")).status, 201);
    assert.equal((await move(bob.token, "bob2", "beta")).body.error, "no_admin");
  } finally {
    await t.srv.close();
    await rm(t.dataDir, { recursive: true, force: true });
  }
});
