// The studio's AI builder (studio/builder.js): its tools over a fake container, and the agent loop over a fake
// Anthropic client. No network, no browser (tests/e2e/builder.mjs drives the real pane).
import { test } from "node:test";
import assert from "node:assert/strict";

const mod = "../studio/builder.js"; // untyped browser module
const { createAgent, createTools, projectPath, validate, TOOLS, SYSTEM, MODEL } = await import(mod);

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A cresslet-container stand-in: an in-memory file system under /project and a scripted `jsh -c`. */
function fakeContainer(files: Record<string, string> = {}, commands: Record<string, { out: string; code?: number; hang?: boolean }> = {}) {
  const fs = new Map(Object.entries(files).map(([k, v]) => [`/project/${k}`, v]));
  const dirs = () => {
    const d = new Set(["/project"]);
    for (const p of fs.keys()) for (let i = p.lastIndexOf("/"); i > 0; i = p.lastIndexOf("/", i - 1)) d.add(p.slice(0, i));
    return d;
  };
  const spawned: string[][] = [];
  const c = {
    workdir: "/project",
    spawned,
    files: fs,
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
    async spawn(cmd: string, args: string[]) {
      spawned.push([cmd, ...args]);
      const spec = commands[args[1]] ?? { out: `jsh: ${args[1]}: not found\n`, code: 127 };
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

/** An Anthropic client stand-in: each `beta.messages.stream` call plays the next scripted reply. */
function fakeClient(replies: Json[]) {
  const calls: Json[] = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params: Json, opts: Json) {
          calls.push({ params: structuredClone(params), signal: opts?.signal });
          const r = replies.shift();
          if (!r) throw new Error("no more scripted replies");
          const handlers: Record<string, ((x: Json) => void)[]> = {};
          return {
            on(ev: string, fn: (x: Json) => void) {
              (handlers[ev] ??= []).push(fn);
              return this;
            },
            async finalMessage() {
              if (r.thinking) handlers.streamEvent?.forEach((f) => f({ type: "content_block_start", content_block: { type: "thinking" } }));
              for (const t of r.text ?? []) handlers.text?.forEach((f) => f(t));
              if (r.wait) await r.wait(opts?.signal);
              if (r.throw) throw r.throw;
              return { content: r.content, stop_reason: r.stop_reason };
            },
          };
        },
      },
    },
  };
}

const toolUse = (id: string, name: string, input: Json) => ({ type: "tool_use", id, name, input });

test("paths stay inside the project and away from local secrets", () => {
  assert.equal(projectPath("src/App.tsx"), "src/App.tsx");
  assert.equal(projectPath("./src//a.ts"), "src/a.ts");
  assert.equal(projectPath("", { dir: true }), "");
  for (const bad of ["/etc/passwd", "../x", "src/../../x", ".env", ".env.cresslet", "server/.env.local", ".dev.vars", ".envrc", ".git/config", ""]) {
    assert.throws(() => projectPath(bad), Error, bad);
  }
});

test("tool inputs are checked against their schemas", () => {
  assert.equal(validate("read_file", { path: "a" }), null);
  assert.equal(validate("list_files", {}), null);
  assert.match(validate("read_file", {}), /missing field: path/);
  assert.match(validate("read_file", { path: 1 }), /must be a string/);
  assert.match(validate("read_file", { path: "a", x: "y" }), /unexpected field/);
  assert.match(validate("nope", {}), /unknown tool/);
  assert.match(validate("read_file", null), /object/);
  // Streamed tool inputs (validated here, not by the API)
  for (const t of TOOLS) assert.equal(t.eager_input_streaming, true, t.name);
});

