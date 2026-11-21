// AI builder: a chat that changes the open project. Claude is called straight from this browser with the user's own
// Anthropic API key, and its tools act on the same things the user does: the project's files in the container, the
// in-browser shell, and `cresslet deploy` (the same control-plane API the CLI uses). No server endpoint of its own.
// No DOM here (app.js renders): the loop and the tools also run under node for tests/builder_test.ts.

export const MODEL = "claude-opus-5-5";
const MAX_TOKENS = 64000;
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 16_000; // chars of command / dev server output handed back (the tail: errors come last)
const MAX_READ = 256_000; // chars of one file
const MAX_LIST = 2000; // paths in one listing

export const SYSTEM = `You are the AI builder in Cresslet Studio. You change one Cresslet app (a small web app: client code bundled by esbuild, an optional server fetch handler with SQLite and file storage) that the user has open in their browser.

How you work:
- Your tools act on the project's files and an in-browser shell. Paths are relative to the project root.
- Read AGENTS.md first if the project has one: it describes the app format, the server rules and the commands.
- The dev server (\`cresslet dev\`) is already running in the studio's terminal and reloads the preview when files change. Don't start another one or anything else that keeps running: commands are stopped after ${COMMAND_TIMEOUT_MS / 1000} seconds. Use read_dev_log to see its output, such as build errors after an edit.
- \`npm install <pkg>\` works in the shell. \`cresslet build\` builds; \`cresslet deploy\` builds and deploys the app with the user's Cresslet session (it goes live at once), so run it only when the user asks you to deploy.
- Local secret files (.env*, .dev.vars, .envrc) are not available to your file tools. Don't try to read them another way.
- Prefer small, targeted edits (edit_file) to rewriting whole files.
- When you're done, say briefly what you changed. The user sees the preview update by itself.`;

const str = (description) => ({ type: "string", description });
const tool = (name, description, properties = {}, required = Object.keys(properties)) => ({
  name,
  description,
  // Large inputs (file contents) stream as they're generated; inputs are then validated here (validate below).
  eager_input_streaming: true,
  input_schema: { type: "object", properties, required, additionalProperties: false },
});

export const TOOLS = [
  tool("list_files", "List the project's files (recursively, without node_modules, dist and .cresslet).", { dir: str("Directory to list, relative to the project root. Omit for the whole project.") }, []),
  tool("read_file", "Read a text file.", { path: str("File path, relative to the project root.") }),
  tool("write_file", "Create or overwrite a file with the given contents (parent directories are created).", { path: str("File path, relative to the project root."), content: str("The whole new file contents.") }),
  tool("edit_file", "Replace one exact occurrence of old_text in a file with new_text. old_text must appear exactly once: include enough surrounding lines to make it unique.", { path: str("File path, relative to the project root."), old_text: str("Exact text to replace, whitespace included."), new_text: str("Replacement text.") }),
  tool("delete_file", "Delete a file.", { path: str("File path, relative to the project root.") }),
  tool("run_command", `Run a shell command in the project root (the in-browser shell: npm, node, cresslet build|deploy, ls, cat, and the like) and get its exit code and output. Stopped after ${COMMAND_TIMEOUT_MS / 1000} seconds.`, { command: str("The command line.") }),
  tool("read_dev_log", "Read the latest output of the studio's terminal, where the dev server runs (build errors, server logs)."),
];

/** The tool's input against its schema (eager input streaming means the API no longer checks it). */
export function validate(name, input) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return `unknown tool: ${name}`;
  if (!input || typeof input !== "object" || Array.isArray(input)) return "input must be an object";
  const { properties, required } = t.input_schema;
  for (const k of Object.keys(input)) if (!(k in properties)) return `unexpected field: ${k}`;
  for (const k of required) if (!(k in input)) return `missing field: ${k}`;
  for (const [k, v] of Object.entries(input)) if (typeof v !== "string") return `${k} must be a string`;
  return null;
}

