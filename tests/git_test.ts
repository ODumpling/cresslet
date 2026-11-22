// Source control (server/git.ts) against a fake GitHub (tests/fake_github.ts).
import { createHmac } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/main.ts";
import { type Config, loadConfig } from "../server/config.ts";
import { SecretBox } from "../server/secretbox.ts";
import { blobSha } from "../server/git.ts";
import { fakeGithub, type GhUser } from "./fake_github.ts";
import { makeLegacyAnonymous } from "./owner.ts";

async function setup(over: Partial<Config["git"]> = {}, extra: Partial<Config> = {}) {
  const gh = await fakeGithub({ clientId: "app-cid", clientSecret: "app-secret" });
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-git-test-"));
  const base = loadConfig({ dataDir });
  const srv = await createServer(loadConfig({
    dataDir,
    domain: "test.local",
    publicPort: 80,
    adminToken: "adm",
    github: { clientId: "app-cid", clientSecret: "app-secret", webUrl: gh.base, apiUrl: gh.base },
    git: {
      ...base.git,
      githubApp: { appId: "1", clientId: "app-cid", clientSecret: "app-secret", slug: "cresslet-test" },
      webUrl: gh.base,
      apiUrl: gh.base,
      ...over,
    },
    ...extra,
  }));
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", "test.local");
    if (init.body) headers.set("content-type", "application/json");
    return srv.handler(new Request(`http://test.local${path}`, { ...init, headers }));
  };
  const send = async (method: string, path: string, token?: string, input?: unknown) => {
    const r = await call(path, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const account = async (email: string) =>
    (await send("POST", "/v1/accounts", "adm", { email })).body.token as string;
  /** The studio's connect flow, start to finish; returns where the browser lands. */
  const connect = async (token: string, u: GhUser, tamper: { cookie?: string } = {}) => {
    const start = await call("/v1/git/github/connect", {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ returnTo: "/apps/shop" }),
    });
    assert.equal(start.status, 200);
    const url = new URL((await start.json()).url);
    assert.equal(url.origin + url.pathname, `${gh.base}/login/oauth/authorize`);
    const cookie = start.headers.get("set-cookie")!.split(";")[0];
    const cbPath = new URL(url.searchParams.get("redirect_uri")!).pathname;
    const cb = await call(`${cbPath}?code=${gh.approve(u)}&state=${url.searchParams.get("state")}`, {
      headers: { cookie: tamper.cookie ?? cookie },
    });
    assert.equal(cb.status, 302);
    return new URL(cb.headers.get("location")!);
  };
  const deploy = (token: string, app: string, extra: Record<string, unknown> = {}) =>
    send("POST", "/v1/deploys", token, { app, files: [{ path: "index.html", data: "hi" }], ...extra });
  return {
    gh, srv, call, send, account, connect, deploy, dataDir,
    async dispose() {
      await srv.close();
      await gh.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
type T = Awaited<ReturnType<typeof setup>>;
const withServer = (fn: (t: T) => Promise<void>, over: Partial<Config["git"]> = {}, extra: Partial<Config> = {}) => async () => {
  const t = await setup(over, extra);
  try {
    await fn(t);
  } finally {
    await t.dispose();
  }
};
const hash = (u: URL) => Object.fromEntries(new URLSearchParams(u.hash.slice(1)));

test("connect GitHub: tokens sealed server-side, status without them, disconnect", withServer(async (t) => {
  const tok = await t.account("octo@b.co");
  const octo = t.gh.user("octo");
  assert.deepEqual((await t.send("GET", "/v1", undefined)).body.git, { github: true });
  const start = new URL((await t.send("POST", "/v1/git/github/connect", tok, {})).body.url);
  assert.equal(start.searchParams.get("redirect_uri"), "http://test.local/v1/git/github/callback");
  assert.equal(start.searchParams.get("scope"), null); // a GitHub App's permissions are its own
  const before = await t.send("GET", "/v1/me/git", tok);
  assert.deepEqual(before.body, {
    provider: "github", available: true, kind: "app", connected: false, login: null, status: null,
    installUrl: `${t.gh.base}/apps/cresslet-test/installations/new`,
  });
  const back = await t.connect(tok, octo);
  assert.equal(back.origin + back.pathname, "http://test.local/apps/shop");
  assert.deepEqual(hash(back), { cresslet_git: "connected" });
  const me = await t.send("GET", "/v1/me/git", tok);
  assert.equal(me.body.connected, true);
  assert.equal(me.body.login, "octo");
  assert.equal(me.body.status, "active");
  assert.doesNotMatch(JSON.stringify(me.body), /gh[ur]_/);

  // At rest: sealed, not the token.
  const raw = await t.srv.store.db.all<{ access_token: Uint8Array }>("SELECT access_token FROM git_connections");
  assert.equal(raw.length, 1);
  assert.doesNotMatch(Buffer.from(raw[0].access_token).toString(), /ghu_/);

  assert.equal((await t.send("GET", "/v1/git/github/repos", tok)).status, 200);
  assert.equal((await t.send("DELETE", "/v1/me/git/github", tok)).status, 200);
  assert.equal((await t.send("GET", "/v1/me/git", tok)).body.connected, false);
  assert.equal((await t.send("GET", "/v1/git/github/repos", tok)).body.error, "git_not_connected");
}));

test("connect GitHub: state must come back to the browser and account that started it", withServer(async (t) => {
  const tok = await t.account("octo@b.co");
  const back = await t.connect(tok, t.gh.user("octo"), { cookie: "cresslet_git_state=gs_someone_else" });
  assert.match(hash(back).cresslet_git_error, /expired/);
  assert.equal((await t.send("GET", "/v1/me/git", tok)).body.connected, false);
  // A forged state with a matching cookie isn't one this server issued.
  const cb = await t.call("/v1/git/github/callback?code=x&state=gs_forged", { headers: { cookie: "cresslet_git_state=gs_forged" } });
  assert.match(hash(new URL(cb.headers.get("location")!)).cresslet_git_error, /expired/);
  // Starting needs the account's full-access token.
  assert.equal((await t.send("POST", "/v1/git/github/connect", undefined, {})).status, 401);
}));

test("over HTTPS the state cookie is __Host- (a subdomain can't plant one)", withServer(async (t) => {
  const tok = await t.account("octo@b.co");
  const start = await t.call("/v1/git/github/connect", { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: "{}" });
  const cookie = start.headers.get("set-cookie")!;
  assert.match(cookie, /^__Host-cresslet_git_state=gs_/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Secure/);
  assert.doesNotMatch(cookie, /Domain=/i);
  // A plain-named cookie (what a sibling subdomain could set) doesn't count.
  const state = new URL((await start.json()).url).searchParams.get("state");
  const cb = await t.call(`/v1/git/github/callback?code=${t.gh.approve(t.gh.user("octo"))}&state=${state}`, { headers: { cookie: `cresslet_git_state=${state}` } });
  assert.match(hash(new URL(cb.headers.get("location")!)).cresslet_git_error, /expired/);
  assert.equal((await t.send("GET", "/v1/me/git", tok)).body.connected, false);
}, {}, { scheme: "https" }));

test("tokens refresh before they expire (once, however many calls); a revoked refresh asks to reconnect", withServer(async (t) => {
  const tok = await t.account("octo@b.co");
  t.gh.setExpiresIn(60); // under the 5-minute margin: the next call refreshes first
  await t.connect(tok, t.gh.user("octo"));
  t.gh.setExpiresIn(8 * 3600);
  const all = await Promise.all([1, 2, 3].map(() => t.send("GET", "/v1/git/github/repos", tok)));
  assert.deepEqual(all.map((r) => r.status), [200, 200, 200]);
  assert.equal(t.gh.stats.refreshes, 1);
  assert.equal((await t.send("GET", "/v1/git/github/repos", tok)).status, 200);
  assert.equal(t.gh.stats.refreshes, 1); // good for 8h now

  // Revoked on GitHub: the access token fails → the connection is marked expired (no retry loop).
  t.gh.revokeAll();
  const r = await t.send("GET", "/v1/git/github/repos", tok);
  assert.equal(r.status, 401);
  assert.equal(r.body.error, "git_reauth_required");
  assert.equal((await t.send("GET", "/v1/me/git", tok)).body.status, "expired");
  assert.equal((await t.send("GET", "/v1/git/github/repos", tok)).body.error, "git_reauth_required");
  // The Cresslet token itself is fine.
  assert.equal((await t.send("GET", "/v1/me", tok)).status, 200);

  // Reconnecting makes it active again; then a bad refresh token also lands on git_reauth_required.
  t.gh.setExpiresIn(60);
  await t.connect(tok, t.gh.user("octo"));
  assert.equal((await t.send("GET", "/v1/me/git", tok)).body.status, "active");
  t.gh.revokeAll();
  const r2 = await t.send("GET", "/v1/git/github/repos", tok);
  assert.equal(r2.body.error, "git_reauth_required");
  assert.equal(t.gh.stats.refreshes, 2);
  assert.equal((await t.send("GET", "/v1/me/git", tok)).body.status, "expired"); // kept (on Postgres too)
  assert.equal((await t.send("GET", "/v1/git/github/repos", tok)).body.error, "git_reauth_required");
  assert.equal(t.gh.stats.refreshes, 2); // not tried again
}));

test("sealed tokens are bound to their account: swapped between rows they don't decrypt", async () => {
  const box = new SecretBox([Buffer.alloc(32, 7)]);
  const sealed = box.seal("acct:acct_a", "git:github:access", "ghu_secret");
  assert.equal(box.open("acct:acct_a", "git:github:access", sealed).value, "ghu_secret");
  assert.throws(() => box.open("acct:acct_b", "git:github:access", sealed));
  assert.throws(() => box.open("acct:acct_a", "git:github:refresh", sealed));

  const t = await setup();
  try {
    const a = await t.account("a@b.co"), b = await t.account("b@b.co");
    await t.connect(a, t.gh.user("aa"));
    await t.connect(b, t.gh.user("bb"));
    const db = t.srv.store.db;
    const rows = await db.all<{ account_id: string; access_token: Uint8Array }>("SELECT account_id, access_token FROM git_connections ORDER BY login");
    await db.run("UPDATE git_connections SET access_token = ? WHERE account_id = ?", rows[1].access_token, rows[0].account_id);
    await assert.rejects(t.srv.store.getGitConnection(rows[0].account_id, "github"), /cannot decrypt/);
  } finally {
    await t.dispose();
  }
});

test("link a repository and push: secrets stripped, commits authored as the user", withServer(async (t) => {
  const tok = await t.account("octo@b.co");
  const octo = t.gh.user("octo");
  assert.equal((await t.deploy(tok, "shop")).status, 201);
  // Not connected yet.
  assert.equal((await t.send("POST", "/v1/apps/shop/git/connect", tok, { owner: "octo", repo: "shop" })).body.error, "git_not_connected");
  await t.connect(tok, octo);
  const created = await t.send("POST", "/v1/git/github/repos", tok, { name: "shop" });
  assert.equal(created.status, 201);
  assert.equal(created.body.repo.fullName, "octo/shop");
  assert.equal(created.body.repo.private, true);
  assert.equal((await t.send("POST", "/v1/git/github/repos", tok, { name: "shop" })).body.error, "repo_exists");

  const files = [
    { path: "src/app.ts", data: "export const x = 1;\n" },
    { path: "index.html", data: "<h1>hi</h1>" },
    { path: ".env", data: "VITE_TITLE=Shop\nSTRIPE_KEY=sk_live_123\n" },
    { path: ".env.local", data: "DB=secret" },
    { path: ".dev.vars", data: "TOKEN=x" },
    { path: ".envrc", data: "export A=1" },
    { path: "node_modules/x/index.js", data: "x" },
    { path: "img.png", data: Buffer.from([0, 255, 1]).toString("base64"), encoding: "base64" },
  ];
  const linked = await t.send("POST", "/v1/apps/shop/git/connect", tok, { owner: "octo", repo: "shop", initialSync: "push", files });
  assert.equal(linked.status, 201, JSON.stringify(linked.body));
  assert.equal(linked.body.repo.fullName, "octo/shop");
  assert.equal(linked.body.repo.defaultBranch, "main");
  const remote = t.gh.files("octo/shop");
  assert.deepEqual(Object.keys(remote).sort(), [".env", "img.png", "index.html", "src/app.ts"]); // README.md: not in the workspace
  assert.equal(remote[".env"], "VITE_TITLE=Shop\n");
  const c = t.gh.commit(linked.body.sha);
  assert.deepEqual(c.author, { name: "octo", email: "octo@users.example" });
  assert.equal(c.by, "octo");

  const app = await t.send("GET", "/v1/apps/shop", tok);
  assert.equal(app.body.repo.fullName, "octo/shop");
  assert.equal(app.body.repo.lastSyncedSha, linked.body.sha);

  // Pull it back: the same (sanitized) files.
  const tree = await t.send("GET", "/v1/apps/shop/git/tree", tok);
  assert.equal(tree.body.sha, linked.body.sha);
  assert.deepEqual(tree.body.files.map((f: { path: string }) => f.path), [".env", "img.png", "index.html", "src/app.ts"]);
  assert.equal(tree.body.files.find((f: { path: string }) => f.path === "img.png").encoding, "base64");

  // A repository the user can't push to.
  t.gh.addRepo("someone", "theirs", []);
  assert.equal((await t.send("POST", "/v1/apps/shop/git/connect", tok, { owner: "someone", repo: "theirs" })).status, 404);
  // A token limited to the app can't choose which repository it reaches.
  const scoped = (await t.send("POST", "/v1/me/tokens", tok, { name: "shop only", apps: ["shop"] })).body.token;
  assert.equal((await t.send("POST", "/v1/apps/shop/git/connect", scoped, { owner: "octo", repo: "shop" })).status, 403);
  // Apps without an owner (anonymous, from before every app needed one) can't link.
  const anon = await t.send("POST", "/v1/deploys", tok, { files: [{ path: "index.html", data: "x" }] });
  await makeLegacyAnonymous(t.srv.store, anon.body.app.id);
  assert.equal((await t.send("POST", `/v1/apps/${anon.body.app.name}/git/connect`, tok, { owner: "octo", repo: "shop" })).status, 403);
}));

test("link an app that's already deployed: its live deploy's source is pushed, from the server", withServer(async (t) => {
  const tok = await t.account("octo@b.co");
  await t.connect(tok, t.gh.user("octo"));
  // Deployed before it had a repository (the CLI, another studio): built files plus the source uploaded with them.
  const sources = [
    { path: "src/main.ts", data: "console.log(1);\n" },
    { path: "index.html", data: "<h1>shop</h1>" },
    { path: ".env", data: "VITE_TITLE=Shop\nSTRIPE_KEY=sk_live_123\n" },
    { path: ".env.local", data: "DB=secret" },
    { path: "logo.png", data: Buffer.from([0, 255, 1]).toString("base64"), encoding: "base64" },
  ];
  assert.equal((await t.deploy(tok, "shop", { sources })).status, 201);
  assert.equal((await t.send("POST", "/v1/git/github/repos", tok, { name: "shop" })).status, 201);
  const linked = await t.send("POST", "/v1/apps/shop/git/connect", tok, { owner: "octo", repo: "shop", initialSync: "deploy" });
  assert.equal(linked.status, 201, JSON.stringify(linked.body));
  assert.equal(linked.body.files, undefined);
  const remote = t.gh.files("octo/shop");
  assert.deepEqual(Object.keys(remote).sort(), [".env", "index.html", "logo.png", "src/main.ts"]);
  assert.equal(remote[".env"], "VITE_TITLE=Shop\n"); // secrets never stored with the deploy, nor pushed
  assert.equal(remote["src/main.ts"], "console.log(1);\n");
  assert.equal(t.gh.commit(linked.body.sha).by, "octo");
  assert.equal((await t.send("GET", "/v1/apps/shop", tok)).body.repo.lastSyncedSha, linked.body.sha);
  // The studio then loads it like any linked app.
  const tree = await t.send("GET", "/v1/apps/shop/git/tree", tok);
  assert.deepEqual(tree.body.files.map((f: { path: string }) => f.path), [".env", "index.html", "logo.png", "src/main.ts"]);

  // Deployed without its source: nothing to push, nothing linked (and the studio is told).
  assert.equal((await t.deploy(tok, "bare")).status, 201);
  t.gh.addRepo("octo", "bare", ["octo"]);
  const bare = await t.send("POST", "/v1/apps/bare/git/connect", tok, { owner: "octo", repo: "bare", initialSync: "deploy" });
  assert.equal(bare.status, 409);
  assert.equal(bare.body.error, "no_source");
  assert.equal((await t.send("GET", "/v1/apps/bare", tok)).body.deploys[0].hasSource, false);
  assert.equal((await t.send("GET", "/v1/apps/shop", tok)).body.deploys[0].hasSource, true);
  assert.equal((await t.send("GET", "/v1/apps/bare", tok)).body.repo, null);
  assert.deepEqual(Object.keys(t.gh.files("octo/bare")), ["README.md"]);
  assert.equal((await t.send("POST", "/v1/apps/shop/git/connect", tok, { owner: "octo", repo: "shop", initialSync: "sideways" })).status, 400);
}));

test("sync: one commit for the workspace, refused when the branch moved; repo-only files kept", withServer(async (t) => {
  const tok = await t.account("octo@b.co");
  await t.deploy(tok, "shop");
  await t.connect(tok, t.gh.user("octo"));
  t.gh.addRepo("octo", "shop", ["octo"]);
  t.gh.write(t.gh.repo("octo/shop"), "main", {
    "app/index.html": "v1", "app/.env": "VITE_A=1\nSECRET=s\n", "app/.env.local": "KEY=k", "other/x.txt": "x",
  });
  const linked = await t.send("POST", "/v1/apps/shop/git/connect", tok, { owner: "octo", repo: "shop", subdir: "app", initialSync: "pull" });
  assert.equal(linked.status, 201);
  assert.deepEqual(linked.body.files.map((f: { path: string; data: string }) => [f.path, f.data]), [[".env", "VITE_A=1\n"], ["index.html", "v1"]]);
  const base = linked.body.sha;

  // Same files back: nothing to commit (the .env's secret line stays on GitHub).
  const same = await t.send("POST", "/v1/apps/shop/git/sync", tok, { branch: "main", baseSha: base, files: linked.body.files });
  assert.deepEqual(same.body, { branch: "main", sha: base, changed: false });

  const sync = await t.send("POST", "/v1/apps/shop/git/sync", tok, {
    branch: "main", baseSha: base, message: "Add about", files: [...linked.body.files, { path: "about.html", data: "about" }],
  });
  assert.equal(sync.status, 200, JSON.stringify(sync.body));
  assert.equal(sync.body.changed, true);
  const remote = t.gh.files("octo/shop");
  assert.equal(remote["app/about.html"], "about");
  assert.equal(remote["app/.env"], "VITE_A=1\nSECRET=s\n"); // untouched
  assert.equal(remote["app/.env.local"], "KEY=k"); // never sent, never deleted
  assert.equal(remote["other/x.txt"], "x"); // outside subdir
  assert.equal(t.gh.commit(sync.body.sha).message, "Add about");

  // Its public entry edited: the repository's copy keeps the secret line the studio never saw.
  const env = await t.send("POST", "/v1/apps/shop/git/sync", tok, {
    branch: "main", baseSha: sync.body.sha, files: [{ path: ".env", data: "VITE_A=2\n" }, { path: "index.html", data: "v1" }, { path: "about.html", data: "about" }],
  });
  assert.equal(env.status, 200, JSON.stringify(env.body));
  assert.equal(t.gh.files("octo/shop")["app/.env"], "VITE_A=2\nSECRET=s\n");

  // Deleting a file the workspace had.
  const del = await t.send("POST", "/v1/apps/shop/git/sync", tok, { branch: "main", baseSha: env.body.sha, files: [{ path: "index.html", data: "v1" }] });
  assert.equal(del.body.changed, true);
  assert.deepEqual(Object.keys(t.gh.files("octo/shop")).sort(), ["README.md", "app/.env.local", "app/index.html", "other/x.txt"]);

  // Someone pushed meanwhile: 409 with their head, nothing written.
  const theirs = t.gh.write(t.gh.repo("octo/shop"), "main", { "app/index.html": "v2" });
  const stale = await t.send("POST", "/v1/apps/shop/git/sync", tok, { branch: "main", baseSha: del.body.sha, files: [{ path: "index.html", data: "mine" }] });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "conflict");
  assert.equal(stale.body.headSha, theirs);
  assert.equal(t.gh.files("octo/shop")["app/index.html"], "v2");
  assert.equal((await t.send("POST", "/v1/apps/shop/git/sync", tok, { branch: "nope", baseSha: theirs, files: [] })).body.error, "branch_not_found");
  assert.equal((await t.send("POST", "/v1/apps/shop/git/sync", tok, { branch: "main", baseSha: "abc", files: [] })).status, 400);
}));

test("branches and merges: fast-forward, three-way (main moved), conflict, protected", withServer(async (t) => {
  const tok = await t.account("octo@b.co");
  await t.deploy(tok, "shop");
  await t.connect(tok, t.gh.user("octo"));
  t.gh.addRepo("octo", "shop", ["octo"]);
  const linked = await t.send("POST", "/v1/apps/shop/git/connect", tok, { owner: "octo", repo: "shop", initialSync: "pull" });
  const main0 = linked.body.sha;

  const br = await t.send("POST", "/v1/apps/shop/git/branches", tok, { name: "feat/about" });
  assert.equal(br.status, 201);
  assert.deepEqual(br.body.branch, { name: "feat/about", sha: main0 });
  assert.equal((await t.send("POST", "/v1/apps/shop/git/branches", tok, { name: "feat/about" })).body.error, "branch_exists");
  assert.equal((await t.send("POST", "/v1/apps/shop/git/branches", tok, { name: "bad..name" })).status, 400);
  const status = await t.send("GET", "/v1/apps/shop/git/status", tok);
  assert.equal(status.body.mainSha, main0);
  assert.deepEqual(status.body.branches.map((b: { name: string }) => b.name).sort(), ["feat/about", "main"]);

  // Fast-forward: main didn't move.
  const s1 = await t.send("POST", "/v1/apps/shop/git/sync", tok, {
    branch: "feat/about", baseSha: main0, files: [...linked.body.files, { path: "about.html", data: "a" }],
  });
  const ff = await t.send("POST", "/v1/apps/shop/git/merge", tok, { branch: "feat/about" });
  assert.equal(ff.status, 200, JSON.stringify(ff.body));
  assert.deepEqual(ff.body, { mergedSha: s1.body.sha, fastForward: true, treeChanged: false, branch: "main", deletedBranch: true });
  assert.equal(t.gh.repo("octo/shop").refs.get("main"), s1.body.sha);
  assert.equal(t.gh.repo("octo/shop").refs.has("feat/about"), false);
  assert.equal((await t.send("GET", "/v1/apps/shop", tok)).body.repo.lastSyncedSha, s1.body.sha);

  // Three-way: main got a commit on GitHub; the merge has both, and its files come back.
  await t.send("POST", "/v1/apps/shop/git/branches", tok, { name: "feat/contact" });
  const s2 = await t.send("POST", "/v1/apps/shop/git/sync", tok, {
    branch: "feat/contact", baseSha: s1.body.sha,
    files: [...linked.body.files, { path: "about.html", data: "a" }, { path: "contact.html", data: "c" }],
  });
  assert.equal(s2.status, 200);
  t.gh.write(t.gh.repo("octo/shop"), "main", { "NOTES.md": "upstream" });
  const m = await t.send("POST", "/v1/apps/shop/git/merge", tok, { branch: "feat/contact" });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.fastForward, false);
  assert.equal(m.body.treeChanged, true);
  assert.deepEqual(m.body.files.map((f: { path: string }) => f.path), ["NOTES.md", "README.md", "about.html", "contact.html"]);
  assert.deepEqual(t.gh.commit(m.body.mergedSha).parents.length, 2);

  // Conflict: both sides changed about.html.
  await t.send("POST", "/v1/apps/shop/git/branches", tok, { name: "feat/x" });
  await t.send("POST", "/v1/apps/shop/git/sync", tok, { branch: "feat/x", baseSha: m.body.mergedSha, files: m.body.files.map((f: { path: string }) => f.path === "about.html" ? { ...f, data: "mine" } : f) });
  t.gh.write(t.gh.repo("octo/shop"), "main", { "about.html": "theirs" });
  const mainBefore = t.gh.repo("octo/shop").refs.get("main");
  const cf = await t.send("POST", "/v1/apps/shop/git/merge", tok, { branch: "feat/x" });
  assert.equal(cf.status, 409);
  assert.equal(cf.body.error, "merge_conflict");
  assert.deepEqual(cf.body.paths, ["about.html"]);
  assert.equal(t.gh.repo("octo/shop").refs.get("main"), mainBefore);
  assert.equal(t.gh.repo("octo/shop").refs.has("feat/x"), true); // kept, to fix

  // Protected main: fast-forward and merge commits both refused.
  t.gh.repo("octo/shop").protected.add("main");
  await t.send("POST", "/v1/apps/shop/git/branches", tok, { name: "feat/y" });
  const files = (await t.send("GET", "/v1/apps/shop/git/tree", tok)).body;
  await t.send("POST", "/v1/apps/shop/git/sync", tok, { branch: "feat/y", baseSha: files.sha, files: [...files.files, { path: "y", data: "y" }] });
  const pr = await t.send("POST", "/v1/apps/shop/git/merge", tok, { branch: "feat/y" });
  assert.equal(pr.status, 422);
  assert.equal(pr.body.error, "branch_protected");
  await t.send("POST", "/v1/apps/shop/git/sync", tok, { branch: "feat/x", baseSha: t.gh.repo("octo/shop").refs.get("feat/x"), files: [{ path: "z", data: "z" }] });
  assert.equal((await t.send("POST", "/v1/apps/shop/git/merge", tok, { branch: "feat/x" })).body.error, "branch_protected");
  // A ruleset says it differently.
  t.gh.repo("octo/shop").protected.clear();
  t.gh.repo("octo/shop").rulesets = true;
  assert.equal((await t.send("POST", "/v1/apps/shop/git/merge", tok, { branch: "feat/y" })).body.error, "branch_protected");
}));

