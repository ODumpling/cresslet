import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/main.ts";
import { loadConfig, paths } from "../server/config.ts";
import { pruneOldPageVersions } from "../server/deploys.ts";

const DAY = 86_400_000;

async function setup(overrides: Parameters<typeof loadConfig>[0] = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-pages-"));
  const srv = createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80, adminToken: "adm", ...overrides }));
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
  const account = async (email: string) =>
    (await json("/v1/accounts", { method: "POST", headers: { authorization: "Bearer adm" }, body: JSON.stringify({ email }) })).body.token as string;
  const send = (method: string, path: string, token: string, input?: unknown) =>
    json(path, { method, headers: { authorization: `Bearer ${token}` }, body: input === undefined ? undefined : JSON.stringify(input) });
  /** GET on a page's host. */
  const visit = (name: string, path = "/", cookie?: string) =>
    raw(path, { host: `${name}.test.local`, headers: cookie ? { cookie } : {}, redirect: "manual" });
  return { dataDir, srv, raw, json, account, send, visit };
}

test("pages: account defaults, per-upload overrides, and settings changes", async () => {
  const t = await setup();
  try {
    const tok = await t.account("a@b.co");
    // Server defaults until the account sets its own.
    const s0 = await t.send("GET", "/v1/me/settings", tok);
    assert.deepEqual(s0.body, { pages: { visibility: "private", retentionDays: 30 }, defaults: { pages: { visibility: "private", retentionDays: 30 } } });

    const before = Date.now();
    const p1 = await t.send("POST", "/v1/pages", tok, { html: "<h1>one</h1>", title: " Report " });
    assert.equal(p1.status, 201);
    const page = p1.body.page;
    assert.match(page.name, /^pg-[0-9a-f]{20}$/);
    assert.equal(page.url, `http://${page.name}.test.local`);
    assert.equal(page.title, "Report");
    assert.equal(page.visibility, "private");
    assert.equal(page.retentionDays, 30);
    assert.equal(page.access, "owner");
    assert.equal(page.files, 1);
    const exp = Date.parse(page.expiresAt);
    assert.ok(exp >= before + 30 * DAY && exp <= Date.now() + 30 * DAY);

    // Account defaults apply to new uploads; a key left out keeps its value.
    const s1 = await t.send("PUT", "/v1/me/settings", tok, { pages: { visibility: "link" } });
    assert.deepEqual(s1.body.pages, { visibility: "link", retentionDays: 30 });
    const s2 = await t.send("PUT", "/v1/me/settings", tok, { pages: { retentionDays: null } });
    assert.deepEqual(s2.body.pages, { visibility: "link", retentionDays: null });
    const p2 = (await t.send("POST", "/v1/pages", tok, { html: "two" })).body.page;
    assert.equal(p2.visibility, "link");
    assert.equal(p2.retentionDays, null);
    assert.equal(p2.expiresAt, null);
    // An upload's own settings win.
    const p3 = (await t.send("POST", "/v1/pages", tok, { html: "three", visibility: "public", retentionDays: 7 })).body.page;
    assert.equal(p3.visibility, "public");
    assert.equal(p3.retentionDays, 7);

    for (const bad of [{ visibility: "secret" }, { retentionDays: 0 }, { retentionDays: 1.5 }, { retentionDays: 3651 }, { retentionDays: "30" }]) {
      assert.equal((await t.send("PUT", "/v1/me/settings", tok, { pages: bad })).status, 400, JSON.stringify(bad));
      assert.equal((await t.send("POST", "/v1/pages", tok, { html: "x", ...bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await t.send("PUT", "/v1/me/settings", tok, { pages: null })).body.pages.visibility, "private");

    // Change one page's settings: a new retention counts from now.
    const ch = await t.send("PATCH", `/v1/pages/${p2.name}`, tok, { visibility: "private", retentionDays: 1, title: "Two" });
    assert.equal(ch.status, 200);
    assert.equal(ch.body.page.visibility, "private");
    assert.equal(ch.body.page.title, "Two");
    assert.ok(Math.abs(Date.parse(ch.body.page.expiresAt) - (Date.now() + DAY)) < 5000);
    assert.equal((await t.send("PATCH", `/v1/pages/${p2.name}`, tok, { retentionDays: null })).body.page.expiresAt, null);

    // Listing: pages only (apps are separate), newest change first.
    const list = (await t.send("GET", "/v1/pages", tok)).body;
    assert.deepEqual(list.pages.map((p: { name: string }) => p.name), [p2.name, p3.name, page.name]);
    assert.deepEqual(list.defaults, { visibility: "private", retentionDays: 30 });
    assert.deepEqual((await t.send("GET", "/v1/apps", tok)).body.apps, []);

    // Other accounts can't see or change it; a read token can't upload.
    const other = await t.account("o@b.co");
    assert.equal((await t.send("GET", `/v1/pages/${page.name}`, other)).status, 403);
    assert.equal((await t.send("PATCH", `/v1/pages/${page.name}`, other, { visibility: "public" })).status, 403);
    const read = (await t.send("POST", "/v1/me/tokens", tok, { name: "r", role: "read" })).body.token;
    assert.equal((await t.send("POST", "/v1/pages", read, { html: "x" })).status, 403);
    assert.equal((await t.send("GET", `/v1/pages/${page.name}`, read)).status, 200);
    assert.equal((await t.send("POST", "/v1/pages", "", { html: "x" })).status, 401);
  } finally {
    t.srv.close();
    await rm(t.dataDir, { recursive: true, force: true });
  }
});

test("pages: upload formats, replacing files, and app-only endpoints", async () => {
  const t = await setup();
  try {
    const tok = await t.account("a@b.co");
    assert.equal((await t.send("POST", "/v1/pages", tok, { files: [{ path: "about.html", data: "x" }] })).status, 400); // no index.html
    assert.equal((await t.send("POST", "/v1/pages", tok, { html: "x", files: [] })).status, 400);
    assert.equal((await t.send("POST", "/v1/pages", tok, {})).status, 400);
    const page = (await t.send("POST", "/v1/pages", tok, {
      visibility: "public",
      files: [
        { path: "index.html", data: "<img src=a.png>" },
        { path: "a.png", data: Buffer.from([137, 80, 78, 71]).toString("base64"), encoding: "base64" },
      ],
    })).body.page;
    assert.equal(page.files, 2);
    let r = await t.visit(page.name, "/a.png");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/png");
    assert.equal(r.headers.get("x-robots-tag"), null); // public: indexable

    // Several pages: extensionless and .html URLs, directory indexes; a broken link is a 404 (its
    // 404.html if there is one), never index.html.
    const multi = (await t.send("POST", "/v1/pages", tok, {
      visibility: "link",
      files: [
        { path: "index.html", data: "home" },
        { path: "about.html", data: "about" },
        { path: "docs/index.html", data: "docs" },
      ],
    })).body.page;
    for (const [path, body] of [["/", "home"], ["/about", "about"], ["/about.html", "about"], ["/docs/", "docs"], ["/docs", "docs"]]) {
      r = await t.visit(multi.name, path);
      assert.equal(r.status, 200, path);
      assert.equal(await r.text(), body, path);
    }
    r = await t.visit(multi.name, "/missing");
    assert.equal(r.status, 404);
    assert.notEqual(await r.text(), "home");
    await t.send("PUT", `/v1/pages/${multi.name}`, tok, { files: [{ path: "index.html", data: "home" }, { path: "404.html", data: "nope" }] });
    r = await t.visit(multi.name, "/missing");
    assert.equal(r.status, 404);
    assert.equal(await r.text(), "nope");
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
    // Apps keep their SPA fallback.
    await t.send("POST", "/v1/deploys", tok, { app: "spa", files: [{ path: "index.html", data: "spa" }] });
    r = await t.visit("spa", "/some/route");
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "spa");

    // Same URL, new files; the clock restarts.
    const put = await t.send("PUT", `/v1/pages/${page.name}`, tok, { html: "v2" });
    assert.equal(put.status, 200);
    assert.equal(put.body.page.files, 1);
    assert.equal(await (await t.visit(page.name)).text(), "v2");
    assert.equal((await t.visit(page.name, "/a.png")).status, 404);

    // A page isn't an app: no deploys, rollback, secrets, egress or domains.
    assert.equal((await t.send("POST", "/v1/deploys", tok, { app: page.name, files: [{ path: "index.html", data: "app" }] })).status, 409);
    assert.equal((await t.send("POST", `/v1/apps/${page.name}/rollback`, tok, {})).status, 409);
    assert.equal((await t.send("PUT", `/v1/apps/${page.name}/secrets`, tok, { A: "1" })).status, 409);
    assert.equal((await t.send("PUT", `/v1/apps/${page.name}/egress`, tok, { allow: [] })).status, 409);
    assert.equal((await t.send("POST", `/v1/apps/${page.name}/domains`, tok, { domain: "x.example.com" })).status, 409);
    // …and an app isn't a page.
    await t.send("POST", "/v1/deploys", tok, { app: "site", files: [{ path: "index.html", data: "app" }] });
    assert.equal((await t.send("GET", "/v1/pages/site", tok)).status, 404);
    assert.equal((await t.send("PATCH", "/v1/pages/site", tok, { visibility: "public" })).status, 404);

    // Writes nothing on the shared `current_deploy_id` (a pre-pages server serves none of them).
    const row = t.srv.store.appByName(page.name)!;
    assert.equal(row.current_deploy_id, null);
    assert.ok(row.page_deploy_id);

    assert.equal((await t.send("DELETE", `/v1/pages/${page.name}`, tok)).status, 200);
    assert.equal((await t.visit(page.name)).status, 404);
    assert.equal(existsSync(paths(t.srv.cfg, row.id).app), false);
  } finally {
    t.srv.close();
    await rm(t.dataDir, { recursive: true, force: true });
  }
});

test("pages: link pages aren't indexed; private pages need a signed-in owner or collaborator", async () => {
  const t = await setup();
  try {
    const owner = await t.account("own@b.co");
    const link = (await t.send("POST", "/v1/pages", owner, { html: "link", visibility: "link" })).body.page;
    let r = await t.visit(link.name);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    // No ticket needed: the view URL is the page's.
    assert.equal((await t.send("POST", `/v1/pages/${link.name}/view`, owner, {})).body.url, `${link.url}/`);

    const priv = (await t.send("POST", "/v1/pages", owner, { html: "secret", visibility: "private" })).body.page;
    // No session: off to the studio, which signs the visitor in and comes back.
    r = await t.visit(priv.name, "/x?y=1");
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), `http://test.local/#/view/${priv.name}?path=%2Fx%3Fy%3D1`);
    assert.equal(r.headers.get("cache-control"), "no-store");

    const signIn = async (tok: string, path = "/") => {
      const v = await t.send("POST", `/v1/pages/${priv.name}/view`, tok, { path });
      if (v.status !== 200) return { status: v.status, cookie: "" };
      const u = new URL(v.body.url);
      const res = await t.visit(priv.name, u.pathname + u.search);
      const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
      return { status: res.status, location: res.headers.get("location"), setCookie: res.headers.get("set-cookie"), cookie, url: u };
    };
    const s = await signIn(owner, "/deep?q=1");
    assert.equal(s.status, 303);
    assert.equal(s.location, "/deep?q=1"); // the ticket is dropped from the URL
    assert.match(s.setCookie!, /^cresslet_page=pvs_[0-9a-f]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=86400$/);
    r = await t.visit(priv.name, "/", s.cookie);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "secret");
    assert.equal(r.headers.get("cache-control"), "private, no-store");
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
    // The redirect stays on the page's host.
    const evil = new URL((await t.send("POST", `/v1/pages/${priv.name}/view`, owner, {})).body.url);
    r = await t.raw(`//evil.example/x${evil.search}`, { host: `${priv.name}.test.local`, redirect: "manual" });
    assert.equal(r.headers.get("location"), "/evil.example/x");
    assert.equal((await t.send("POST", `/v1/pages/${priv.name}/view`, owner, { path: "/\\evil.example/" })).status, 400);
    // A ticket works once, and only on its page.
    assert.equal((await t.visit(priv.name, s.url!.pathname + s.url!.search)).status, 403);
    const other = await signIn(owner);
    assert.equal((await t.visit(link.name, "/", other.cookie)).status, 200); // link pages ignore it
    const ticket = (await t.send("POST", `/v1/pages/${priv.name}/view`, owner, {})).body.url.split("cresslet_view=")[1];
    const priv2 = (await t.send("POST", "/v1/pages", owner, { html: "two", visibility: "private" })).body.page;
    assert.equal((await t.visit(priv2.name, `/?cresslet_view=${ticket}`)).status, 403);
    assert.equal((await t.visit(priv2.name, "/", s.cookie)).status, 302); // the session is per page
    // Another host's cookie of the same name (e.g. tossed by a sibling subdomain) doesn't hide a good one.
    assert.equal((await t.visit(priv.name, "/", `cresslet_page=pvs_bogus; ${s.cookie}`)).status, 200);

    // Strangers get no ticket; collaborators do, and lose access (and their session) when removed.
    const stranger = await t.account("x@b.co");
    assert.equal((await signIn(stranger)).status, 403);
    const viewer = await t.account("v@b.co");
    const inv = (await t.send("POST", `/v1/apps/${priv.name}/collaborators`, owner, { email: "v@b.co" })).body.invite;
    await t.send("POST", `/v1/me/invites/${inv.id}/accept`, viewer, {});
    assert.deepEqual((await t.send("GET", "/v1/pages", viewer)).body.pages.map((p: { name: string; access: string }) => [p.name, p.access]), [[priv.name, "viewer"]]);
    const vs = await signIn(viewer);
    assert.equal(vs.status, 303);
    assert.equal((await t.visit(priv.name, "/", vs.cookie)).status, 200);
    assert.equal((await t.send("PATCH", `/v1/pages/${priv.name}`, viewer, { visibility: "public" })).status, 403);
    const me = (await t.send("GET", "/v1/me", viewer)).body.account.id;
    await t.send("DELETE", `/v1/apps/${priv.name}/collaborators/${me}`, owner);
    assert.equal((await t.visit(priv.name, "/", vs.cookie)).status, 302);

    // Made public: anyone; private again: sessions still work.
    await t.send("PATCH", `/v1/pages/${priv.name}`, owner, { visibility: "public" });
    assert.equal((await t.visit(priv.name)).status, 200);
    await t.send("PATCH", `/v1/pages/${priv.name}`, owner, { visibility: "private" });
    assert.equal((await t.visit(priv.name)).status, 302);
    assert.equal((await t.visit(priv.name, "/", s.cookie)).status, 200);
  } finally {
    t.srv.close();
    await rm(t.dataDir, { recursive: true, force: true });
  }
});

