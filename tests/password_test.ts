import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/main.ts";
import { type Config, loadConfig } from "../server/config.ts";
import { hashPassword, verifyPassword } from "../server/passwords.ts";
import { PasswordChangedError } from "../server/store.ts";

async function setup(overrides: Partial<Config> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-pw-"));
  const srv = await createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80, adminToken: "adm", passwordLogin: true, clientIpHeader: "x-test-ip", ...overrides }));
  const json = async (path: string, init: RequestInit & { ip?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", "test.local");
    headers.set("x-test-ip", init.ip ?? "10.0.0.1");
    if (init.body) headers.set("content-type", "application/json");
    const r = await srv.handler(new Request(`http://test.local${path}`, { ...init, headers }));
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const create = (body: unknown) => json("/v1/accounts", { method: "POST", headers: bearer("adm"), body: JSON.stringify(body) });
  const login = (email: string, password: string, ip?: string) =>
    json("/v1/auth/password", { method: "POST", body: JSON.stringify({ email, password }), ip });
  return { srv, json, bearer, create, login, dispose: async () => (await srv.close(), await rm(dataDir, { recursive: true, force: true })) };
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

test("hashes: salted, verify matches only the password; no hash never matches", async () => {
  const a = await hashPassword("correct horse"), b = await hashPassword("correct horse");
  assert.notEqual(a, b);
  assert.match(a, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword("correct horse", a), true);
  assert.equal(await verifyPassword("correct horsf", a), false);
  assert.equal(await verifyPassword("anything", null), false);
});

test("config: password login follows GitHub login unless set", () => {
  const gh = { clientId: "c", clientSecret: "s", webUrl: "https://github.com", apiUrl: "https://api.github.com" };
  assert.equal(loadConfig({ github: null }).passwordLogin, false);
  assert.equal(loadConfig({ github: gh }).passwordLogin, true);
  process.env.CRESSLET_PASSWORD_LOGIN = "false";
  try {
    assert.equal(loadConfig({ github: gh }).passwordLogin, false);
    process.env.CRESSLET_PASSWORD_LOGIN = "true";
    assert.equal(loadConfig({ github: null }).passwordLogin, true);
  } finally {
    delete process.env.CRESSLET_PASSWORD_LOGIN;
  }
});

test("meta: password login and the CLI browser login, without GitHub", withServer(async (t) => {
  assert.deepEqual((await t.json("/v1")).body.auth, { github: false, password: true, cli: true });
  assert.equal((await t.json("/v1/auth/cli", { method: "POST", body: "{}" })).status, 200);
}));

test("off: no password route, the operator can't set one", withServer(async (t) => {
  assert.deepEqual((await t.json("/v1")).body.auth, { github: false, password: false, cli: false });
  assert.equal((await t.login("a@b.co", "whatever-123")).status, 404);
  assert.equal((await t.create({ email: "a@b.co", password: "whatever-123" })).status, 400);
}, { passwordLogin: false }));

test("operator-set password: log in by email (any case), wrong ones refused alike", withServer(async (t) => {
  assert.equal((await t.create({ email: "a@b.co", password: "short" })).status, 400);
  const made = await t.create({ email: "a@b.co", password: "hunter22!" });
  assert.equal(made.status, 201);
  assert.equal(made.body.account.password, true);
  assert.equal(JSON.stringify(made.body).includes("scrypt"), false);

  const ok = await t.login(" A@B.co ", "hunter22!");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.account.id, made.body.account.id);
  assert.match(ok.body.token, /^clv_acct_/);
  const me = await t.json("/v1/me", { headers: t.bearer(ok.body.token) });
  assert.equal(me.body.tokenInfo.name, "Studio (password login)");
  assert.equal(me.body.account.password, true);

  const wrong = await t.login("a@b.co", "hunter23!");
  const nobody = await t.login("nobody@b.co", "hunter22!");
  assert.deepEqual([wrong.status, wrong.body.error], [401, "invalid_credentials"]);
  assert.deepEqual(nobody.body, wrong.body);
  assert.equal((await t.login("a@b.co", "")).status, 400);

  // An account without a password (invited, or GitHub-only) can't be logged in to by password.
  await t.create({ email: "c@b.co" });
  assert.equal((await t.login("c@b.co", "")).status, 400);
  assert.equal((await t.login("c@b.co", "anything-at-all")).status, 401);

  // The operator resets it.
  assert.equal((await t.create({ email: "a@b.co", password: "new-one-456" })).status, 201);
  assert.equal((await t.login("a@b.co", "hunter22!")).status, 401);
  assert.equal((await t.login("a@b.co", "new-one-456")).status, 200);
}));

test("no signup by password: an unknown email gets no account", withServer(async (t) => {
  assert.equal((await t.login("new@b.co", "hunter22!")).status, 401);
  assert.equal((await t.json("/v1/admin/accounts", { headers: t.bearer("adm") })).body.accounts.length, 0);
}, { openSignup: true }));

test("settings: set a password, change it only with the current one", withServer(async (t) => {
  const tok = (await t.create({ email: "a@b.co" })).body.token as string;
  const put = (body: unknown, token = tok) => t.json("/v1/me/password", { method: "PUT", headers: t.bearer(token), body: JSON.stringify(body) });
  assert.equal((await put({ password: "short" })).status, 400);
  assert.equal((await put({ password: "x".repeat(257) })).status, 400);
  const set = await put({ password: "first-pass-1" });
  assert.equal(set.status, 200);
  assert.equal(set.body.account.password, true);
  assert.equal((await t.login("a@b.co", "first-pass-1")).status, 200);

  // Changing: the current password, not just a token. Wrong: 403 (the session stays).
  assert.deepEqual((await put({ password: "second-pass-2" })).body.error, "wrong_password");
  const bad = await put({ password: "second-pass-2", currentPassword: "nope-nope" });
  assert.equal(bad.status, 403);
  assert.equal((await t.json("/v1/me", { headers: t.bearer(tok) })).status, 200);
  assert.equal((await put({ password: "second-pass-2", currentPassword: "first-pass-1" })).status, 200);
  assert.equal((await t.login("a@b.co", "first-pass-1")).status, 401);
  assert.equal((await t.login("a@b.co", "second-pass-2")).status, 200);

  // An over-long current password is just wrong.
  assert.equal((await put({ password: "third-pass-3", currentPassword: "x".repeat(257) })).status, 403);

  // A scoped token can't.
  const scoped = (await t.json("/v1/me/tokens", { method: "POST", headers: t.bearer(tok), body: '{"name":"ci","role":"deploy"}' })).body.token;
  assert.equal((await put({ password: "third-pass-3", currentPassword: "second-pass-2" }, scoped)).status, 403);
  assert.equal((await t.json("/v1/me/password", { method: "PUT", body: '{"password":"third-pass-3"}' })).status, 401);
}));

test("disabled account: password login refused", withServer(async (t) => {
  const made = await t.create({ email: "a@b.co", password: "hunter22!" });
  const off = await t.json(`/v1/admin/accounts/${made.body.account.id}`, { method: "PATCH", headers: t.bearer("adm"), body: '{"disabled":true}' });
  assert.equal(off.status, 200);
  assert.equal((await t.login("a@b.co", "hunter22!")).status, 401);
  await t.json(`/v1/admin/accounts/${made.body.account.id}`, { method: "PATCH", headers: t.bearer("adm"), body: '{"disabled":false}' });
  assert.equal((await t.login("a@b.co", "hunter22!")).status, 200);
}));

test("rate limits: per email, and per client", withServer(async (t) => {
  await t.create({ email: "a@b.co", password: "hunter22!" });
  for (let i = 0; i < 10; i++) assert.equal((await t.login("a@b.co", `guess-${i}-xx`, `10.0.1.${i}`)).status, 401);
  // Even the right password, from a new client: that email is resting.
  assert.equal((await t.login("a@b.co", "hunter22!", "10.0.2.1")).status, 429);
  for (let i = 0; i < 30; i++) assert.equal((await t.login(`u${i}@b.co`, "guess-xx-1", "10.0.3.1")).status, 401);
  assert.equal((await t.login("other@b.co", "guess-xx-1", "10.0.3.1")).status, 429);
}));

test("remove: needs the current password; then no password login", withServer(async (t) => {
  const made = await t.create({ email: "a@b.co", password: "hunter22!" });
  const del = (currentPassword?: string) =>
    t.json("/v1/me/password", { method: "DELETE", headers: t.bearer(made.body.token), body: JSON.stringify({ currentPassword }) });
  // Like replacing it, removing it needs the current one (a token alone can't clear the way for its own).
  assert.equal((await del()).status, 403);
  assert.equal((await del("not-it-123")).status, 403);
  const ok = await del("hunter22!");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.account.password, false);
  assert.equal((await t.login("a@b.co", "hunter22!")).status, 401);
}));