const SECRET = /(?:^|\/)(?:\.env[^/]*|\.envrc[^/]*|\.dev\.vars[^/]*)$/i;
const SKIP = /^(?:node_modules|dist|\.cresslet|\.git)(?:\/|$)/;

/** A model-supplied path, confined to the project: relative, no `..`, not a local secret or .git. Throws otherwise. */
export function projectPath(p, { dir = false } = {}) {
  if (typeof p !== "string") throw new Error("path must be a string");
  const parts = p.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
  if (p.startsWith("/") || parts.includes("..")) throw new Error(`path must stay inside the project: ${p}`);
  const rel = parts.join("/");
  if (!rel && !dir) throw new Error("path is empty");
  if (SECRET.test(rel)) throw new Error(`${rel} is a local secrets file; it isn't available to the AI builder`);
  if (/^\.git(?:\/|$)/.test(rel)) throw new Error(".git isn't available to the AI builder");
  return rel;
}

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\r(?!\n)/g;
export const plain = (s) => s.replace(ANSI, "");
const tail = (s, n = MAX_OUTPUT) => (s.length > n ? `[… ${s.length - n} earlier characters not shown]\n${s.slice(-n)}` : s);

/**
 * The tools, over a cresslet-container (`c.fs`, `c.spawn`, `c.workdir`).
 * `devLog()`: the studio terminal's output so far; `onChange(path)`: after a file was written or deleted.
 */