test("a linked repository is followed by its id: renamed, it's still the one; a new one under the old name is never touched", withServer(async (t) => {
  const tok = await t.account("octo@b.co");
  await t.deploy(tok, "shop");
  await t.connect(tok, t.gh.user("octo"));
  t.gh.addRepo("octo", "shop", ["octo"]);
  const linked = await t.send("POST", "/v1/apps/shop/git/connect", tok, { owner: "octo", repo: "shop", initialSync: "pull" });
  t.gh.rename("octo/shop", "store");
  t.gh.addRepo("octo", "shop", ["octo"]);
  const sync = await t.send("POST", "/v1/apps/shop/git/sync", tok, { branch: "main", baseSha: linked.body.sha, files: [{ path: "a", data: "1" }] });
  assert.equal(sync.status, 200, JSON.stringify(sync.body));
  assert.equal(t.gh.files("octo/store").a, "1");
  assert.equal(t.gh.files("octo/shop").a, undefined);
  assert.equal((await t.send("GET", "/v1/apps/shop", tok)).body.repo.fullName, "octo/store");
}));

test("a merge that worked is reported even if its files can't be loaded; the branch stays", withServer(async (t) => {
  const tok = await t.account("octo@b.co");
  await t.deploy(tok, "shop");
  await t.connect(tok, t.gh.user("octo"));
  t.gh.addRepo("octo", "shop", ["octo"]);
  const linked = await t.send("POST", "/v1/apps/shop/git/connect", tok, { owner: "octo", repo: "shop", initialSync: "pull" });
  await t.send("POST", "/v1/apps/shop/git/branches", tok, { name: "feat/a" });
  await t.send("POST", "/v1/apps/shop/git/sync", tok, { branch: "feat/a", baseSha: linked.body.sha, files: [...linked.body.files, { path: "a", data: "1" }] });
  // main gets more files than a deploy may hold: the merged tree is too big to load.
  t.gh.write(t.gh.repo("octo/shop"), "main", Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, "x"])));
  const m = await t.send("POST", "/v1/apps/shop/git/merge", tok, { branch: "feat/a" });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.treeChanged, true);
  assert.match(m.body.filesError, /more than 20 files/);
  assert.equal(m.body.deletedBranch, false);
  assert.equal(t.gh.repo("octo/shop").refs.has("feat/a"), true);
  assert.equal(t.gh.repo("octo/shop").refs.get("main"), m.body.mergedSha);
}, {}, { limits: { ...loadConfig().limits, deployFiles: 20 } }));

