// AI builder: a chat that changes the open project. Claude is reached either through this server on the account's AI
// credits (`/v1/ai`, server/credits.ts: the operator's key, metered) or straight from this browser with the user's own
// Anthropic API key. Its tools act on the same things the user does: the project's files in the container, the
// in-browser shell, and `cresslet deploy` (the same control-plane API the CLI uses).
// No DOM here (app.ts renders): the loop and the tools also run under node for tests/builder_test.ts.
import type { Container } from "./vendor/cresslet-container/cresslet-container.js";
import type { Anthropic, ContentBlockParam, MessageParam, MessageStream, StopReason, Tool, ToolResultBlockParam } from "./vendor/anthropic.js";

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
- For live or multi-user features (chat, presence, shared boards, games), use WebSockets:
  - Server: requests with \`Upgrade: websocket\` on a server route (e.g. \`/api/ws\`) reach fetch; answer with a Workers-style \`WebSocketPair\`: \`const [client, server] = Object.values(new WebSocketPair()); server.accept(); …; return new Response(null, { status: 101, webSocket: client });\`. If the data is private, first check the user, their access to the room, and that \`Origin\` is the app's own origin (403 otherwise).
  - Broadcast: on the platform only the request that opened a socket may use it; \`send\` from any other request (another socket's message handler, a POST) throws "Cannot perform I/O on behalf of a different request". \`cresslet dev\` and this preview don't enforce that, so such code works here and fails once deployed. All of an app's sockets live in one server process, so keep a module-level \`Map\` from room (chat room, document, game; one room for the whole app if there's only one) to a \`Set\` of entries \`{ q: [], wake: null }\` (socket bookkeeping is the one thing that belongs in globals). To broadcast to a room, push the message to each of that room's entries' \`q\` and call its \`wake?.()\`; never send private data to entries of rooms the user wasn't let into. The upgrade handler starts the entry's sender loop without awaiting it, then returns the 101: \`(async () => { while (open) { if (!e.q.length) await new Promise((r) => (e.wake = r)); e.wake = null; for (const m of e.q.splice(0)) { if (!open) break; try { server.send(m); } catch { cleanup(); } } } })();\`. One idempotent \`cleanup\`, run on the socket's close and error events, sets \`open = false\`, removes the entry from its room's Set (and an empty Set from the Map) and calls \`e.wake?.()\`, so the loop ends.
  - State: sockets only deliver. Keep durable state in \`db\`/\`files\` and send it when a client connects; things that only exist while connected (who's online) can come from the open sockets.
  - Client: connect to \`\${location.protocol === "https:" ? "wss" : "ws"}://\${location.host}/api/ws\`. Send a small message (e.g. "ping", which the server ignores) every 30 seconds: proxies close quiet sockets (Cloudflare after ~100 seconds). Sockets also close on every redeploy, after 10 idle minutes, after an hour, and in the preview when a server file is saved: reconnect with a backoff and refetch the state. Open sockets per app are capped (past it, upgrades get 503).
- Prefer small, targeted edits (edit_file) to rewriting whole files.
- When you're done, say briefly what you changed. The user sees the preview update by itself.`;

const str = (description: string) => ({ type: "string", description });
type Schema = ReturnType<typeof str>;
const tool = (name: string, description: string, properties: Record<string, Schema> = {}, required = Object.keys(properties)) => ({
  name,
  description,
  // Large inputs (file contents) stream as they're generated; inputs are then validated here (validate below).
  eager_input_streaming: true,
  input_schema: { type: "object" as const, properties, required, additionalProperties: false },
}) satisfies Tool;

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
export function validate(name: string, input: unknown): string | null {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return `unknown tool: ${name}`;
  if (!input || typeof input !== "object" || Array.isArray(input)) return "input must be an object";
  const { properties, required } = t.input_schema;
  for (const k of Object.keys(input)) if (!(k in properties)) return `unexpected field: ${k}`;
  for (const k of required) if (!(k in input)) return `missing field: ${k}`;
  for (const [k, v] of Object.entries(input)) if (typeof v !== "string") return `${k} must be a string`;
  return null;
}

// Local secret files, or anything inside a directory named like one (as NOT_SOURCE in cresslet-plugin.ts).
const SECRET = /(?:^|\/)(?:\.env[^/]*|\.dev\.vars[^/]*)(?:\/|$)/i;
const SKIP = /^(?:node_modules|dist|\.cresslet|\.git)(?:\/|$)/;

