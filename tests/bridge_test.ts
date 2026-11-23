// Studio MCP bridge (studio/mcp-bridge.ts): tool schemas, path/secret guards over the bridge,
// commit_change turn boundary, cancellation, and live relay round-trip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { loadConfig } from "../server/config.ts";
import { createRelay } from "../server/relay.ts";
import { Store } from "../server/store.ts";
import "./studio-imports.ts";

const builderMod = "../studio/builder.ts";
const bridgeMod = "../studio/mcp-bridge.ts";
const { createTools, TOOLS } = await import(builderMod);
const { BRIDGE_TOOLS, connectBridge, createBridgeDispatcher } = await import(bridgeMod);

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function fakeContainer(files: Record<string, string> = {}, commands: Record<string, { out: string; code?: number; hang?: boolean }> = {}) {
  const fs = new Map(Object.entries(files).map(([k, v]) => [`/project/${k}`, v]));
  const dirs = () => {
    const d = new Set(["/project"]);
    for (const p of fs.keys()) for (let i = p.lastIndexOf("/"); i > 0; i = p.lastIndexOf("/", i - 1)) d.add(p.slice(0, i));
    return d;
  };
  const spawnEnv: Json[] = [];
  const runningObserved: number[] = [];
  let toolsRef: { running: number } | null = null;
  const c = {
    workdir: "/project",
    spawnEnv,
    runningObserved,
    setToolsRef(t: { running: number }) {
      toolsRef = t;
    },
    fs: {
      async readFile(p: string) {
        if (!fs.has(p)) throw new Error(`ENOENT: ${p}`);
        return fs.get(p);
      },
      async writeFile(p: string, d: string) {
        fs.set(p, d);
      },
      async exists(p: string) {
        return fs.has(p) || dirs().has(p);
      },
      async mkdir() {},
      async rm(p: string) {
        if (!fs.delete(p)) throw new Error(`ENOENT: ${p}`);
      },
      async readdir(p: string) {
        const names = new Map<string, boolean>();
        for (const f of [...fs.keys(), ...dirs()]) {
          if (!f.startsWith(p + "/")) continue;
          const [name, ...rest] = f.slice(p.length + 1).split("/");
          names.set(name, (names.get(name) ?? false) || rest.length > 0 || dirs().has(`${p}/${name}`));
        }
        return [...names].map(([name, dir]) => ({ name, isDirectory: () => dir }));
      },
    },
    async spawn(_cmd: string, args: string[], opts: Json) {
      spawnEnv.push(opts?.env);
      if (toolsRef) runningObserved.push(toolsRef.running);
      const spec = commands[args[1]] ?? { out: `ok:${args[1]}\n`, code: 0 };
      let killed!: () => void;
      const exit = spec.hang ? new Promise<number>((r) => (killed = () => r(130))) : Promise.resolve(spec.code ?? 0);
      return {
        output: new ReadableStream<string>({ start(ctl) { ctl.enqueue(spec.out); if (!spec.hang) ctl.close(); } }),
        input: new WritableStream<string>(),
        exit,
        kill: () => killed?.(),
      };
    },
  };
  return c;
}

test("BRIDGE_TOOLS reuses all 7 builder tools verbatim plus commit_change", () => {
  const names = BRIDGE_TOOLS.map((t: { name: string }) => t.name);
  assert.deepEqual(names, [...TOOLS.map((t: { name: string }) => t.name), "commit_change"]);
  for (const t of TOOLS) {
    const bt = BRIDGE_TOOLS.find((x: { name: string }) => x.name === t.name);
    assert.equal(bt.description, t.description);
    assert.deepEqual(bt.inputSchema.properties, t.input_schema.properties);
    assert.deepEqual(bt.inputSchema.required, t.input_schema.required);
  }
});

