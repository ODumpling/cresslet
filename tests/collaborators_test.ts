import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "../server/main.ts";
import { loadConfig } from "../server/config.ts";

const SERVER = `
export default {
  async fetch(req, env) {
    await env.db.exec("CREATE TABLE IF NOT EXISTS c (id INTEGER PRIMARY KEY)");
    await env.db.run("INSERT INTO c DEFAULT VALUES");
    return Response.json(await env.db.first("SELECT count(*) n FROM c"));
  },
};`;

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-collab-"));
  const srv = createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80, adminToken: "adm", siteAdmins: ["boss@b.co", "viewer@b.co"] }));
  const json = async (path: string, init: RequestInit & { host?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", init.host ?? "test.local");
    if (init.body) headers.set("content-type", "application/json");
    const r = await srv.handler(new Request(`http://${init.host ?? "test.local"}${path}`, { ...init, headers }));
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const account = async (email: string) =>
    (await json("/v1/accounts", { method: "POST", headers: bearer("adm"), body: JSON.stringify({ email }) })).body.token as string;
  const send = (method: string, path: string, token: string, input?: unknown) =>
    json(path, { method, headers: bearer(token), body: input === undefined ? undefined : JSON.stringify(input) });
  const deploy = (token: string, app: string) =>
    send("POST", "/v1/deploys", token, { app, files: [{ path: "index.html", data: "hi" }], sources: [{ path: "src/a.js", data: "1" }], server: SERVER, config: { routes: ["/api/*"] } });
  return { dataDir, srv, json, bearer, account, send, deploy };
}

test("collaborators: invite by email, accept, and each role gets what it allows", async () => {
  const t = await setup();
  try {
    const owner = await t.account("own@b.co");
    assert.equal((await t.deploy(owner, "shop")).status, 201);
    assert.equal((await t.deploy(owner, "shop")).status, 201);
    await t.json("/api/n", { host: "shop.test.local" }); // creates the app's database

    // Invite an email with no account yet, and one that has an account.
    const inv = await t.send("POST", "/v1/apps/shop/collaborators", owner, { email: "Viewer@B.co" });
    assert.equal(inv.status, 201);
    assert.equal(inv.body.invite.email, "viewer@b.co");
    assert.equal(inv.body.invite.role, "viewer"); // default
    assert.equal(inv.body.invite.invitedBy.email, "own@b.co");
    const adminTok = await t.account("adm@b.co");
    const first = await t.send("POST", "/v1/apps/shop/collaborators", owner, { email: "adm@b.co", role: "viewer" });
    assert.equal(first.status, 201);
    // Inviting the same email again changes the pending invite's role; a new role is a new invite (id).
    const again = await t.send("POST", "/v1/apps/shop/collaborators", owner, { email: "adm@b.co", role: "admin" });
    assert.equal(again.status, 200);
    assert.equal(again.body.invite.role, "admin");
    assert.notEqual(again.body.invite.id, first.body.invite.id);
    assert.equal((await t.send("POST", `/v1/me/invites/${first.body.invite.id}/accept`, adminTok)).status, 404);
    const same = await t.send("POST", "/v1/apps/shop/collaborators", owner, { email: "adm@b.co", role: "admin" });
    assert.equal(same.body.invite.id, again.body.invite.id);
    assert.equal((await t.send("POST", "/v1/apps/shop/collaborators", owner, { email: "own@b.co" })).status, 400);
    assert.equal((await t.send("POST", "/v1/apps/shop/collaborators", owner, { email: "nope" })).status, 400);
    assert.equal((await t.send("POST", "/v1/apps/shop/collaborators", owner, { email: "x@b.co", role: "owner" })).status, 400);

    // Pending invites give no access.
    assert.equal((await t.send("GET", "/v1/apps/shop", adminTok)).status, 403);
    const list0 = (await t.send("GET", "/v1/apps/shop/collaborators", owner)).body;
    assert.equal(list0.owner.email, "own@b.co");
    assert.deepEqual(list0.collaborators, []);
    assert.deepEqual(list0.invites.map((i: { email: string; role: string }) => [i.email, i.role]), [["viewer@b.co", "viewer"], ["adm@b.co", "admin"]]);

    // The invitee sees and accepts it; someone else can't.
    const viewer = await t.account("viewer@b.co"); // account created after the invite
    const mine = (await t.send("GET", "/v1/me/invites", viewer)).body.invites;
    assert.deepEqual(mine.map((i: { app: string; role: string }) => [i.app, i.role]), [["shop", "viewer"]]);
    const adminInvite = (await t.send("GET", "/v1/me/invites", adminTok)).body.invites[0];
    assert.equal((await t.send("POST", `/v1/me/invites/${adminInvite.id}/accept`, viewer)).status, 404);
    assert.equal((await t.send("POST", `/v1/me/invites/${mine[0].id}/accept`, viewer)).body.app.access, "viewer");
    assert.equal((await t.send("POST", `/v1/me/invites/${mine[0].id}/accept`, viewer)).status, 404); // used up
    // Accepting needs a full-access token.
    const readOnly = (await t.send("POST", "/v1/me/tokens", adminTok, { name: "ro", role: "read" })).body.token;
    assert.equal((await t.send("POST", `/v1/me/invites/${adminInvite.id}/accept`, readOnly)).status, 403);
    assert.equal((await t.send("GET", "/v1/me/invites", readOnly)).body.invites.length, 1);
    assert.equal((await t.send("POST", `/v1/me/invites/${adminInvite.id}/accept`, adminTok)).body.app.access, "admin");
    assert.equal((await t.send("POST", "/v1/apps/shop/collaborators", owner, { email: "adm@b.co" })).status, 409);

    // Shared apps are listed with the caller's access; they don't count toward the invitee's quota.
    assert.deepEqual((await t.send("GET", "/v1/apps", viewer)).body.apps.map((a: { name: string; access: string }) => [a.name, a.access]), [["shop", "viewer"]]);
    assert.equal((await t.send("GET", "/v1/apps", owner)).body.apps[0].access, "owner");
    assert.equal((await t.send("GET", "/v1/apps/shop", viewer)).body.app.access, "viewer");

    // Viewer: read endpoints only.
    for (const p of ["", "/logs", "/source", "/secrets", "/egress", "/domains", "/db"]) {
      assert.equal((await t.send("GET", `/v1/apps/shop${p}`, viewer)).status, 200, p);
    }
    assert.deepEqual((await t.send("POST", "/v1/apps/shop/db/query", viewer, { sql: "SELECT count(*) n FROM c" })).body.rows, [{ n: 1 }]);
    const denied = [
      (await t.deploy(viewer, "shop")),
      (await t.send("POST", "/v1/apps/shop/rollback", viewer, {})),
      (await t.send("PUT", "/v1/apps/shop/secrets", viewer, { K: "v" })),
      (await t.send("PUT", "/v1/apps/shop/egress", viewer, { allow: null })),
      (await t.send("POST", "/v1/apps/shop/domains", viewer, { domain: "shop.example.com" })),
      (await t.send("GET", "/v1/apps/shop/collaborators", viewer)),
      (await t.send("POST", "/v1/apps/shop/collaborators", viewer, { email: "z@b.co" })),
      (await t.send("DELETE", "/v1/apps/shop", viewer)),
    ];
    assert.deepEqual(denied.map((r) => r.status), denied.map(() => 403));
    assert.match(denied[0].body.message, /viewers of shop can't/);

    // Admin: deploy, roll back, secrets, egress, domains, manage collaborators; not delete the app.
    assert.equal((await t.deploy(adminTok, "shop")).status, 201);
    assert.equal((await t.send("POST", "/v1/apps/shop/rollback", adminTok, {})).status, 200);
    assert.equal((await t.send("PUT", "/v1/apps/shop/secrets", adminTok, { K: "v" })).status, 200);
    assert.equal((await t.send("PUT", "/v1/apps/shop/egress", adminTok, { allow: ["api.example.com"] })).status, 200);
    assert.equal((await t.send("POST", "/v1/apps/shop/domains", adminTok, { domain: "shop.example.com" })).status, 201);
    assert.equal((await t.send("GET", "/v1/apps/shop/collaborators", adminTok)).body.collaborators.length, 2);
    const del = await t.send("DELETE", "/v1/apps/shop", adminTok);
    assert.equal(del.status, 403);
    assert.match(del.body.message, /only the owner/);
    // Claiming is unchanged: the app already has an owner.
    assert.equal((await t.send("POST", "/v1/apps/shop/claim", adminTok, {})).status, 409);

    // The calling token still limits what a collaborator can do.
    const adminRead = (await t.send("POST", "/v1/me/tokens", adminTok, { name: "r", role: "read", apps: ["shop"] }));
    assert.equal(adminRead.status, 201, "tokens can be scoped to a shared app");
    assert.equal((await t.send("GET", "/v1/apps/shop", adminRead.body.token)).status, 200);
    assert.equal((await t.deploy(adminRead.body.token, "shop")).status, 403);
    const other = await t.account("other@b.co");
    assert.equal((await t.deploy(other, "else")).status, 201);
    assert.equal((await t.send("POST", "/v1/me/tokens", adminTok, { name: "x", apps: ["else"] })).status, 400);

    // Strangers and deploy keys can't see or change who has access.
    assert.equal((await t.send("GET", "/v1/apps/shop/collaborators", other)).status, 403);
    assert.equal((await t.json("/v1/apps/shop/collaborators")).status, 401);
    const anon = await t.send("POST", "/v1/deploys", "none", { files: [{ path: "index.html", data: "hi" }] });
    const keyed = await t.json(`/v1/apps/${anon.body.app.name}/collaborators`, {
      method: "POST",
      headers: { "x-cresslet-deploy-key": anon.body.deployKey },
      body: JSON.stringify({ email: "z@b.co" }),
    });
    assert.equal(keyed.status, 401);

    // Roles change; removed collaborators lose access; collaborators can leave.
    const viewerId = (await t.send("GET", "/v1/me", viewer)).body.account.id;
    const adminId = (await t.send("GET", "/v1/me", adminTok)).body.account.id;
    assert.equal((await t.send("PUT", `/v1/apps/shop/collaborators/${viewerId}`, owner, { role: "admin" })).status, 200);
    assert.equal((await t.send("PUT", "/v1/apps/shop/secrets", viewer, { K: "w" })).status, 200);
    assert.equal((await t.send("PUT", `/v1/apps/shop/collaborators/${viewerId}`, adminTok, { role: "viewer" })).status, 200);
    assert.equal((await t.send("PUT", "/v1/apps/shop/secrets", viewer, { K: "x" })).status, 403);
    assert.equal((await t.send("PUT", `/v1/apps/shop/collaborators/nope`, owner, { role: "viewer" })).status, 404);
    assert.equal((await t.send("PUT", `/v1/apps/shop/collaborators/${viewerId}`, owner, { role: "owner" })).status, 400);
    const ownerId = (await t.send("GET", "/v1/me", owner)).body.account.id;
    assert.equal((await t.send("DELETE", `/v1/apps/shop/collaborators/${ownerId}`, owner)).status, 400);
    assert.equal((await t.send("DELETE", `/v1/apps/shop/collaborators/${ownerId}`, adminTok)).status, 404);
    // A viewer leaves (with a full-access token; a read token can't).
    const viewerRead = (await t.send("POST", "/v1/me/tokens", viewer, { name: "r", role: "read" })).body.token;
    assert.equal((await t.send("DELETE", `/v1/apps/shop/collaborators/${viewerId}`, viewerRead)).status, 403);
    assert.equal((await t.send("DELETE", `/v1/apps/shop/collaborators/${viewerId}`, viewer)).status, 200);
    assert.equal((await t.send("GET", "/v1/apps/shop", viewer)).status, 403);
    assert.deepEqual((await t.send("GET", "/v1/apps", viewer)).body.apps, []);
    // The owner removes the admin.
    assert.equal((await t.send("DELETE", `/v1/apps/shop/collaborators/${adminId}`, owner)).status, 200);
    assert.equal((await t.deploy(adminTok, "shop")).status, 403);
    assert.equal((await t.send("DELETE", `/v1/apps/shop/collaborators/${adminId}`, owner)).status, 404);
  } finally {
    t.srv.close();
    await rm(t.dataDir, { recursive: true, force: true });
  }
});

test("invites: decline, cancel, cap, hidden while the app is deleted, gone with the app", async () => {
  const t = await setup();
  try {
    const owner = await t.account("own@b.co");
    const bob = await t.account("bob@b.co");
    assert.equal((await t.deploy(owner, "shop")).status, 201);

    // Decline.
    await t.send("POST", "/v1/apps/shop/collaborators", owner, { email: "bob@b.co" });
    const [inv] = (await t.send("GET", "/v1/me/invites", bob)).body.invites;
    assert.equal(inv.invitedBy.email, "own@b.co");
    assert.equal((await t.send("DELETE", `/v1/me/invites/${inv.id}`, bob)).status, 200);
    assert.deepEqual((await t.send("GET", "/v1/me/invites", bob)).body.invites, []);
    assert.equal((await t.send("GET", "/v1/apps/shop/collaborators", owner)).body.invites.length, 0);

    // Cancel (only on its own app).
    const again = (await t.send("POST", "/v1/apps/shop/collaborators", owner, { email: "bob@b.co" })).body.invite;
    assert.equal((await t.deploy(bob, "bobs")).status, 201);
    assert.equal((await t.send("DELETE", `/v1/apps/bobs/invites/${again.id}`, bob)).status, 404);
    assert.equal((await t.send("DELETE", `/v1/apps/shop/invites/${again.id}`, owner)).status, 200);
    assert.deepEqual((await t.send("GET", "/v1/me/invites", bob)).body.invites, []);

    // At most 50 collaborators and invites per app.
    for (let i = 0; i < 50; i++) {
      assert.equal((await t.send("POST", "/v1/apps/shop/collaborators", owner, { email: `u${i}@b.co` })).status, 201);
    }
    assert.equal((await t.send("POST", "/v1/apps/shop/collaborators", owner, { email: "u50@b.co" })).status, 400);
    assert.equal((await t.send("POST", "/v1/apps/shop/collaborators", owner, { email: "u3@b.co", role: "admin" })).status, 200);
    const first = (await t.send("GET", "/v1/apps/shop/collaborators", owner)).body.invites[0];
    await t.send("DELETE", `/v1/apps/shop/invites/${first.id}`, owner);

    // While a site admin has the app deleted, its invites can't be seen or accepted.
    await t.send("POST", "/v1/apps/shop/collaborators", owner, { email: "bob@b.co", role: "admin" });
    const [pending] = (await t.send("GET", "/v1/me/invites", bob)).body.invites;
    assert.equal((await t.send("DELETE", "/v1/admin/sites/shop", "adm")).status, 200);
    assert.deepEqual((await t.send("GET", "/v1/me/invites", bob)).body.invites, []);
    assert.equal((await t.send("POST", `/v1/me/invites/${pending.id}/accept`, bob)).status, 404);
    assert.equal((await t.send("POST", "/v1/admin/sites/shop/restore", "adm")).status, 200);
    assert.equal((await t.send("POST", `/v1/me/invites/${pending.id}/accept`, bob)).body.app.access, "admin");

    // Deleting the app (owner only) removes its collaborators and invites.
    assert.equal((await t.send("DELETE", "/v1/apps/shop", bob)).status, 403);
    assert.equal((await t.send("DELETE", "/v1/apps/shop", owner)).status, 200);
    const db = new DatabaseSync(join(t.dataDir, "cresslet.db"), { readOnly: true });
    try {
      assert.equal((db.prepare("SELECT count(*) n FROM collaborators").get() as { n: number }).n, 0);
      assert.equal((db.prepare("SELECT count(*) n FROM invites").get() as { n: number }).n, 0);
    } finally {
      db.close();
    }
  } finally {
    t.srv.close();
    await rm(t.dataDir, { recursive: true, force: true });
  }
});

test("site admin view: an invited admin sees the app's database tables, a viewer doesn't", async () => {
  const t = await setup();
  try {
    const owner = await t.account("own@b.co");
    const boss = await t.account("boss@b.co"); // site admin, invited as admin
    const viewer = await t.account("viewer@b.co"); // site admin, invited as viewer
    assert.equal((await t.deploy(owner, "shop")).status, 201);
    await t.json("/api/n", { host: "shop.test.local" });
    const site = (tok: string) => t.send("GET", "/v1/admin/sites/shop", tok);
    assert.equal((await site(boss)).body.database, null);
    for (const [email, role, tok] of [["boss@b.co", "admin", boss], ["viewer@b.co", "viewer", viewer]]) {
      await t.send("POST", "/v1/apps/shop/collaborators", owner, { email, role });
      const [inv] = (await t.send("GET", "/v1/me/invites", tok)).body.invites;
      assert.equal((await t.send("POST", `/v1/me/invites/${inv.id}/accept`, tok)).status, 200);
    }
    assert.deepEqual((await site(boss)).body.database.tables, [{ name: "c", rows: 1 }]);
    assert.equal((await site(viewer)).body.database, null);
    assert.equal((await site("adm")).body.database, null);
  } finally {
    t.srv.close();
    await rm(t.dataDir, { recursive: true, force: true });
  }
});

test("revoked mid-request: no re-promotion while the body was in flight; follow logs stop at removal", async () => {
  const t = await setup();
  try {
    const owner = await t.account("own@b.co");
    const adm = await t.account("adm@b.co");
    assert.equal((await t.deploy(owner, "shop")).status, 201);
    for (const [email, role] of [["adm@b.co", "admin"], ["v@b.co", "viewer"]]) {
      await t.send("POST", "/v1/apps/shop/collaborators", owner, { email, role });
    }
    const v = await t.account("v@b.co");
    for (const tok of [adm, v]) {
      const [inv] = (await t.send("GET", "/v1/me/invites", tok)).body.invites;
      await t.send("POST", `/v1/me/invites/${inv.id}/accept`, tok);
    }
    const admId = (await t.send("GET", "/v1/me", adm)).body.account.id;
    const vId = (await t.send("GET", "/v1/me", v)).body.account.id;

    // The admin sends "make me admin" slowly; the owner demotes them to viewer meanwhile.
    const slow = (path: string, method: string, json: string) => {
      let reading!: () => void, send!: () => void;
      const started = new Promise<void>((r) => (reading = r)), go = new Promise<void>((r) => (send = r));
      const res = t.srv.handler(new Request(`http://test.local${path}`, {
        method,
        headers: { host: "test.local", "content-type": "application/json", ...t.bearer(adm) },
        body: new ReadableStream({
          async pull(ctrl) {
            reading();
            await go;
            ctrl.enqueue(new TextEncoder().encode(json));
            ctrl.close();
          },
        }, { highWaterMark: 0 }),
        duplex: "half",
      } as RequestInit));
      return { started, send, res };
    };
    const promote = slow(`/v1/apps/shop/collaborators/${admId}`, "PUT", '{"role":"admin"}');
    const invite = slow("/v1/apps/shop/collaborators", "POST", '{"email":"alt@b.co","role":"admin"}');
    const secret = slow("/v1/apps/shop/secrets", "PUT", '{"SNEAKY":"1"}');
    await Promise.all([promote.started, invite.started, secret.started]);
    assert.equal((await t.send("PUT", `/v1/apps/shop/collaborators/${admId}`, owner, { role: "viewer" })).status, 200);
    promote.send();
    invite.send();
    secret.send();
    assert.equal((await promote.res).status, 403);
    assert.equal((await invite.res).status, 403);
    assert.equal((await secret.res).status, 403);
    assert.deepEqual((await t.send("GET", "/v1/apps/shop/secrets", owner)).body.keys, []);
    const list = (await t.send("GET", "/v1/apps/shop/collaborators", owner)).body;
    assert.equal(list.collaborators.find((x: { id: string }) => x.id === admId).role, "viewer");
    assert.deepEqual(list.invites, []);

    // A viewer's open log stream ends when they're removed; the owner's keeps going.
    const follow = async (tok: string) => {
      const r = await t.srv.handler(new Request("http://test.local/v1/apps/shop/logs?follow=1", { headers: { host: "test.local", ...t.bearer(tok) } }));
      assert.equal(r.status, 200);
      return r.body!.getReader();
    };
    const viewerLogs = await follow(v), ownerLogs = await follow(owner);
    const dec = new TextDecoder();
    const until = async (r: ReadableStreamDefaultReader<Uint8Array>, re: RegExp) => {
      for (let seen = ""; !re.test(seen);) {
        const { value, done } = await r.read();
        assert.ok(!done, `stream ended before ${re}`);
        seen += dec.decode(value);
      }
    };
    t.srv.runtime.logs.push((await t.send("GET", "/v1/apps/shop", owner)).body.app.id, "system", "before");
    await until(viewerLogs, /before/);
    await until(ownerLogs, /before/);
    assert.equal((await t.send("DELETE", `/v1/apps/shop/collaborators/${vId}`, owner)).status, 200);
    t.srv.runtime.logs.push((await t.send("GET", "/v1/apps/shop", owner)).body.app.id, "system", "after");
    assert.deepEqual(await viewerLogs.read(), { done: true, value: undefined });
    await until(ownerLogs, /after/);
    await ownerLogs.cancel();

    // On a quiet app too: the stream closes within 15s of losing access, without another log line.
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      assert.equal((await t.send("PUT", `/v1/apps/shop/collaborators/${admId}`, owner, { role: "viewer" })).status, 200);
      const quiet = await follow(adm);
      await until(quiet, /after/);
      assert.equal((await t.send("DELETE", `/v1/apps/shop/collaborators/${admId}`, owner)).status, 200);
      mock.timers.tick(15_000);
      assert.deepEqual(await quiet.read(), { done: true, value: undefined });
    } finally {
      mock.timers.reset();
    }
  } finally {
    t.srv.close();
    await rm(t.dataDir, { recursive: true, force: true });
  }
});