/** A model-supplied path, confined to the project: relative, no `..`, not a local secret or .git. Throws otherwise. */
export function projectPath(p: unknown, { dir = false } = {}): string {
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
export const plain = (s: string) => s.replace(ANSI, "");
const tail = (s: string, n = MAX_OUTPUT) => (s.length > n ? `[… ${s.length - n} earlier characters not shown]\n${s.slice(-n)}` : s);

/**
 * The tools, over a cresslet-container (`c.fs`, `c.spawn`, `c.workdir`).
 * `devLog()`: the studio terminal's output so far; `onChange(path)`: after a file was written or deleted.
 * `cresslet deploy` asks the user first while one of these commands runs (`running`; cresslet-plugin.ts), however it
 * was started (directly, an npm script, `sh -c`). Commands also get CRESSLET_AI_BUILDER=1, for one left in the
 * background. `paused()`: true while the user is being asked; that time doesn't count toward the timeout.
 */
export interface ToolsOptions {
  devLog?: () => string;
  onChange?: (path: string) => void;
  timeoutMs?: number;
  paused?: () => boolean;
  clock?: () => number;
}

/** What a tool call resolves to. */
export interface ToolResult {
  text: string;
  error?: boolean;
  /** One line for the chat. */
  summary?: string;
}

/** Tool inputs after `validate`: an object of strings. */
type Input = Record<string, string>;

export function createTools(c: Pick<Container, "fs" | "spawn" | "workdir">, { devLog = () => "", onChange = () => {}, timeoutMs = COMMAND_TIMEOUT_MS, paused = () => false, clock = () => performance.now() }: ToolsOptions = {}) {
  const wd = c.workdir;
  let running = 0;
  const abs = (rel: string) => (rel ? `${wd}/${rel}` : wd);

  async function list(dir: string, out: string[] = []): Promise<string[]> {
    const entries = await c.fs.readdir(abs(dir), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (SKIP.test(rel)) continue;
      if (out.length >= MAX_LIST) break;
      if (SECRET.test(rel)) out.push(`${rel}${e.isDirectory() ? "/" : ""} (local secrets, not readable)`);
      else if (e.isDirectory()) await list(rel, out);
      else out.push(rel);
    }
    return out;
  }

  async function exists(rel: string) {
    try {
      return await c.fs.exists(abs(rel));
    } catch {
      return false;
    }
  }

  async function readText(rel: string) {
    if (!(await exists(rel))) throw new Error(`no such file: ${rel}`);
    const text = await c.fs.readFile(abs(rel), "utf8");
    if (text.includes("\u0000")) throw new Error(`${rel} looks like a binary file`);
    return text;
  }

  async function write(rel: string, content: string) {
    const i = rel.lastIndexOf("/");
    if (i > 0) await c.fs.mkdir(abs(rel.slice(0, i)), { recursive: true });
    await c.fs.writeFile(abs(rel), content);
    onChange(rel);
  }

  async function run(command: string, signal?: AbortSignal) {
    running++;
    try {
      return await runOne(command, signal);
    } finally {
      running--;
    }
  }

  async function runOne(command: string, signal?: AbortSignal): Promise<ToolResult> {
    const proc = await c.spawn("jsh", ["-c", command], { cwd: wd, env: { CRESSLET_AI_BUILDER: "1" } });
    let out = "", dropped = 0; // only the tail is kept
    const reading = proc.output.pipeTo(new WritableStream({ write: (d) => {
      out += d;
      if (out.length > 2 * MAX_OUTPUT) {
        dropped += out.length - MAX_OUTPUT;
        out = out.slice(-MAX_OUTPUT);
      }
    } })).catch(() => {});
    await proc.input.close().catch(() => {}); // no stdin: a command that waits for input gets EOF
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop = () => {};
    const stopped = new Promise<"timeout" | "stopped">((r) => {
      // Wall-clock time (timers are throttled in background tabs), not counting time spent asking the user.
      // An interval in which the user was being asked at either end counts at most one normal tick (a throttled,
      // late tick can't charge the wait), and it never times out while they're being asked.
      let used = 0, last = clock(), wasAsking = paused();
      const tick = () => {
        const now = clock(), asking = paused();
        used += !wasAsking && !asking ? now - last : wasAsking !== asking ? Math.min(now - last, 250) : 0;
        last = now;
        wasAsking = asking;
        if (used >= timeoutMs && !asking) r("timeout");
        else timer = setTimeout(tick, 250);
      };
      timer = setTimeout(tick, 250);
      stop = () => r("stopped");
      if (signal?.aborted) stop();
      else signal?.addEventListener("abort", stop, { once: true });
    });
    const code = await Promise.race([proc.exit, stopped]);
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    if (typeof code !== "number") {
      proc.kill(); // cooperative: give the command a moment to wind down (a deploy aborts its upload)
      await Promise.race([proc.exit, new Promise((r) => setTimeout(r, 2000))]);
    }
    await Promise.race([reading, new Promise((r) => setTimeout(r, 200))]);
    const shown = plain(out).trimEnd();
    const cut = dropped + Math.max(0, shown.length - MAX_OUTPUT);
    const text = cut ? `[… ${cut} earlier characters not shown]\n${shown.slice(-MAX_OUTPUT)}` : shown;
    if (code === "timeout") return { error: true, text: `stopped after ${timeoutMs / 1000}s (still running)\n${text}` };
    if (code === "stopped") return { error: true, text: `stopped by the user (anything it had already sent, such as a deploy upload, may still have gone through)\n${text}` };
    return { error: code !== 0, text: `exit code ${code}\n${text}` };
  }

  /** Runs one tool call. Resolves to { text, error, summary } (summary: one line for the chat). Never throws. */
  async function execute(name: string, raw: unknown, signal?: AbortSignal): Promise<ToolResult & { summary: string }> {
    const bad = validate(name, raw);
    if (bad) return { error: true, text: `invalid input: ${bad}`, summary: `${name}: invalid input` };
    const input = raw as Input; // validated: an object of strings
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
      const msg = (e as { message?: string } | null)?.message;
      return { error: true, text: msg ?? String(e), summary: `${name}: ${msg ?? e}` };
    }
    return { error: true, text: `unknown tool: ${name}`, summary: `unknown tool: ${name}` };
  }

  return {
    execute,
    /** Builder commands running now. */
    get running() {
      return running;
    },
  };
}

