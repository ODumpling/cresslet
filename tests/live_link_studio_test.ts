// Live Link v2, the Studio's side (studio/live-link.ts, studio/mcp-bridge.ts): Remember on the Allow card, the owning
// tab's presence carrying a remembered agent's calls into the tab's dispatcher, its reconnect after a server restart
// (jittered backoff), Disconnect stopping local execution and Resume, and the backoff's bounds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { loadConfig } from "../server/config.ts";
import { createRelay } from "../server/relay.ts";
import { Store } from "../server/store.ts";
import "./studio-imports.ts";

// Studio modules are type-checked with the studio's config (their vendor types): imported untyped here, like bridge_test.
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const liveMod = "../studio/live-link.ts", bridgeMod = "../studio/mcp-bridge.ts";
const { backoff, connectPresence } = await import(liveMod) as Json;
const { connectBridge, createBridgeDispatcher } = await import(bridgeMod) as Json;

type Msg = Record<string, unknown>;
const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("condition never met");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("backoff: 1 s doubling to 30 s, jittered between half and all of it", () => {
  assert.equal(backoff(0, () => 1), 1000);
  assert.equal(backoff(0, () => 0), 500);
  assert.equal(backoff(3, () => 1), 8000);
  assert.equal(backoff(10, () => 1), 30_000);
  assert.equal(backoff(10, () => 0), 15_000);
});

