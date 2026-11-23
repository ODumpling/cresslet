// The studio's session cookie (server/api.ts): set by a login the studio sends, counted only on requests from the
// studio's own origin (an app under the domain is the same site), revoked by logging out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/main.ts";
import { type Config, loadConfig } from "../server/config.ts";

const STUDIO = { "sec-fetch-site": "same-origin" };
const APP = { "sec-fetch-site": "same-site", origin: "http://evil.test.local" };

async function setup(overrides: Partial<Config> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-session-"));
  const srv = await createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80, adminToken: "adm", passwordLogin: true, ...overrides }));
  const req = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", "test.local");
    if (init.body) headers.set("content-type", "application/json");
    const r = await srv.handler(new Request(`http://test.local${path}`, { ...init, headers }));
    return { status: r.status, body: await r.json().catch(() => null), cookies: r.headers.getSetCookie(), cacheControl: r.headers.get("cache-control"), headers: r.headers };
  };
  const made = await req("/v1/accounts", { method: "POST", headers: { authorization: "Bearer adm" }, body: '{"email":"a@b.co","password":"hunter22!"}' });
  assert.equal(made.status, 201);
  const login = (headers: Record<string, string> = STUDIO) =>
    req("/v1/auth/password", { method: "POST", headers, body: '{"email":"a@b.co","password":"hunter22!"}' });
  return { req, login, account: made.body.account.id as string, adminToken: made.body.token as string, dispose: async () => (await srv.close(), await rm(dataDir, { recursive: true, force: true })) };
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
/** The session cookie a response set, as a request's Cookie header. */
const sessionOf = (cookies: string[]) => {
  const c = cookies.find((c) => /^(__Host-)?cresslet_session=clv_acct_/.test(c));
  assert.ok(c, `no session cookie in ${JSON.stringify(cookies)}`);
  return c.split(";")[0];
};

