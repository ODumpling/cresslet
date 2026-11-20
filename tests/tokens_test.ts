import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "../server/main.ts";
import { loadConfig } from "../server/config.ts";
import { sha256 } from "../server/store.ts";

async function setup(dataDir?: string) {
  dataDir ??= await mkdtemp(join(tmpdir(), "cresslet-tok-"));
  const srv = createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80, adminToken: "adm" }));
  const json = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", "test.local");
    if (init.body) headers.set("content-type", "application/json");
    const r = await srv.handler(new Request(`http://test.local${path}`, { ...init, headers }));
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const account = async (email: string) =>
    (await json("/v1/accounts", { method: "POST", headers: bearer("adm"), body: JSON.stringify({ email }) })).body.token as string;
  const deploy = (token: string, app?: string) =>
    json("/v1/deploys", { method: "POST", headers: bearer(token), body: JSON.stringify({ app, files: [{ path: "index.html", data: "hi" }] }) });
  const mint = (token: string, input: unknown) =>
    json("/v1/me/tokens", { method: "POST", headers: bearer(token), body: JSON.stringify(input) });
  return { dataDir, srv, json, bearer, account, deploy, mint };
}

test("named tokens: create, list (no secrets), last used, revoke one", async () => {
  const t = await setup();
  try {
    const root = await t.account("a@b.co");
    const made = await t.mint(root, { name: "CI" });
    assert.equal(made.status, 201);
    assert.match(made.body.token, /^clv_acct_/);
    assert.deepEqual(
      { ...made.body.info, id: undefined, createdAt: undefined },
      { id: undefined, name: "CI", role: "admin", apps: null, createdAt: undefined, lastUsedAt: null },
    );
    const ci = made.body.token;
    assert.equal((await t.json("/v1/me", { headers: t.bearer(ci) })).body.token.name, "CI");

    const list = await t.json("/v1/me/tokens", { headers: t.bearer(root) });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.tokens.map((x: { name: string; current: boolean }) => [x.name, x.current]), [
      ["Operator-issued", true],
      ["CI", false],
    ]);
    assert.ok(list.body.tokens[1].lastUsedAt, "use recorded");
    assert.ok(!JSON.stringify(list.body).includes("clv_acct_"), "secrets never listed");

    // Revoke one: it stops working, the others keep going.
    const ciId = made.body.info.id;
    assert.equal((await t.json(`/v1/me/tokens/${ciId}`, { method: "DELETE", headers: t.bearer(root) })).status, 200);
    assert.equal((await t.json("/v1/me", { headers: t.bearer(ci) })).status, 401);
    assert.equal((await t.json("/v1/me", { headers: t.bearer(root) })).status, 200);
    assert.equal((await t.json(`/v1/me/tokens/${ciId}`, { method: "DELETE", headers: t.bearer(root) })).status, 404);

    // Another account can't see or revoke them.
    const other = await t.account("o@b.co");
    const rootId = list.body.tokens[0].id;
    assert.equal((await t.json(`/v1/me/tokens/${rootId}`, { method: "DELETE", headers: t.bearer(other) })).status, 404);
    assert.equal((await t.json("/v1/me", { headers: t.bearer(root) })).status, 200);
    assert.equal((await t.json("/v1/me/tokens", { headers: t.bearer(other) })).body.tokens.length, 1);

    // Validation.
    assert.equal((await t.mint(root, { name: "" })).status, 400);
    assert.equal((await t.mint(root, { name: "x".repeat(65) })).status, 400);
    assert.equal((await t.mint(root, { name: "x", role: "owner" })).status, 400);
    assert.equal((await t.mint(root, { name: "x", apps: [] })).status, 400);
    assert.equal((await t.mint(root, { name: "x", apps: ["nope"] })).status, 400);
    const theirs = (await t.deploy(other)).body.app.name;
    assert.equal((await t.mint(root, { name: "x", apps: [theirs] })).status, 400);
  } finally {
    t.srv.close();
    await rm(t.dataDir, { recursive: true, force: true });
  }
});