export function createTools(c, { devLog = () => "", onChange = () => {}, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const wd = c.workdir;
  const abs = (rel) => (rel ? `${wd}/${rel}` : wd);

  async function list(dir, out = []) {
    const entries = await c.fs.readdir(abs(dir), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (SKIP.test(rel)) continue;
      if (out.length >= MAX_LIST) break;
      if (e.isDirectory()) await list(rel, out);
      else out.push(SECRET.test(rel) ? `${rel} (local secrets, not readable)` : rel);
    }
    return out;
  }

  async function exists(rel) {
    try {
      return await c.fs.exists(abs(rel));
    } catch {
      return false;
    }
  }

  async function readText(rel) {
    if (!(await exists(rel))) throw new Error(`no such file: ${rel}`);
    const text = await c.fs.readFile(abs(rel), "utf8");
    if (text.includes("\u0000")) throw new Error(`${rel} looks like a binary file`);
    return text;
  }

  async function write(rel, content) {
    const i = rel.lastIndexOf("/");
    if (i > 0) await c.fs.mkdir(abs(rel.slice(0, i)), { recursive: true });
    await c.fs.writeFile(abs(rel), content);
    onChange(rel);
  }

  async function run(command, signal) {
    const proc = await c.spawn("jsh", ["-c", command], { cwd: wd });
    let out = "";
    const reading = proc.output.pipeTo(new WritableStream({ write: (d) => void (out += d) })).catch(() => {});
    await proc.input.close().catch(() => {}); // no stdin: a command that waits for input gets EOF
    let timer, stop;
    const stopped = new Promise((r) => {
      timer = setTimeout(() => r("timeout"), timeoutMs);
      stop = () => r("stopped");
      if (signal?.aborted) stop();
      else signal?.addEventListener("abort", stop, { once: true });
    });
    const code = await Promise.race([proc.exit, stopped]);
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    if (typeof code !== "number") proc.kill();
    await Promise.race([reading, new Promise((r) => setTimeout(r, 200))]);
    const text = tail(plain(out).trimEnd());
    if (code === "timeout") return { error: true, text: `stopped after ${timeoutMs / 1000}s (still running)\n${text}` };
    if (code === "stopped") return { error: true, text: `stopped by the user\n${text}` };
    return { error: code !== 0, text: `exit code ${code}\n${text}` };
  }

  /** Runs one tool call. Resolves to { text, error, summary } (summary: one line for the chat). Never throws. */
  async function execute(name, input, signal) {
    const bad = validate(name, input);
    if (bad) return { error: true, text: `invalid input: ${bad}`, summary: `${name}: invalid input` };
    try {
      switch (name) {
        case "list_files": {
          const dir = projectPath(input.dir ?? "", { dir: true });
          const files = await list(dir);
          const more = files.length >= MAX_LIST ? `\n[listing stopped at ${MAX_LIST} files]` : "";
          return { text: (files.join("\n") || "(no files)") + more, summary: `Listed ${dir || "files"}` };
        }
        case "read_file": {
          const rel = projectPath(input.path);
          const text = await readText(rel);
          if (text.length > MAX_READ) {
            return { error: true, text: `${rel} is ${text.length} characters, over the ${MAX_READ} this tool reads; use run_command (e.g. head, grep) to look at parts of it`, summary: `Read ${rel}` };
          }
          return { text, summary: `Read ${rel}` };
        }
        case "write_file": {
          const rel = projectPath(input.path);
          const existed = await exists(rel);
          await write(rel, input.content);
          return { text: `wrote ${rel} (${input.content.length} characters)`, summary: `${existed ? "Rewrote" : "Created"} ${rel}` };
        }
        case "edit_file": {
          const rel = projectPath(input.path);
          const text = await readText(rel);
          if (!input.old_text) throw new Error("old_text is empty");
          const at = text.indexOf(input.old_text);
          if (at < 0) throw new Error(`old_text not found in ${rel}`);
          if (text.indexOf(input.old_text, at + 1) >= 0) throw new Error(`old_text appears more than once in ${rel}; include more surrounding text`);
          await write(rel, text.slice(0, at) + input.new_text + text.slice(at + input.old_text.length));
          return { text: `edited ${rel}`, summary: `Edited ${rel}` };
        }
        case "delete_file": {
          const rel = projectPath(input.path);
          if (!(await exists(rel))) throw new Error(`no such file: ${rel}`);
          await c.fs.rm(abs(rel));
          onChange(rel);
          return { text: `deleted ${rel}`, summary: `Deleted ${rel}` };
        }
        case "run_command": {
          const r = await run(input.command, signal);
          return { ...r, summary: `Ran ${input.command}` };
        }
        case "read_dev_log":
          return { text: tail(plain(devLog()).trimEnd()) || "(no output yet)", summary: "Read the dev server output" };
      }
    } catch (e) {
      return { error: true, text: e?.message ?? String(e), summary: `${name}: ${e?.message ?? e}` };
    }
    return { error: true, text: `unknown tool: ${name}`, summary: `unknown tool: ${name}` };
  }

  return { execute };
}

/**
 * One conversation. `client()` resolves to an Anthropic client; `tools.execute` runs tool calls.
 * `on(event)`: { type: "text", delta } | { type: "turn" } (a new assistant message starts) | { type: "thinking" } |
 * { type: "tool", name, input } | { type: "tool-done", name, summary, error } | { type: "notice", text, error? }.
 * The history is append-only (thinking blocks are passed back unchanged, as the API requires).
 */
export function createAgent({ client, tools, on = () => {}, model = MODEL }) {
  const messages = [];
  let ctl = null;

  // Tool calls the last assistant turn made but that never ran (stopped, refused, cut off): the API needs a result
  // for each before the next user text.
  function unanswered() {
    const last = messages.at(-1);
    if (last?.role !== "assistant" || !Array.isArray(last.content)) return [];
    return last.content.filter((b) => b.type === "tool_use").map((b) => ({
      type: "tool_result", tool_use_id: b.id, is_error: true, content: "not run: the turn ended before this tool ran",
    }));
  }

  async function turn(api, signal) {
    for (let retries = 0; ;) {
      const stream = api.beta.messages.stream({
        model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM,
        tools: TOOLS,
        messages,
        output_config: { effort: "medium" },
        cache_control: { type: "ephemeral" }, // tools + system + history so far are a stable prefix
        // A request a safety classifier declines is re-run on a fallback model in the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      }, { signal });
      on({ type: "turn" });
      stream.on("text", (delta) => on({ type: "text", delta }));
      stream.on("streamEvent", (e) => e.type === "content_block_start" && e.content_block.type === "thinking" && on({ type: "thinking" }));
      try {
        return await stream.finalMessage();
      } catch (e) {
        // API errors (bad key, rate limit, overload after the SDK's own retries) and stops end the turn; a dropped
        // connection or a tool input that isn't valid JSON is re-issued (the failed turn was never appended).
        if (signal.aborted || e?.status !== undefined || e?.name === "APIUserAbortError" || ++retries > 2) throw e;
        on({ type: "notice", text: "The connection dropped; trying again." });
      }
    }
  }

  async function send(text) {
    if (ctl) throw new Error("already working");
    ctl = new AbortController();
    const { signal } = ctl;
    const pending = unanswered();
    messages.push({ role: "user", content: pending.length ? [...pending, { type: "text", text }] : text });
    try {
      const api = await client();
      for (;;) {
        const msg = await turn(api, signal);
        messages.push({ role: "assistant", content: msg.content });
        if (msg.stop_reason === "pause_turn") continue;
        if (msg.stop_reason === "refusal") {
          on({ type: "notice", text: "Claude declined this request.", error: true });
          return;
        }
        const calls = msg.content.filter((b) => b.type === "tool_use");
        if (!calls.length) {
          if (msg.stop_reason === "max_tokens") on({ type: "notice", text: "The reply hit the length limit.", error: true });
          return;
        }
        if (msg.stop_reason === "max_tokens") {
          // A cut-off tool input can still look valid: don't run it.
          on({ type: "notice", text: "The reply hit the length limit before its tool call was complete; ask again in smaller steps.", error: true });
          return;
        }
        const results = [];
        for (const b of calls) {
          if (signal.aborted) {
            results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: "not run: stopped by the user" });
            continue;
          }
          on({ type: "tool", name: b.name, input: b.input });
          const r = await tools.execute(b.name, b.input, signal);
          on({ type: "tool-done", name: b.name, summary: r.summary, error: !!r.error });
          results.push({ type: "tool_result", tool_use_id: b.id, content: r.text || "(no output)", ...(r.error ? { is_error: true } : {}) });
        }
        messages.push({ role: "user", content: results });
        if (signal.aborted) {
          on({ type: "notice", text: "Stopped." });
          return;
        }
      }
    } catch (e) {
      if (signal.aborted) on({ type: "notice", text: "Stopped." });
      else on({ type: "notice", text: errorText(e), error: true });
    } finally {
      ctl = null;
    }
  }

  return {
    send,
    stop: () => ctl?.abort(),
    get busy() {
      return ctl !== null;
    },
    get messages() {
      return messages;
    },
  };
}

export function errorText(e) {
  const s = e?.status;
  if (s === 401) return "Anthropic didn't accept the API key. Check it, or forget it and enter another.";
  if (s === 403) return "This API key isn't allowed to use the model.";
  if (s === 429) return "Anthropic's rate limit for this key was reached. Wait a moment and send again.";
  if (s === 529 || s === 503) return "Claude is overloaded right now. Try again in a moment.";
  const m = e?.error?.error?.message ?? e?.message ?? String(e);
  return s ? `Anthropic API error ${s}: ${m}` : `Couldn't reach Claude: ${m}`;
}

// The user's Anthropic API key: localStorage on the studio origin, like the Cresslet token (previews and project
// code run on the preview origin and can't read it). Sent only to api.anthropic.com.
const KEY = "cresslet.anthropicKey";
export const apiKey = {
  get() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  /** True if stored. */
  set(v) {
    try {
      v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY);
      return localStorage.getItem(KEY) === (v || null);
    } catch {
      return false;
    }
  },
};

/** An Anthropic client for this browser; the SDK bundle loads on first use. */
export async function anthropicClient(key) {
  const { Anthropic } = await import("./vendor/anthropic.js");
  return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
}
