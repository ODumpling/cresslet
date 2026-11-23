// Studio-side MCP bridge (`cresslet connect`): reuses the 7 builder tool definitions and `tools.execute`
// from studio/builder.ts, adds `commit_change(title)` as an explicit turn boundary, serializes calls with
// per-call cancellation, and speaks the `/v1/workspace/relay` WebSocket protocol.
// No DOM here (src/views/workspace/Builder.tsx renders): runs under node for tests/bridge_test.ts.
import { TOOLS, type ToolResult } from "./builder.ts";

export interface BridgeToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: false;
  };
}

/** The 7 builder tools (reused verbatim from studio/builder.ts) plus `commit_change`. */
export const BRIDGE_TOOLS: BridgeToolSchema[] = [
  ...TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: "object" as const,
      properties: t.input_schema.properties,
      required: [...t.input_schema.required],
      additionalProperties: false as const,
    },
  })),
  {
    name: "commit_change",
    description: "End a turn and record the workspace's changes as a stack change (when linked to GitHub) or a local turn boundary. Does not run automatically; call it when a logical change is complete.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short summary of the change (1 line, up to 200 characters)." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
];

export const ALLOWED_BRIDGE_TOOLS = new Set(BRIDGE_TOOLS.map((t) => t.name));

export type BridgeEvent =
  | { type: "tool"; id: string; name: string; input: unknown }
  | { type: "tool-done"; id: string; name: string; summary: string; error: boolean };

export interface BridgeExecutor {
  execute(name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult & { summary: string }>;
}

export interface BridgeDispatcherOptions {
  tools: BridgeExecutor;
  commitChange: (title: string, signal?: AbortSignal) => Promise<ToolResult & { summary: string }>;
  onEvent?: (ev: BridgeEvent) => void;
  /** Called when a call finishes (used to decline stray deploy approvals). */
  onCallEnd?: () => void;
  maxQueued?: number;
}

export interface BridgeToolReply {
  id: string;
  text: string;
  error?: boolean;
}

interface QueuedCall {
  id: string;
  name: string;
  input: unknown;
  ctl: AbortController;
  resolve: (reply: BridgeToolReply) => void;
}

const MAX_TITLE = 200;

/**
 * Serialized tool dispatcher over the builder's `tools.execute` + `commit_change`.
 * Enforces the 8-tool allowlist, validates `commit_change` input, and supports per-call cancellation
 * for both running and queued calls.
 */
export function createBridgeDispatcher({
  tools,
  commitChange,
  onEvent = () => {},
  onCallEnd = () => {},
  maxQueued = 32,
}: BridgeDispatcherOptions) {
  const queue: QueuedCall[] = [];
  let active: QueuedCall | null = null;

  async function drain() {
    if (active) return;
    while (queue.length) {
      const item = queue.shift()!;
      if (item.ctl.signal.aborted) {
        item.resolve({ id: item.id, text: "Cancelled.", error: true });
        continue;
      }
      active = item;
      onEvent({ type: "tool", id: item.id, name: item.name, input: item.input });
      let r: ToolResult & { summary: string };
      try {
        if (item.name === "commit_change") {
          r = await runCommitChange(item.input, item.ctl.signal);
        } else {
          r = await tools.execute(item.name, item.input, item.ctl.signal);
        }
      } catch (e) {
        const msg = (e as { message?: string } | null)?.message ?? String(e);
        r = { error: true, text: msg, summary: `${item.name}: ${msg}` };
      } finally {
        active = null;
        onCallEnd();
      }
      onEvent({ type: "tool-done", id: item.id, name: item.name, summary: r.summary, error: !!r.error });
      item.resolve({ id: item.id, text: r.text || "(no output)", ...(r.error ? { error: true } : {}) });
    }
  }

  async function runCommitChange(raw: unknown, signal: AbortSignal): Promise<ToolResult & { summary: string }> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { error: true, text: "invalid input: input must be an object", summary: "commit_change: invalid input" };
    }
    const obj = raw as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (k !== "title") return { error: true, text: `invalid input: unexpected field: ${k}`, summary: "commit_change: invalid input" };
    }
    if (typeof obj.title !== "string" || !obj.title.trim()) {
      return { error: true, text: "invalid input: title must be a non-empty string", summary: "commit_change: invalid input" };
    }
    const title = obj.title.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_TITLE);
    return commitChange(title, signal);
  }

  function call(id: string, name: string, input: unknown): Promise<BridgeToolReply> {
    if (!ALLOWED_BRIDGE_TOOLS.has(name)) {
      return Promise.resolve({ id, text: `unknown tool: ${name}`, error: true });
    }
    if (queue.length >= maxQueued) {
      return Promise.resolve({ id, text: "too many tool calls queued; wait for earlier calls to finish", error: true });
    }
    return new Promise<BridgeToolReply>((resolve) => {
      queue.push({ id, name, input, ctl: new AbortController(), resolve });
      void drain();
    });
  }

  function cancel(id: string) {
    if (active?.id === id) {
      active.ctl.abort();
      return;
    }
    const idx = queue.findIndex((q) => q.id === id);
    if (idx >= 0) {
      const [removed] = queue.splice(idx, 1);
      removed!.ctl.abort();
      removed!.resolve({ id: removed!.id, text: "Cancelled.", error: true });
    }
  }

  function cancelAll(reason = "Disconnected.") {
    active?.ctl.abort();
    for (const q of queue.splice(0)) {
      q.ctl.abort();
      q.resolve({ id: q.id, text: reason, error: true });
    }
  }

  return {
    call,
    cancel,
    cancelAll,
    get busy() {
      return active !== null || queue.length > 0;
    },
    get active() {
      return active !== null;
    },
  };
}