test("scoped tokens: roles and app limits are enforced", async () => {
  const t = await setup();
  try {
    const root = await t.account("a@b.co");
    const one = (await t.deploy(root)).body.app.name, two = (await t.deploy(root)).body.app.name;
    const tok = async (input: unknown) => (await t.mint(root, input)).body.token as string;
    const read = await tok({ name: "dash", role: "read" });
    const dep = await tok({ name: "ci", role: "deploy", apps: [one] });
    const adm1 = await tok({ name: "app admin", role: "admin", apps: [one] });
    const st = async (token: string, method: string, path: string, body?: unknown) =>
      (await t.json(path, { method, headers: t.bearer(token), body: body === undefined ? undefined : JSON.stringify(body) })).status;

    // read: look, don't touch.
    assert.equal(await st(read, "GET", `/v1/apps/${one}`), 200);
    assert.equal(await st(read, "GET", `/v1/apps/${two}/logs`), 200);
    assert.equal(await st(read, "GET", `/v1/apps/${one}/secrets`), 200);
    assert.equal(await st(read, "POST", `/v1/apps/${one}/db/query`, { sql: "select 1" }), 200);
    assert.equal((await t.deploy(read, one)).status, 403);
    assert.equal((await t.deploy(read)).status, 403); // no new apps either
    assert.equal(await st(read, "POST", `/v1/apps/${one}/rollback`, {}), 403);
    assert.equal(await st(read, "PUT", `/v1/apps/${one}/secrets`, { K: "v" }), 403);
    assert.equal(await st(read, "DELETE", `/v1/apps/${one}`), 403);
    assert.equal((await t.json("/v1/apps", { headers: t.bearer(read) })).body.apps.length, 2);

    // deploy, limited to one app: deploy/rollback there, nothing elsewhere, no new apps, no admin.
    assert.equal((await t.deploy(dep, one)).status, 201);
    assert.equal(await st(dep, "POST", `/v1/apps/${one}/rollback`, {}), 200);
    assert.equal(await st(dep, "GET", `/v1/apps/${one}/logs`), 200);
    assert.equal((await t.deploy(dep, two)).status, 403);
    assert.equal(await st(dep, "GET", `/v1/apps/${two}`), 403);
    assert.equal((await t.deploy(dep)).status, 403);
    assert.equal((await t.deploy(dep, "brand-new-app")).status, 403);
    assert.equal(await st(dep, "PUT", `/v1/apps/${one}/egress`, { allow: [] }), 403);
    assert.equal(await st(dep, "DELETE", `/v1/apps/${one}`), 403);
    assert.deepEqual((await t.json("/v1/apps", { headers: t.bearer(dep) })).body.apps.map((a: { name: string }) => a.name), [one]);
    assert.equal((await t.json("/v1/me", { headers: t.bearer(dep) })).status, 200); // `cresslet login --token` works

    // admin limited to one app: manages it, but not the account (tokens, claims) or other apps.
    assert.equal(await st(adm1, "PUT", `/v1/apps/${one}/secrets`, { K: "v" }), 200);
    assert.equal(await st(adm1, "PUT", `/v1/apps/${two}/secrets`, { K: "v" }), 403);
    assert.equal(await st(adm1, "GET", "/v1/me/tokens"), 403);
    assert.equal(await st(adm1, "POST", "/v1/me/tokens", { name: "escalate" }), 403);
    assert.equal(await st(adm1, "POST", "/v1/me/token", {}), 403);
    for (const x of [read, dep]) {
      assert.equal(await st(x, "GET", "/v1/me/tokens"), 403);
      assert.equal(await st(x, "POST", "/v1/me/tokens", { name: "escalate", role: "admin" }), 403);
    }
    const anon = await t.json("/v1/deploys", { method: "POST", body: JSON.stringify({ files: [{ path: "index.html", data: "x" }] }) });
    assert.equal(await st(adm1, "POST", `/v1/apps/${anon.body.app.name}/claim`, { deployKey: anon.body.deployKey }), 403);
    assert.equal(await st(root, "POST", `/v1/apps/${anon.body.app.name}/claim`, { deployKey: anon.body.deployKey }), 200);
    assert.equal(await st(adm1, "DELETE", `/v1/apps/${one}`), 200);

    // A deleted app doesn't come back into scope when its name is reused.
    assert.equal((await t.deploy(root, one)).status, 201);
    assert.equal((await t.deploy(dep, one)).status, 403);
    const listed = (await t.json("/v1/me/tokens", { headers: t.bearer(root) })).body.tokens;
    assert.deepEqual(listed.find((x: { name: string }) => x.name === "ci").apps, []);
  } finally {
    t.srv.close();
    await rm(t.dataDir, { recursive: true, force: true });
  }
});

test("tokens from before named tokens keep full access", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-tok-mig-"));
  try {
    // The previous schema, with one account and one token.
    const legacy = "clv_acct_" + "ab".repeat(24);
    const db = new DatabaseSync(join(dataDir, "cresslet.db"));
    db.exec(`
      CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE tokens (hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL);
      INSERT INTO accounts VALUES ('acct_1', 'old@b.co', 1);
    `);
    db.prepare("INSERT INTO tokens VALUES (?, 'acct_1', 2)").run(await sha256(legacy));
    db.prepare("INSERT INTO tokens VALUES (?, 'acct_1', 3)").run(await sha256(legacy + "2"));
    db.close();

    const t = await setup(dataDir);
    try {
      const me = await t.json("/v1/me", { headers: t.bearer(legacy) });
      assert.equal(me.status, 200);
      assert.equal(me.body.account.email, "old@b.co");
      assert.equal(me.body.token.role, "admin");
      assert.equal(me.body.token.apps, null);
      const list = (await t.json("/v1/me/tokens", { headers: t.bearer(legacy) })).body.tokens;
      assert.equal(list.length, 2);
      assert.notEqual(list[0].id, list[1].id);
      assert.match(list[0].id, /^tok_/);
      assert.equal((await t.deploy(legacy)).status, 201);
      assert.equal((await t.mint(legacy, { name: "new" })).status, 201);
    } finally {
      t.srv.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