test("file tools read, write, edit, delete and list; changes are reported", async () => {
  const c = fakeContainer({ "AGENTS.md": "# app", "src/App.tsx": "const a = 1;\nconst b = 1;\n", ".env.cresslet": "SECRET=1", "node_modules/x/index.js": "" });
  const changed: string[] = [];
  const t = createTools(c, { onChange: (p: string) => changed.push(p) });

  const ls = await t.execute("list_files", {});
  assert.equal(ls.error, undefined);
  assert.deepEqual(ls.text.split("\n").sort(), [".env.cresslet (local secrets, not readable)", "AGENTS.md", "src/App.tsx"]);

  assert.equal((await t.execute("read_file", { path: "AGENTS.md" })).text, "# app");
  const secret = await t.execute("read_file", { path: ".env.cresslet" });
  assert.equal(secret.error, true);
  assert.doesNotMatch(secret.text, /SECRET=1/);
  assert.equal((await t.execute("read_file", { path: "nope.ts" })).error, true);

  const w = await t.execute("write_file", { path: "src/new.ts", content: "export {};\n" });
  assert.equal(w.summary, "Created src/new.ts");
  assert.equal(c.files.get("/project/src/new.ts"), "export {};\n");

  const twice = await t.execute("edit_file", { path: "src/App.tsx", old_text: "= 1;", new_text: "= 2;" });
  assert.equal(twice.error, true);
  assert.match(twice.text, /more than once/);
  assert.equal((await t.execute("edit_file", { path: "src/App.tsx", old_text: "zzz", new_text: "" })).error, true);
  const e = await t.execute("edit_file", { path: "src/App.tsx", old_text: "const b = 1;", new_text: "const b = 2;" });
  assert.equal(e.summary, "Edited src/App.tsx");
  assert.equal(c.files.get("/project/src/App.tsx"), "const a = 1;\nconst b = 2;\n");

  assert.equal((await t.execute("write_file", { path: "../escape.ts", content: "" })).error, true);
  assert.equal((await t.execute("delete_file", { path: "src/new.ts" })).summary, "Deleted src/new.ts");
  assert.equal(c.files.has("/project/src/new.ts"), false);
  assert.deepEqual(changed, ["src/new.ts", "src/App.tsx", "src/new.ts"]);
});

test("run_command returns exit code and output; a command that keeps running is stopped", async () => {
  const c = fakeContainer({}, {
    "npm install zod": { out: "\x1b[32madded 1 package\x1b[0m\n" },
    "false": { out: "", code: 1 },
    "cresslet dev": { out: "listening\n", hang: true },
  });
  const t = createTools(c, { timeoutMs: 50, devLog: () => "\x1b[31merror\x1b[0m TS2304\r\n" });
  const ok = await t.execute("run_command", { command: "npm install zod" });
  assert.equal(ok.error, false);
  assert.equal(ok.text, "exit code 0\nadded 1 package"); // ANSI stripped
  assert.deepEqual(c.spawned[0], ["jsh", "-c", "npm install zod"]);
  assert.equal((await t.execute("run_command", { command: "false" })).error, true);
  const hung = await t.execute("run_command", { command: "cresslet dev" });
  assert.equal(hung.error, true);
  assert.match(hung.text, /stopped after .*\nlistening/);
  const stopping = new AbortController();
  const p = t.execute("run_command", { command: "cresslet dev" }, stopping.signal);
  stopping.abort();
  assert.match((await p).text, /stopped by the user/);
  assert.equal((await t.execute("read_dev_log", {})).text, "error TS2304");
});

test("agent: runs tool calls until Claude ends its turn, with the history append-only", async () => {
  const c = fakeContainer({ "src/App.tsx": "<h1>Todos</h1>" });
  const api = fakeClient([
    { thinking: true, text: ["Let me look."], content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "Let me look." }, toolUse("t1", "read_file", { path: "src/App.tsx" })], stop_reason: "tool_use" },
    { content: [toolUse("t2", "edit_file", { path: "src/App.tsx", old_text: "Todos", new_text: "Tasks" }), toolUse("t3", "read_file", { path: "missing" })], stop_reason: "tool_use" },
    { text: ["Renamed ", "the heading."], content: [{ type: "text", text: "Renamed the heading." }], stop_reason: "end_turn" },
  ]);
  const events: Json[] = [];
  const agent = createAgent({ client: async () => api, tools: createTools(c), on: (e: Json) => events.push(e) });
  await agent.send("Call it Tasks");
  assert.equal(agent.busy, false);
  assert.equal(c.files.get("/project/src/App.tsx"), "<h1>Tasks</h1>");

  assert.equal(api.calls.length, 3);
  const p = api.calls[0].params;
  assert.equal(p.model, MODEL);
  assert.equal(p.system, SYSTEM);
  assert.equal(p.tools.length, TOOLS.length);
  assert.deepEqual(p.output_config, { effort: "medium" });
  assert.deepEqual(p.cache_control, { type: "ephemeral" });
  assert.equal(p.fallbacks, "default");
  assert.equal("temperature" in p, false);
  // each request extends the previous one (thinking block passed back unchanged)
  const last = api.calls[2].params.messages;
  assert.deepEqual(api.calls[1].params.messages, last.slice(0, 3));
  assert.deepEqual(last[1].content[0], { type: "thinking", thinking: "", signature: "sig" });
  assert.deepEqual(last[2].content, [{ type: "tool_result", tool_use_id: "t1", content: "<h1>Todos</h1>" }]);
  // both results of a parallel call in one user message; the failed one marked
  assert.equal(last[4].content.length, 2);
  assert.equal(last[4].content[1].is_error, true);
  assert.equal(agent.messages.at(-1).role, "assistant");

  assert.deepEqual(events.filter((e) => e.type === "text").map((e) => e.delta), ["Let me look.", "Renamed ", "the heading."]);
  assert.deepEqual(events.filter((e) => e.type === "tool-done").map((e) => e.summary), ["Read src/App.tsx", "Edited src/App.tsx", "read_file: no such file: missing"]);
  assert.ok(events.some((e) => e.type === "thinking"));
});