test("refresh and expiry only touch the tokens they were for; a stale 401's expiry doesn't outlive the refresh", withServer(async (t) => {
  const tok = await t.account("octo@b.co");
  await t.connect(tok, t.gh.user("octo"));
  const store = t.srv.store;
  const me = (await t.send("GET", "/v1/me", tok)).body.account.id;
  const old = (await store.getGitConnection(me, "github"))!;
  // Another server's 401 with the old token lands first; then its refresh's new tokens: active again.
  await store.expireGitConnection(me, "github", old.gen);
  assert.equal((await store.getGitConnection(me, "github"))!.status, "expired");
  assert.equal(await store.refreshGitConnection(me, "github", old.gen, { access_token: "ghu_new", refresh_token: "ghr_new", expires_at: null, scopes: null }), true);
  const now = (await store.getGitConnection(me, "github"))!;
  assert.deepEqual([now.status, now.access_token], ["active", "ghu_new"]);
  // Old tokens' refresh and expiry don't apply to newer ones, nor to a reconnect.
  assert.equal(await store.refreshGitConnection(me, "github", old.gen, { access_token: "ghu_x", refresh_token: null, expires_at: null, scopes: null }), false);
  await store.expireGitConnection(me, "github", old.gen);
  assert.equal((await store.getGitConnection(me, "github"))!.status, "active");
  await store.deleteGitConnection(me, "github");
  assert.equal(await store.refreshGitConnection(me, "github", now.gen, { access_token: "ghu_y", refresh_token: null, expires_at: null, scopes: null }), false);
  assert.equal(await store.getGitConnection(me, "github"), undefined); // a disconnect isn't undone
}));