test("pages: expired pages are gone at once and purged by the reaper; secure cookie on https", async () => {
  const t = await setup({ scheme: "https", publicPort: 443, pages: { visibility: "link", retentionDays: 2 }, limits: { maxPagesPerAccount: 2 } as never });
  try {
    const tok = await t.account("a@b.co");
    assert.deepEqual((await t.send("GET", "/v1/me/settings", tok)).body.pages, { visibility: "link", retentionDays: 2 });
    const page = (await t.send("POST", "/v1/pages", tok, { html: "bye" })).body.page;
    assert.equal(page.visibility, "link");
    assert.equal(page.url, `https://${page.name}.test.local`);
    await t.send("POST", "/v1/pages", tok, { html: "two" });
    assert.equal((await t.send("POST", "/v1/pages", tok, { html: "three" })).status, 403); // quota
    const row = t.srv.store.appByName(page.name)!;
    t.srv.store.db.prepare("UPDATE apps SET expires_at = ? WHERE id = ?").run(Date.now() - 1, row.id);
    assert.equal((await t.visit(page.name)).status, 404);
    assert.equal((await t.send("GET", `/v1/pages/${page.name}`, tok)).status, 404);
    assert.equal((await t.send("GET", "/v1/pages", tok)).body.pages.length, 1);
    await t.srv.reap();
    assert.equal(t.srv.store.appByName(page.name), undefined);
    assert.equal(existsSync(paths(t.srv.cfg, row.id).app), false);

    // https: the session cookie is __Host- and Secure.
    const priv = (await t.send("POST", "/v1/pages", tok, { html: "p", visibility: "private" })).body.page;
    const u = new URL((await t.send("POST", `/v1/pages/${priv.name}/view`, tok, {})).body.url);
    const r = await t.visit(priv.name, u.pathname + u.search);
    assert.match(r.headers.get("set-cookie")!, /^__Host-cresslet_page=pvs_[0-9a-f]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure$/);
  } finally {
    t.srv.close();
    await rm(t.dataDir, { recursive: true, force: true });
  }
});