test("operator: no current password needed to reset, and it counts on a GitHub-linked account", withServer(async (t) => {
  const made = await t.create({ email: "a@b.co", password: "hunter22!" });
  await t.srv.store.db.run("UPDATE accounts SET github_id = 42, github_login = 'octo' WHERE id = ?", made.body.account.id);
  const reset = await t.create({ email: "a@b.co", password: "reset-pass-1" });
  assert.equal(reset.body.account.password, true);
  assert.equal((await t.login("a@b.co", "reset-pass-1")).status, 200);
  assert.equal((await t.login("a@b.co", "hunter22!")).status, 401);
}));

test("in flight: a login or a password save after the password or token changed gets nothing", withServer(async (t) => {
  const made = await t.create({ email: "a@b.co", password: "hunter22!" });
  const store = t.srv.store, id = made.body.account.id;
  const before = (await store.accountById(id))!.password_hash!;
  const me = await t.json("/v1/me", { headers: t.bearer(made.body.token) });
  const tokenId = me.body.tokenInfo.id;
  // The password changed after a login read it: no token.
  await store.setPasswordHash(id, "other");
  await assert.rejects(store.issueToken(id, { name: "late", passwordHash: before }), PasswordChangedError);
  // A save that read the old hash, or whose token was revoked meanwhile, writes nothing.
  assert.equal(await store.setPasswordHash(id, "mine", { was: before, tokenId }), false);
  assert.equal(await store.setPasswordHash(id, "mine", { was: ":other", tokenId }), true);
  await store.revokeTokens(id);
  assert.equal(await store.setPasswordHash(id, "again", { was: ":mine", tokenId }), false);
  assert.equal((await store.accountById(id))!.password_hash, ":mine");
}));

test("a password set before a GitHub link stops counting (the link by a server without passwords)", withServer(async (t) => {
  const made = await t.create({ email: "a@b.co", password: "hunter22!" });
  // What an older server's GitHub link does: id set, tokens gone, the password column left alone.
  await t.srv.store.db.run("UPDATE accounts SET github_id = 42, github_login = 'octo' WHERE id = ?", made.body.account.id);
  assert.equal((await t.login("a@b.co", "hunter22!")).status, 401);
  const tok = (await t.create({ email: "a@b.co" })).body.token;
  assert.equal((await t.json("/v1/me", { headers: t.bearer(tok) })).body.account.password, false);
  // Set again now: it counts (bound to that GitHub id).
  assert.equal((await t.json("/v1/me/password", { method: "PUT", headers: t.bearer(tok), body: '{"password":"after-link-1"}' })).status, 200);
  assert.equal((await t.login("a@b.co", "after-link-1")).status, 200);
}));