test("presence carries a remembered agent's calls into the tab, reconnects after a restart, Disconnect stops it until Resume", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-ll-studio-"));
  const cfg = loadConfig({ dataDir, domain: "test.local", publicPort: 80 });
  const store = await Store.open(cfg.dataDir, cfg.database);
  let relay = createRelay(cfg, store);
  const http = serve({ fetch: () => new Response("ok"), port: 0 });
  http.on("upgrade", (req, sock, head) => relay.upgrade(req, sock, head));
  await new Promise((r) => http.once("listening", r));
  const wsUrl = `ws://127.0.0.1:${(http.address() as { port: number }).port}/v1/workspace/relay`;
    try {
    const acct = await store.createAccount("a@b.co");
    const session = await store.issueToken(acct.id, { name: "studio" });
    const cli = await store.issueToken(acct.id, { name: "cli" });
    const install = { id: "instS1", secret: randomBytes(32).toString("base64url") };
    const ran: string[] = [];
    let release: (() => void) | null = null;
    const dispatcher = createBridgeDispatcher({
      tools: {
        execute: async (name: string, _input: unknown, signal?: AbortSignal) => {
          ran.push(name);
          if (name === "run_command") {
            // Runs until cancelled (Disconnect) or released.
            await new Promise<void>((r) => {
              release = r;
              signal?.addEventListener("abort", () => r(), { once: true });
            });
            return { text: signal?.aborted ? "aborted" : "done", summary: name, ...(signal?.aborted ? { error: true } : {}) };
          }
          return { text: `ok ${name}`, summary: name };
        },
      },
      commitChange: async (title: string) => ({ text: title, summary: title }),
    });
    const states: Msg[] = [];
    const presence = connectPresence({
      wsUrl, install, projectId: "proj0001", projectName: "Demo", paused: false, dispatcher,
      onState: (st: Msg) => states.push(st),
      createSocket: (url: string) => new WebSocket(url, { headers: { origin: "http://test.local", cookie: `cresslet_session=${session.token}` } }),
      random: () => 0, minDelayMs: 20, maxDelayMs: 100,
    });
    await until(() => presence.state.phase === "online");

    // Code pairing with Remember (the tab's bridge offers it: a v2 CLI and a proven installation).
    const agentSecret = randomBytes(32).toString("base64url");
    const c = new WebSocket(wsUrl);
    const cliMsgs: Msg[] = [];
    c.on("message", (d) => cliMsgs.push(JSON.parse(d.toString())));
    await new Promise((r) => c.once("open", r));
    c.send(JSON.stringify({ v: 1, type: "hello", role: "cli", token: cli.token, agent: "Claude Code", enroll: { secretHash: createHash("sha256").update(agentSecret).digest("hex"), instanceId: "i1" } }));
    await until(() => cliMsgs.some((m) => m.type === "code"));
    const phases: string[] = [];
    const bridge = connectBridge({
      wsUrl, code: cliMsgs.find((m) => m.type === "code")!.code as string, projectName: "Demo", install, projectId: "proj0001", dispatcher,
      createSocket: (url: string) => new WebSocket(url, { headers: { origin: "http://test.local", cookie: `cresslet_session=${session.token}` } }),
      onState: (st: Json) => {
        phases.push(st.phase);
        if (st.phase === "awaiting_approval") {
          assert.equal(st.canRemember, true);
          bridge.decide(true, true);
        }
      },
    });
    await until(() => phases.includes("enrolled"));
    const enrolled = cliMsgs.find((m) => m.type === "enrolled")!;

    // The agent reconnects with its credential and binds through the presence.
    const agentMsgs: Msg[] = [];
    let a = new WebSocket(wsUrl);
    const openAgent = async () => {
      a = new WebSocket(wsUrl);
      a.on("message", (d) => agentMsgs.push(JSON.parse(d.toString())));
      await new Promise((r) => a.once("open", r));
      a.send(JSON.stringify({ v: 1, type: "hello", role: "agent", token: cli.token, agent: "Claude Code", instanceId: "i1", credentials: [{ id: enrolled.credentialId, secret: agentSecret }], bind: enrolled.handle }));
    };
    await openAgent();
    const take = async (type: string, id?: string) => {
      await until(() => agentMsgs.some((m) => m.type === type && (id === undefined || m.id === id)));
      const i = agentMsgs.findIndex((m) => m.type === type && (id === undefined || m.id === id));
      return agentMsgs.splice(i, 1)[0]!;
    };
    let bound = await take("bound");
    await until(() => presence.state.binding?.agent === "Claude Code");
    a.send(JSON.stringify({ v: 1, type: "tool_call", id: "t1", name: "read_file", arguments: { path: "a" }, handle: enrolled.handle, epoch: bound.epoch }));
    assert.equal((await take("tool_result", "t1")).text, "ok read_file");

    // Server restart: the presence reconnects on its own (backoff), the agent binds again.
    relay.close();
    relay = createRelay(cfg, store);
    await until(() => presence.state.phase === "offline" || presence.state.phase === "connecting");
    await until(() => presence.state.phase === "online");
    await openAgent();
    bound = await take("bound");
    a.send(JSON.stringify({ v: 1, type: "tool_call", id: "t2", name: "list_files", arguments: {}, handle: enrolled.handle, epoch: bound.epoch }));
    assert.equal((await take("tool_result", "t2")).text, "ok list_files");

    // Disconnect mid-call: local execution stops at once, the agent is unbound and stays so until Resume.
    a.send(JSON.stringify({ v: 1, type: "tool_call", id: "t3", name: "run_command", arguments: {}, handle: enrolled.handle, epoch: bound.epoch }));
    await until(() => release !== null);
    await presence.pause();
    assert.equal(dispatcher.busy, false);
    assert.equal((await take("unbound")).reason, "paused");
    assert.equal(presence.state.paused, true);
    let cleared = false;
    await presence.resume(async () => void (cleared = true));
    assert.equal(cleared, true);
    assert.equal(presence.state.paused, false);
    bound = await take("bound");
    a.send(JSON.stringify({ v: 1, type: "tool_call", id: "t4", name: "read_file", arguments: {}, handle: enrolled.handle, epoch: bound.epoch }));
    assert.equal((await take("tool_result", "t4")).text, "ok read_file");
    assert.deepEqual(ran, ["read_file", "list_files", "run_command", "read_file"]);

    presence.close();
    assert.equal(presence.state.phase, "stopped");
    a.close();
    c.close();
    void states;
  } finally {
    relay.close();
    http.close();
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
