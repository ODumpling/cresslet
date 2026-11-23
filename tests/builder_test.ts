// The studio's AI builder (studio/builder.ts): its tools over a fake container, and the agent loop over a fake
// Anthropic client. No network, no browser (tests/e2e/builder.ts drives the real pane).
import { test } from "node:test";
import assert from "node:assert/strict";
import "./studio-imports.ts"; // studio modules' ./x.js imports → x.ts

const mod = "../studio/builder.ts"; // browser module: typed by studio/tsconfig.json, not this program
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
  const spawnEnv: Json[] = [];
  const c = {
    workdir: "/project",
    spawned,
    spawnEnv,
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
    async spawn(cmd: string, args: string[], opts: Json) {
      spawned.push([cmd, ...args]);
      spawnEnv.push(opts?.env);
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
              // tool inputs as streamed (`raw[id]` overrides: JSON the SDK's tolerant parser would still accept)
              (r.content ?? []).forEach((b: Json, index: number) => {
                if (b.type !== "tool_use") return;
                handlers.streamEvent?.forEach((f) => f({ type: "content_block_start", index, content_block: { ...b, input: {} } }));
                const json = r.raw?.[b.id] ?? JSON.stringify(b.input);
                handlers.streamEvent?.forEach((f) => f({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json } }));
              });
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
  for (const bad of ["/etc/passwd", "../x", "src/../../x", ".env", ".env.cresslet", "server/.env.local", ".dev.vars", ".envrc", ".env.d/token", ".git/config", ""]) {
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
  const c = fakeContainer({ "AGENTS.md": "# app", "src/App.tsx": "const a = 1;\nconst b = 1;\n", ".env.cresslet": "SECRET=1", ".env.d/token": "T", "node_modules/x/index.js": "" });
  const changed: string[] = [];
  const t = createTools(c, { onChange: (p: string) => changed.push(p) });

  const ls = await t.execute("list_files", {});
  assert.equal(ls.error, undefined);
  assert.deepEqual(ls.text.split("\n").sort(), [".env.cresslet (local secrets, not readable)", ".env.d/ (local secrets, not readable)", "AGENTS.md", "src/App.tsx"]);

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
  assert.deepEqual(c.spawnEnv[0], { CRESSLET_AI_BUILDER: "1" }); // so `cresslet deploy` asks the user first
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

test("run_command: counts as running (deploys then need approval); time spent asking the user doesn't time out", async () => {
  let asking = true;
  const c = fakeContainer({}, { "cresslet deploy": { out: "", hang: true } });
  const t = createTools(c, { timeoutMs: 300, paused: () => asking });
  assert.equal(t.running, 0);
  const p = t.execute("run_command", { command: "cresslet deploy" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(t.running, 1);
  let done = false;
  p.then(() => (done = true));
  await new Promise((r) => setTimeout(r, 700)); // well past the timeout, but the user is still being asked
  assert.equal(done, false);
  asking = false;
  assert.match((await p).text, /stopped after 0.3s/);
  assert.equal(t.running, 0);
  // a late (throttled) tick spanning the start or end of a question charges at most one normal tick
  let t0 = 0;
  asking = false;
  const late = createTools(c, { timeoutMs: 1000, paused: () => asking, clock: () => t0 });
  const q = late.execute("run_command", { command: "cresslet deploy" });
  let lateDone = false;
  q.then(() => (lateDone = true));
  await new Promise((r) => setTimeout(r, 300)); // one tick, not asking: nothing charged (clock stood still)
  asking = true;
  t0 += 5000; // asked just after that tick; the next one comes 5 s late
  await new Promise((r) => setTimeout(r, 300));
  asking = false;
  t0 += 5000;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(lateDone, false); // 2 × 250 ms charged, not 10 s
  t0 += 600;
  assert.match((await q).text, /stopped after 1s/);
  // long output: one note for everything left out
  const big = createTools(fakeContainer({}, { "yes": { out: "y\n".repeat(30_000) } }));
  const text = (await big.execute("run_command", { command: "yes" })).text;
  assert.equal(text.match(/earlier characters not shown/g)?.length, 1);
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
  assert.equal(agent.messages.length, 0); // nothing came back: the message isn't kept (or sent again with the next)

  const second = agent.send("two");
  await new Promise((r) => setTimeout(r, 10));
  agent.stop();
  release();
  await second;
  assert.equal(events.filter((e) => e.type === "tool").length, 0); // neither call ran
  const results = agent.messages.at(-1).content;
  assert.deepEqual(results.map((r: Json) => [r.tool_use_id, r.is_error]), [["a", true], ["b", true]]);

  await agent.send("three");
  assert.equal(api.calls.length, 3);
  assert.deepEqual(api.calls[2].params.messages.map((m: Json) => m.role), ["user", "assistant", "user", "user"]);
  assert.equal(api.calls[2].params.messages[0].content, "two");
  assert.equal(agent.messages.at(-1).content[0].text, "ok");
});

test("agent: refused, cut-off or malformed tool calls don't run; a declined message isn't kept", async () => {
  const c = fakeContainer({ "a.txt": "x" });
  const api = fakeClient([
    { content: [toolUse("r", "delete_file", { path: "a.txt" })], stop_reason: "max_tokens" },
    { content: [{ type: "text", text: "fine" }], stop_reason: "end_turn" },
    { content: [], stop_reason: "refusal" },
    { content: [], stop_reason: "max_tokens" },
    { content: [toolUse("w", "write_file", { path: "a.txt", content: "y" })], stop_reason: "model_context_window_exceeded" },
    // the tolerant parser made `content` shorter than what the model wrote
    { content: [toolUse("j", "write_file", { path: "a.txt", content: "trunc" })], raw: { j: '{"path":"a.txt","content":"trunc"ated"}' }, stop_reason: "tool_use" },
    { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
  ]);
  const events: Json[] = [];
  const agent = createAgent({ client: async () => api, tools: createTools(c), on: (e: Json) => events.push(e) });
  await agent.send("delete it");
  assert.equal(c.files.has("/project/a.txt"), true);
  assert.match(events.at(-1).text, /length limit before its tool calls were complete/);
  await agent.send("ok then");
  const sent = api.calls[1].params.messages.at(-1).content;
  assert.deepEqual(sent[0], { type: "tool_result", tool_use_id: "r", is_error: true, content: "not run: the turn ended before this tool ran" });
  assert.deepEqual(sent[1], { type: "text", text: "ok then" });

  const before = agent.messages.length;
  await agent.send("something declined");
  assert.equal(events.at(-1).text, "Claude declined this request.");
  assert.equal(agent.messages.length, before); // neither the request nor an (empty) reply

  await agent.send("empty and cut off");
  assert.match(events.at(-1).text, /length limit\.$/); // said, not silently "finished"
  await agent.send("write it");
  assert.equal(c.files.get("/project/a.txt"), "x");
  assert.match(events.at(-1).text, /too long for Claude/);
  await agent.send("write it again");
  assert.equal(c.files.get("/project/a.txt"), "x"); // invalid JSON: not run
  const results = api.calls[6].params.messages.at(-1).content;
  assert.equal(results[0].tool_use_id, "j");
  assert.match(results[0].content, /INVALID_JSON/);
  for (const call of api.calls) for (const m of call.params.messages) assert.ok(typeof m.content === "string" || m.content.length, "no empty message");
});

test("agent: API errors end the turn with a readable message; dropped connections are retried", async () => {
  const api = fakeClient([
    { throw: Object.assign(new Error("invalid x-api-key"), { status: 401 }) },
    { text: ["Hel"], throw: new TypeError("network error") },
    { text: ["Hello"], content: [{ type: "text", text: "Hello" }], stop_reason: "end_turn" },
  ]);
  const events: Json[] = [];
  const agent = createAgent({ client: async () => api, tools: createTools(fakeContainer()), on: (e: Json) => events.push(e) });
  await agent.send("hello");
  assert.equal(events.at(-1).error, true);
  assert.match(events.at(-1).text, /didn't accept the API key/);
  assert.equal(agent.messages.length, 0); // sending again doesn't repeat it
  await agent.send("hello again");
  // the partial reply ("Hel") is dropped before the retry streams the whole one
  const texts = events.filter((e) => e.type === "text" || e.type === "retry").map((e) => e.delta ?? "retry");
  assert.deepEqual(texts, ["Hel", "retry", "Hello"]);
  assert.deepEqual(api.calls[2].params.messages, [{ role: "user", content: "hello again" }]);
  assert.equal(agent.messages.at(-1).content[0].text, "Hello");
});

test("cresslet deploy from the builder: asks first, deploys to the app it named, keeps cresslet.json edits", async () => {
  const plugin = "../studio/cresslet-plugin.ts"; // browser module: typed by studio/tsconfig.json, not this program
  const { createCresslet } = await import(plugin);
  const c = fakeContainer({ "cresslet.json": '{"routes":["/api/*"]}' });
  let command!: (ctx: Json) => Promise<number>;
  Object.assign(c, {
    registerCommand: (_name: string, fn: typeof command) => (command = fn),
    build: async () => ({ files: [] }),
    export: async () => ({}),
  });
  const project: Json = { deploy: null };
  let running = false;
  const asked: Json[] = [];
  let answer = (_ok: boolean) => {};
  const cresslet = createCresslet(c, {
    auth: () => ({ token: null }),
    project: () => project,
    builderRunning: () => running,
    approveDeploy: (target: string | null) => {
      asked.push(target);
      return new Promise<boolean>((r) => (answer = r));
    },
  });
  assert.ok(cresslet.deploy);
  const posted: Json[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: Json) => {
    posted.push({ body: JSON.parse(init.body), key: init.headers["x-cresslet-deploy-key"] });
    return Response.json({ app: { name: "new-app", url: "http://new-app.test", claimed: true } });
  }) as typeof fetch;
  const ctx = (env: Json = {}) => ({ args: ["deploy"], env, stdout: { write() {} }, stderr: { write() {} }, signal: new AbortController().signal });
  try {
    // the user's own terminal: no question
    assert.equal(await command(ctx()), 0);
    assert.deepEqual(asked, []);
    assert.equal(JSON.parse(c.files.get("/project/cresslet.json")!).name, "new-app");
    c.files.set("/project/cresslet.json", '{"routes":["/api/*"]}'); // unnamed again
    // while a builder command runs, even with the marker unset: asked; declined → nothing sent
    running = true;
    const declined = command(ctx());
    await new Promise((r) => setTimeout(r, 0));
    answer(false);
    assert.equal(await declined, 1);
    assert.equal(posted.length, 1);
    // approved: the upload goes where the question said, even if the project was attached elsewhere meanwhile;
    // cresslet.json edits made while asking survive
    const approved = command(ctx({ CRESSLET_AI_BUILDER: "1" }));
    await new Promise((r) => setTimeout(r, 0));
    project.deploy = { name: "other-app", deployKey: "k-other" };
    c.files.set("/project/cresslet.json", '{"routes":["/x/*"]}');
    answer(true);
    assert.equal(await approved, 0);
    assert.deepEqual(asked, [null, null]);
    assert.equal(posted[1].body.app, undefined); // a new app, as approved; not other-app
    assert.equal(posted[1].key, undefined);
    assert.deepEqual(JSON.parse(c.files.get("/project/cresslet.json")!), { routes: ["/x/*"], name: "new-app" });
    // a name the user removed while asked isn't put back
    project.deploy = null;
    c.files.set("/project/cresslet.json", '{"name":"named"}');
    const third = command(ctx({ CRESSLET_AI_BUILDER: "1" }));
    await new Promise((r) => setTimeout(r, 0));
    c.files.set("/project/cresslet.json", "{}");
    answer(true);
    assert.equal(await third, 0);
    assert.equal(posted[2].body.app, "named");
    assert.equal(c.files.get("/project/cresslet.json"), "{}");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- source control (studio/git.ts): branch first, merge then deploy

const gitMod = "../studio/git.ts"; // browser module: typed by studio/tsconfig.json, not this program
const { createGitWorkspace, branchSlug, commitMessage, landBlocked } = await import(gitMod);

/** A linked project over a scripted /v1/apps/:name/git API: the calls it made, its state, what was loaded. */
function fakeGit({ taken = [] as string[], merge = null as Json, onDefault = true, hydrate = null as null | ((f: Json) => Promise<void>), duringSync = () => {}, duringStack = () => {}, duringBack = () => {}, duringRestore = () => {}, stackError = null as string | null } = {}) {
  const opts = { stackError };
  const calls: { path: string; body?: Json }[] = [];
  const hydrated: Json[] = [];
  let state: Json = {
    provider: "github", owner: "octo", repo: "shop", url: "https://github.example/octo/shop", defaultBranch: "main",
    activeBranch: onDefault ? "main" : "feat/x", baseSha: "a".repeat(40), headSha: "a".repeat(40), dirty: false,
  };
  let n = 0;
  const api = async (path: string, init: Json = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, body });
    if (path.endsWith("/git/branches")) {
      if (taken.includes(body.name)) throw Object.assign(new Error("exists"), { status: 409, code: "branch_exists" });
      return { branch: { name: body.name, sha: body.from } };
    }
    if (path.endsWith("/git/stack/back")) {
      duringBack();
      return { change: { id: body.change, position: 1, branch: "feat/s/1-one", sha: "1".repeat(40), title: "One" }, stack: { id: "stk_1" }, now: ["chg_2"], setAside: [{ title: "Two" }, { title: "Three" }] };
    }
    if (/\/git\/stack\/(pull-in|carry-on)$/.test(path)) return { change: { id: body.change, sha: body.sha } };
    if (path.includes("/git/stack/undo?change=chg_p")) return { title: "Undo: Deps", top: { branch: state.activeBranch, sha: state.headSha }, conflicts: ["package.json"], files: [{ path: ".env", data: "VITE_THEME=light\n" }, { path: "package.json", data: "<<<<<<< now\n{}\n=======\n>>>>>>> undo change 1\n" }] };
    if (path.includes("/git/stack/undo?change=chg_f")) return { title: "Undo: Theme", top: { branch: state.activeBranch, sha: state.headSha }, conflicts: ["a.txt"], files: [{ path: ".env", data: "VITE_THEME=light\n" }, { path: "a.txt", data: "<<<<<<< now\nx\n=======\n>>>>>>> undo change 1\n" }] };
    if (path.includes("/git/stack/undo?change=chg_e")) return { title: "Undo: Theme", top: { branch: state.activeBranch, sha: state.headSha }, conflicts: [], files: [{ path: ".env", data: "VITE_THEME=light\n" }], restore: [".env"] };
    if (path.includes("/git/stack/undo")) {
      const conflicted = path.includes("chg_c");
      return {
        title: "Undo: Add a", top: { branch: state.activeBranch, sha: state.headSha }, conflicts: conflicted ? ["a.txt"] : [],
        files: [{ path: "a.txt", data: conflicted ? "<<<<<<< now\nx\n=======\n>>>>>>> undo change 1\n" : "b" }],
      };
    }
    if (path.endsWith("/git/stack/restore")) {
      duringRestore();
      return { change: { id: "chg_3", position: 3, branch: "feat/s/3-three", sha: "3".repeat(40) }, below: { id: "chg_1", sha: "1".repeat(40) }, restored: 2 };
    }
    if (path.endsWith("/git/stack") && init.method === "POST") {
      duringStack();
      if (opts.stackError) throw Object.assign(new Error(opts.stackError), { status: 409, code: opts.stackError });
      if (!["main", "feat/s/1-one", "feat/s/2-two"].includes(body.from)) throw Object.assign(new Error("not a change of a stack"), { status: 409, code: "not_on_stack" });
      if (body.files.some((f: Json) => f.data === "same")) return { changed: false, sha: body.baseSha };
      return { changed: true, sha: String(++n).padStart(40, "c"), branch: "feat/s/2-two", change: { position: 2 }, stack: { id: "stk_1", name: "s" } };
    }
    if (path.endsWith("/git/stack")) return { defaultBranch: "main", stacks: [{ id: "stk_1", name: "s", baseSha: "a".repeat(40), changes: [{ branch: "feat/s/1-one" }] }] };
    if (path.endsWith("/git/sync")) {
      if (body.branch === "feat/s/1-lower") throw Object.assign(new Error("below its top"), { status: 409, code: "not_on_top" });
      duringSync();
      if (body.branch === "gone") throw Object.assign(new Error("no branch"), { status: 404, code: "branch_not_found" });
      return { branch: body.branch, sha: String(++n).padStart(40, "b"), changed: true };
    }
    if (path.endsWith("/git/merge")) {
      if (merge?.error) throw Object.assign(new Error(merge.error), { status: merge.status, code: merge.error, body: merge.body ?? {} });
      return merge ?? { mergedSha: "c".repeat(40), fastForward: true, treeChanged: false, branch: "main", deletedBranch: true };
    }
    if (path.endsWith("/git/stack/land-next") && body.change === "chg_edit") rev.n++; // an edit while it lands
    if (path.endsWith("/git/stack/land-next")) return { landed: { id: body.change }, sha: "e".repeat(40), next: { change: "chg_2", pull: { review: "pending" } } };
    if (path.endsWith("/git/stack/update")) {
      if (body.change === "chg_edit") rev.n++; // an edit while it's on GitHub
      return { change: { id: body.change, sha: "7".repeat(40) } };
    }
    if (path.includes("/git/tree")) return { sha: "d".repeat(40), files: [{ path: "a.txt", data: "pulled" }] };
    if (path.includes("/git/conflicts")) return { intoSha: "f".repeat(40), headSha: "9".repeat(40), conflicts: ["app.txt"], files: [{ path: "app.txt", data: "<<<<<<< feat/x\na\n=======\nb\n>>>>>>> main\n" }] };
    if (path.includes("/git/pulls")) return init.method === "POST" ? { pull: { number: 7, url: "u", title: "t", review: "pending", checks: "none" } } : { pull: null };
    throw new Error(`unexpected ${path}`);
  };
  const rev = { n: 0 };
  const files = { list: [{ path: "index.html", data: "<h1>hi</h1>" }] as Json[] };
  const git = createGitWorkspace({
    app: () => "shop", api, state: () => state, save: (s: Json) => void (state = s),
    files: async () => files.list,
    hydrate: hydrate ?? (async (f: Json) => void hydrated.push(f)),
    revision: () => rev.n,
  });
  return {
    git, calls, hydrated, rev, files, get state() { return state; }, set state(s: Json) { state = s; },
    get stackError() { return opts.stackError; }, set stackError(v: string | null) { opts.stackError = v; },
  };
}

test("git: branch names and commit messages come from the prompt", () => {
  assert.equal(branchSlug("Add a dark-mode toggle to the header, please!"), "add-a-dark-mode-toggle-to-the-header");
  assert.equal(branchSlug("¿Qué?"), "que");
  assert.equal(branchSlug("!!!"), "change");
  assert.equal(commitMessage("  Fix the footer\nand more"), "Fix the footer");
  assert.equal(commitMessage("x".repeat(100)).length, 72);
});

test("git: a turn's commit is a change of the stack: on its own branch from the workspace's commit, or the branch as before", async () => {
  // On the default branch: a new change (the server starts the stack); the workspace moves to its branch.
  const g = fakeGit();
  g.state.dirty = true;
  const out = await g.git.commitChange("Add a thing", "Add a thing, please");
  assert.deepEqual(g.calls.map((x) => x.path.split("/git")[1]), ["/stack"]);
  assert.deepEqual(g.calls[0].body, { from: "main", baseSha: "a".repeat(40), files: [{ path: "index.html", data: "<h1>hi</h1>" }], title: "Add a thing", prompt: "Add a thing, please" });
  assert.equal(out.change.position, 2);
  assert.deepEqual([g.state.activeBranch, g.state.headSha, g.state.baseSha, g.state.dirty], ["feat/s/2-two", "1".padStart(40, "c"), "a".repeat(40), false]);

  // Nothing changed: the workspace stays where it is.
  const same = fakeGit();
  same.state.dirty = true;
  same.files.list = [{ path: "index.html", data: "same" }];
  assert.equal((await same.git.commitChange("x")).changed, false);
  assert.deepEqual([same.state.activeBranch, same.state.dirty], ["main", false]);

  // On a stack's top change GitHub moved (the server says not_on_stack): committed to its branch, as before.
  const own = fakeGit({ onDefault: false });
  own.state.dirty = true;
  await own.git.commitChange("Fix");
  assert.deepEqual(own.calls.map((x) => x.path.split("/git")[1]), ["/stack", "/sync"]);
  assert.deepEqual([own.calls[1].body.branch, own.state.activeBranch], ["feat/x", "feat/x"]);

  // Below a stack's top (not_on_top), or GitHub unreachable: nothing committed, the changes kept here; the next
  // turn's commit sends them again.
  for (const code of ["not_on_top", "github_error"]) {
    const kept = fakeGit({ onDefault: false, stackError: code });
    kept.state.dirty = true;
    await assert.rejects(kept.git.commitChange("One"), (e: Json) => e.code === code);
    assert.deepEqual([kept.state.activeBranch, kept.state.dirty], ["feat/x", true]);
    kept.stackError = null;
    kept.state.activeBranch = "main";
    await kept.git.commitChange("Two");
    assert.deepEqual(kept.calls.map((x) => x.path.split("/git")[1]), ["/stack", "/stack"]);
    assert.deepEqual(kept.calls[1].body.files, kept.calls[0].body.files);
    assert.equal(kept.state.dirty, false);
  }

  // Finishing a merge: that's committed to its branch (with its second parent), not a new change.
  const merging = fakeGit({ onDefault: false });
  merging.state = { ...merging.state, dirty: true, mergeParent: "f".repeat(40), conflicts: [] };
  await merging.git.commitChange("Resolve");
  assert.deepEqual(merging.calls.map((x) => x.path.split("/git")[1]), ["/sync"]);
  assert.equal(merging.calls[0].body.mergeParent, "f".repeat(40));

  // The stack the workspace is on.
  const on = fakeGit();
  on.state.activeBranch = "feat/s/1-one";
  assert.equal((await on.git.stacks()).current?.id, "stk_1");
  assert.equal((await fakeGit().git.stacks()).current, null);
});

test("git: edits on a change below its stack's top (one added elsewhere) go on a branch of their own when switching away", async () => {
  const g = fakeGit({ onDefault: false });
  g.state.activeBranch = "feat/s/1-lower";
  g.state.dirty = true;
  await g.git.switchTo("feat/s/2-two");
  assert.deepEqual(g.calls.map((x) => x.path.split("/git")[1].split("?")[0]), ["/sync", "/branches", "/sync", "/tree"]);
  assert.deepEqual([g.calls[1].body.name, g.calls[2].body.branch, g.state.activeBranch], ["keep/feat-s-1-lower", "keep/feat-s-1-lower", "feat/s/2-two"]);
});

test("git: a change's fallback commit (its top moved on GitHub) commits what was read, not an edit made meanwhile", async () => {
  let g: Json;
  g = fakeGit({ onDefault: false, stackError: "not_on_stack", duringStack: () => {
    g.rev.n++;
    g.files.list = [{ path: "index.html", data: "late" }];
  } });
  g.state.dirty = true;
  await g.git.commitChange("One");
  assert.deepEqual(g.calls.map((x: Json) => x.path.split("/git")[1]), ["/stack", "/sync"]);
  assert.deepEqual(g.calls[1].body.files, g.calls[0].body.files);
  assert.equal(g.state.dirty, true); // the edit stays to commit
});

test("git: going back to a change commits changes here first, then loads its commit; restore loads the top again", async () => {
  const g = fakeGit({ onDefault: false });
  g.state.activeBranch = "feat/s/1-one"; // on the stack's top (the fake starts the next change as 2-two)
  g.state.dirty = true;
  await g.git.goBack({ id: "chg_1", branch: "feat/s/1-one", sha: "1".repeat(40) });
  // Committed as a change first (never dropped); its files in hand before the server sets anything aside.
  assert.deepEqual(g.calls.map((x: Json) => x.path.split("/git")[1]), ["/stack", `/tree?ref=${"1".repeat(40)}`, "/stack/back"]);
  assert.deepEqual([g.calls[0].body.title, g.calls[0].body.submit], ["Edits made in the studio", false]); // not auto-submitted
  assert.deepEqual(g.calls[2].body, { change: "chg_1", sha: "1".repeat(40) });
  assert.deepEqual([g.state.activeBranch, g.state.headSha, g.state.dirty], ["feat/s/1-one", "d".repeat(40), false]);
  assert.deepEqual(g.state.back, { position: 1, title: "One", setAside: ["Two", "Three"] });
  assert.deepEqual(g.hydrated, [[{ path: "a.txt", data: "pulled" }]]);
  // The next change made from here clears the note.
  g.state.dirty = true;
  g.state.activeBranch = "feat/s/1-one";
  await g.git.commitChange("Four");
  assert.equal(g.state.back, undefined);

  // An edit made while the server set them aside: they're put back, nothing is loaded over the edit.
  let e: Json;
  e = fakeGit({ onDefault: false, duringBack: () => void e.rev.n++ });
  e.state.activeBranch = "feat/s/3-three";
  await assert.rejects(e.git.goBack({ id: "chg_1", branch: "feat/s/1-one", sha: "1".repeat(40) }), /changed while/);
  assert.deepEqual(e.calls.map((x: Json) => x.path.split("/git")[1].split("?")[0]), ["/tree", "/stack/back", "/stack/restore"]);
  assert.deepEqual(e.calls[2].body, { stack: "stk_1", only: ["chg_2"] }); // only what this one set aside
  assert.deepEqual([e.state.activeBranch, e.hydrated], ["feat/s/3-three", []]);

  // Restore: refused over changes here unless they're to be dropped; the top's files first, then the server.
  const top = { id: "chg_3", branch: "feat/s/3-three", sha: "3".repeat(40) };
  const r = fakeGit({ onDefault: false });
  r.state.dirty = true;
  await assert.rejects(r.git.restore("stk_1", top), (e: Json) => e.code === "dirty");
  assert.equal(r.calls.length, 0);
  await r.git.restore("stk_1", top, true);
  assert.deepEqual(r.calls.map((x: Json) => x.path.split("/git")[1]), [`/tree?ref=${"3".repeat(40)}`, "/stack/restore"]);
  assert.deepEqual(r.calls[1].body, { stack: "stk_1", top: "chg_3", sha: "3".repeat(40) });
  assert.equal(r.state.activeBranch, "feat/s/3-three");
  // An edit made while the server restored them: set aside again (back to the top before), the edit kept.
  let re: Json;
  re = fakeGit({ onDefault: false, duringRestore: () => void re.rev.n++ });
  re.state.activeBranch = "feat/s/1-one";
  await assert.rejects(re.git.restore("stk_1", top), /changed while/);
  assert.deepEqual(re.calls.map((x: Json) => x.path.split("/git")[1].split("?")[0]), ["/tree", "/stack/restore", "/stack/back"]);
  assert.deepEqual(re.calls[2].body, { change: "chg_1", sha: "1".repeat(40), top: "chg_3", topSha: "3".repeat(40) });
  assert.deepEqual([re.state.activeBranch, re.hydrated], ["feat/s/1-one", []]);
  // The workspace is waited on by a request sent meanwhile.
  await r.git.idle();
});

test("git: a change pushed to on GitHub is loaded as GitHub has it once the server took it (pulled in, or carried on from)", async () => {
  const g = fakeGit({ onDefault: false });
  const change = { id: "chg_2", branch: "feat/s/2-two", sha: "2".repeat(40), headSha: "e".repeat(40) };
  await g.git.takeOutside("pull-in", change);
  assert.deepEqual(g.calls.map((x: Json) => x.path.split("/git")[1]), [`/tree?ref=${"e".repeat(40)}`, "/stack/pull-in"]);
  assert.deepEqual(g.calls[1].body, { change: "chg_2", sha: "e".repeat(40) });
  assert.equal(g.state.activeBranch, "feat/s/2-two");
  const d = fakeGit({ onDefault: false });
  d.state.dirty = true;
  await assert.rejects(d.git.takeOutside("carry-on", change), (e: Json) => e.code === "dirty");
  await d.git.takeOutside("carry-on", change, true);
  assert.equal(d.calls[1].path.split("/git")[1], "/stack/carry-on");
});

test("git: undoing a change loads the result; clean, it's committed at once as \"Undo: …\"; with conflicts, not until they're resolved", async () => {
  const top = { id: "chg_t", branch: "feat/s/1-one", sha: "a".repeat(40) };
  const g = fakeGit({ onDefault: false });
  g.state.activeBranch = "feat/s/1-one";
  await g.git.undo({ id: "chg_1" }, top);
  assert.deepEqual(g.calls.map((x: Json) => x.path.split("/git")[1].split("?")[0]), ["/stack/undo", "/stack"]);
  assert.equal(g.calls[1].body.title, "Undo: Add a");
  assert.deepEqual([g.state.undo, g.hydrated], [undefined, [[{ path: "a.txt", data: "b" }]]]);

  const c = fakeGit({ onDefault: false });
  c.state.activeBranch = "feat/s/1-one";
  const r = await c.git.undo({ id: "chg_c" }, top);
  assert.deepEqual([r.conflicts, c.state.undo, c.state.dirty], [["a.txt"], { title: "Undo: Add a", conflicts: ["a.txt"] }, true]);
  assert.deepEqual(c.calls.map((x: Json) => x.path.split("/git")[1].split("?")[0]), ["/stack/undo"]); // nothing committed
  c.files.list = [{ path: "a.txt", data: "<<<<<<< now\nx\n=======\n>>>>>>> undo change 1\n" }];
  await assert.rejects(c.git.commitChange("Fix it", "resolve"), (e: Json) => e.code === "conflicts_left");
  // As the workspace may export text: base64.
  c.files.list = [{ path: "a.txt", data: Buffer.from("<<<<<<< now\nx\n=======\n>>>>>>> undo change 1\n").toString("base64"), encoding: "base64" }];
  await assert.rejects(c.git.commitChange("Fix it", "resolve"), (e: Json) => e.code === "conflicts_left");
  // Pushing it (or opening a pull request, switching branch): a change of its own too, never a commit onto the top.
  await assert.rejects(c.git.sync("Update"), (e: Json) => e.code === "conflicts_left");
  c.files.list = [{ path: "a.txt", data: "x" }];
  await c.git.sync("Update");
  assert.deepEqual([c.calls.at(-1)!.path.split("/git")[1], c.calls.at(-1)!.body.title], ["/stack", "Undo: Add a"]);
  assert.equal(c.state.undo, undefined);

  // Edits here: committed first as a change of their own; the undo goes on that (the server's top is the new one).
  const d = fakeGit({ onDefault: false });
  d.state.activeBranch = "feat/s/1-one";
  d.state.dirty = true;
  const u = await d.git.undo({ id: "chg_1" }, top);
  assert.deepEqual(d.calls.map((x: Json) => x.path.split("/git")[1].split("?")[0]), ["/stack", "/stack/undo", "/stack"]);
  assert.deepEqual([d.calls[0].body.title, d.calls[2].body.title, u.committed], ["Edits made in the studio", "Undo: Add a", true]);
  // Loaded, but its commit refused (the top moved meanwhile): held, and said so.
  const h = fakeGit({ onDefault: false, stackError: "moved" });
  h.state.activeBranch = "feat/s/1-one";
  await assert.rejects(h.git.undo({ id: "chg_1" }, top), (x: Json) => x.held === true && x.code === "moved");
  assert.deepEqual([h.state.undo, h.state.dirty], [{ title: "Undo: Add a", conflicts: [] }, true]);
  // A dotenv file the workspace kept as it was (its own lines in the way): held, not committed, the path said.
  const k = fakeGit({ onDefault: false });
  k.state.activeBranch = "feat/s/1-one";
  k.files.list = [{ path: ".env", data: "VITE_THEME=dark\n" }];
  await assert.rejects(k.git.undo({ id: "chg_e", position: 1 }, top), (x: Json) => x.held === true && x.code === "dotenv_kept" && /\.env/.test(x.message));
  assert.deepEqual([k.state.undo?.title, k.calls.some((x: Json) => x.path.endsWith("/git/stack"))], ["Undo: Theme", false]);
  // Committing it (Push, a request): refused until the file is put back, then committed.
  await assert.rejects(k.git.commitChange("Commit the undo"), (x: Json) => x.code === "dotenv_kept");
  k.files.list = [{ path: ".env", data: "VITE_THEME=light\n" }];
  await k.git.commitChange("Commit the undo");
  assert.deepEqual([k.calls.at(-1)!.body.title, k.state.undo], ["Undo: Theme", undefined]);
  // One it leaves as it is but the workspace kept otherwise (its own lines in the way): held to it too.
  const drift = fakeGit({ onDefault: false });
  drift.state.activeBranch = "feat/s/1-one";
  drift.files.list = [{ path: ".env", data: "VITE_THEME=old\n" }];
  await assert.rejects(drift.git.undo({ id: "chg_f", position: 1 }, top), (x: Json) => x.held === true && x.code === "dotenv_kept");
  assert.deepEqual(drift.state.undo?.env, [{ path: ".env", data: "VITE_THEME=light\n" }]);
  // npm install failing after the files are in (a conflicted package.json): checked all the same.
  const deps = fakeGit({ onDefault: false, hydrate: async () => { throw Object.assign(new Error("npm install failed"), { filesWritten: true }); } });
  deps.state.activeBranch = "feat/s/1-one";
  deps.files.list = [{ path: ".env", data: "VITE_THEME=old\n" }];
  assert.deepEqual((await deps.git.undo({ id: "chg_p", position: 1 }, top)).conflicts, ["package.json"]);
  assert.deepEqual(deps.state.undo?.env, [{ path: ".env", data: "VITE_THEME=light\n" }]);
  deps.files.list = [{ path: ".env", data: "VITE_THEME=old\n" }, { path: "package.json", data: "{}" }];
  await assert.rejects(deps.git.commitChange("Commit the undo"), (x: Json) => x.code === "dotenv_kept");
  // A dotenv file the undo leaves as it is: not held to it (resolving may change it).
  const same = fakeGit({ onDefault: false });
  same.state.activeBranch = "feat/s/1-one";
  same.files.list = [{ path: ".env", data: "VITE_THEME=light\n" }];
  await same.git.undo({ id: "chg_f", position: 1 }, top);
  assert.equal(same.state.undo?.env, undefined);
  same.files.list = [{ path: ".env", data: "VITE_THEME=dark\n" }, { path: "a.txt", data: "x" }];
  await same.git.commitChange("Commit the undo");
  assert.equal(same.calls.at(-1)!.body.title, "Undo: Theme");
  const kk = fakeGit({ onDefault: false });
  kk.state.activeBranch = "feat/s/1-one";
  kk.files.list = [{ path: ".env", data: "VITE_THEME=light\n" }]; // put back: committed
  assert.equal((await kk.git.undo({ id: "chg_e", position: 1 }, top)).committed, true);
  // The stack not as the caller saw it: nothing done.
  const e = fakeGit({ onDefault: false });
  e.state.activeBranch = "feat/s/1-one";
  await assert.rejects(e.git.undo({ id: "chg_1" }, { ...top, sha: "f".repeat(40) }), (x: Json) => x.code === "changed");
  assert.deepEqual(e.calls, []);
});

test("git: Land next lands the bottom through its pull request (the workspace on it goes to the default branch); Update loads the bottom's new commit", async () => {
  const bottom = { id: "chg_1", branch: "feat/s/1-one", sha: "1".repeat(40), pull: 1 };
  // On the landed change: loads the default branch.
  const g = fakeGit({ onDefault: false });
  g.state.activeBranch = bottom.branch;
  const r = await g.git.landNext(bottom, "feat/s/3-three");
  assert.deepEqual([g.calls[0].body, r.next.pull.review], [{ change: "chg_1", sha: bottom.sha }, "pending"]);
  assert.equal(g.state.activeBranch, "main");
  // An edit made while it lands: not overwritten (landed all the same, said).
  const e = fakeGit({ onDefault: false });
  e.state.activeBranch = bottom.branch;
  await assert.rejects(e.git.landNext({ ...bottom, id: "chg_edit" }, "feat/s/3-three"), (x: Json) => x.landed?.sha === "e".repeat(40) && /landed in main, but main isn't loaded here/.test(x.message));
  assert.deepEqual([e.state.activeBranch, e.hydrated], [bottom.branch, []]);
  // Changes not pushed on it: refused (its branch goes).
  const d = fakeGit({ onDefault: false });
  d.state.activeBranch = bottom.branch;
  d.state.dirty = true;
  await assert.rejects(d.git.landNext(bottom, "feat/s/3-three"), (e: Json) => e.code === "dirty");
  assert.deepEqual(d.calls, []);
  // On the top above it: stays, on the merge.
  const t = fakeGit({ onDefault: false });
  t.state.activeBranch = "feat/s/3-three";
  await t.git.landNext(bottom, "feat/s/3-three");
  assert.deepEqual([t.state.activeBranch, t.state.baseSha, t.calls.length], ["feat/s/3-three", "e".repeat(40), 1]);

  // Update: on it with changes not pushed, refused; on it, its new commit loaded.
  const u = fakeGit({ onDefault: false });
  u.state.activeBranch = bottom.branch;
  u.state.dirty = true;
  await assert.rejects(u.git.updateBottom(bottom), (e: Json) => e.code === "dirty");
  u.state.dirty = false;
  assert.equal((await u.git.updateBottom(bottom)).sha, "7".repeat(40));
  assert.deepEqual(u.calls.map((x: Json) => x.path.split("/git")[1].split("?")[0]), ["/stack/update", "/tree"]);
  // An edit made while it's updated on GitHub: not overwritten (updated there all the same, said).
  const e = fakeGit({ onDefault: false });
  e.state.activeBranch = bottom.branch;
  await assert.rejects(e.git.updateBottom({ ...bottom, id: "chg_edit" }), (x: Json) => x.updated?.sha === "7".repeat(40) && /up to date on GitHub, but not loaded here/.test(x.message));
  assert.deepEqual(e.hydrated, []);
});

test("git: why Land next can't land the bottom yet, from its pull request", () => {
  const c = { pull: 1 }, p = (x: Json) => ({ review: "approved", checks: "success", mergeable: "clean", ...x });
  assert.match(landBlocked({ pull: null }, undefined, "main"), /submit the stack/);
  assert.equal(landBlocked(c, p({}), "main"), null);
  assert.equal(landBlocked(c, p({ mergeable: "blocked", review: "pending" }), "main"), "waiting for review");
  assert.equal(landBlocked(c, p({ mergeable: "blocked", review: "changes_requested" }), "main"), "changes requested");
  assert.equal(landBlocked(c, p({ mergeable: "blocked", checks: "pending" }), "main"), "checks running");
  assert.equal(landBlocked(c, p({ mergeable: "blocked", checks: "failure" }), "main"), "checks failing");
  assert.match(landBlocked(c, p({ mergeable: "behind" }), "main"), /behind main.*Update/);
  assert.match(landBlocked(c, p({ mergeable: "dirty" }), "main"), /conflicts with main/);
  assert.equal(landBlocked(c, p({ mergeable: "unstable", checks: "failure" }), "main"), null); // (an optional check: GitHub would merge it)
});

test("git: switching away from the default branch with edits puts them on a branch of their own first", async () => {
  const g = fakeGit();
  g.state.dirty = true;
  await g.git.switchTo("feat/s/1-one");
  assert.deepEqual(g.calls.map((x) => x.path.split("/git")[1].split("?")[0]), ["/branches", "/sync", "/tree"]);
  assert.equal(g.calls[0].body.name, "edit/changes");
  assert.equal(g.calls[1].body.branch, "edit/changes");
  assert.equal(g.state.activeBranch, "feat/s/1-one");
});

test("AI builder: the repository and branch go to Claude with each message", async () => {
  const api = fakeClient([{ text: ["ok"], content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }]);
  const agent = createAgent({ client: async () => api, tools: createTools(fakeContainer()), context: () => "[Source control: on feat/x]" });
  await agent.send("hi");
  assert.deepEqual(api.calls[0].params.messages[0].content, [{ type: "text", text: "[Source control: on feat/x]" }, { type: "text", text: "hi" }]);
  assert.equal(api.calls[0].params.system, SYSTEM); // the cached prefix doesn't change
});

test("deploy on a linked app: commit the branch, merge it into main, build main (loading its files if main moved)", async () => {
  const g = fakeGit({ onDefault: false });
  g.state.dirty = true;
  const prov = await g.git.prepareDeploy();
  assert.deepEqual(g.calls.map((x) => x.path.split("/git")[1]), ["/sync", "/merge"]);
  assert.equal(g.calls[0].body.branch, "feat/x");
  assert.deepEqual(g.calls[0].body.files, [{ path: "index.html", data: "<h1>hi</h1>" }]);
  assert.deepEqual(prov, { sha: "c".repeat(40), branch: "main", repo: "octo/shop", files: [{ path: "index.html", data: "<h1>hi</h1>" }] });
  assert.equal(g.state.activeBranch, "main"); // back on main, at the merge
  assert.equal(g.state.headSha, "c".repeat(40));
  assert.equal(g.state.dirty, false);
  assert.deepEqual(g.hydrated, []);

  // main had commits of its own: its merged files are loaded before the build.
  const moved = fakeGit({ onDefault: false, merge: { mergedSha: "e".repeat(40), fastForward: false, treeChanged: true, files: [{ path: "NOTES.md", data: "up" }] } });
  const movedProv = await moved.git.prepareDeploy();
  assert.deepEqual(moved.hydrated, [[{ path: "NOTES.md", data: "up" }]]);
  assert.deepEqual(movedProv.files, [{ path: "NOTES.md", data: "up" }]); // the merge's own files, not the workspace after npm install

  // Edits on main: a change of their own first, then merged like any other.
  const edited = fakeGit();
  edited.state.dirty = true;
  const p1 = await edited.git.prepareDeploy();
  assert.deepEqual(edited.calls.map((x) => x.path.split("/git")[1]), ["/stack", "/merge"]);
  assert.deepEqual([edited.calls[0].body.from, edited.calls[1].body.branch], ["main", "feat/s/2-two"]);
  assert.equal(p1.branch, "main");

  // Claude deploys mid-turn: that turn is a change of its own (its title and prompt) first, and that commit is built.
  const turn = fakeGit({ onDefault: false });
  turn.state.activeBranch = "feat/s/1-one";
  turn.state.dirty = true;
  const p3 = await turn.git.prepareDeploy(() => {}, undefined, { turn: () => ({ title: "Dark mode", prompt: "Dark mode please" }), running: () => true });
  assert.deepEqual(turn.calls.map((x) => x.path.split("/git")[1]), ["/stack", "/merge"]);
  assert.deepEqual([turn.calls[0].body.title, turn.calls[0].body.prompt, turn.calls[0].body.submit, turn.calls[1].body.branch], ["Dark mode", "Dark mode please", false, "feat/s/2-two"]);
  assert.equal(turn.calls[1].body.headSha, "1".padStart(40, "c"));
  assert.equal(p3.branch, "main");
  // Deployed by hand while the builder works on a request (checked when the step runs, after any queued before it):
  // refused, nothing sent.
  const busy = fakeGit({ onDefault: false });
  busy.state.dirty = true;
  let working = false;
  const queued = busy.git.sync("before");
  const refused = busy.git.prepareDeploy(() => {}, undefined, { turn: () => (working ? { title: "x", prompt: "x" } : null), running: () => false });
  working = true; // the request starts while the deploy waits behind the sync
  await queued;
  await assert.rejects(refused, /AI builder is working on a request/);
  assert.deepEqual(busy.calls.map((x: Json) => x.path.split("/git")[1]), ["/sync"]);

  // An edit made while that change was being committed: nothing merged, nothing synced on its own (onto main); it
  // stays here.
  let late: Json;
  late = fakeGit({ duringStack: () => void late.rev.n++ });
  late.state.dirty = true;
  late.files.list = [{ path: "index.html", data: "same" }]; // the change itself is a no-op: still on main
  await assert.rejects(late.git.prepareDeploy(), /changed while deploying/);
  assert.deepEqual(late.calls.map((x: Json) => x.path.split("/git")[1]), ["/stack"]);
  assert.deepEqual([late.state.activeBranch, late.state.dirty], ["main", true]);

  // On main already: just the commit.
  const main = fakeGit();
  const p2 = await main.git.prepareDeploy();
  assert.deepEqual(main.calls.map((x) => x.path.split("/git")[1]), ["/sync"]);
  assert.equal(p2.branch, "main");
});

test("deploy on a linked app: a conflict or a protected main stops it, with a pull request link", async () => {
  const cf = fakeGit({ onDefault: false, merge: { error: "merge_conflict", status: 409, body: { paths: ["src/App.tsx"] } } });
  await assert.rejects(cf.git.prepareDeploy(), (e: Json) => {
    assert.match(e.message, /doesn't merge cleanly.*src\/App\.tsx.*Nothing was deployed/);
    assert.equal(e.compare, "https://github.example/octo/shop/compare/main...feat%2Fx?expand=1");
    return true;
  });
  assert.equal(cf.state.activeBranch, "feat/x"); // still on the branch, to fix it
  const big = fakeGit({ onDefault: false, merge: { mergedSha: "e".repeat(40), fastForward: false, treeChanged: true, filesError: "too many files" } });
  await assert.rejects(big.git.prepareDeploy(), /couldn't load the result \(too many files\)\. Nothing was deployed/);
  assert.equal(big.state.activeBranch, "feat/x");
  const pr = fakeGit({ onDefault: false, merge: { error: "branch_protected", status: 422 } });
  await assert.rejects(pr.git.prepareDeploy(), /protected on GitHub.*pull request/);
});

test("git: steps run one at a time; switching branches pushes changes first; New chat's way back to main", async () => {
  const g = fakeGit({ onDefault: false });
  g.state.dirty = true;
  await Promise.all([g.git.newBranch("keep", "x"), g.git.switchTo("main")]);
  assert.deepEqual(g.calls.map((x) => x.path.split("/git")[1].split("?")[0]), ["/branches", "/sync", "/tree"]); // in order
  assert.equal(g.calls[1].body.branch, "keep/x");
  assert.equal(g.state.activeBranch, "main");
  assert.equal(g.state.baseSha, "d".repeat(40));
  assert.deepEqual(g.hydrated, [[{ path: "a.txt", data: "pulled" }]]);
});

test("git: an edit made while a sync is on its way keeps the workspace dirty (a branch switch then pushes it)", async () => {
  let g: Json;
  g = fakeGit({ onDefault: false, duringSync: () => void g.rev.n++ });
  g.state.dirty = true;
  await g.git.sync("x");
  assert.equal(g.state.dirty, true);
  const quiet = fakeGit({ onDefault: false });
  quiet.state.dirty = true;
  await quiet.git.sync("x");
  assert.equal(quiet.state.dirty, false);
});

test("deploy on a linked app: merges exactly the commit it synced; stopped before the merge, nothing merges", async () => {
  const g = fakeGit({ onDefault: false });
  await g.git.prepareDeploy();
  assert.equal(g.calls[1].body.headSha, "1".padStart(40, "b")); // the sync's commit
  const stopped = fakeGit({ onDefault: false });
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(stopped.git.prepareDeploy(() => {}, ctl.signal));
  assert.deepEqual(stopped.calls, []);
});

test("deploy on a linked app: npm install failing after the merged files are in leaves the workspace on main", async () => {
  const g = fakeGit({
    onDefault: false,
    merge: { mergedSha: "e".repeat(40), fastForward: false, treeChanged: true, files: [{ path: "a", data: "1" }] },
    hydrate: async () => { throw Object.assign(new Error("npm install failed"), { filesWritten: true }); },
  });
  await assert.rejects(g.git.prepareDeploy(), /npm install failed/);
  assert.deepEqual([g.state.activeBranch, g.state.headSha], ["main", "e".repeat(40)]);
  // A branch merged and deleted on GitHub meanwhile: said plainly.
  const gone = fakeGit({ onDefault: false });
  gone.state = { ...gone.state, activeBranch: "gone" };
  await assert.rejects(gone.git.prepareDeploy(), /gone is gone on GitHub .*Switch to main/);
});

test("git: an app linked elsewhere is adopted by loading its default branch", async () => {
  const g = fakeGit();
  g.state = undefined;
  await g.git.adopt({ provider: "github", owner: "octo", name: "shop", url: "https://github.example/octo/shop", defaultBranch: "main" });
  assert.deepEqual(g.hydrated, [[{ path: "a.txt", data: "pulled" }]]);
  assert.deepEqual([g.state.activeBranch, g.state.headSha, g.state.baseSha], ["main", "d".repeat(40), "d".repeat(40)]);
});

test("git: a pull or switch whose npm install fails is still on the branch whose files it wrote; changes made meanwhile stop it", async () => {
  const g = fakeGit({ onDefault: false, hydrate: async () => { throw Object.assign(new Error("npm install failed"), { filesWritten: true }); } });
  await assert.rejects(g.git.switchTo("main"), /npm install failed/);
  assert.deepEqual([g.state.activeBranch, g.state.headSha], ["main", "d".repeat(40)]);
  const adopted = fakeGit({ hydrate: async () => { throw Object.assign(new Error("npm install failed"), { filesWritten: true }); } });
  adopted.state = undefined;
  await assert.rejects(adopted.git.adopt({ provider: "github", owner: "o", name: "r", url: "u", defaultBranch: "main" }));
  assert.equal(adopted.state.activeBranch, "main"); // still linked: its files are in

  // An edit while the switch's push was on its way: the switch stops, nothing is overwritten.
  let busy: Json;
  busy = fakeGit({ onDefault: false, duringSync: () => void busy.rev.n++ });
  busy.state.dirty = true;
  await assert.rejects(busy.git.switchTo("main"), /changed while/);
  assert.deepEqual(busy.hydrated, []);
  assert.equal(busy.state.activeBranch, "feat/x");
});

test("deploy on a linked app: an edit made while it syncs stops it before the merge", async () => {
  let g: Json;
  g = fakeGit({ onDefault: false, duringSync: () => void g.rev.n++ });
  await assert.rejects(g.git.prepareDeploy(), /changed while deploying/);
  assert.deepEqual(g.calls.map((x: Json) => x.path.split("/git")[1]), ["/sync"]);
  assert.equal(g.state.dirty, true);
});

test("dotenv: a file's private lines are exactly those the deploy filter doesn't keep", async () => {
  const { privateDotenvLines, publicDotenv } = await import("../studio/cresslet-plugin.ts" as string);
  const text = "# config\nVITE_A=1 # note\nSECRET=s\n\nVITE_B=2\nKEY=\"-----BEGIN\nVITE_INSIDE=1\n-----END\"\nVITE_AFTER=3\n";
  assert.equal(publicDotenv(text), "VITE_A=1\n\nVITE_B=2");
  // Everything publicDotenv drops is kept as written: comments, private entries, and all lines from the multi-line
  // value on (its VITE_ lines are part of a private value, not entries).
  assert.deepEqual(privateDotenvLines(text), ["# config", "SECRET=s", "KEY=\"-----BEGIN", "VITE_INSIDE=1", "-----END\"", "VITE_AFTER=3", ""]);
});

test("cresslet deploy on a linked app: the upload is refused if the source isn't what was committed", async () => {
  const { createCresslet, sourceDigest } = await import("../studio/cresslet-plugin.ts" as string);
  const c = fakeContainer({ "index.html": "<h1>v2</h1>", "cresslet.json": "{}" });
  const realFetch = globalThis.fetch;
  const posted: Json[] = [];
  globalThis.fetch = (async (_u: string, init: Json) => (posted.push(init), new Response(JSON.stringify({ app: { name: "a", url: "u", claimed: true } }), { status: 201 }))) as typeof fetch;
  Object.assign(c, {
    async build() { return { files: [] }; },
    async bundle() { return { outputFiles: [] }; },
    async export() { return { "index.html": { file: { contents: c.files.get("/project/index.html") } }, "cresslet.json": { file: { contents: "{}" } } }; },
    registerCommand() {},
  });
  try {
    const committed = sourceDigest([{ path: "cresslet.json", data: "{}" }, { path: "index.html", data: "<h1>v1</h1>" }]);
    const cr = createCresslet(c as Json, { auth: () => ({}), project: () => ({ deploy: { name: "a" } }), beforeDeploy: async () => ({ sha: "a".repeat(40), branch: "main", repo: "o/r", source: committed }) });
    await assert.rejects(cr.deploy(), /changed while building/);
    assert.equal(posted.length, 0);
    const same = createCresslet(c as Json, { auth: () => ({}), project: () => ({ deploy: { name: "a" } }), beforeDeploy: async () => ({ sha: "a".repeat(40), branch: "main", repo: "o/r", source: sourceDigest([{ path: "cresslet.json", data: "{}" }, { path: "index.html", data: "<h1>v2</h1>" }]) }) });
    await same.deploy();
    assert.equal(posted.length, 1);
    assert.deepEqual(JSON.parse(posted[0].body).git, { sha: "a".repeat(40), branch: "main", repo: "o/r" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("source digests compare bytes, whichever way a file was sent", async () => {
  const { sourceDigest } = await import("../studio/cresslet-plugin.ts" as string);
  assert.equal(sourceDigest([{ path: "a", data: "héllo" }]), sourceDigest([{ path: "a", data: Buffer.from("héllo").toString("base64"), encoding: "base64" }]));
  assert.notEqual(sourceDigest([{ path: "a", data: "x" }]), sourceDigest([{ path: "a", data: "y" }]));
});

test("dotenv hydration: the repository's public entries exactly, the file's own private lines kept", async () => {
  const { mergeDotenv, publicDotenv } = await import("../studio/cresslet-plugin.ts" as string);
  // Plain: private kept, public replaced (a stale one among the private lines dropped).
  const out = mergeDotenv("VITE_API=old\nSECRET=s\nVITE_MODE=stale\n", "VITE_API=new\nVITE_MODE=new\n");
  assert.equal(publicDotenv(out), "VITE_API=new\nVITE_MODE=new\n");
  assert.match(out, /SECRET=s/);
  assert.doesNotMatch(out, /stale|old/);
  // A multi-line private value: kept intact, after the public entries, and the export is still exactly the incoming.
  const pem = "KEY=\"-----BEGIN\nabc\n-----END\"\n";
  const merged = mergeDotenv(pem, "VITE_API=new\n");
  assert.equal(publicDotenv(merged), "VITE_API=new\n");
  assert.ok(merged.includes(pem.trimEnd()));
  // No final newline upstream: still exact.
  assert.equal(publicDotenv(mergeDotenv("SECRET=s\n", "VITE_A=1")), "VITE_A=1");
  // Nothing private: the incoming file as is.
  assert.equal(mergeDotenv("VITE_A=0\n", "VITE_A=1\n"), "VITE_A=1\n");
});

test("merge conflicts resolved here: main's merge loaded with markers, not committed until they're gone, then committed with main as a parent", async () => {
  const g = fakeGit({ onDefault: false });
  const paths = await g.git.resolveConflicts();
  assert.deepEqual(paths, ["app.txt"]);
  assert.match(g.hydrated[0][0].data, /^<<<<<<< feat\/x/);
  assert.deepEqual([g.state.mergeParent, g.state.headSha, g.state.dirty], ["f".repeat(40), "9".repeat(40), true]);
  g.files.list = g.hydrated[0];
  await assert.rejects(g.git.sync("resolve"), /markers left in app\.txt/);
  g.files.list = [{ path: "app.txt", data: "a and b\n" }];
  await g.git.sync("resolve");
  const sync = g.calls.at(-1)!;
  assert.equal(sync.body.mergeParent, "f".repeat(40));
  assert.equal(sync.body.baseSha, "9".repeat(40));
  assert.equal(g.state.mergeParent, undefined);
  assert.equal(g.state.conflicts, undefined);
});

test("pull requests from the active branch: pushed first, then opened", async () => {
  const g = fakeGit({ onDefault: false });
  g.state.dirty = true;
  const pr = await g.git.openPullRequest();
  assert.equal(pr.number, 7);
  assert.deepEqual(g.calls.map((x) => x.path.split("/git")[1]), ["/sync", "/pulls"]);
  assert.equal(g.calls[1].body.branch, "feat/x");
  assert.equal(await g.git.pullRequest(), null);
});

test("merge conflicts: npm install failing after the merge's files are in still leaves the merge loaded (and says so unless package.json conflicted)", async () => {
  const g = fakeGit({ onDefault: false, hydrate: async () => { throw Object.assign(new Error("npm install failed"), { filesWritten: true }); } });
  await assert.rejects(g.git.resolveConflicts(), /npm install failed/); // app.txt conflicted, not package.json: said
  assert.equal(g.state.mergeParent, "f".repeat(40)); // but loaded
});
