// Live Link v2 (server/relay.ts, #153): browser presence, remembered agents (Remember this agent), binding and routing,
// reconnects without a code, per-project approval, switches, one agent per project, Disconnect/Resume, Forget,
// expiry and the relay's rate limits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { loadConfig } from "../server/config.ts";
import { createRelay, type RelayOptions } from "../server/relay.ts";
import { Store } from "../server/store.ts";

type Msg = Record<string, unknown>;

/** A socket that keeps every frame, so a test can wait for one of a given type. */
class Peer {
  ws: WebSocket;
  buf: Msg[] = [];
  closed: { code: number; reason: string } | null = null;
  private wake: (() => void)[] = [];
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (d) => {
      this.buf.push(JSON.parse(d.toString("utf8")));
      for (const w of this.wake.splice(0)) w();
    });
    ws.on("close", (code, reason) => {
      this.closed = { code, reason: reason.toString("utf8") };
      for (const w of this.wake.splice(0)) w();
    });
  }
  send(m: Msg) {
    this.ws.send(JSON.stringify({ v: 1, ...m }));
  }
  /** The next frame matching (removed from the buffer); rejects on close or after `ms`. */
  async next(type: string | ((m: Msg) => boolean), ms = 3000): Promise<Msg> {
    const match = typeof type === "string" ? (m: Msg) => m.type === type : type;
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.buf.findIndex(match);
      if (i >= 0) return this.buf.splice(i, 1)[0]!;
      if (this.closed) throw new Error(`closed (${this.closed.code} ${this.closed.reason}) waiting for ${String(type)}; got ${JSON.stringify(this.buf)}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${String(type)}; got ${JSON.stringify(this.buf)}`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.wake.push(() => (clearTimeout(t), r()));
      });
    }
  }
  /** No frame matching arrives within `ms`. */
  async none(type: string, ms = 150) {
    await new Promise((r) => setTimeout(r, ms));
    assert.equal(this.buf.find((m) => m.type === type), undefined, `unexpected ${type}: ${JSON.stringify(this.buf)}`);
  }
  latestState(): Msg | undefined {
    const states = this.buf.filter((m) => m.type === "state");
    return states.at(-1);
  }
  async state(pred: (m: Msg) => boolean, ms = 3000): Promise<Msg> {
    const deadline = Date.now() + ms;
    for (;;) {
      const s = this.latestState();
      if (s && pred(s)) return s;
      if (Date.now() > deadline) throw new Error(`state never matched; last ${JSON.stringify(s)}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  async waitClose() {
    while (!this.closed) await new Promise((r) => setTimeout(r, 10));
    return this.closed;
  }
  close() {
    this.ws.close();
  }
}

const secret = () => randomBytes(32).toString("base64url");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function setup(opts: RelayOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-livelink-"));
  const cfg = loadConfig({ dataDir, domain: "test.local", publicPort: 80 });
  const store = await Store.open(cfg.dataDir, cfg.database);
  let relay = createRelay(cfg, store, opts);
  const http = serve({ fetch: () => new Response("ok"), port: 0 });
  http.on("upgrade", (req, sock, head) => relay.upgrade(req, sock, head));
  await new Promise((r) => http.once("listening", r));
  const port = (http.address() as { port: number }).port;
  const url = `ws://127.0.0.1:${port}/v1/workspace/relay`;
  const open = (headers: Record<string, string> = {}) => new Promise<Peer>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const p = new Peer(ws);
    ws.once("open", () => resolve(p));
    ws.once("error", reject);
  });
  const studioHeaders = { origin: "http://test.local" };
  const acct = await store.createAccount("alice@example.com");
  const cli = await store.issueToken(acct.id, { name: "cli" });
  const session = await store.issueToken(acct.id, { name: "studio session" });
  const install = { id: "inst" + randomBytes(4).toString("hex"), secret: secret() };

  /** The owning tab of `projectId`. */
  async function presence(projectId: string, extra: Msg = {}, inst = install, token = session.token) {
    const p = await open(studioHeaders);
    p.send({ type: "hello", role: "presence", token, install: inst, projectId, projectName: `Project ${projectId}`, ...extra });
    return p;
  }
  /** Enrols an agent with code + Allow + Remember on `projectId` (its tab: `tab`). */
  async function enrol(projectId: string, label = "Claude Code", instanceId = "i" + randomBytes(4).toString("hex"), token = cli.token) {
    const agentSecret = secret();
    const c = await open();
    c.send({ type: "hello", role: "cli", token, agent: label, enroll: { secretHash: sha(agentSecret), instanceId } });
    const { code } = await c.next("code");
    const s = await open(studioHeaders);
    s.send({ type: "hello", role: "studio", token: session.token, code, projectName: `Project ${projectId}`, projectId, install });
    const req = await s.next("pair_request");
    assert.equal(req.canRemember, true);
    s.send({ type: "pair_decision", allow: true, remember: true });
    const enrolled = await c.next("enrolled");
    assert.equal(enrolled.handle, `${install.id}:${projectId}`);
    assert.equal((await s.next("enrolled")).credentialId, enrolled.credentialId);
    await Promise.all([c.waitClose(), s.waitClose()]);
    return { id: enrolled.credentialId as string, secret: agentSecret, handle: enrolled.handle as string, instanceId, label };
  }
  /** A remembered agent's socket. */
  async function agent(creds: { id: string; secret: string }[], instanceId: string, extra: Msg = {}, token = cli.token, label = "Claude Code") {
    const a = await open();
    a.send({ type: "hello", role: "agent", token, agent: label, instanceId, credentials: creds.map(({ id, secret }) => ({ id, secret })), ...extra });
    return a;
  }
  /** A tab that runs every tool call it gets, answering `ran <name>`. */
  function autoRun(p: Peer, log: string[] = []) {
    p.ws.on("message", (d) => {
      const m = JSON.parse(d.toString("utf8")) as Msg;
      if (m.type === "tool_call") {
        log.push(m.name as string);
        p.send({ type: "tool_result", id: m.id, text: `ran ${m.name}` });
      }
    });
    return log;
  }
  return {
    cfg, store, acct, cli, session, install, presence, enrol, agent, autoRun, open, studioHeaders,
    get relay() {
      return relay;
    },
    /** A server restart: a new relay (memory gone), same database. */
    restart(o: RelayOptions = opts) {
      relay.close();
      relay = createRelay(cfg, store, o);
    },
    async done() {
      relay.close();
      http.close();
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test("presence: tracked per open project, replaced by a newer socket, refused without the install secret, closed on logout", async () => {
  const t = await setup();
  try {
    const p1 = await t.presence("aaaa1111");
    assert.equal((await p1.next("presence_ok")).handle, `${t.install.id}:aaaa1111`);
    assert.equal(t.relay.stats().presence, 1);
    assert.deepEqual(t.relay.presence(t.acct.id).map((p) => p.projectName), ["Project aaaa1111"]);

    // The same project again (a reload): the newer socket replaces the stale one.
    const p2 = await t.presence("aaaa1111");
    await p2.next("presence_ok");
    assert.equal((await p1.waitClose()).code, 4009);
    assert.equal(t.relay.stats().presence, 1);

    // A wrong secret for this installation, or none, is refused.
    const bad = await t.presence("aaaa1111", {}, { id: t.install.id, secret: secret() });
    assert.equal((await bad.next("error")).code, "unauthorized");
    const none = await t.open(t.studioHeaders);
    none.send({ type: "hello", role: "presence", token: t.session.token, projectId: "x1" });
    assert.equal((await none.next("error")).code, "bad_frame");
    // Not from the studio's origin: refused.
    const elsewhere = await t.open();
    elsewhere.send({ type: "hello", role: "presence", token: t.session.token, install: t.install, projectId: "x1" });
    assert.equal((await elsewhere.next("error")).code, "forbidden");

    // Closing the tab: gone.
    p2.close();
    await p2.waitClose();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(t.relay.stats().presence, 0);

    // Studio logout (its session token revoked): presence closes at once.
    const p3 = await t.presence("bbbb2222");
    await p3.next("presence_ok");
    await t.store.revokeToken(t.acct.id, t.session.info.id);
    assert.equal((await p3.next("error")).code, "unauthorized");
    await p3.waitClose();
  } finally {
    await t.done();
  }
});

test("two tabs registering one installation together end up with one identity", async () => {
  const t = await setup();
  try {
    const [a, b] = await Promise.all([t.presence("p1"), t.presence("p2")]);
    await Promise.all([a.next("presence_ok"), b.next("presence_ok")]);
    const rows = await t.store.db.all("SELECT * FROM browser_installs");
    assert.equal(rows.length, 1);
  } finally {
    await t.done();
  }
});

test("Remember this agent: a new process reaches the project with token + secret, no code; unchecked behaves as today", async () => {
  const t = await setup();
  try {
    const tab = await t.presence("proj0001");
    await tab.next("presence_ok");
    const ran = t.autoRun(tab);
    const cred = await t.enrol("proj0001");

    // A fresh process (harness restart): token + credential, asks for its pin.
    const a = await t.agent([cred], "fresh-1", { bind: cred.handle });
    const ready = await a.next("ready");
    assert.deepEqual(ready.credentials, [cred.id]);
    assert.deepEqual((ready.projects as Msg[]).map((p) => p.name), ["Project proj0001"]);
    const bound = await a.next("bound");
    assert.equal(bound.projectName, "Project proj0001");
    a.send({ type: "tool_call", id: "c1", name: "read_file", arguments: { path: "x" }, handle: cred.handle, epoch: bound.epoch });
    assert.equal((await a.next("tool_result")).text, "ran read_file");
    assert.deepEqual(ran, ["read_file"]);
    assert.equal((await tab.state((s) => !!s.binding)).binding && true, true);

    // A leaked account token without the secret can't bind; nor the secret with another login's token.
    const leaked = await t.agent([{ id: cred.id, secret: secret() }], "x");
    assert.equal((await leaked.next("error")).code, "unauthorized_agent");
    const other = await t.store.issueToken(t.acct.id, { name: "other cli" });
    const wrongLogin = await t.agent([cred], "y", {}, other.token);
    assert.equal((await wrongLogin.next("error")).code, "unauthorized_agent");
    const noCreds = await t.open();
    noCreds.send({ type: "hello", role: "agent", token: t.cli.token, instanceId: "z", credentials: [] });
    assert.equal((await noCreds.next("error")).code, "bad_frame");

    // Remember unchecked: paired as today, no credential.
    const c = await t.open();
    c.send({ type: "hello", role: "cli", token: t.cli.token, agent: "Codex", enroll: { secretHash: sha(secret()), instanceId: "q" } });
    const { code } = await c.next("code");
    const s = await t.open(t.studioHeaders);
    s.send({ type: "hello", role: "studio", token: t.session.token, code, projectName: "P2", projectId: "proj0002", install: t.install });
    await s.next("pair_request");
    s.send({ type: "pair_decision", allow: true });
    assert.equal((await c.next("paired")).projectName, "P2");
    assert.equal((await t.store.agentCredentials(t.acct.id)).length, 1);
  } finally {
    await t.done();
  }
});

test("reconnects: tab reload and server restart need no code; dispatched calls are never replayed; epoch fences calls queued before a Disconnect", async () => {
  const t = await setup();
  try {
    let tab = await t.presence("proj0001");
    await tab.next("presence_ok");
    const cred = await t.enrol("proj0001");
    let a = await t.agent([cred], "inst-1", { bind: cred.handle });
    let bound = await a.next("bound");

    // A call in flight when the tab reloads: reported "outcome unknown", not replayed to the new tab.
    a.send({ type: "tool_call", id: "w1", name: "write_file", arguments: {}, handle: cred.handle, epoch: bound.epoch });
    assert.equal((await tab.next("tool_call")).id, "w1");
    tab.close();
    const unknown = await a.next("tool_result");
    assert.equal(unknown.id, "w1");
    assert.equal(unknown.code, "outcome_unknown");
    assert.equal((await a.next("unbound")).reason, "not_open");
    tab = await t.presence("proj0001");
    await tab.next("presence_ok");
    bound = await a.next("bound"); // pinned: bound again when its tab is back
    await tab.none("tool_call");
    const ran = t.autoRun(tab);
    a.send({ type: "tool_call", id: "r1", name: "read_file", arguments: {}, handle: cred.handle, epoch: bound.epoch });
    assert.equal((await a.next("tool_result")).text, "ran read_file");
    assert.deepEqual(ran, ["read_file"]);

    // Server restart: both sides reconnect, no code.
    t.restart();
    await Promise.all([a.waitClose(), tab.waitClose()]);
    tab = await t.presence("proj0001");
    await tab.next("presence_ok");
    t.autoRun(tab);
    a = await t.agent([cred], "inst-1", { bind: cred.handle });
    bound = await a.next("bound");
    a.send({ type: "tool_call", id: "r2", name: "list_files", arguments: {}, handle: cred.handle, epoch: bound.epoch });
    assert.equal((await a.next("tool_result")).text, "ran list_files");

    // The same process reconnecting replaces its own stale socket.
    const a2 = await t.agent([cred], "inst-1", { bind: cred.handle });
    assert.equal((await a.waitClose()).code, 4009);
    const bound2 = await a2.next("bound");
    assert.equal(bound2.epoch, bound.epoch);

    // Disconnect (pause) bumps the epoch: a call made before it isn't run after Resume.
    tab.buf = [];
    tab.send({ type: "pause" });
    await tab.next("paused");
    assert.equal((await a2.next("unbound")).reason, "paused");
    tab.send({ type: "resume" });
    await tab.next("resumed");
    const rebound = await a2.next("bound");
    assert.ok((rebound.epoch as number) > (bound2.epoch as number));
    a2.send({ type: "tool_call", id: "old", name: "write_file", arguments: {}, handle: cred.handle, epoch: bound2.epoch });
    const stale = await a2.next("tool_result");
    assert.equal(stale.code, "stale_epoch");
    await tab.none("tool_call");
  } finally {
    await t.done();
  }
});

test("several projects: list, pick one, writes land only there; a closed pinned tab never redirects", async () => {
  const t = await setup();
  try {
    const tab1 = await t.presence("proj0001");
    const tab2 = await t.presence("proj0002");
    await Promise.all([tab1.next("presence_ok"), tab2.next("presence_ok")]);
    const log1 = t.autoRun(tab1), log2 = t.autoRun(tab2);
    const cred = await t.enrol("proj0001");
    // Approve the second project from its tab (no code).
    tab2.send({ type: "grant", credentialId: cred.id });
    await tab2.next("granted");
    // A third open project without a grant isn't listed.
    const tab3 = await t.presence("proj0003");
    await tab3.next("presence_ok");

    const a = await t.agent([cred], "inst-1");
    const ready = await a.next("ready");
    assert.deepEqual((ready.projects as Msg[]).map((p) => p.name).sort(), ["Project proj0001", "Project proj0002"]);
    const h2 = `${t.install.id}:proj0002`;
    a.send({ type: "bind", handle: h2 });
    const bound = await a.next("bound");
    assert.equal(bound.handle, h2);
    a.send({ type: "tool_call", id: "w", name: "write_file", arguments: {}, handle: h2, epoch: bound.epoch });
    await a.next("tool_result");
    assert.deepEqual([log1, log2], [[], ["write_file"]]);

    // An ungranted project can't be bound.
    a.send({ type: "bind", handle: `${t.install.id}:proj0001x` });
    // (bound elsewhere: that's a switch request, refused for no grant)
    assert.equal((await a.next("bind_error")).code, "no_grant");

    // The pinned tab closes: calls fail, never sent to the other project.
    tab2.close();
    assert.equal((await a.next("unbound")).reason, "not_open");
    a.send({ type: "tool_call", id: "w2", name: "write_file", arguments: {}, handle: h2, epoch: bound.epoch });
    assert.equal((await a.next("tool_result")).code, "not_bound");
    a.send({ type: "bind", handle: h2 });
    const err = await a.next("bind_error");
    assert.equal(err.code, "not_open");
    assert.match(err.message as string, /isn't open in Cresslet Studio/);
    assert.match(err.url as string, /\/p\/proj0002$/);
    assert.deepEqual(log1, []);
  } finally {
    await t.done();
  }
});

test("approval from Studio only: the CLI can't create a grant", async () => {
  const t = await setup();
  try {
    const tab1 = await t.presence("proj0001");
    await tab1.next("presence_ok");
    const cred = await t.enrol("proj0001");
    const a = await t.agent([cred], "inst-1");
    await a.next("ready");
    a.send({ type: "grant", credentialId: cred.id, handle: `${t.install.id}:proj0009` });
    assert.equal((await a.next("error")).code, "bad_frame");
    assert.deepEqual((await t.store.agentGrants(cred.id)).map((g) => g.project_handle), [cred.handle]);
    // Another browser installation's tab can't grant this browser's agent.
    const otherInstall = { id: "other" + randomBytes(3).toString("hex"), secret: secret() };
    const foreign = await t.presence("proj0005", {}, otherInstall);
    await foreign.next("presence_ok");
    foreign.send({ type: "grant", credentialId: cred.id });
    assert.equal((await foreign.next("error")).code, "not_found");
  } finally {
    await t.done();
  }
});

test("switching projects needs a click in the target tab; ignored requests expire; no call crosses the switch", async () => {
  let fakeNow = Date.now();
  const t = await setup({ clock: () => fakeNow, pingMs: 50 });
  try {
    const tab1 = await t.presence("proj0001");
    const tab2 = await t.presence("proj0002");
    await Promise.all([tab1.next("presence_ok"), tab2.next("presence_ok")]);
    const log2 = t.autoRun(tab2);
    const cred = await t.enrol("proj0001");
    tab2.send({ type: "grant", credentialId: cred.id });
    await tab2.next("granted");
    const h1 = cred.handle, h2 = `${t.install.id}:proj0002`;
    const a = await t.agent([cred], "inst-1", { bind: h1 });
    const b1 = await a.next("bound");

    // Asking to switch: the agent keeps its pin until the user clicks.
    a.send({ type: "bind", handle: h2 });
    assert.equal((await a.next("switch_pending")).projectName, "Project proj0002");
    const st = await tab2.state((s) => (s.switches as Msg[]).length === 1);
    a.send({ type: "tool_call", id: "k1", name: "read_file", arguments: {}, handle: h1, epoch: b1.epoch });
    const c1 = await tab1.next("tool_call");
    assert.equal(c1.id, "k1");

    // Accepted while k1 runs: new calls get "switching"; the switch waits for k1 to settle.
    tab2.send({ type: "switch_accept", id: (st.switches as Msg[])[0]!.id });
    await new Promise((r) => setTimeout(r, 50));
    a.send({ type: "tool_call", id: "k2", name: "write_file", arguments: {}, handle: h1, epoch: b1.epoch });
    assert.equal((await a.next((m) => m.type === "tool_result" && m.id === "k2")).code, "switching");
    tab1.send({ type: "tool_result", id: "k1", text: "done k1" });
    assert.equal((await a.next((m) => m.type === "tool_result" && m.id === "k1")).text, "done k1");
    assert.equal((await a.next("unbound")).reason, "switched");
    const b2 = await a.next("bound");
    assert.equal(b2.handle, h2);
    assert.equal(b2.switched, true);
    // A call made under the old binding never lands in the new project.
    a.send({ type: "tool_call", id: "k3", name: "write_file", arguments: {}, handle: h1, epoch: b1.epoch });
    assert.equal((await a.next("tool_result")).code, "stale_binding");
    assert.deepEqual(log2, []);

    // An ignored request expires (5 min) and the agent carries on.
    a.send({ type: "bind", handle: h1 });
    await a.next("switch_pending");
    fakeNow += 5 * 60_000 + 1000;
    assert.equal((await a.next("switch_expired")).reason, "expired");
    a.send({ type: "tool_call", id: "k4", name: "read_file", arguments: {}, handle: h2, epoch: b2.epoch });
    assert.equal((await a.next("tool_result")).text, "ran read_file");

    // Withdrawn with use_project(<current>).
    a.send({ type: "bind", handle: h1 });
    await a.next("switch_pending");
    await tab1.state((s) => (s.switches as Msg[]).length === 1);
    a.send({ type: "bind", handle: h2 });
    await a.next("bound");
    await tab1.state((s) => (s.switches as Msg[]).length === 0);
  } finally {
    await t.done();
  }
});

test("one agent per project: another process is refused, Take over moves control; a busy tab refuses binds", async () => {
  const t = await setup();
  try {
    const tab = await t.presence("proj0001");
    await tab.next("presence_ok");
    t.autoRun(tab);
    const c1 = await t.enrol("proj0001", "Claude Code");
    const c2 = await t.enrol("proj0001", "Codex");
    const a1 = await t.agent([c1], "p1", { bind: c1.handle });
    const b1 = await a1.next("bound");
    const a2 = await t.agent([c2], "p2", { bind: c2.handle }, t.cli.token, "Codex");
    const refused = await a2.next("bind_error");
    assert.equal(refused.code, "in_use");
    assert.match(refused.message as string, /in use by Claude Code/);
    const st = await tab.state((s) => (s.waiting as Msg[]).length === 1);
    assert.equal((st.waiting as Msg[])[0]!.agent, "Codex");

    tab.send({ type: "take_over", instanceId: "p2" });
    assert.equal((await a1.next("unbound")).reason, "taken_over");
    const b2 = await a2.next("bound");
    a1.send({ type: "tool_call", id: "x", name: "write_file", arguments: {}, handle: c1.handle, epoch: b1.epoch });
    assert.equal((await a1.next("tool_result")).code, "not_bound");
    a2.send({ type: "tool_call", id: "y", name: "read_file", arguments: {}, handle: c2.handle, epoch: b2.epoch });
    assert.equal((await a2.next("tool_result")).text, "ran read_file");

    // One call at a time: a second one while the first runs is "busy".
    const slow = await t.presence("proj0001"); // replaces tab (a reload); a2 rebinds
    await slow.next("presence_ok");
    const b3 = await a2.next("bound");
    a2.send({ type: "tool_call", id: "s1", name: "run_command", arguments: {}, handle: c2.handle, epoch: b3.epoch });
    await slow.next("tool_call");
    a2.send({ type: "tool_call", id: "s2", name: "read_file", arguments: {}, handle: c2.handle, epoch: b3.epoch });
    assert.equal((await a2.next((m) => m.id === "s2")).code, "busy");

    // The built-in builder running (occupied): binds refused.
    slow.send({ type: "pause" });
    await slow.next("paused");
    slow.send({ type: "occupied", by: "Claude (built-in)" });
    slow.send({ type: "resume" });
    await slow.next("resumed");
    a2.send({ type: "bind", handle: c2.handle });
    const busy = await a2.next("bind_error");
    assert.equal(busy.code, "in_use");
    assert.match(busy.message as string, /built-in/);
  } finally {
    await t.done();
  }
});

test("Disconnect pauses until Resume, across reloads (the tab's record or the server's)", async () => {
  const t = await setup();
  try {
    let tab = await t.presence("proj0001");
    await tab.next("presence_ok");
    const cred = await t.enrol("proj0001");
    const a = await t.agent([cred], "i1", { bind: cred.handle });
    await a.next("bound");
    tab.send({ type: "pause" });
    await tab.next("paused");
    assert.equal((await a.next("unbound")).reason, "paused");

    // Reload: still paused (server record), binds refused.
    tab.close();
    await tab.waitClose();
    tab = await t.presence("proj0001");
    assert.equal((await tab.next("presence_ok")).paused, true);
    a.send({ type: "bind", handle: cred.handle });
    assert.equal((await a.next("bind_error")).code, "paused");

    // Resume: auto-connect restored.
    tab.send({ type: "resume" });
    await tab.next("resumed");
    await a.next("bound");

    // A reload mid-write (the tab recorded the pause, the server never heard): the tab's record counts.
    tab.close();
    await tab.waitClose();
    await a.next("unbound");
    tab = await t.presence("proj0001", { paused: true });
    assert.equal((await tab.next("presence_ok")).paused, true);
    assert.equal(await t.store.agentPaused(t.acct.id, cred.handle), true);
    await a.none("bound");
  } finally {
    await t.done();
  }
});

test("Forget cuts a live session within one call; revoking the CLI token revokes its agents; 90 days unused expires", async () => {
  let fakeNow = Date.now();
  const t = await setup({ clock: () => fakeNow, tokenCheckMs: 50 });
  try {
    const tab = await t.presence("proj0001");
    await tab.next("presence_ok");
    t.autoRun(tab);
    const cred = await t.enrol("proj0001");
    const a = await t.agent([cred], "i1", { bind: cred.handle });
    const b = await a.next("bound");
    tab.send({ type: "forget", credentialId: cred.id });
    assert.equal((await tab.next("forgotten")).ok, true);
    assert.equal((await a.next("error")).code, "unauthorized_agent");
    await a.waitClose();
    const again = await t.agent([cred], "i1");
    assert.equal((await again.next("error")).code, "unauthorized_agent");
    void b;

    // Token revocation (Settings → Tokens) revokes the agents enrolled with it.
    const cli2 = await t.store.issueToken(t.acct.id, { name: "cli2" });
    const cred2 = await t.enrol("proj0001", "Codex", "i2", cli2.token);
    const a2 = await t.agent([cred2], "i2", { bind: cred2.handle }, cli2.token);
    await a2.next("bound");
    await t.store.revokeToken(t.acct.id, cli2.info.id);
    assert.match((await a2.next("error")).code as string, /^unauthorized/);
    assert.equal(await t.store.agentCredentialLive(cred2.id), false);

    // Unused for 90 days: a code again.
    const cred3 = await t.enrol("proj0001", "T3 Code", "i3");
    const later = Date.now() + 91 * 86_400_000;
    assert.equal(await t.store.agentCredentialLive(cred3.id, later), false);
    fakeNow = later;
    const a3 = await t.agent([cred3], "i3");
    assert.equal((await a3.next("error")).code, "unauthorized_agent");
  } finally {
    await t.done();
  }
});

test("rate limits: a restart with 10 tabs + 10 agents behind one IP recovers; brute force is still throttled", async () => {
  const t = await setup();
  try {
    const tabs: Peer[] = [];
    for (let i = 0; i < 10; i++) {
      const p = await t.presence(`proj${i}`);
      await p.next("presence_ok");
      tabs.push(p);
    }
    const creds = [];
    for (let i = 0; i < 10; i++) creds.push(await t.enrol(`proj${i}`, `Agent ${i}`, `inst${i}`));
    for (let round = 0; round < 3; round++) {
      t.restart();
      const ps = await Promise.all(Array.from({ length: 10 }, (_, i) => t.presence(`proj${i}`)));
      const as = await Promise.all(creds.map((c) => t.agent([c], c.instanceId, { bind: c.handle })));
      await Promise.all(ps.map((p) => p.next("presence_ok")));
      await Promise.all(as.map((a) => a.next("bound")));
    }
    // Brute force: failed auths throttled (30 / 10 min by default), then refused before any token lookup.
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) {
      const c = await t.open();
      c.send({ type: "hello", role: "agent", token: `clv_acct_${randomBytes(8).toString("hex")}`, instanceId: "b", credentials: [{ id: "agt_x", secret: secret() }] });
      const e = await c.next("error");
      if (e.code === "rate_limited") limited = true;
      else assert.equal(e.code, "unauthorized");
    }
    assert.ok(limited, "failed auths are throttled");
    // And kept across a restart (in the database).
    t.restart();
    const c = await t.open();
    c.send({ type: "hello", role: "agent", token: "clv_acct_nope", instanceId: "b", credentials: [{ id: "agt_x", secret: secret() }] });
    const first = await c.next("error");
    assert.ok(first.code === "rate_limited" || first.code === "unauthorized");
    const c2 = await t.open();
    c2.send({ type: "hello", role: "agent", token: "clv_acct_nope", instanceId: "b", credentials: [{ id: "agt_x", secret: secret() }] });
    assert.equal((await c2.next("error")).code, "rate_limited");
  } finally {
    await t.done();
  }
});

test("HTTP: list remembered agents, Forget from a Studio browser only, `cresslet logout` revokes its own agents and token", async () => {
  const { createServer } = await import("../server/main.ts");
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-livelink-api-"));
  const srv = await createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80 }));
  const json = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", "test.local");
    if (init.body) headers.set("content-type", "application/json");
    const r = await srv.handler(new Request(`http://test.local${path}`, { ...init, headers }));
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    const store = srv.store;
    const acct = await store.createAccount("a@b.co");
    const cli = await store.issueToken(acct.id, { name: "CLI (browser login)" });
    const session = await store.issueToken(acct.id, { name: "studio" });
    const install = { id: "instAPI1", secret: secret() };
    assert.equal(await store.proveInstall(acct.id, install.id, install.secret), true);
    const mk = (label: string, tokenId = cli.info.id) => store.createAgentCredential({
      accountId: acct.id, cliTokenId: tokenId, installId: install.id, secretHash: sha(secret()), label, handle: `${install.id}:p1`, projectName: "P1",
    });
    const a1 = await mk("Claude Code");
    const other = await store.issueToken(acct.id, { name: "other" });
    const a2 = await mk("Codex", other.info.id);

    const studio = { cookie: `cresslet_session=${session.token}`, origin: "http://test.local", "x-cresslet-user": acct.id };
    const list = await json("/v1/me/agents", { headers: studio });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.agents.map((x: { label: string }) => x.label), ["Claude Code", "Codex"]);
    assert.deepEqual(list.body.agents[0].projects, [{ handle: `${install.id}:p1`, projectId: "p1", name: "P1" }]);

    // Forget needs the Studio session and a proven browser installation.
    assert.equal((await json(`/v1/me/agents/${a1.id}/forget`, { method: "POST", headers: { authorization: `Bearer ${cli.token}` }, body: JSON.stringify({ install }) })).status, 403);
    assert.equal((await json(`/v1/me/agents/${a1.id}/forget`, { method: "POST", headers: studio, body: JSON.stringify({ install: { id: install.id, secret: secret() } }) })).status, 403);
    assert.equal((await json(`/v1/me/agents/${a1.id}/forget`, { method: "POST", headers: studio, body: JSON.stringify({ install }) })).status, 200);
    assert.equal(await store.agentCredentialLive(a1.id), false);

    // logout: the calling token's agents only, then the token itself.
    const a3 = await mk("T3 Code");
    const rev = await json("/v1/me/agents/revoke", { method: "POST", headers: { authorization: `Bearer ${cli.token}` } });
    assert.deepEqual(rev.body.revoked, [a3.id]);
    assert.equal(await store.agentCredentialLive(a2.id), true);
    assert.equal((await json("/v1/me/token/revoke", { method: "POST", headers: { authorization: `Bearer ${cli.token}` } })).status, 200);
    assert.equal((await json("/v1/me", { headers: { authorization: `Bearer ${cli.token}` } })).status, 401);
  } finally {
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