test("pages keep only the version they serve on disk; apps keep 10 for rollback", async () => {
  const t = await setup();
  try {
    const tok = await t.account("a@b.co");
    const { store, cfg } = t.srv;
    const rows = (appId: string) => store.deploys(appId, 100).map((d) => d.id);
    const rowSet = (appId: string) => rows(appId).sort();
    const onDisk = async (appId: string) => (await readdir(paths(cfg, appId).deploys)).sort();
    const page = (await t.send("POST", "/v1/pages", tok, { html: "v1", visibility: "link" })).body.page;
    for (const v of ["v2", "v3", "v4"]) assert.equal((await t.send("PUT", `/v1/pages/${page.name}`, tok, { html: v })).status, 200);
    const row = store.appByName(page.name)!;
    const served = row.page_deploy_id!;
    // An upload removes all but the version it replaced, which a request in flight may still read.
    const [, previous] = rows(row.id);
    assert.deepEqual(rows(row.id), [served, previous]);
    assert.deepEqual(await onDisk(row.id), [served, previous].sort());
    assert.equal(await (await t.visit(page.name)).text(), "v4");

    // Versions an older server kept (rows and directories).
    for (const [i, d] of ["dep_old1", "dep_old2"].entries()) {
      store.addDeploy({ id: d, app_id: row.id, created_at: Date.now() - 1000 * (i + 1), bytes: 2, file_count: 1, has_server: 0, source: "api" });
      await mkdir(join(paths(cfg, row.id).deploy(d), "public"), { recursive: true });
    }
    const all = [served, previous, "dep_old1", "dep_old2"];
    // The reaper waits a minute after an upload, and leaves pages another node owns alone.
    await t.srv.reap();
    assert.deepEqual(rows(row.id), all);
    store.db.prepare("UPDATE deploys SET created_at = ? WHERE id = ?").run(Date.now() - 61_000, served);
    await pruneOldPageVersions(cfg, store, () => false);
    assert.deepEqual(rowSet(row.id), [...all].sort());
    assert.deepEqual(await onDisk(row.id), [...all].sort());
    // Then only the served version is left.
    await t.srv.reap();
    assert.deepEqual(rows(row.id), [served]);
    assert.deepEqual(await onDisk(row.id), [served]);
    assert.equal(await (await t.visit(page.name)).text(), "v4");

    // An app keeps its last 10 deploys (rollback), files and rows alike; the reaper leaves them alone.
    for (let i = 0; i < 12; i++) {
      assert.equal((await t.send("POST", "/v1/deploys", tok, { app: "site", files: [{ path: "index.html", data: `a${i}` }] })).status, 201);
    }
    const site = store.appByName("site")!;
    store.db.prepare("UPDATE deploys SET created_at = 1 WHERE app_id = ?").run(site.id); // same-millisecond ties
    await t.srv.reap();
    const kept = rows(site.id);
    assert.equal(kept.length, 10);
    assert.equal(kept[0], site.current_deploy_id);
    assert.deepEqual(await onDisk(site.id), [...kept].sort());
    assert.equal((await t.send("POST", "/v1/apps/site/rollback", tok, {})).status, 200);
    assert.equal(await (await t.visit("site")).text(), "a10");
    assert.equal((await t.send("POST", "/v1/apps/site/rollback", tok, { deployId: kept[9] })).status, 200);
    assert.equal(await (await t.visit("site")).text(), "a2");
  } finally {
    t.srv.close();
    await rm(t.dataDir, { recursive: true, force: true });
  }
});

test("pages: bad server defaults fail at startup", () => {
  assert.throws(() => loadConfig({ pages: { visibility: "secret" as never, retentionDays: 30 } }), /CRESSLET_PAGE_VISIBILITY/);
  assert.throws(() => loadConfig({ pages: { visibility: "link", retentionDays: -1 } }), /CRESSLET_PAGE_RETENTION_DAYS/);
});