/** Minimal WebSocket surface the bridge client uses (browser WebSocket or a test double). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
}

export type BridgeState =
  | { phase: "connecting" }
  | { phase: "awaiting_approval"; agent: string }
  | { phase: "paired"; agent: string }
  | { phase: "closed"; error?: string; reason?: string };

export interface BridgeClientOptions {
  wsUrl: string;
  token: string;
  code: string;
  projectName: string;
  dispatcher: ReturnType<typeof createBridgeDispatcher>;
  onState: (state: BridgeState) => void;
  createSocket?: (url: string) => SocketLike;
}

/**
 * Connects one Studio project tab to `/v1/workspace/relay` with a user-entered pairing code.
 * Emits state transitions (`connecting` → `awaiting_approval` → `paired` → `closed`),
 * dispatches incoming `tool_call` / `tool_cancel` frames, and cleans up on disconnect.
 */
export function connectBridge({
  wsUrl,
  token,
  code,
  projectName,
  dispatcher,
  onState,
  createSocket = (url) => new WebSocket(url) as unknown as SocketLike,
}: BridgeClientOptions) {
  let closed = false;
  let lastError: string | undefined;
  let phase: BridgeState["phase"] = "connecting";
  onState({ phase: "connecting" });

  const ws = createSocket(wsUrl);

  const send = (msg: Record<string, unknown>) => {
    if (closed || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ v: 1, ...msg }));
  };

  const finish = (error?: string, reason?: string) => {
    if (closed) return;
    closed = true;
    phase = "closed";
    dispatcher.cancelAll(reason ?? error ?? "Disconnected.");
    onState({ phase: "closed", ...(error ? { error } : {}), ...(reason ? { reason } : {}) });
  };

  ws.addEventListener("open", () => {
    send({ type: "hello", role: "studio", token, code, projectName });
  });

  ws.addEventListener("message", (ev) => {
    if (closed || typeof ev.data !== "string") return;
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(ev.data);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.type === "error") {
      lastError = typeof msg.message === "string" ? msg.message : "Relay error";
      return;
    }
    if (msg.type === "pair_request" && phase === "connecting") {
      const agent = typeof msg.agent === "string" ? msg.agent : "Desktop agent";
      phase = "awaiting_approval";
      onState({ phase: "awaiting_approval", agent });
      return;
    }
    if (msg.type === "paired" && phase === "awaiting_approval") {
      const agent = typeof msg.agent === "string" ? msg.agent : "Desktop agent";
      phase = "paired";
      onState({ phase: "paired", agent });
      return;
    }
    if (msg.type === "tool_call" && phase === "paired") {
      const id = typeof msg.id === "string" ? msg.id : "";
      const name = typeof msg.name === "string" ? msg.name : "";
      if (!id || !name) return;
      void dispatcher.call(id, name, msg.arguments ?? {}).then((reply) => {
        send({ type: "tool_result", ...reply });
      });
      return;
    }
    if (msg.type === "tool_cancel" && phase === "paired") {
      if (typeof msg.id === "string" && msg.id) dispatcher.cancel(msg.id);
    }
  });

  ws.addEventListener("error", () => {
    lastError ??= "Couldn't reach the relay server.";
  });

  ws.addEventListener("close", () => {
    finish(lastError, phase === "paired" ? "Disconnected." : undefined);
  });

  return {
    decide(allow: boolean) {
      if (closed || phase !== "awaiting_approval") return;
      send({ type: "pair_decision", allow });
      if (!allow) {
        try { ws.close(1000, "denied"); } catch { /* already closed */ }
        finish(undefined, "Denied.");
      }
    },
    disconnect() {
      if (closed) return;
      try { ws.close(1000, "disconnected"); } catch { /* already closed */ }
      finish(undefined, "Disconnected.");
    },
  };
}