test("agent: Stop ends the turn; the next message answers the calls that never ran", async () => {
  const c = fakeContainer();
  let release!: () => void;
  const api = fakeClient([
    // aborted while waiting for Claude
    { content: [], stop_reason: "end_turn", wait: (signal: AbortSignal) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "APIUserAbortError" })))) },
    // tool calls, then Stop before they run
    { content: [toolUse("a", "list_files", {}), toolUse("b", "list_files", {})], stop_reason: "tool_use", wait: () => new Promise<void>((r) => (release = r)) },
    { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
  ]);
  const events: Json[] = [];
  const agent = createAgent({ client: async () => api, tools: createTools(c), on: (e: Json) => events.push(e) });

  const first = agent.send("one");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(agent.busy, true);
  await assert.rejects(agent.send("again"), /already working/);
  agent.stop();
  await first;
  assert.equal(events.at(-1).text, "Stopped.");
  assert.equal(agent.messages.length, 1); // the unanswered request; nothing appended

  const second = agent.send("two");
  await new Promise((r) => setTimeout(r, 10));
  agent.stop();
  release();
  await second;
  assert.equal(events.filter((e) => e.type === "tool").length, 0); // neither call ran
  const results = agent.messages.at(-1).content;
  assert.deepEqual(results.map((r: Json) => [r.tool_use_id, r.is_error]), [["a", true], ["b", true]]);

  await agent.send("three");
  // consecutive user turns are allowed; the history stays valid for the API
  assert.equal(api.calls.length, 3);
  assert.equal(agent.messages.at(-1).content[0].text, "ok");
});

test("agent: refused or cut-off tool calls don't run, and the next message answers them", async () => {
  const c = fakeContainer({ "a.txt": "x" });
  const api = fakeClient([
    { content: [toolUse("r", "delete_file", { path: "a.txt" })], stop_reason: "max_tokens" },
    { content: [{ type: "text", text: "fine" }], stop_reason: "end_turn" },
    { content: [], stop_reason: "refusal" },
  ]);
  const events: Json[] = [];
  const agent = createAgent({ client: async () => api, tools: createTools(c), on: (e: Json) => events.push(e) });
  await agent.send("delete it");
  assert.equal(c.files.has("/project/a.txt"), true);
  assert.match(events.at(-1).text, /length limit/);
  await agent.send("ok then");
  const sent = api.calls[1].params.messages.at(-1).content;
  assert.deepEqual(sent[0], { type: "tool_result", tool_use_id: "r", is_error: true, content: "not run: the turn ended before this tool ran" });
  assert.deepEqual(sent[1], { type: "text", text: "ok then" });
  await agent.send("something else");
  assert.equal(events.at(-1).text, "Claude declined this request.");
});

test("agent: API errors end the turn with a readable message; dropped connections are retried", async () => {
  const api = fakeClient([
    { throw: Object.assign(new Error("invalid x-api-key"), { status: 401 }) },
    { throw: new TypeError("network error") },
    { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" },
  ]);
  const events: Json[] = [];
  const agent = createAgent({ client: async () => api, tools: createTools(fakeContainer()), on: (e: Json) => events.push(e) });
  await agent.send("hello");
  assert.equal(events.at(-1).error, true);
  assert.match(events.at(-1).text, /didn't accept the API key/);
  await agent.send("hello again");
  assert.ok(events.some((e) => e.text === "The connection dropped; trying again."));
  assert.equal(agent.messages.at(-1).content[0].text, "hi");
});