test("a refresh GitHub refuses for the server's own reasons (wrong client secret) doesn't make the user reconnect", withServer(async (t) => {
  const tok = await t.account("octo@b.co");
  t.gh.setExpiresIn(60);
  await t.connect(tok, t.gh.user("octo"));
  t.gh.breakClientSecret(true);
  const r = await t.send("GET", "/v1/git/github/repos", tok);
  assert.equal(r.status, 502);
  assert.equal((await t.send("GET", "/v1/me/git", tok)).body.status, "active");
  t.gh.breakClientSecret(false);
  assert.equal((await t.send("GET", "/v1/git/github/repos", tok)).status, 200);
}));

test("an app's address can be reserved with nothing deployed, then linked; a merge refuses a branch that moved past what was synced", withServer(async (t) => {
  const tok = await t.account("octo@b.co");
  const r = await t.send("POST", "/v1/apps", tok, { name: "fresh" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.app.currentDeployId, null);
  assert.equal((await t.send("POST", "/v1/apps", tok, { name: "fresh" })).status, 409);
  assert.equal((await t.send("POST", "/v1/apps", tok, { name: "Bad Name" })).status, 400);
  assert.equal((await t.send("POST", "/v1/apps", undefined, { name: "anon" })).status, 401);
  await t.connect(tok, t.gh.user("octo"));
  t.gh.addRepo("octo", "fresh", ["octo"]);
  const linked = await t.send("POST", "/v1/apps/fresh/git/connect", tok, { owner: "octo", repo: "fresh", initialSync: "push", files: [{ path: "index.html", data: "x" }] });
  assert.equal(linked.status, 201);
  await t.send("POST", "/v1/apps/fresh/git/branches", tok, { name: "feat/a" });
  const s1 = await t.send("POST", "/v1/apps/fresh/git/sync", tok, { branch: "feat/a", baseSha: linked.body.sha, files: [{ path: "index.html", data: "y" }] });
  t.gh.write(t.gh.repo("octo/fresh"), "feat/a", { "late.txt": "pushed meanwhile" });
  const m = await t.send("POST", "/v1/apps/fresh/git/merge", tok, { branch: "feat/a", headSha: s1.body.sha });
  assert.equal(m.status, 409);
  assert.equal(m.body.error, "conflict");
  assert.equal(t.gh.repo("octo/fresh").refs.get("main"), linked.body.sha); // nothing merged
}));

test("collaborators act with their own GitHub token, never the owner's", withServer(async (t) => {
  const owner = await t.account("own@b.co");
  await t.deploy(owner, "shop");
  await t.connect(owner, t.gh.user("owner"));
  t.gh.addRepo("owner", "shop", ["owner", "collab"]);
  const linked = await t.send("POST", "/v1/apps/shop/git/connect", owner, { owner: "owner", repo: "shop", initialSync: "pull" });
  assert.equal(linked.status, 201);

  const collab = await t.account("c@b.co");
  const inv = await t.send("POST", "/v1/apps/shop/collaborators", owner, { email: "c@b.co", role: "admin" });
  assert.equal((await t.send("POST", `/v1/me/invites/${inv.body.invite.id}/accept`, collab)).status, 200);
  const viewer = await t.account("v@b.co");
  const vinv = await t.send("POST", "/v1/apps/shop/collaborators", owner, { email: "v@b.co", role: "viewer" });
  await t.send("POST", `/v1/me/invites/${vinv.body.invite.id}/accept`, viewer);

  // Not connected: refused, and the owner's token wasn't used.
  const calls = t.gh.stats.calls.length;
  const r = await t.send("POST", "/v1/apps/shop/git/sync", collab, { branch: "main", baseSha: linked.body.sha, files: [{ path: "a", data: "1" }] });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "git_not_connected");
  assert.equal(t.gh.stats.calls.length, calls);

  await t.connect(collab, t.gh.user("collab"));
  const ok = await t.send("POST", "/v1/apps/shop/git/sync", collab, { branch: "main", baseSha: linked.body.sha, files: [{ path: "a", data: "1" }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(t.gh.commit(ok.body.sha).by, "collab");
  assert.equal(t.gh.commit(ok.body.sha).author?.name, "collab");
  assert.ok(t.gh.stats.calls.slice(calls).every((c) => c.login === "collab"));

  // A viewer can read the repository (as themselves) but not write; only admins link and unlink.
  await t.connect(viewer, t.gh.user("viewer"));
  t.gh.repo("owner/shop").push.add("viewer");
  assert.equal((await t.send("GET", "/v1/apps/shop/git/status", viewer)).status, 200);
  assert.equal((await t.send("POST", "/v1/apps/shop/git/branches", viewer, { name: "v" })).status, 403);
  assert.equal((await t.send("DELETE", "/v1/apps/shop/git", viewer)).status, 403);
  assert.equal((await t.send("DELETE", "/v1/apps/shop/git", collab)).status, 200);
  assert.equal((await t.send("GET", "/v1/apps/shop/git/status", owner)).body.error, "git_not_linked");
}));

test("deploys record the commit they were built from", withServer(async (t) => {
  const tok = await t.account("octo@b.co");
  const sha = blobSha(new TextEncoder().encode("x"));
  const d = await t.deploy(tok, "shop", { git: { sha, branch: "main", repo: "octo/shop" } });
  assert.equal(d.status, 201);
  await t.deploy(tok, "shop");
  const app = await t.send("GET", "/v1/apps/shop", tok);
  assert.deepEqual(app.body.deploys.map((x: { git: unknown }) => x.git), [null, { sha, branch: "main", repo: "octo/shop", url: `${t.gh.base}/octo/shop/commit/${sha}` }]);
  assert.equal(app.body.repo, null);
  for (const git of [{ sha: "nope" }, { sha, branch: "a b" }, { sha, repo: "no-slash" }, "x"]) {
    assert.equal((await t.deploy(tok, "shop", { git })).status, 400, JSON.stringify(git));
  }
}));

test("OAuth App fallback: asks the login app for the repo scope, under its callback URL", withServer(async (t) => {
  const tok = await t.account("octo@b.co");
  const start = await t.send("POST", "/v1/git/github/connect", tok, {});
  const url = new URL(start.body.url);
  assert.equal(url.searchParams.get("client_id"), "app-cid");
  assert.equal(url.searchParams.get("scope"), "repo read:user user:email");
  assert.equal(url.searchParams.get("redirect_uri"), "http://test.local/v1/auth/github/callback");
  assert.equal((await t.send("GET", "/v1/me/git", tok)).body.kind, "oauth");
  // The login callback hands it to source control.
  assert.deepEqual(hash(await t.connect(tok, t.gh.user("octo"))), { cresslet_git: "connected" });
  assert.equal((await t.send("GET", "/v1/me/git", tok)).body.login, "octo");
}, { githubApp: null, oauthFallback: true }));

test("source control off: says so", withServer(async (t) => {
  const tok = await t.account("octo@b.co");
  assert.deepEqual((await t.send("GET", "/v1", undefined)).body.git, { github: false });
  assert.equal((await t.send("GET", "/v1/me/git", tok)).body.available, false);
  assert.equal((await t.send("POST", "/v1/git/github/connect", tok, {})).body.error, "git_unavailable");
}, { githubApp: null }));

test("migration 4 re-runs cleanly, and an older server's deploy rows (no git columns) still work", withServer(async (t) => {
  const { migrate } = await import("../server/migrations.ts");
  const db = t.srv.store.db;
  const tok = await t.account("octo@b.co");
  await t.deploy(tok, "shop");
  await db.run("DELETE FROM schema_migrations WHERE version = 4");
  assert.deepEqual((await migrate(db)).applied, [4]);
  const app = (await t.srv.store.appByName("shop"))!;
  // What a release before this one inserts.
  await db.run("INSERT INTO deploys (id, app_id, created_at, bytes, file_count, has_server, source) VALUES (?, ?, ?, 1, 1, 0, 'cli')", "dep_old", app.id, Date.now() + 1000);
  const r = await t.send("GET", "/v1/apps/shop", tok);
  assert.equal(r.body.deploys[0].id, "dep_old");
  assert.equal(r.body.deploys[0].git, null);
}));

// ---- pull requests, webhooks, conflicts (#104)

async function linkedShop(t: T) {
  const tok = await t.account("octo@b.co");
  await t.deploy(tok, "shop");
  await t.connect(tok, t.gh.user("octo"));
  t.gh.addRepo("octo", "shop", ["octo"]);
  const linked = await t.send("POST", "/v1/apps/shop/git/connect", tok, { owner: "octo", repo: "shop", initialSync: "pull" });
  return { tok, linked: linked.body as { sha: string; files: { path: string; data: string }[] } };
}

test("pull requests: opened once from a branch as the user, with its review and checks", withServer(async (t) => {
  const { tok, linked } = await linkedShop(t);
  await t.send("POST", "/v1/apps/shop/git/branches", tok, { name: "feat/a" });
  const s = await t.send("POST", "/v1/apps/shop/git/sync", tok, { branch: "feat/a", baseSha: linked.sha, files: [...linked.files, { path: "a", data: "1" }] });
  assert.deepEqual((await t.send("GET", "/v1/apps/shop/git/pulls?branch=feat/a", tok)).body, { pull: null });
  const opened = await t.send("POST", "/v1/apps/shop/git/pulls", tok, { branch: "feat/a" });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  assert.equal(opened.body.pull.number, 1);
  assert.equal(opened.body.pull.review, "pending");
  assert.equal(opened.body.pull.checks, "none");
  assert.equal(t.gh.repo("octo/shop").pulls[0].base, "main");
  // Asked again: the same one.
  assert.equal((await t.send("POST", "/v1/apps/shop/git/pulls", tok, { branch: "feat/a" })).status, 200);
  assert.equal(t.gh.repo("octo/shop").pulls.length, 1);
  t.gh.repo("octo/shop").pulls[0].reviews.push({ user: { login: "rev" }, state: "APPROVED" });
  t.gh.check(s.body.sha, "in_progress", null);
  let p = (await t.send("GET", "/v1/apps/shop/git/pulls?branch=feat/a", tok)).body.pull;
  assert.deepEqual([p.review, p.checks], ["approved", "pending"]);
  t.gh.repo("octo/shop").pulls[0].reviews.push({ user: { login: "rev" }, state: "CHANGES_REQUESTED" });
  t.gh.check(s.body.sha, "completed", "failure");
  p = (await t.send("GET", "/v1/apps/shop/git/pulls?branch=feat/a", tok)).body.pull;
  assert.deepEqual([p.review, p.checks], ["changes_requested", "failure"]);
  assert.equal((await t.send("POST", "/v1/apps/shop/git/pulls", tok, { branch: "main" })).status, 400);
}));

test("webhooks: signed pushes to a linked repository's default branch are noted; anything else isn't", withServer(async (t) => {
  const { tok } = await linkedShop(t);
  const repo = t.gh.repo("octo/shop");
  const hook = (payload: unknown, secret = "whsec", event = "push") => {
    const raw = JSON.stringify(payload);
    const sig = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
    return t.call("/v1/webhooks/github", { method: "POST", headers: { "x-hub-signature-256": sig, "x-github-event": event }, body: raw });
  };
  const after = "f".repeat(40);
  assert.equal((await hook({ ref: "refs/heads/main", after, repository: { id: repo.id } }, "wrong")).status, 401);
  assert.equal((await t.send("GET", "/v1/apps/shop", tok)).body.repo.upstreamSha, null);
  assert.equal((await hook({ zen: "hi" }, "whsec", "ping")).status, 200);
  const other = await hook({ ref: "refs/heads/feat/x", after, repository: { id: repo.id } });
  assert.equal((await other.json()).apps, 0); // not the default branch
  const ok = await hook({ ref: "refs/heads/main", after, repository: { id: repo.id } });
  assert.deepEqual(await ok.json(), { ok: true, apps: 1 });
  assert.equal((await t.send("GET", "/v1/apps/shop", tok)).body.repo.upstreamSha, after);
}, { webhookSecret: "whsec" }));

test("webhooks off: 404", withServer(async (t) => {
  assert.equal((await t.call("/v1/webhooks/github", { method: "POST", body: "{}" })).status, 404);
}));

test("conflicts: main merged into the branch with markers; resolved and committed with main as a parent, the deploy merge fast-forwards", withServer(async (t) => {
  const { tok, linked } = await linkedShop(t);
  const base = [...linked.files, { path: "app.txt", data: "hello\n" }, { path: "keep.txt", data: "k\n" }];
  const m0 = await t.send("POST", "/v1/apps/shop/git/sync", tok, { branch: "main", baseSha: linked.sha, files: base });
  await t.send("POST", "/v1/apps/shop/git/branches", tok, { name: "feat/c" });
  const mine = await t.send("POST", "/v1/apps/shop/git/sync", tok, {
    branch: "feat/c", baseSha: m0.body.sha, files: base.map((f) => (f.path === "app.txt" ? { ...f, data: "hello from the branch\n" } : f)).concat([{ path: "new.txt", data: "n\n" }]),
  });
  const theirs = t.gh.write(t.gh.repo("octo/shop"), "main", { "app.txt": "hello from main\n", "keep.txt": null, "upstream.txt": "u\n" });
  assert.equal((await t.send("POST", "/v1/apps/shop/git/merge", tok, { branch: "feat/c" })).body.error, "merge_conflict");

  const cf = await t.send("GET", "/v1/apps/shop/git/conflicts?branch=feat/c", tok);
  assert.equal(cf.status, 200, JSON.stringify(cf.body));
  assert.deepEqual(cf.body.conflicts, ["app.txt"]);
  assert.equal(cf.body.intoSha, theirs);
  assert.equal(cf.body.headSha, mine.body.sha);
  const files = Object.fromEntries(cf.body.files.map((f: { path: string; data: string }) => [f.path, f.data]));
  assert.equal(files["app.txt"], "<<<<<<< feat/c\nhello from the branch\n=======\nhello from main\n>>>>>>> main\n");
  assert.equal(files["new.txt"], "n\n"); // the branch's own
  assert.equal(files["upstream.txt"], "u\n"); // main's own
  assert.equal(files["keep.txt"], undefined); // main deleted it, the branch didn't touch it

  // Resolved, committed as a merge of main into the branch; then the deploy's merge is a fast-forward.
  const resolved = cf.body.files.map((f: { path: string; data: string }) => (f.path === "app.txt" ? { ...f, data: "hello from both\n" } : f));
  const s = await t.send("POST", "/v1/apps/shop/git/sync", tok, { branch: "feat/c", baseSha: mine.body.sha, files: resolved, mergeParent: theirs });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual(t.gh.commit(s.body.sha).parents, [mine.body.sha, theirs]);
  const m = await t.send("POST", "/v1/apps/shop/git/merge", tok, { branch: "feat/c" });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.fastForward, true);
  assert.equal(t.gh.files("octo/shop")["app.txt"], "hello from both\n");
  assert.equal(t.gh.files("octo/shop")["upstream.txt"], "u\n");
}));

test("conflicts in a subfolder app: the resolved merge keeps the default branch's changes elsewhere; ones the studio can't resolve are refused", withServer(async (t) => {
  const tok = await t.account("octo@b.co");
  await t.deploy(tok, "shop");
  await t.connect(tok, t.gh.user("octo"));
  t.gh.addRepo("octo", "shop", ["octo"]);
  const repo = t.gh.repo("octo/shop");
  t.gh.write(repo, "main", { "app/app.txt": "hello\n", "app/.env": "VITE_A=1\n", "other/x.txt": "x\n" });
  const linked = await t.send("POST", "/v1/apps/shop/git/connect", tok, { owner: "octo", repo: "shop", subdir: "app", initialSync: "pull" });
  await t.send("POST", "/v1/apps/shop/git/branches", tok, { name: "feat/c" });
  const mine = await t.send("POST", "/v1/apps/shop/git/sync", tok, {
    branch: "feat/c", baseSha: linked.body.sha, files: linked.body.files.map((f: { path: string }) => (f.path === "app.txt" ? { ...f, data: "mine\n" } : f)),
  });
  // main: the same file (a conflict to resolve), plus a file outside the app and its .env (merged by themselves).
  const theirs = t.gh.write(repo, "main", { "app/app.txt": "theirs\n", "other/x.txt": "x2\n", "app/.env": "VITE_A=2\nSECRET=s\n" });
  const cf = await t.send("GET", "/v1/apps/shop/git/conflicts?branch=feat/c", tok);
  assert.equal(cf.status, 200, JSON.stringify(cf.body));
  assert.deepEqual(cf.body.conflicts, ["app.txt"]);
  assert.equal(cf.body.files.find((f: { path: string }) => f.path === ".env").data, "VITE_A=2\n"); // main's, sanitized
  const resolved = cf.body.files.map((f: { path: string }) => (f.path === "app.txt" ? { ...f, data: "both\n" } : f));
  const s = await t.send("POST", "/v1/apps/shop/git/sync", tok, { branch: "feat/c", baseSha: mine.body.sha, files: resolved, mergeParent: theirs });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const m = await t.send("POST", "/v1/apps/shop/git/merge", tok, { branch: "feat/c" });
  assert.equal(m.body.fastForward, true);
  const files = t.gh.files("octo/shop");
  assert.equal(files["app/app.txt"], "both\n");
  assert.equal(files["other/x.txt"], "x2\n"); // main's change outside the app kept
  assert.equal(files["app/.env"], "VITE_A=2\nSECRET=s\n"); // main's own .env, secret line and all

  // Both sides change a file outside the app: not resolvable here.
  await t.send("POST", "/v1/apps/shop/git/branches", tok, { name: "feat/d" });
  await t.gh.write(repo, "feat/d", { "other/x.txt": "branch\n" });
  t.gh.write(repo, "main", { "other/x.txt": "main\n" });
  const un = await t.send("GET", "/v1/apps/shop/git/conflicts?branch=feat/d", tok);
  assert.equal(un.status, 409);
  assert.equal(un.body.error, "merge_unresolvable");
  assert.deepEqual(un.body.paths, ["other/x.txt"]);
  assert.equal((await t.send("GET", "/v1/apps/shop/git/conflicts?branch=main", tok)).status, 400);
}));

test("conflict resolution: a .env edited meanwhile, and binary files (NUL bytes) both sides changed, are refused", withServer(async (t) => {
  const tok = await t.account("octo@b.co");
  await t.deploy(tok, "shop");
  await t.connect(tok, t.gh.user("octo"));
  t.gh.addRepo("octo", "shop", ["octo"]);
  const repo = t.gh.repo("octo/shop");
  t.gh.write(repo, "main", { "a.txt": "a\n", ".env": "VITE_A=1\n", "img.bin": "x\u0000y" });
  const linked = await t.send("POST", "/v1/apps/shop/git/connect", tok, { owner: "octo", repo: "shop", initialSync: "pull" });
  await t.send("POST", "/v1/apps/shop/git/branches", tok, { name: "feat/e" });
  const mine = await t.send("POST", "/v1/apps/shop/git/sync", tok, {
    branch: "feat/e", baseSha: linked.body.sha, files: linked.body.files.map((f: { path: string }) => (f.path === "a.txt" ? { ...f, data: "mine\n" } : f)),
  });
  const theirs = t.gh.write(repo, "main", { "a.txt": "theirs\n" });
  const cf = await t.send("GET", "/v1/apps/shop/git/conflicts?branch=feat/e", tok);
  assert.deepEqual(cf.body.conflicts, ["a.txt"]);
  const edited = cf.body.files.map((f: { path: string }) => (f.path === "a.txt" ? { ...f, data: "both\n" } : f.path === ".env" ? { ...f, data: "VITE_A=9\n" } : f));
  const s = await t.send("POST", "/v1/apps/shop/git/sync", tok, { branch: "feat/e", baseSha: mine.body.sha, files: edited, mergeParent: theirs });
  assert.equal(s.status, 409);
  assert.equal(s.body.error, "merge_dotenv_changed");

  // A binary file both sides changed: no markers, refused.
  await t.send("POST", "/v1/apps/shop/git/branches", tok, { name: "feat/b" });
  t.gh.write(repo, "feat/b", { "img.bin": "x\u0000mine" });
  t.gh.write(repo, "main", { "img.bin": "x\u0000theirs" });
  const bin = await t.send("GET", "/v1/apps/shop/git/conflicts?branch=feat/b", tok);
  assert.equal(bin.body.error, "merge_unresolvable");
  assert.deepEqual(bin.body.paths, ["img.bin"]);
}));

test("conflict resolution: dotenv files deleted on one side are handled both ways", withServer(async (t) => {
  const tok = await t.account("octo@b.co");
  await t.deploy(tok, "shop");
  await t.connect(tok, t.gh.user("octo"));
  t.gh.addRepo("octo", "shop", ["octo"]);
  const repo = t.gh.repo("octo/shop");
  t.gh.write(repo, "main", { "a.txt": "a\n", ".env": "VITE_A=1\n" });
  const linked = await t.send("POST", "/v1/apps/shop/git/connect", tok, { owner: "octo", repo: "shop", initialSync: "pull" });
  await t.send("POST", "/v1/apps/shop/git/branches", tok, { name: "feat/g" });
  const mine = await t.send("POST", "/v1/apps/shop/git/sync", tok, {
    branch: "feat/g", baseSha: linked.body.sha, files: linked.body.files.map((f: { path: string }) => (f.path === "a.txt" ? { ...f, data: "mine\n" } : f)),
  });
  // main deletes .env (and conflicts on a.txt): the workspace keeps an empty (private-only) one: fine.
  const theirs = t.gh.write(repo, "main", { "a.txt": "theirs\n", ".env": null });
  const cf = await t.send("GET", "/v1/apps/shop/git/conflicts?branch=feat/g", tok);
  assert.equal(cf.body.files.some((f: { path: string }) => f.path === ".env"), false);
  const files = [...cf.body.files.map((f: { path: string }) => (f.path === "a.txt" ? { ...f, data: "both\n" } : f)), { path: ".env", data: "" }];
  const s = await t.send("POST", "/v1/apps/shop/git/sync", tok, { branch: "feat/g", baseSha: mine.body.sha, files, mergeParent: theirs });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(t.gh.files("octo/shop", "feat/g")[".env"], undefined);
}));

test("conflict resolution: a .env deleted in the workspace while merging is refused", withServer(async (t) => {
  const tok = await t.account("octo@b.co");
  await t.deploy(tok, "shop");
  await t.connect(tok, t.gh.user("octo"));
  t.gh.addRepo("octo", "shop", ["octo"]);
  const repo = t.gh.repo("octo/shop");
  t.gh.write(repo, "main", { "a.txt": "a\n", ".env": "VITE_A=1\n" });
  const linked = await t.send("POST", "/v1/apps/shop/git/connect", tok, { owner: "octo", repo: "shop", initialSync: "pull" });
  await t.send("POST", "/v1/apps/shop/git/branches", tok, { name: "feat/h" });
  const mine = await t.send("POST", "/v1/apps/shop/git/sync", tok, {
    branch: "feat/h", baseSha: linked.body.sha, files: linked.body.files.map((f: { path: string }) => (f.path === "a.txt" ? { ...f, data: "mine\n" } : f)),
  });
  const theirs = t.gh.write(repo, "main", { "a.txt": "theirs\n" });
  const cf = await t.send("GET", "/v1/apps/shop/git/conflicts?branch=feat/h", tok);
  const files = cf.body.files.filter((f: { path: string }) => f.path !== ".env").map((f: { path: string }) => (f.path === "a.txt" ? { ...f, data: "both\n" } : f));
  const s = await t.send("POST", "/v1/apps/shop/git/sync", tok, { branch: "feat/h", baseSha: mine.body.sha, files, mergeParent: theirs });
  assert.equal(s.body.error, "merge_dotenv_changed");
}));

// ---- stacked changes (#118)

test("stack: each change on its own branch, read by a collaborator too; a push onto the top follows it; merging the top lands the stack", withServer(async (t) => {
  const { tok, linked } = await linkedShop(t);
  const files = (x: string) => [...linked.files, { path: "app.txt", data: x }];
  const c1 = await t.send("POST", "/v1/apps/shop/git/stack", tok, { from: "main", baseSha: linked.sha, files: files("1"), title: "Add due dates", prompt: "Add due dates to tasks" });
  assert.equal(c1.status, 201, JSON.stringify(c1.body));
  assert.equal(c1.body.branch, "feat/add-due-dates/1-add-due-dates");
  const c2 = await t.send("POST", "/v1/apps/shop/git/stack", tok, { from: c1.body.branch, baseSha: c1.body.sha, files: files("2"), title: "Dark mode" });
  assert.equal(c2.body.branch, "feat/add-due-dates/2-dark-mode");
  assert.deepEqual(t.gh.commit(c2.body.sha).parents, [c1.body.sha]);
  assert.equal(t.gh.commit(c2.body.sha).author?.name, "octo");
  // Nothing changed: no branch.
  const none = await t.send("POST", "/v1/apps/shop/git/stack", tok, { from: c2.body.branch, baseSha: c2.body.sha, files: files("2"), title: "Explain" });
  assert.deepEqual([none.status, none.body], [200, { changed: false, sha: c2.body.sha }]);
  assert.equal([...t.gh.repo("octo/shop").refs.keys()].filter((b) => b.startsWith("feat/")).length, 2);
  // Not from a stack's top: said, nothing written.
  const below = await t.send("POST", "/v1/apps/shop/git/stack", tok, { from: c1.body.branch, baseSha: c1.body.sha, files: files("3"), title: "Three" });
  assert.deepEqual([below.status, below.body.error], [409, "not_on_top"]);

  // Deploying a change below the top on its own: refused before anything merges (the top lands them all).
  const low = await t.send("POST", "/v1/apps/shop/git/merge", tok, { branch: c1.body.branch });
  assert.deepEqual([low.status, low.body.error], [409, "not_on_top"]);
  assert.equal(t.gh.repo("octo/shop").refs.get("main"), linked.sha);
  // …or committed to (the changes above wouldn't hold it).
  const onto = await t.send("POST", "/v1/apps/shop/git/sync", tok, { branch: c1.body.branch, baseSha: c1.body.sha, files: files("x") });
  assert.deepEqual([onto.status, onto.body.error], [409, "not_on_top"]);
  assert.equal(t.gh.repo("octo/shop").refs.get(c1.body.branch), c1.body.sha);

  // A collaborator (their own GitHub) sees the same stack.
  const bob = await t.account("bob@b.co");
  const inv = await t.send("POST", "/v1/apps/shop/collaborators", tok, { email: "bob@b.co", role: "viewer" });
  assert.equal((await t.send("POST", `/v1/me/invites/${inv.body.invite.id}/accept`, bob)).status, 200);
  await t.connect(bob, t.gh.user("bob"));
  t.gh.repo("octo/shop").push.add("bob");
  const read = await t.send("GET", "/v1/apps/shop/git/stack", bob);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.stacks.length, 1);
  assert.deepEqual(read.body.stacks[0].changes.map((c: { branch: string; github: string; title: string }) => [c.branch, c.title, c.github]), [
    ["feat/add-due-dates/1-add-due-dates", "Add due dates", "ok"], ["feat/add-due-dates/2-dark-mode", "Dark mode", "ok"],
  ]);
  assert.equal(read.body.stacks[0].changes[0].prompt, "Add due dates to tasks");

  // A hand edit pushed onto the top change: it follows.
  const s = await t.send("POST", "/v1/apps/shop/git/sync", tok, { branch: c2.body.branch, baseSha: c2.body.sha, files: files("2b") });
  const top = (await t.send("GET", "/v1/apps/shop/git/stack", tok)).body.stacks[0].changes[1];
  assert.deepEqual([top.sha, top.github], [s.body.sha, "ok"]);
  // Pushed to on GitHub: moved.
  t.gh.write(t.gh.repo("octo/shop"), c1.body.branch, { "other.txt": "x" });
  assert.equal((await t.send("GET", "/v1/apps/shop/git/stack", tok)).body.stacks[0].changes[0].github, "moved");

  // Deploy's merge of the top change: the stack is landed and its branches go (the moved one stays).
  const m = await t.send("POST", "/v1/apps/shop/git/merge", tok, { branch: c2.body.branch, headSha: s.body.sha });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.deepEqual(m.body.landed, { stack: "add-due-dates", changes: 2 });
  assert.equal(t.gh.files("octo/shop")["app.txt"], "2b");
  assert.deepEqual((await t.send("GET", "/v1/apps/shop/git/stack", tok)).body.stacks, []);
  assert.equal(t.gh.repo("octo/shop").refs.has(c2.body.branch), false);
  assert.equal(t.gh.repo("octo/shop").refs.has(c1.body.branch), true);
}));

test("stack: an older branch named like the stack (feat/<name>) moves it to the next name", withServer(async (t) => {
  const { tok, linked } = await linkedShop(t);
  t.gh.repo("octo/shop").refs.set("feat/dark-mode", linked.sha); // GitHub refuses feat/dark-mode/… ("Reference update failed")
  const c = await t.send("POST", "/v1/apps/shop/git/stack", tok, { from: "main", baseSha: linked.sha, files: [...linked.files, { path: "a", data: "1" }], title: "Dark mode" });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.body.branch, "feat/dark-mode-2/1-dark-mode");
  // …and one under the name (feat/x/… when making feat/x): taken too, not an error.
  t.gh.repo("octo/shop").refs.set("keep/x/old", linked.sha);
  const taken = await t.send("POST", "/v1/apps/shop/git/branches", tok, { name: "keep/x" });
  assert.deepEqual([taken.status, taken.body.error], [409, "branch_exists"]);
  // From a branch of its own: a stack starts there.
  const own = await t.send("POST", "/v1/apps/shop/git/stack", tok, { from: "feat/dark-mode", baseSha: linked.sha, files: [...linked.files, { path: "b", data: "1" }], title: "Go on" });
  assert.deepEqual([own.status, own.body.branch, own.body.change.baseSha], [201, "feat/go-on/1-go-on", linked.sha]);
}));