test("bridge enforces path/secret guards, deploy marker, commit_change, and cancellation", async () => {
  const c = fakeContainer(
    {
      "index.html": "<h1>Hello</h1>",
      ".env": "SECRET=123",
      ".env.local": "LOCAL=456",
      ".envrc": "export X=1",
      ".dev.vars": "DEV=789",
      ".git/config": "[core]",
    },
    {
      "cresslet deploy": { out: "deployed\n", code: 0 },
      "sleep 99": { out: "waiting...", hang: true },
    },
  );
  const tools = createTools(c, { devLog: () => "server ready on :3000" });
  c.setToolsRef(tools);

  const commits: string[] = [];
  const events: string[] = [];
  const dispatcher = createBridgeDispatcher({
    tools,
    commitChange: async (title: string) => {
      commits.push(title);
      return { text: `Committed: ${title}`, summary: `Committed: ${title}` };
    },
    onEvent: (ev: { type: string; name: string }) => events.push(`${ev.type}:${ev.name}`),
  });

  // Guards: absolute path, .., .git, .env*, .envrc, .dev.vars, unknown tool.
  for (const badPath of ["/etc/passwd", "../escape.txt", "a/../../escape.txt", ".git/config", ".env", ".env.local", ".envrc", ".dev.vars"]) {
    const r = await dispatcher.call("g", "read_file", { path: badPath });
    assert.equal(r.error, true, `read_file(${badPath}) should be refused`);
    const w = await dispatcher.call("g", "write_file", { path: badPath, content: "x" });
    assert.equal(w.error, true, `write_file(${badPath}) should be refused`);
  }
  assert.equal((await dispatcher.call("u", "rm_rf", {})).error, true);

  // Normal file ops + dev log.
  const listed = await dispatcher.call("1", "list_files", {});
  assert.equal(listed.error, undefined);
  assert.match(listed.text, /index\.html/);
  assert.match(listed.text, /\.env \(local secrets, not readable\)/);

  const written = await dispatcher.call("2", "write_file", { path: "src/app.ts", content: "export const n = 1;\n" });
  assert.equal(written.error, undefined);
  const edited = await dispatcher.call("3", "edit_file", { path: "src/app.ts", old_text: "n = 1", new_text: "n = 2" });
  assert.equal(edited.error, undefined);
  const read = await dispatcher.call("4", "read_file", { path: "src/app.ts" });
  assert.equal(read.text, "export const n = 2;\n");

  const log = await dispatcher.call("5", "read_dev_log", {});
  assert.match(log.text, /server ready/);

  // run_command sets CRESSLET_AI_BUILDER=1 and tools.running > 0 so deploy approval is always triggered.
  const dep = await dispatcher.call("6", "run_command", { command: "cresslet deploy" });
  assert.equal(dep.error, undefined);
  assert.equal(c.spawnEnv[0]?.CRESSLET_AI_BUILDER, "1");
  assert.equal(c.runningObserved[0], 1);

  // commit_change validates input and calls commitChange handler.
  assert.equal((await dispatcher.call("7", "commit_change", {})).error, true);
  assert.equal((await dispatcher.call("8", "commit_change", { title: "   " })).error, true);
  assert.equal((await dispatcher.call("9", "commit_change", { title: "ok", extra: "bad" })).error, true);
  const cm = await dispatcher.call("10", "commit_change", { title: "Update counter\nto 2" });
  assert.equal(cm.error, undefined);
  assert.deepEqual(commits, ["Update counter to 2"]);

  // Cancellation: abort running command AND drop queued call.
  const hangP = dispatcher.call("h1", "run_command", { command: "sleep 99" });
  const queuedP = dispatcher.call("h2", "read_file", { path: "index.html" });
  assert.equal(dispatcher.busy, true);
  dispatcher.cancel("h2");
  dispatcher.cancel("h1");
  const [hangRes, queuedRes] = await Promise.all([hangP, queuedP]);
  assert.equal(hangRes.error, true);
  assert.match(hangRes.text, /stopped/i);
  assert.equal(queuedRes.error, true);
  assert.match(queuedRes.text, /cancelled/i);
  assert.equal(dispatcher.busy, false);
  assert.ok(events.includes("tool:write_file"));
  assert.ok(events.includes("tool-done:commit_change"));
});

test("connectBridge pairs through real relay and executes tool calls", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-bridge-"));
  const cfg = loadConfig({ dataDir, domain: "test.local", publicPort: 80 });
  const store = await Store.open(cfg.dataDir, cfg.database);
  const relay = createRelay(cfg, store);
  const http = serve({ fetch: () => new Response("ok"), port: 0 });
  http.on("upgrade", (req, sock, head) => relay.upgrade(req, sock, head));
  await new Promise((r) => http.once("listening", r));
  const port = (http.address() as { port: number }).port;
  const wsUrl = `ws://127.0.0.1:${port}/v1/workspace/relay`;

  try {
    const aliceAcct = await store.createAccount("alice@example.com");
    const alice = { account: aliceAcct, token: (await store.issueToken(aliceAcct.id, { name: "alice" })).token };
    const c = fakeContainer({ "index.html": "<p>hi</p>" });
    const tools = createTools(c);
    const dispatcher = createBridgeDispatcher({
      tools,
      commitChange: async (title: string) => ({ text: `Committed ${title}`, summary: title }),
    });

    // CLI opens relay and receives code.
    const cli = new WebSocket(wsUrl);
    await new Promise<void>((r) => cli.once("open", () => r()));
    const nextCli = () => new Promise<Record<string, unknown>>((r) => cli.once("message", (d) => r(JSON.parse(d.toString()))));
    const codeP = nextCli();
    cli.send(JSON.stringify({ v: 1, type: "hello", role: "cli", token: alice.token, agent: "Claude Code" }));
    const code = (await codeP).code as string;

    // Studio connects via connectBridge.
    const states: string[] = [];
    let onPaired!: () => void;
    const pairedP = new Promise<void>((r) => (onPaired = r));
    const bridge = connectBridge({
      wsUrl,
      token: alice.token,
      code,
      projectName: "demo",
      dispatcher,
      createSocket: (url: string) => new WebSocket(url, { headers: { origin: "http://test.local" } }) as unknown as Json,
      onState(st: { phase: string }) {
        states.push(st.phase);
        if (st.phase === "awaiting_approval") bridge.decide(true);
        if (st.phase === "paired") onPaired();
      },
    });
    const cliPaired = await nextCli();
    assert.equal(cliPaired.type, "paired");
    await pairedP;
    assert.deepEqual(states, ["connecting", "awaiting_approval", "paired"]);

    // Execute a write_file and a blocked .env read over the relay.
    const r1P = nextCli();
    cli.send(JSON.stringify({ v: 1, type: "tool_call", id: "t1", name: "write_file", arguments: { path: "hello.txt", content: "world" } }));
    const r1 = await r1P;
    assert.equal(r1.type, "tool_result");
    assert.equal(r1.id, "t1");
    assert.equal(r1.error, undefined);

    const r2P = nextCli();
    cli.send(JSON.stringify({ v: 1, type: "tool_call", id: "t2", name: "read_file", arguments: { path: ".env" } }));
    const r2 = await r2P;
    assert.equal(r2.error, true);
    assert.match(String(r2.text), /local secrets/i);

    bridge.disconnect();
    cli.close();
  } finally {
    relay.close();
    http.close();
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