/**
 * One conversation. `client()` resolves to an Anthropic client; `tools.execute` runs tool calls.
 * `on(event)`: { type: "text", delta } | { type: "turn" } (a new assistant message starts) | { type: "retry" } (drop the
 * text shown since the last "turn") | { type: "thinking" } |
 * { type: "tool", name, input } | { type: "tool-done", name, summary, error } | { type: "notice", text, error? }.
 * The history is append-only (thinking blocks are passed back unchanged, as the API requires).
 */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "turn" }
  | { type: "retry" }
  | { type: "thinking" }
  | { type: "tool"; name: string; input: unknown }
  | { type: "tool-done"; name: string; summary: string; error: boolean }
  | { type: "notice"; text: string; error?: boolean };

/** The client surface the agent uses (tests pass a fake). */
export type Api = Pick<Anthropic, "beta">;

export interface AgentOptions {
  client: () => Promise<Api>;
  tools: { execute(name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult & { summary: string }> };
  on?: (event: AgentEvent) => void;
  model?: string;
  errorText?: (e: unknown) => string;
}

export function createAgent({ client, tools, on = () => {}, model = MODEL, errorText: describe = errorText }: AgentOptions) {
  const messages: MessageParam[] = [];
  let ctl: AbortController | null = null;

  // Tool calls the last assistant turn made but that never ran (stopped, refused, cut off): the API needs a result
  // for each before the next user text.
  function unanswered(): ToolResultBlockParam[] {
    const last = messages.at(-1);
    if (last?.role !== "assistant" || !Array.isArray(last.content)) return [];
    return last.content.filter((b) => b.type === "tool_use").map((b) => ({
      type: "tool_result" as const, tool_use_id: b.id, is_error: true, content: "not run: the turn ended before this tool ran",
    }));
  }

  // Streams one request. Resolves to the message and the ids of tool calls whose input wasn't valid JSON: with eager
  // input streaming the API doesn't check it, and the SDK's tolerant parser can turn bad JSON into a shorter valid
  // input (a truncated file), so the raw input is parsed strictly here.
  async function turn(api: Api, signal: AbortSignal) {
    for (let retries = 0; ;) {
      const stream: MessageStream = api.beta.messages.stream({
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
      const raw = new Map<number, string>(); // content index → tool input JSON as streamed
      stream.on("text", (delta) => on({ type: "text", delta }));
      stream.on("streamEvent", (e) => {
        if (e.type === "content_block_start" && e.content_block.type === "thinking") on({ type: "thinking" });
        else if (e.type === "content_block_start" && e.content_block.type === "tool_use") raw.set(e.index, "");
        else if (e.type === "content_block_delta" && e.delta.type === "input_json_delta" && raw.has(e.index)) raw.set(e.index, raw.get(e.index) + e.delta.partial_json);
      });
      try {
        const msg = await stream.finalMessage();
        const invalid = new Set<string>();
        for (const [i, json] of raw) {
          const b = msg.content[i];
          if (b?.type !== "tool_use" || !json.trim()) continue;
          try {
            JSON.parse(json);
          } catch {
            invalid.add(b.id);
          }
        }
        return { msg, invalid };
      } catch (e) {
        // API errors (bad key, rate limit, overload after the SDK's own retries) and stops end the turn; a dropped
        // connection or a tool input the SDK couldn't parse at all is re-issued (the failed turn was never appended).
        const err = e as { status?: number; name?: string } | null;
        if (signal.aborted || err?.status !== undefined || err?.name === "APIUserAbortError" || ++retries > 2) throw e;
        on({ type: "retry" });
        on({ type: "notice", text: "The connection dropped; trying again." });
      }
    }
  }

  const CUT_OFF: Partial<Record<StopReason, string>> = {
    max_tokens: "The reply hit the length limit",
    model_context_window_exceeded: "The conversation is too long for Claude (start a new chat)",
  };

  async function send(text: string) {
    if (ctl) throw new Error("already working");
    ctl = new AbortController();
    const { signal } = ctl;
    const pending = unanswered();
    const start = messages.length;
    messages.push({ role: "user", content: pending.length ? [...pending, { type: "text", text }] : text });
    try {
      const api = await client();
      for (;;) {
        const { msg, invalid } = await turn(api, signal);
        if (msg.stop_reason === "refusal") {
          // A declined reply (and any partial output) stays out of the history.
          on({ type: "notice", text: "Claude declined this request.", error: true });
          return;
        }
        const stop = msg.stop_reason;
        const cut = (stop && CUT_OFF[stop]) ?? (stop && ["end_turn", "tool_use", "stop_sequence", "pause_turn"].includes(stop) ? null : `The reply stopped early (${stop})`);
        if (!msg.content.length) {
          // an empty message would make every later request fail: not kept
          if (cut) on({ type: "notice", text: `${cut}.`, error: true });
          return;
        }
        messages.push({ role: "assistant", content: msg.content });
        if (msg.stop_reason === "pause_turn") continue;
        const calls = msg.content.filter((b) => b.type === "tool_use");
        if (cut) {
          // A cut-off tool input can still look valid: don't run it (the next message answers it as not run).
          on({ type: "notice", text: calls.length ? `${cut} before its tool calls were complete; they weren't run.` : `${cut}.`, error: true });
          return;
        }
        if (!calls.length || msg.stop_reason !== "tool_use") return;
        const results: ContentBlockParam[] = [];
        for (const b of calls) {
          if (signal.aborted) {
            results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: "not run: stopped by the user" });
            continue;
          }
          if (invalid.has(b.id)) {
            results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: "not run: INVALID_JSON (the tool input wasn't valid JSON); send the call again" });
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
      else on({ type: "notice", text: describe(e), error: true });
    } finally {
      // Nothing came back for this message (stopped, failed, declined): drop it, so it isn't sent again with the next.
      if (messages.length === start + 1) messages.length = start;
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

/** `credits`: the request went through this server on AI credits (not the user's own key). */
export function errorText(e: unknown, { credits = false } = {}): string {
  // An Anthropic SDK APIError (status, the API's error body), or anything else thrown.
  const err = e as { status?: number; message?: string; error?: { error?: { message?: string } } } | null | undefined;
  const s = err?.status;
  const m = err?.error?.error?.message ?? err?.message ?? String(e);
  if (credits) {
    if (s === 401) return "Your Cresslet session expired. Log in again to use your AI credits.";
    if (s === 402 || s === 403 || s === 400) return m;
    if (s === 429) return `${m}. Wait a moment and send again.`;
  }
  if (s === 401) return "Anthropic didn't accept the API key. Check it, or forget it and enter another.";
  if (s === 403) return "This API key isn't allowed to use the model.";
  if (s === 429) return "Anthropic's rate limit for this key was reached. Wait a moment and send again.";
  if (s === 529 || s === 503) return "Claude is overloaded right now. Try again in a moment.";
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
  set(v: string | null) {
    try {
      v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY);
      return localStorage.getItem(KEY) === (v || null);
    } catch {
      return false;
    }
  },
};

/** An Anthropic client for this browser; the SDK bundle loads on first use. */
export async function anthropicClient(key: string) {
  const { Anthropic } = await import("./vendor/anthropic.js");
  return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
}

/**
 * An Anthropic client that goes through this server on the account's AI credits: the same Messages API at
 * `<origin>/v1/ai`, authenticated with the Cresslet session token (it never reaches Anthropic).
 */
export async function creditsClient(token: string, origin: string | undefined = globalThis.location?.origin) {
  const { Anthropic } = await import("./vendor/anthropic.js");
  return new Anthropic({ apiKey: null, authToken: token, baseURL: `${origin}/v1/ai`, dangerouslyAllowBrowser: true });
}
