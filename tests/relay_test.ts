// Workspace relay (/v1/workspace/relay): pairing, same-account isolation, expiry, rate limits,
// origin checks, token scope/revocation, and directional frame relaying.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { createServer } from "../server/main.ts";
import { loadConfig } from "../server/config.ts";
import { createRelay } from "../server/relay.ts";
import { Store } from "../server/store.ts";

function connectWs(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function connectExpectReject(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    ws.once("open", () => {
      ws.close();
      reject(new Error("expected HTTP rejection, but WebSocket opened"));
    });
    ws.once("error", () => { /* paired with unexpected-response */ });
  });
}

function nextMsg(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMsg = (d: Buffer) => {
      cleanup();
      resolve(JSON.parse(d.toString("utf8")));
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`closed (${code}: ${reason.toString()}) before message`));
    };
    const onErr = (e: Error) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      ws.off("message", onMsg);
      ws.off("close", onClose);
      ws.off("error", onErr);
    };
    ws.on("message", onMsg);
    ws.on("close", onClose);
    ws.on("error", onErr);
  });
}

function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve({ code: 1006, reason: "" });
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
  });
}

test("relay pairs same-account CLI and studio, relays frames, and enforces isolation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-relay-"));
  const srv = await createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80 }));
  const http = serve({ fetch: srv.handler, port: 0 });
  http.on("upgrade", srv.upgrade);
  await new Promise((r) => http.once("listening", r));
  const port = (http.address() as { port: number }).port;
  const wsUrl = `ws://127.0.0.1:${port}/v1/workspace/relay`;
  const hostHeaders = { host: "test.local" };
  const studioHeaders = { host: "test.local", origin: "http://test.local" };

  try {
    const aliceAcct = await srv.store.createAccount("alice@example.com");
    const alice = { account: aliceAcct, token: (await srv.store.issueToken(aliceAcct.id, { name: "alice" })).token };
    const bobAcct = await srv.store.createAccount("bob@example.com");
    const bob = { account: bobAcct, token: (await srv.store.issueToken(bobAcct.id, { name: "bob" })).token };
    const aliceRead = await srv.store.issueToken(alice.account.id, { name: "readonly", role: "read" });
    const app = await srv.store.createApp("demo-app", alice.account.id);
    const aliceScoped = await srv.store.issueToken(alice.account.id, { name: "scoped", role: "admin", apps: [app.app.id] });

    // Cross-origin and preview-origin upgrades are rejected before WebSocket open.
    assert.equal(await connectExpectReject(wsUrl, { host: "test.local", origin: "https://evil.example" }), 403);
    assert.equal(await connectExpectReject(wsUrl, { host: "test.local", origin: "http://preview.test.local" }), 403);
    assert.equal(await connectExpectReject(wsUrl, { host: "preview.test.local" }), 404);
    assert.equal(await connectExpectReject(`ws://127.0.0.1:${port}/v1/other`, hostHeaders), 404);

    // Reject read-only tokens, app-scoped tokens, and deploy keys.
    for (const badToken of [aliceRead.token, aliceScoped.token, app.deployKey, "invalid"]) {
      const ws = await connectWs(wsUrl, hostHeaders);
      const msgP = nextMsg(ws);
      ws.send(JSON.stringify({ v: 1, type: "hello", role: "cli", token: badToken }));
      const err = await msgP;
      assert.equal(err.type, "error");
      assert.equal(err.code, "unauthorized");
      await waitClose(ws);
    }

    // Studio role requires the studio Origin header.
    {
      const ws = await connectWs(wsUrl, hostHeaders);
      const msgP = nextMsg(ws);
      ws.send(JSON.stringify({ v: 1, type: "hello", role: "studio", token: alice.token, code: "BBBB-CCCC" }));
      const err = await msgP;
      assert.equal(err.type, "error");
      assert.equal(err.code, "forbidden");
      await waitClose(ws);
    }

    // CLI starts a pairing session for Alice.
    const cli = await connectWs(wsUrl, hostHeaders);
    const codeP = nextMsg(cli);
    cli.send(JSON.stringify({ v: 1, type: "hello", role: "cli", token: alice.token, agent: "Claude Code\n\x07" }));
    const codeMsg = await codeP;
    assert.equal(codeMsg.type, "code");
    const code = codeMsg.code as string;
    assert.match(code, /^[A-Z]{4}-[A-Z]{4}$/);

    // Bob (different account) cannot pair with Alice's code — gets generic not_found.
    {
      const bobStudio = await connectWs(wsUrl, studioHeaders);
      const msgP = nextMsg(bobStudio);
      bobStudio.send(JSON.stringify({ v: 1, type: "hello", role: "studio", token: bob.token, code, projectName: "bob-app" }));
      const err = await msgP;
      assert.equal(err.type, "error");
      assert.equal(err.code, "not_found");
      await waitClose(bobStudio);
    }

    // Studio opens and closes before deciding: code reverts to pending (CLI stays alive).
    {
      const s1 = await connectWs(wsUrl, studioHeaders);
      const reqP = nextMsg(s1);
      s1.send(JSON.stringify({ v: 1, type: "hello", role: "studio", token: alice.token, code, projectName: "My App" }));
      const req = await reqP;
      assert.equal(req.type, "pair_request");
      assert.equal(req.agent, "Claude Code"); // control chars stripped
      s1.close();
      await waitClose(s1);
      await new Promise((r) => setTimeout(r, 30));
    }

    // The studio's session cookie (sent with the upgrade from the studio's origin) is its credential: no token in the
    // hello. It wins over one (Bob's cookie with Alice's token: Bob's, so not her code).
    {
      const s = await connectWs(wsUrl, { ...studioHeaders, cookie: `other=1; cresslet_session=${alice.token}` });
      const reqP = nextMsg(s);
      s.send(JSON.stringify({ v: 1, type: "hello", role: "studio", code, projectName: "My App" }));
      assert.equal((await reqP).type, "pair_request");
      s.close();
      await waitClose(s);
      await new Promise((r) => setTimeout(r, 30));
      const b = await connectWs(wsUrl, { ...studioHeaders, cookie: `cresslet_session=${bob.token}` });
      const errP = nextMsg(b);
      b.send(JSON.stringify({ v: 1, type: "hello", role: "studio", token: alice.token, code }));
      assert.equal((await errP).code, "not_found");
      await waitClose(b);
    }

    // Alice's studio claims the code and approves.
    const studio = await connectWs(wsUrl, studioHeaders);
    const reqP = nextMsg(studio);
    studio.send(JSON.stringify({ v: 1, type: "hello", role: "studio", token: alice.token, code: code.toLowerCase().replace("-", ""), projectName: "My App" }));
    const req = await reqP;
    assert.equal(req.type, "pair_request");
    assert.equal(req.agent, "Claude Code");

    // A second studio trying to claim the same code while awaiting_approval gets not_found.
    {
      const s2 = await connectWs(wsUrl, studioHeaders);
      const errP = nextMsg(s2);
      s2.send(JSON.stringify({ v: 1, type: "hello", role: "studio", token: alice.token, code, projectName: "Other" }));
      assert.equal((await errP).code, "not_found");
      await waitClose(s2);
    }

    const cliPairedP = nextMsg(cli);
    const studioPairedP = nextMsg(studio);
    studio.send(JSON.stringify({ v: 1, type: "pair_decision", allow: true }));
    assert.deepEqual(await cliPairedP, { v: 1, type: "paired", projectName: "My App" });
    assert.deepEqual(await studioPairedP, { v: 1, type: "paired", agent: "Claude Code" });

    // Reusing the consumed code fails.
    {
      const s3 = await connectWs(wsUrl, studioHeaders);
      const errP = nextMsg(s3);
      s3.send(JSON.stringify({ v: 1, type: "hello", role: "studio", token: alice.token, code, projectName: "Reuse" }));
      assert.equal((await errP).code, "not_found");
      await waitClose(s3);
    }

    // Bidirectional relay: tool_call, tool_cancel, tool_result.
    const callP = nextMsg(studio);
    cli.send(JSON.stringify({ v: 1, type: "tool_call", id: "c1", name: "list_files", arguments: {} }));
    assert.deepEqual(await callP, { v: 1, type: "tool_call", id: "c1", name: "list_files", arguments: {} });

    const cancelP = nextMsg(studio);
    cli.send(JSON.stringify({ v: 1, type: "tool_cancel", id: "c1" }));
    assert.deepEqual(await cancelP, { v: 1, type: "tool_cancel", id: "c1" });

    const resP = nextMsg(cli);
    studio.send(JSON.stringify({ v: 1, type: "tool_result", id: "c1", text: "index.html" }));
    assert.deepEqual(await resP, { v: 1, type: "tool_result", id: "c1", text: "index.html" });

    // Closing studio disconnects CLI.
    const cliClosed = waitClose(cli);
    studio.close();
    await cliClosed;
    assert.deepEqual(srv.relay.stats(), { pending: 0, paired: 0, unauth: 0, presence: 0, agents: 0, bound: 0 });
  } finally {
    http.close();
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("relay enforces code expiry, deny, token revocation on approve, and rate limits", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-relay-exp-"));
  const cfg = loadConfig({ dataDir, domain: "test.local", publicPort: 80 });
  const store = await Store.open(cfg.dataDir, cfg.database);
  let fakeNow = 1_000_000;
  const relay = createRelay(cfg, store, {
    codeTtlMs: 5_000,
    cliStartsPer10Min: 4,
    studioClaimsPer10Min: 2,
    clock: () => fakeNow,
  });
  const http = serve({ fetch: () => new Response("ok"), port: 0 });
  http.on("upgrade", (req, sock, head) => relay.upgrade(req, sock, head));
  await new Promise((r) => http.once("listening", r));
  const port = (http.address() as { port: number }).port;
  const wsUrl = `ws://127.0.0.1:${port}/v1/workspace/relay`;
  const studioHeaders = { host: "test.local", origin: "http://test.local" };

  try {
    const aliceAcct = await store.createAccount("alice@example.com");
    const alice = { account: aliceAcct, token: (await store.issueToken(aliceAcct.id, { name: "alice" })).token };
    const bobAcct = await store.createAccount("bob@example.com");
    const bob = { account: bobAcct, token: (await store.issueToken(bobAcct.id, { name: "bob" })).token };

    // 1. Expired code cannot be claimed.
    const cli1 = await connectWs(wsUrl);
    const code1P = nextMsg(cli1);
    cli1.send(JSON.stringify({ v: 1, type: "hello", role: "cli", token: alice.token, agent: "Codex" }));
    const code1 = (await code1P).code as string;

    fakeNow += 6_000;
    const s1 = await connectWs(wsUrl, studioHeaders);
    const err1P = nextMsg(s1);
    s1.send(JSON.stringify({ v: 1, type: "hello", role: "studio", token: alice.token, code: code1 }));
    assert.equal((await err1P).code, "not_found");
    await waitClose(s1);
    await waitClose(cli1);

    // 2. Explicit Deny notifies CLI and closes both.
    const cli2 = await connectWs(wsUrl);
    const code2P = nextMsg(cli2);
    cli2.send(JSON.stringify({ v: 1, type: "hello", role: "cli", token: alice.token, agent: "Codex" }));
    const code2 = (await code2P).code as string;

    const s2 = await connectWs(wsUrl, studioHeaders);
    const req2P = nextMsg(s2);
    s2.send(JSON.stringify({ v: 1, type: "hello", role: "studio", token: alice.token, code: code2 }));
    assert.equal((await req2P).type, "pair_request");

    const deniedP = nextMsg(cli2);
    s2.send(JSON.stringify({ v: 1, type: "pair_decision", allow: false }));
    assert.equal((await deniedP).type, "denied");
    await Promise.all([waitClose(cli2), waitClose(s2)]);

    // 3. Studio claim rate limit (2 per 10 min for Alice -> 3rd gets rate_limited).
    {
      const s3 = await connectWs(wsUrl, studioHeaders);
      const err3P = nextMsg(s3);
      s3.send(JSON.stringify({ v: 1, type: "hello", role: "studio", token: alice.token, code: "BBBB-CCCC" }));
      assert.equal((await err3P).code, "rate_limited");
      await waitClose(s3);
    }

    // 4. Token revoked between pair_request and pair_decision fails on Allow.
    const bobCliToken = await store.issueToken(bob.account.id, { name: "bob-cli", role: "deploy" });
    const cli3 = await connectWs(wsUrl);
    const code3P = nextMsg(cli3);
    cli3.send(JSON.stringify({ v: 1, type: "hello", role: "cli", token: bobCliToken.token, agent: "T3 Code" }));
    const code3 = (await code3P).code as string;

    const s4 = await connectWs(wsUrl, studioHeaders);
    const req4P = nextMsg(s4);
    s4.send(JSON.stringify({ v: 1, type: "hello", role: "studio", token: bob.token, code: code3 }));
    assert.equal((await req4P).type, "pair_request");

    await store.revokeToken(bob.account.id, bobCliToken.info.id);
    const cliErrP = nextMsg(cli3);
    const studioErrP = nextMsg(s4);
    s4.send(JSON.stringify({ v: 1, type: "pair_decision", allow: true }));
    assert.equal((await cliErrP).code, "unauthorized");
    assert.equal((await studioErrP).code, "unauthorized");
    await Promise.all([waitClose(cli3), waitClose(s4)]);
  } finally {
    relay.close();
    http.close();
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
