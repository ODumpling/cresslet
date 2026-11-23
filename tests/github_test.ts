import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../server/main.ts";
import { type Config, loadConfig } from "../server/config.ts";

type FakeUser = { id: number; login: string; emails: { email: string; primary: boolean; verified: boolean }[] };

/** Minimal GitHub: OAuth web + device endpoints, /user, /user/emails. */
async function fakeGithub() {
  const tokens = new Map<string, FakeUser>(); // access token → user
  const codes = new Map<string, FakeUser>(); // web code → user
  const devices = new Map<string, { user?: FakeUser; denied?: boolean }>();
  let n = 0;
  const readBody = async (req: IncomingMessage) => {
    let s = "";
    for await (const c of req) s += c;
    return Object.fromEntries(new URLSearchParams(s));
  };
  const issue = (u: FakeUser) => {
    const t = `gho_${++n}`;
    tokens.set(t, u);
    return t;
  };
  const server = httpServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/login/device/code") {
      const b = await readBody(req);
      assert.equal(b.client_id, "cid");
      const dc = `dc_${++n}`;
      devices.set(dc, {});
      return json(200, { device_code: dc, user_code: "ABCD-1234", verification_uri: "https://gh/login/device", expires_in: 900, interval: 5 });
    }
    if (url.pathname === "/login/oauth/access_token") {
      const b = await readBody(req);
      if (b.device_code) {
        const d = devices.get(b.device_code);
        if (!d) return json(200, { error: "expired_token" });
        if (d.denied) return json(200, { error: "access_denied" });
        if (!d.user) return json(200, { error: "authorization_pending" });
        devices.delete(b.device_code);
        return json(200, { access_token: issue(d.user) });
      }
      assert.equal(b.client_secret, "csecret");
      const u = codes.get(b.code);
      codes.delete(b.code);
      return u ? json(200, { access_token: issue(u) }) : json(200, { error: "bad_verification_code" });
    }
    const u = tokens.get(req.headers.authorization?.replace("Bearer ", "") ?? "");
    if (!u) return json(401, { message: "Bad credentials" });
    if (url.pathname === "/user") return json(200, { id: u.id, login: u.login, email: null });
    if (url.pathname === "/user/emails") return json(200, u.emails);
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    /** Simulate the user approving the web flow: returns the code GitHub would redirect back with. */
    approveWeb(u: FakeUser) {
      const c = `code_${++n}`;
      codes.set(c, u);
      return c;
    },
    approveDevice: (dc: string, u: FakeUser) => devices.set(dc, { user: u }),
    denyDevice: (dc: string) => devices.set(dc, { denied: true }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function setup(overrides: Partial<Config> = {}) {
  const gh = await fakeGithub();
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-gh-test-"));
  const srv = await createServer(loadConfig({
    dataDir,
    domain: "test.local",
    publicPort: 80,
    github: { clientId: "cid", clientSecret: "csecret", webUrl: gh.base, apiUrl: gh.base },
    adminToken: "adm",
    ...overrides,
  }));
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", "test.local");
    if (init.body) headers.set("content-type", "application/json");
    return srv.handler(new Request(`http://test.local${path}`, { ...init, headers }));
  };
  const json = async (path: string, init: RequestInit = {}) => {
    const r = await call(path, init);
    return { status: r.status, body: await r.json() };
  };
  /** Full web flow; returns the studio redirect URL. */
  const webLogin = async (u: FakeUser, tamper?: { state?: string; cookie?: string }) => {
    const start = await call("/v1/auth/github");
    assert.equal(start.status, 302);
    const authorize = new URL(start.headers.get("location")!);
    assert.equal(authorize.origin + authorize.pathname, `${gh.base}/login/oauth/authorize`);
    assert.equal(authorize.searchParams.get("redirect_uri"), "http://test.local/v1/auth/github/callback");
    const cookie = start.headers.get("set-cookie")!.split(";")[0];
    const state = tamper?.state ?? authorize.searchParams.get("state")!;
    const cb = await call(`/v1/auth/github/callback?code=${gh.approveWeb(u)}&state=${state}`, {
      headers: { cookie: tamper?.cookie ?? cookie },
    });
    assert.equal(cb.status, 302);
    return new URL(cb.headers.get("location")!);
  };
  return {
    gh,
    srv,
    call,
    json,
    webLogin,
    async dispose() {
      await srv.close();
      await gh.close();
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

const octo: FakeUser = { id: 42, login: "octo", emails: [{ email: "Octo@Example.com", primary: true, verified: true }] };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test("meta advertises GitHub login", withServer(async (t) => {
  // Password login comes on with GitHub's unless CRESSLET_PASSWORD_LOGIN says otherwise.
  assert.deepEqual((await t.json("/v1")).body.auth, { github: true, password: true, cli: true });
}));

test("studio web flow: one-time code → token, account by GitHub id", withServer(async (t) => {
  const back = await t.webLogin(octo);
  assert.equal(back.origin + back.pathname, "http://test.local/");
  const code = new URLSearchParams(back.hash.slice(1)).get("cresslet_login")!;
  assert.ok(code);
  const ex = await t.json("/v1/auth/exchange", { method: "POST", body: JSON.stringify({ code }) });
  assert.equal(ex.status, 200);
  assert.deepEqual(ex.body.account.email, "octo@example.com");
  assert.deepEqual(ex.body.account.github, "octo");
  const me = await t.json("/v1/me", { headers: bearer(ex.body.token) });
  assert.equal(me.body.account.id, ex.body.account.id);

  // code is single-use
  assert.equal((await t.json("/v1/auth/exchange", { method: "POST", body: JSON.stringify({ code }) })).status, 400);

  // second login (GitHub login renamed) → same account
  const back2 = await t.webLogin({ ...octo, login: "octo2" });
  const ex2 = await t.json("/v1/auth/exchange", {
    method: "POST",
    body: JSON.stringify({ code: new URLSearchParams(back2.hash.slice(1)).get("cresslet_login") }),
  });
  assert.equal(ex2.body.account.id, ex.body.account.id);
  assert.equal(ex2.body.account.github, "octo2");
}));

test("web flow rejects state not bound to this browser", withServer(async (t) => {
  const back = await t.webLogin(octo, { cookie: "cresslet_oauth_state=st_other" });
  assert.match(new URLSearchParams(back.hash.slice(1)).get("cresslet_login_error")!, /expired/);
  const back2 = await t.webLogin(octo, { state: "st_forged", cookie: "cresslet_oauth_state=st_forged" });
  assert.match(new URLSearchParams(back2.hash.slice(1)).get("cresslet_login_error")!, /expired/);
}));

test("CLI browser login: studio approves the code, the poll gets a new token once", withServer(async (t) => {
  const back = await t.webLogin(octo);
  const studio = await t.json("/v1/auth/exchange", {
    method: "POST",
    body: JSON.stringify({ code: new URLSearchParams(back.hash.slice(1)).get("cresslet_login") }),
  });
  const start = await t.json("/v1/auth/cli", { method: "POST", body: "{}" });
  assert.equal(start.status, 200);
  assert.match(start.body.userCode, /^[A-Z]{4}-[A-Z]{4}$/);
  assert.equal(start.body.verificationUri, "http://test.local/cli"); // the user types the code
  const poll = (deviceCode = start.body.deviceCode) =>
    t.json("/v1/auth/cli/token", { method: "POST", body: JSON.stringify({ deviceCode }) });
  assert.deepEqual((await poll()).body, { status: "pending" });

  const approve = (userCode: string, headers: HeadersInit = bearer(studio.body.token)) =>
    t.json("/v1/auth/cli/approve", { method: "POST", headers, body: JSON.stringify({ userCode }) });
  assert.equal((await approve(start.body.userCode, {})).status, 401); // needs the studio's login
  assert.equal((await approve("BBBB-BBBB")).status, 404);
  assert.equal((await approve(start.body.userCode.toLowerCase().replace("-", ""))).status, 200); // typed by hand
  assert.equal((await approve(start.body.userCode)).status, 404); // once

  const done = await poll();
  assert.equal(done.body.status, "complete");
  assert.equal(done.body.account.id, studio.body.account.id);
  const me = await t.json("/v1/me", { headers: bearer(done.body.token) });
  assert.equal(me.body.tokenInfo.name, "CLI (browser login)");
  assert.notEqual(done.body.token, studio.body.token);
  assert.equal((await poll()).body.error, "expired_token"); // single use
  assert.equal((await poll("cli_nope")).status, 400);

  // a scoped token can't hand out a full-access one
  const scoped = await t.json("/v1/me/tokens", {
    method: "POST",
    headers: bearer(studio.body.token),
    body: JSON.stringify({ name: "ro", role: "read" }),
  });
  assert.equal(scoped.status, 201, JSON.stringify(scoped.body));
  const s2 = await t.json("/v1/auth/cli", { method: "POST", body: "{}" });
  assert.equal((await approve(s2.body.userCode, bearer(scoped.body.token))).status, 403);

  // the approving token revoked before the CLI collects: no token
  const other = await t.json("/v1/me/tokens", {
    method: "POST",
    headers: bearer(studio.body.token),
    body: JSON.stringify({ name: "other" }),
  });
  assert.equal((await approve(s2.body.userCode, bearer(other.body.token))).status, 200);
  await t.json(`/v1/me/tokens/${other.body.info.id}`, { method: "DELETE", headers: bearer(studio.body.token) });
  assert.equal((await poll(s2.body.deviceCode)).body.error, "expired_token");
  const names = (await t.json("/v1/me/tokens", { headers: bearer(studio.body.token) })).body.tokens.map((x: { name: string }) => x.name);
  assert.equal(names.filter((n: string) => n === "CLI (browser login)").length, 1);

  // code guesses are limited per account (10 tries / 10 min, including the ones above)
  let status = 0;
  for (let i = 0; i < 10 && status !== 429; i++) status = (await approve("BBBB-BBBB")).status;
  assert.equal(status, 429);
}));

test("CLI browser login is rate limited per client", withServer(async (t) => {
  for (let i = 0; i < 20; i++) assert.equal((await t.json("/v1/auth/cli", { method: "POST", body: "{}" })).status, 200);
  assert.equal((await t.json("/v1/auth/cli", { method: "POST", body: "{}" })).status, 429);
}));

test("CLI device flow: pending → complete, denial", withServer(async (t) => {
  const start = await t.json("/v1/auth/github/device", { method: "POST", body: "{}" });
  assert.equal(start.status, 200);
  assert.equal(start.body.userCode, "ABCD-1234");
  const poll = () =>
    t.json("/v1/auth/github/device/token", { method: "POST", body: JSON.stringify({ deviceCode: start.body.deviceCode }) });
  assert.deepEqual((await poll()).body, { status: "pending" });
  t.gh.approveDevice(start.body.deviceCode, octo);
  const done = await poll();
  assert.equal(done.body.status, "complete");
  assert.equal(done.body.account.github, "octo");
  assert.equal((await t.json("/v1/me", { headers: bearer(done.body.token) })).status, 200);

  const s2 = await t.json("/v1/auth/github/device", { method: "POST", body: "{}" });
  t.gh.denyDevice(s2.body.deviceCode);
  const denied = await t.json("/v1/auth/github/device/token", {
    method: "POST",
    body: JSON.stringify({ deviceCode: s2.body.deviceCode }),
  });
  assert.equal(denied.status, 400);
  assert.equal(denied.body.error, "access_denied");
}));

test("GitHub only: no email login; operator pre-created account links, old tokens revoked", withServer(async (t) => {
  const email = await t.json("/v1/accounts", { method: "POST", body: '{"email":"octo@example.com"}' });
  assert.equal(email.status, 403);

  // operator pre-creates the account (closed-instance style)
  const pre = await t.json("/v1/accounts", {
    method: "POST",
    headers: bearer("adm"),
    body: '{"email":"octo@example.com"}',
  });
  assert.equal(pre.status, 201);

  // GitHub login with the same verified email links to it and revokes the unverified token
  const s = await t.json("/v1/auth/github/device", { method: "POST", body: "{}" });
  t.gh.approveDevice(s.body.deviceCode, octo);
  const done = await t.json("/v1/auth/github/device/token", {
    method: "POST",
    body: JSON.stringify({ deviceCode: s.body.deviceCode }),
  });
  assert.equal(done.body.account.id, pre.body.account.id);
  assert.equal((await t.json("/v1/me", { headers: bearer(pre.body.token) })).status, 401);
  assert.equal((await t.json("/v1/me", { headers: bearer(done.body.token) })).status, 200);

  // closed instance: unknown GitHub users can't sign up
  const s2 = await t.json("/v1/auth/github/device", { method: "POST", body: "{}" });
  t.gh.approveDevice(s2.body.deviceCode, { id: 7, login: "x", emails: [] });
  const d2 = await t.json("/v1/auth/github/device/token", {
    method: "POST",
    body: JSON.stringify({ deviceCode: s2.body.deviceCode }),
  });
  assert.equal(d2.status, 403);
}, { openSignup: false }));

const deviceLogin = async (t: T, u: FakeUser) => {
  const s = await t.json("/v1/auth/github/device", { method: "POST", body: "{}" });
  t.gh.approveDevice(s.body.deviceCode, u);
  return t.json("/v1/auth/github/device/token", { method: "POST", body: JSON.stringify({ deviceCode: s.body.deviceCode }) });
};

test("unverified GitHub email never links to an existing account", withServer(async (t) => {
  const other = await t.json("/v1/accounts", { method: "POST", headers: bearer("adm"), body: '{"email":"someone@else.co"}' });
  const d = await deviceLogin(t, { id: 7, login: "x", emails: [{ email: "someone@else.co", primary: true, verified: false }] });
  assert.equal(d.body.account.email, "7+x@users.noreply.github.com");
  assert.notEqual(d.body.account.id, other.body.account.id);
  assert.equal((await t.json("/v1/me", { headers: bearer(other.body.token) })).status, 200);
}));

test("regenerate token revokes all others", withServer(async (t) => {
  const a = (await deviceLogin(t, octo)).body.token;
  const b = (await deviceLogin(t, octo)).body.token;
  assert.equal((await t.json("/v1/me/token", { method: "POST", body: "{}" })).status, 401);
  const r = await t.json("/v1/me/token", { method: "POST", headers: bearer(a), body: "{}" });
  assert.equal(r.status, 200);
  assert.equal(r.body.account.github, "octo");
  for (const old of [a, b]) assert.equal((await t.json("/v1/me", { headers: bearer(old) })).status, 401);
  assert.equal((await t.json("/v1/me", { headers: bearer(r.body.token) })).status, 200);
}));

test("site admin invites: closed signup, any verified email links; disabled accounts can't sign in, enabled ones can", withServer(async (t) => {
  const inv = await t.json("/v1/admin/accounts", { method: "POST", headers: bearer("adm"), body: '{"email":"work@corp.co"}' });
  assert.equal(inv.status, 201);
  assert.equal(inv.body.account.status, "invited");
  // The invite is for a secondary (verified) email on their GitHub account.
  const nine: FakeUser = {
    id: 9,
    login: "nine",
    emails: [{ email: "me@home.co", primary: true, verified: true }, { email: "Work@corp.co", primary: false, verified: true }],
  };
  const d = await deviceLogin(t, nine);
  assert.equal(d.status, 200);
  assert.equal(d.body.account.id, inv.body.account.id);
  const row = async () =>
    (await t.json("/v1/admin/accounts", { headers: bearer("adm") })).body.accounts.find((a: { id: string }) => a.id === inv.body.account.id);
  assert.equal((await row()).status, "active");
  assert.equal((await row()).github, "nine");
  // Signed in: no longer an invite to withdraw.
  assert.equal((await t.json(`/v1/admin/accounts/${inv.body.account.id}`, { method: "DELETE", headers: bearer("adm") })).status, 409);

  // Disabled: its token stops, and GitHub login is refused, by GitHub id or by any verified email.
  const off = await t.json(`/v1/admin/accounts/${inv.body.account.id}`, { method: "PATCH", headers: bearer("adm"), body: '{"disabled":true}' });
  assert.equal(off.body.account.status, "disabled");
  assert.equal((await t.json("/v1/me", { headers: bearer(d.body.token) })).status, 401);
  assert.equal((await deviceLogin(t, nine)).body.error, "account_disabled");
  assert.equal((await deviceLogin(t, { ...nine, id: 10 })).body.error, "account_disabled", "same email, another GitHub account");
  const web = await t.webLogin(nine);
  assert.match(new URLSearchParams(web.hash.slice(1)).get("cresslet_login_error")!, /disabled/);

  // Enabled: the same account again.
  await t.json(`/v1/admin/accounts/${inv.body.account.id}`, { method: "PATCH", headers: bearer("adm"), body: '{"disabled":false}' });
  const back = await deviceLogin(t, nine);
  assert.equal(back.body.account.id, inv.body.account.id);
  assert.equal((await t.json("/v1/me", { headers: bearer(back.body.token) })).status, 200);
}, { openSignup: false }));

test("GitHub linking an operator-created account drops the password set before it (not proven theirs)", withServer(async (t) => {
  const pre = await t.json("/v1/accounts", { method: "POST", headers: bearer("adm"), body: '{"email":"octo@example.com","password":"operator-set-1"}' });
  assert.equal(pre.status, 201);
  assert.equal(pre.body.account.password, true);
  const pw = () => t.json("/v1/auth/password", { method: "POST", body: '{"email":"octo@example.com","password":"operator-set-1"}' });
  assert.equal((await pw()).status, 200);
  const d = await deviceLogin(t, octo);
  assert.equal(d.body.account.id, pre.body.account.id);
  assert.equal(d.body.account.password, false);
  assert.equal((await pw()).status, 401);
  // Set again by its (now GitHub-proven) owner: a later GitHub login keeps it.
  const set = await t.json("/v1/me/password", { method: "PUT", headers: bearer(d.body.token), body: '{"password":"mine-now-123"}' });
  assert.equal(set.status, 200);
  assert.equal((await deviceLogin(t, octo)).body.account.password, true);
  assert.equal((await t.json("/v1/auth/password", { method: "POST", body: '{"email":"octo@example.com","password":"mine-now-123"}' })).status, 200);
}));