test("a login the studio sends: the token goes in an HttpOnly cookie, not the answer", withServer(async (t) => {
  const r = await t.login();
  assert.equal(r.status, 200);
  assert.equal(r.body.account.id, t.account);
  assert.equal(r.body.token, undefined);
  const set = r.cookies.find((c) => c.startsWith("cresslet_session="))!;
  assert.match(set, /; HttpOnly/i);
  assert.match(set, /; SameSite=Strict/i);
  assert.match(set, /; Path=\//i);
  const me = await t.req("/v1/me", { headers: { ...STUDIO, cookie: sessionOf(r.cookies) } });
  assert.equal(me.status, 200);
  assert.equal(me.body.account.id, t.account);
  assert.equal(me.body.tokenInfo.name, "Studio (password login)");
  assert.equal(me.cacheControl, "private, no-store"); // no Authorization header: shared caches kept off by this

  // Logging in again: the session it replaces is revoked.
  const again = await t.req("/v1/auth/password", { method: "POST", headers: { ...STUDIO, cookie: sessionOf(r.cookies) }, body: '{"email":"a@b.co","password":"hunter22!"}' });
  assert.equal((await t.req("/v1/me", { headers: { ...STUDIO, cookie: sessionOf(r.cookies) } })).status, 401);
  assert.equal((await t.req("/v1/me", { headers: { ...STUDIO, cookie: sessionOf(again.cookies) } })).status, 200);

  // Anyone else (a script, another client) gets the token, and no cookie.
  const other = await t.login({});
  assert.match(other.body.token, /^clv_acct_/);
  assert.deepEqual(other.cookies, []);
}));

test("the cookie counts only from the studio's origin: not an app's under the domain", withServer(async (t) => {
  const cookie = sessionOf((await t.login()).cookies);
  const me = (headers: Record<string, string>) => t.req("/v1/me", { headers: { ...headers, cookie } }).then((r) => r.status);
  assert.equal(await me(STUDIO), 200);
  assert.equal(await me(APP), 401);
  assert.equal(await me({ "sec-fetch-site": "cross-site" }), 401);
  assert.equal(await me({ "sec-fetch-site": "none" }), 401); // typed in the address bar
  // A browser without Fetch Metadata: the Origin decides (a GET without one: not counted).
  assert.equal(await me({ origin: "http://test.local" }), 200);
  assert.equal(await me({ origin: "http://evil.test.local" }), 401);
  assert.equal(await me({}), 401);
  // Or the studio's header (another origin's page can't send it: CORS doesn't allow it).
  assert.equal(await me({ "x-cresslet-user": t.account }), 200);
  assert.equal(await me({ origin: "http://evil.test.local", "x-cresslet-user": t.account }), 401); // an Origin decides
  const preflight = await t.req("/v1/me", { method: "OPTIONS", headers: { origin: "http://evil.test.local", "access-control-request-method": "GET", "access-control-request-headers": "x-cresslet-user" } });
  assert.doesNotMatch(preflight.headers.get("access-control-allow-headers") ?? "", /x-cresslet-user/i);
  // Changes too: an app's page can't act as the user.
  const mint = await t.req("/v1/me/tokens", { method: "POST", headers: { ...APP, cookie }, body: '{"name":"stolen"}' });
  assert.equal(mint.status, 401);
  // Nor log the user in to its own account (login CSRF): its login gets no cookie.
  assert.deepEqual((await t.login(APP)).cookies, []);
}));

test("the cookie acts only for the account the studio shows, and only when it's there once", withServer(async (t) => {
  const cookie = sessionOf((await t.login()).cookies);
  const me = (headers: Record<string, string>) => t.req("/v1/me", { headers: { ...STUDIO, ...headers } }).then((r) => r.status);
  assert.equal(await me({ cookie, "x-cresslet-user": t.account }), 200);
  // Another tab logged in as someone else meanwhile: this tab's requests don't act as them.
  assert.equal(await me({ cookie, "x-cresslet-user": "ac_someone_else" }), 401);
  // Twice (over http an app under the domain can set one for the whole domain): neither counts.
  const other = (await t.login({})).body.token;
  assert.equal(await me({ cookie: `${cookie}; cresslet_session=${other}` }), 401);
  // A bearer (an operator's, a deploy key) is the request's credential: the cookie isn't added to it.
  assert.equal(await me({ cookie, authorization: "Bearer adm" }), 401);
}));

test("logging out revokes the session's token; a page elsewhere can't log the user out", withServer(async (t) => {
  const cookie = sessionOf((await t.login()).cookies);
  assert.equal((await t.req("/v1/auth/logout", { method: "POST", headers: { ...APP, cookie } })).status, 403);
  assert.equal((await t.req("/v1/me", { headers: { ...STUDIO, cookie } })).status, 200);

  const out = await t.req("/v1/auth/logout", { method: "POST", headers: { ...STUDIO, cookie } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.cookies, []); // not deleted: a late answer could wipe a newer login's cookie
  assert.equal((await t.req("/v1/me", { headers: { ...STUDIO, cookie } })).status, 401);
  // The token itself is gone, not just the cookie.
  const token = decodeURIComponent(cookie.split("=")[1]);
  assert.equal((await t.req("/v1/me", { headers: { authorization: `Bearer ${token}` } })).status, 401);
  const tokens = await t.req("/v1/me/tokens", { headers: { authorization: `Bearer ${t.adminToken}` } });
  assert.deepEqual(tokens.body.tokens.map((x: { name: string }) => x.name), ["Operator-issued"]);
}));

test("a revoked session's cookie: the request goes on logged out, and a login still works", withServer(async (t) => {
  const cookie = sessionOf((await t.login()).cookies);
  const me = await t.req("/v1/me", { headers: { ...STUDIO, cookie } });
  await t.req(`/v1/me/tokens/${me.body.tokenInfo.id}`, { method: "DELETE", headers: { authorization: `Bearer ${t.adminToken}` } });

  const after = await t.req("/v1/me", { headers: { ...STUDIO, cookie } });
  assert.equal(after.status, 401);
  assert.deepEqual(after.cookies, []); // not cleared: a login in another tab may have replaced it meanwhile
  assert.equal((await t.req("/v1/templates", { headers: { ...STUDIO, cookie } })).status, 200);
  const again = await t.req("/v1/auth/password", { method: "POST", headers: { ...STUDIO, cookie }, body: '{"email":"a@b.co","password":"hunter22!"}' });
  assert.equal(again.status, 200);
  assert.notEqual(sessionOf(again.cookies), cookie);
}));

test("a studio logged in before cookies: its stored token becomes the session", withServer(async (t) => {
  const move = (headers: Record<string, string>) => t.req("/v1/auth/session", { method: "POST", headers });
  const bearer = { authorization: `Bearer ${t.adminToken}` };
  assert.equal((await move(bearer)).status, 403); // not from the studio
  assert.equal((await move({ ...APP, ...bearer })).status, 403);
  assert.equal((await move(STUDIO)).status, 401);
  assert.equal((await move({ ...STUDIO, authorization: "Bearer clv_acct_nope" })).status, 401);
  const scoped = (await t.req("/v1/me/tokens", { method: "POST", headers: bearer, body: '{"name":"ci","role":"deploy"}' })).body.token;
  assert.equal((await move({ ...STUDIO, authorization: `Bearer ${scoped}` })).status, 403);

  const r = await move({ ...STUDIO, ...bearer });
  assert.equal(r.status, 200);
  assert.equal(r.body.account.id, t.account);
  assert.equal(r.body.token, undefined);
  assert.equal(sessionOf(r.cookies), `cresslet_session=${t.adminToken}`);
}));

test("https: a __Host- cookie (no app under the domain can set it), Secure", withServer(async (t) => {
  const r = await t.login();
  const set = r.cookies.find((c) => c.startsWith("__Host-cresslet_session="));
  assert.ok(set, JSON.stringify(r.cookies));
  assert.match(set, /; Secure/i);
  assert.doesNotMatch(set, /Domain=/i);
  assert.equal((await t.req("/v1/me", { headers: { ...STUDIO, cookie: sessionOf(r.cookies) } })).status, 200);
}, { scheme: "https", publicPort: 443 }));