test("stack: go back to a change (later ones set aside, branches kept), restore them, or build on it", withServer(async (t) => {
  const { tok, linked } = await linkedShop(t);
  const files = (x: string) => [...linked.files, { path: "app.txt", data: x }];
  const add = async (from: string, baseSha: string, title: string, x: string) =>
    (await t.send("POST", "/v1/apps/shop/git/stack", tok, { from, baseSha, files: files(x), title })).body;
  const c1 = await add("main", linked.sha, "One", "1");
  const c2 = await add(c1.branch, c1.sha, "Two", "2");
  const read = async () => (await t.send("GET", "/v1/apps/shop/git/stack", tok)).body.stacks[0];

  const back = await t.send("POST", "/v1/apps/shop/git/stack/back", tok, { change: c1.change.id });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual([back.body.change.sha, back.body.setAside.map((c: { title: string }) => c.title)], [c1.sha, ["Two"]]);
  let s = await read();
  assert.deepEqual([s.changes.map((c: { title: string }) => c.title), s.setAside.map((c: { title: string; github: string }) => [c.title, c.github])], [["One"], [["Two", "ok"]]]);
  assert.equal(t.gh.repo("octo/shop").refs.get(c2.branch), c2.sha);
  // The change set aside takes no commit, sync or merge.
  for (const [path, input] of [["/git/stack", { from: c2.branch, baseSha: c2.sha, files: files("x"), title: "X" }], ["/git/sync", { branch: c2.branch, baseSha: c2.sha, files: files("x") }], ["/git/merge", { branch: c2.branch }]] as const) {
    const r = await t.send("POST", `/v1/apps/shop${path}`, tok, input);
    assert.deepEqual([r.status, r.body.error], [409, "set_aside"], path);
  }

  const restored = await t.send("POST", "/v1/apps/shop/git/stack/restore", tok, { stack: s.id });
  assert.deepEqual([restored.status, restored.body.change.branch, restored.body.restored], [200, c2.branch, 1]);
  s = await read();
  assert.deepEqual([s.changes.length, s.setAside.length], [2, 0]);

  // Back, then a hand edit pushed onto change 1: that's building on it too; nothing to restore.
  await t.send("POST", "/v1/apps/shop/git/stack/back", tok, { change: c1.change.id });
  const pushed = await t.send("POST", "/v1/apps/shop/git/sync", tok, { branch: c1.branch, baseSha: c1.sha, files: files("1b") });
  assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
  assert.equal((await t.send("POST", "/v1/apps/shop/git/stack/restore", tok, { stack: s.id })).body.error, "nothing_set_aside");
  s = await read();
  assert.deepEqual([s.changes.map((c: { sha: string }) => c.sha), s.setAside], [[pushed.body.sha], []]);
  const c1b = { ...c1, sha: pushed.body.sha };

  // Back again and build on change 1: a new change 2 from it; the old one can't be restored.
  const n2 = await add(c1b.branch, c1b.sha, "Other two", "2b");
  assert.deepEqual(t.gh.commit(n2.sha).parents, [c1b.sha]);
  assert.equal((await t.send("POST", "/v1/apps/shop/git/stack/restore", tok, { stack: s.id })).body.error, "nothing_set_aside");
  s = await read();
  assert.deepEqual([s.changes.map((c: { title: string }) => c.title), s.setAside], [["One", "Other two"], []]);
  assert.equal((await t.send("POST", "/v1/apps/shop/git/stack/back", tok, { change: "chg_nope" })).status, 404);
}));
