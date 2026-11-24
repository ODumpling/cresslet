// The AI builder: a chat with Claude that changes the open project (studio/builder.ts runs the conversation and the
// tools; this is only the chat). Claude is reached with the account's AI credits through this server, or with the
// user's own Anthropic API key from this browser.
//
// Shown as the Shipline: one rail of everything made, with the ship line on it. Above the line is what's live; under
// it, "Not live yet": the stack's changes (when linked) and this chat's requests, each request one node with what
// Claude did. Deploying moves the line down past them.
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Container } from "../../../vendor/cresslet-container/cresslet-container.js";
import { anthropicClient, apiKey, createAgent, createTools, creditsClient, errorText, type AgentEvent, type ToolResult } from "../../../builder.ts";
import { connectBridge, createBridgeDispatcher, type BridgeState } from "../../../mcp-bridge.ts";
import type * as API from "../../../api-types.ts";
import { commitMessage, gitCode, type GitWorkspace } from "../../../git.ts";
import { api, errorMessage, meta } from "../../lib/api.ts";
import { logIn, session, useLoginButton, useSession } from "../../lib/session.ts";
import { TimeAgo } from "../../ui/bits.tsx";
import { ExtLink, Icon, SrOnly } from "../../ui/icons.tsx";

const STEP_ICON: Record<string, string> = { run_command: "terminal", read_dev_log: "terminal", commit_change: "branch" };
/** A tool call's input as the model sent it (not validated yet). */
const strField = (input: unknown, key: string): string | undefined => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
};
const runningText = (name: string, input: unknown) => ({
  list_files: "Listing files", read_file: `Reading ${strField(input, "path") ?? "a file"}`, write_file: `Writing ${strField(input, "path") ?? "a file"}`,
  edit_file: `Editing ${strField(input, "path") ?? "a file"}`, delete_file: `Deleting ${strField(input, "path") ?? "a file"}`,
  run_command: `Running ${strField(input, "command") ?? "a command"}`, read_dev_log: "Reading the dev server output",
  commit_change: `Committing ${strField(input, "title") ?? "change"}`,
} as Record<string, string>)[name] ?? name;

/** One entry in the chat log. */
type Item =
  | { id: number; kind: "user"; text: string; at: number }
  | { id: number; kind: "assistant"; text: string }
  | { id: number; kind: "step"; state: "running" | "ok" | "error"; icon: string; text: string; failed?: boolean }
  | { id: number; kind: "notice"; text: string; error?: boolean }
  | { id: number; kind: "approval"; text: string; answer: (ok: boolean) => void };

/** An entry before it has its id. */
type NewItem = Item extends infer I ? (I extends Item ? Omit<I, "id"> : never) : never;

export interface BuilderHandle {
  /** Asks the user to approve a deploy the builder started. Resolves to true if approved; false if declined or stopped. */
  approve(text: string, signal?: AbortSignal): Promise<boolean>;
  /** One of its commands is running (in a process it started). */
  running(): boolean;
  /** Who is driving the builder ("Claude" or a connected desktop agent). */
  actor(): string;
  /** Disconnect a paired desktop agent, if any. */
  disconnectAgent(): void;
  /** A request is being worked on. */
  busy(): boolean;
  /** The request being worked on, as a change's title and prompt (null when none is). */
  turn(): { title: string; prompt: string } | null;
  /** Focus into the pane (it was just opened). */
  focusIn(): void;
  /** Opens the pane with a message written for the user to send (or change first). */
  prefill(text: string): void;
}

/** The ship line: what's live, and a deploy under way. */
export interface Ship {
  /** The live app's address (none: never deployed). */
  url?: string;
  /** When it went live from this browser (unknown for a deploy made elsewhere). */
  at?: number;
  deploying: boolean;
  /** The deploy log's latest line while deploying, or why the last deploy failed. */
  line?: string;
  failed?: boolean;
  /** Not live yet: how many changes (the stack's, or this session's requests that changed files). */
  pending: number;
}

export function Builder({ c, devLog, onChange, open, setOpen, git, commandRev = () => 0, stack = null, onStackStale = () => {}, appName, ship, onTurnEnd = () => {}, onAgentChange = () => {}, ref }: {
  c: Container;
  /** Whether this tab owns the project (project-lock.ts; default true): only the owner may run or save it. */
  owner?: boolean;
  /** The project's name (the empty chat asks what it should do). */
  appName: string;
  ship: Ship;
  /** A request finished: whether it changed the workspace (a change not live yet). */
  onTurnEnd?: (changed: boolean) => void;
  /** A desktop agent paired or disconnected (`null` when none). */
  onAgentChange?: (agent: string | null) => void;
  /** Source control: the project's repository, when linked (a finished turn is committed as a change of its stack). */
  git: GitWorkspace | null;
  /** The stack panel (StackPanel.tsx), on the rail under the ship line. */
  stack?: React.ReactNode;
  /** A commit was refused because the stack changed on GitHub: it's read again (its buttons say what to do). */
  onStackStale?: () => void;
  /** Workspace changes that weren't hand edits (a command's), counted (engine.ts). */
  commandRev?: () => number;
  devLog: () => string;
  onChange: (path: string) => unknown;
  open: boolean;
  setOpen: (open: boolean, opts?: { focus?: boolean }) => void;
  ref: Ref<BuilderHandle>;
}) {
  const { user } = useSession();
  const loginIcon = useLoginButton().icon;
  const [creditsOn, setCreditsOn] = useState(false);
  const [keyVersion, setKeyVersion] = useState(0); // bumped when the stored key changes
  const [credits, setCredits] = useState<{ text: string; title: string; low: boolean } | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [working, setWorking] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(""); // the live region (outside the views it reports on, so it's never hidden)
  const [keyValue, setKeyValue] = useState("");
  const [keyError, setKeyError] = useState("");
  const [input, setInput] = useState("");
  const [connectOpen, setConnectOpen] = useState(false);
  const [bridgeCode, setBridgeCode] = useState("");
  const [bridgeError, setBridgeError] = useState("");
  const [bridgeState, setBridgeState] = useState<BridgeState | null>(null);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [wantSetup, setWantSetup] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null), logRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef<HTMLInputElement>(null), loginRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null), bridgeCodeRef = useRef<HTMLInputElement>(null);
  // This request's state: the agent, whether a deploy was approved, Stop pressed; the assistant text and tool step
  // being written; the latest reply text (read out when it ends) and its error.
  const r = useRef({
    agent: null as ReturnType<typeof createAgent> | null,
    approvals: new Set<() => void>(), // decline functions of the deploy approvals waiting for the user
    approved: false, stopped: false, busy: false,
    bubble: null as number | null, step: null as number | null,
    replied: "", failed: "", id: 0, stick: false,
    git, prompt: "", // the project's repository; the message being worked on
    // This turn changed files (its file tools); the count of non-hand changes when it was sent (commands':
    // `commandRev`, studio/src/views/workspace/engine.ts).
    turnChanged: false, cmdRev: 0,
    gone: false, // unmounted (the user left the project): no more UI updates
    // Live Link (`cresslet connect`): paired desktop agent state.
    bridge: null as ReturnType<typeof connectBridge> | null,
    bridgeUser: null as string | null, // who connected the desktop agent
    remoteAgent: null as string | null,
    remoteChanged: false,
    remoteCmdRev: 0,
    remoteSteps: new Map<string, number>(),
    onAgentChange,
    onTurnEnd,
    onStackStale,
    commandRev,
  }).current;
  r.git = git;
  r.onAgentChange = onAgentChange;
  r.onTurnEnd = onTurnEnd;
  r.onStackStale = onStackStale;
  r.commandRev = commandRev;
  const [tools] = useState(() => createTools(c, {
    devLog,
    onChange: (path) => {
      r.turnChanged = true;
      r.remoteChanged = true;
      return onChange(path);
    },
    paused: () => r.approvals.size > 0,
  }));

  // Where Claude is reached: "key" (the user's own key), "credits" (this server; logged in), or null (set one up).
  void keyVersion;
  const source = apiKey.get() ? "key" : creditsOn && user ? "credits" : null;
  const sourceRef = useRef(source);
  sourceRef.current = source;

  useEffect(() => {
    let live = true;
    void meta().then((m) => live && setCreditsOn(!!m.ai?.credits));
    return () => void (live = false);
  }, []);
  const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  async function refreshCredits() {
    if (sourceRef.current !== "credits") return;
    const x = await api<API.MyCredits>("/v1/me/credits?limit=1").catch(() => null);
    if (!x) return;
    if (!x.enabled) return setCreditsOn(false);
    const left = Math.max(0, x.available);
    const unit = fmt.format(left) === "1" ? "credit" : "credits";
    setCredits({ text: `${fmt.format(left)} ${unit}`, title: `${fmt.format(left)} AI ${unit} left`, low: left <= 0 });
  }
  useEffect(() => void refreshCredits(), [source, user]);
  // Leaving the project: the conversation stops with it (no more requests, tools or credits spent), and a deploy
  // waiting for approval is declined.
  useEffect(() => {
    r.gone = false; // (mounted again: React's StrictMode does that in dev)
    return () => {
      r.gone = true;
      r.stopped = true;
      r.agent?.stop();
      r.bridge?.disconnect();
      r.bridge = null;
      for (const decline of r.approvals) decline();
    };
  }, [r]);

  // Disconnect an active desktop agent if the user logs out or switches accounts.
  useEffect(() => {
    if (r.bridge && r.bridgeUser !== user) {
      r.bridge.disconnect();
      r.bridge = null;
    }
  }, [user, r]);

  // Stick to the bottom when new output arrives and the log was already there.
  const nearBottom = () => {
    const log = logRef.current;
    return !log || log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  };
  useLayoutEffect(() => {
    const log = logRef.current;
    if (log && r.stick) log.scrollTop = log.scrollHeight;
    r.stick = false;
  }, [items, r]);
  const add = (item: NewItem) => {
    const id = ++r.id;
    r.stick ||= nearBottom();
    setItems((xs) => [...xs, { ...item, id } as Item]);
    return id;
  };
  const update = (id: number, fn: (i: Item) => Item) => setItems((xs) => xs.map((x) => (x.id === id ? fn(x) : x)));

  /** Abortable sleep for watcher settle. */
  function waitSettle(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(true);
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        resolve(false);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Explicit `commit_change(title)` from a paired desktop agent. */
  async function commitRemoteChange(title: string, signal?: AbortSignal): Promise<ToolResult & { summary: string }> {
    if (signal?.aborted || r.gone) return { error: true, text: "Cancelled.", summary: `Cancelled: ${title}` };
    const g = r.git;
    if (g?.connected) {
      await g.idle();
      if (signal?.aborted || r.gone) return { error: true, text: "Cancelled.", summary: `Cancelled: ${title}` };
      if (!await waitSettle(500, signal) || r.gone) return { error: true, text: "Cancelled.", summary: `Cancelled: ${title}` };
      if (!g.state?.dirty) {
        return { text: "No changes to commit.", summary: `No changes to commit (${title})` };
      }
      try {
        const onto = g.state.activeBranch;
        const out = await g.commitChange(commitMessage(title), title, signal);
        r.remoteChanged = false;
        r.remoteCmdRev = r.commandRev();
        if (!out.changed) {
          return { text: "No changes to commit.", summary: `No changes to commit (${title})` };
        }
        if (r.gone) return { text: `Committed ${out.sha.slice(0, 7)}.`, summary: `Committed: ${title}` };
        r.onTurnEnd(true);
        const s = { ...g.state, ...(out.restacked ? { activeBranch: onto } : {}) };
        const msg = out.joined
          ? `The stack has ${out.change?.position} changes, its most: this change joined the top one, on ${s.activeBranch}.`
          : out.change
            ? `Committed as change ${out.change.position} of the stack, on ${s.activeBranch} (${out.sha.slice(0, 7)}).`
            : `Committed to ${s.activeBranch} (${out.sha.slice(0, 7)}).`;
        add({ kind: "notice", text: msg });
        return { text: msg, summary: `Committed: ${title}` };
      } catch (e) {
        if (signal?.aborted) return { error: true, text: "Cancelled.", summary: `Cancelled: ${title}` };
        if (gitCode(e) === "moved") {
          if (!r.gone) r.onStackStale();
          const msg = `Not committed: ${errorMessage(e)}. Pull it in or carry on from it in Source control first.`;
          if (!r.gone) add({ kind: "notice", text: msg, error: true });
          return { error: true, text: msg, summary: `Commit failed: ${title}` };
        }
        const msg = `Couldn't commit to GitHub: ${errorMessage(e)}`;
        if (!r.gone) add({ kind: "notice", text: msg, error: true });
        return { error: true, text: msg, summary: `Commit failed: ${title}` };
      }
    }
    if (!await waitSettle(500, signal) || r.gone) return { error: true, text: "Cancelled.", summary: `Cancelled: ${title}` };
    const changed = r.remoteChanged || r.commandRev() !== r.remoteCmdRev;
    r.remoteChanged = false;
    r.remoteCmdRev = r.commandRev();
    if (changed) r.onTurnEnd(true);
    const msg = changed
      ? `Recorded local change "${title}" (project is not linked to GitHub).`
      : `No file changes since last commit_change ("${title}").`;
    add({ kind: "notice", text: msg });
    return { text: msg, summary: `Committed: ${title}` };
  }

  const [dispatcher] = useState(() => createBridgeDispatcher({
    tools,
    commitChange: (title, signal) => commitRemoteChange(title, signal),
    onEvent(ev) {
      if (r.gone) return;
      if (ev.type === "tool") {
        const label = runningText(ev.name, ev.input);
        const stepId = add({ kind: "step", state: "running", icon: STEP_ICON[ev.name] ?? "file", text: label });
        r.remoteSteps.set(ev.id, stepId);
        setWorking(`${label}…`);
        setBridgeBusy(true);
      } else if (ev.type === "tool-done") {
        const stepId = r.remoteSteps.get(ev.id);
        r.remoteSteps.delete(ev.id);
        if (stepId !== undefined) {
          update(stepId, (x) => ({ id: x.id, kind: "step", state: ev.error ? "error" : "ok", icon: ev.error ? "x" : STEP_ICON[ev.name] ?? "check", text: ev.summary, failed: ev.error }));
        }
        if (ev.name === "run_command" && !r.stopped) r.approved = false;
        setStatus(ev.error ? `${ev.summary} (failed)` : ev.summary);
        setBridgeBusy(dispatcher.busy);
        if (!dispatcher.busy) setWorking("");
      }
    },
    onCallEnd() {
      for (const decline of r.approvals) decline();
    },
  }));

  function startBridge(e: React.FormEvent) {
    e.preventDefault();
    const code = bridgeCode.trim();
    if (!code || !user || r.busy || r.bridge) return;
    setBridgeError("");
    const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/workspace/relay`;
    r.bridgeUser = user;
    r.bridge = connectBridge({
      wsUrl,
      code,
      projectName: appName,
      dispatcher,
      onState(st) {
        if (r.gone) return;
        setBridgeState(st);
        if (st.phase === "paired") {
          r.remoteAgent = st.agent;
          r.remoteChanged = false;
          r.remoteCmdRev = r.commandRev();
          setConnectOpen(false);
          setBridgeCode("");
          setBridgeError("");
          r.onAgentChange(st.agent);
          add({ kind: "notice", text: `Connected to ${st.agent}. Tool calls appear here; deploys still ask for your approval.` });
          setStatus(`Connected to ${st.agent}`);
        } else if (st.phase === "closed") {
          const wasAgent = r.remoteAgent;
          const hadUncommitted = !!wasAgent && (r.remoteChanged || r.commandRev() !== r.remoteCmdRev);
          r.remoteAgent = null;
          r.bridge = null;
          r.bridgeUser = null;
          setBridgeBusy(false);
          setWorking("");
          for (const decline of r.approvals) decline();
          r.onAgentChange(null);
          if (st.error) setBridgeError(st.error);
          if (wasAgent) {
            add({
              kind: "notice",
              text: hadUncommitted
                ? `Disconnected from ${wasAgent}. Workspace changes since the last commit_change are kept locally (not committed).`
                : `Disconnected from ${wasAgent}.`,
            });
            setStatus(`Disconnected from ${wasAgent}`);
          }
        }
      },
    });
  }

  // Where focus goes in the chat: the message field.
  const chatFocus = () => inputRef.current?.focus();
  const setupFocus = () => (creditsOn && !user ? loginRef.current : keyRef.current)?.focus();

  function on(ev: AgentEvent) {
    switch (ev.type) {
      case "turn":
        r.bubble = null;
        setWorking("Thinking…");
        break;
      case "thinking":
        setWorking("Thinking…");
        break;
      case "retry": // the partial reply is sent again in full
        if (r.bubble !== null) {
          const gone = r.bubble;
          setItems((xs) => xs.filter((x) => x.id !== gone));
        }
        r.bubble = null;
        r.replied = "";
        break;
      case "text":
        if (r.bubble === null) {
          r.bubble = add({ kind: "assistant", text: "" });
        }
        r.replied += ev.delta;
        r.stick ||= nearBottom();
        update(r.bubble, (x) => ({ ...x, text: (x as { text: string }).text + ev.delta }) as Item);
        setWorking("Writing…");
        break;
      case "tool":
        r.bubble = null;
        r.step = add({ kind: "step", state: "running", icon: STEP_ICON[ev.name] ?? "file", text: runningText(ev.name, ev.input) });
        setWorking(`${runningText(ev.name, ev.input)}…`);
        break;
      case "tool-done":
        if (r.step !== null) {
          update(r.step, (x) => ({ id: x.id, kind: "step", state: ev.error ? "error" : "ok", icon: ev.error ? "x" : STEP_ICON[ev.name] ?? "check", text: ev.summary, failed: ev.error }));
        }
        r.step = null;
        if (ev.name === "run_command" && !r.stopped) r.approved = false; // an approved deploy in it has finished
        setStatus(ev.error ? `${ev.summary} (failed)` : ev.summary);
        setWorking("Thinking…");
        break;
      case "notice":
        add({ kind: "notice", text: ev.text, error: ev.error });
        if (ev.error) {
          setStatus(ev.text);
          r.failed = ev.text;
        }
        break;
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || r.busy || r.bridge || dispatcher.busy) return;
    if (!sourceRef.current) return;
    // Each request goes the way chosen when it's sent (the key can be forgotten or entered mid-chat).
    r.agent ??= createAgent({
      // ("key": a stored key; "credits": this browser's session cookie)
      client: () => (sourceRef.current === "key" ? anthropicClient(apiKey.get()!) : creditsClient({ user: session().user ?? "" })),
      errorText: (x) => errorText(x, { credits: sourceRef.current !== "key" }),
      tools,
      on,
      context: () => {
        const s = r.git?.connected ? r.git.state : undefined;
        const back = s?.back ? ` The user went back to change ${s.back.position} ("${s.back.title}"): the later changes (${s.back.setAside.map((t) => `"${t}"`).join(", ") || "none"}) are set aside, so their code isn't in the workspace; your changes go on top of change ${s.back.position}.` : "";
        const undo = s?.undo ? ` The workspace holds "${s.undo.title}", not committed yet: it reverses an earlier change while keeping the later ones.${s.undo.conflicts.length ? ` Where later changes touched the same lines there are conflict markers (in ${s.undo.conflicts.join(", ")}): the part between <<<<<<< and ======= is what's there now, the part after it what the earlier change undone gives; resolve them, keeping the later changes' intent.` : ""}` : "";
        return s ? `[Source control: this project is linked to the GitHub repository ${s.owner}/${s.repo}. The workspace is on branch ${s.activeBranch} (default branch: ${s.defaultBranch})${s.dirty ? ", with changes not committed yet" : ""}.${back}${undo}]` : null;
      },
    });
    r.stick = true;
    add({ kind: "user", text, at: Date.now() });
    setInput("");
    r.replied = "";
    r.failed = "";
    r.approved = r.stopped = false;
    const fromSend = document.activeElement?.id === "builder-send";
    r.busy = true;
    flushSync(() => setBusy(true));
    if (fromSend) inputRef.current?.focus(); // Send is disabled while Claude works
    setWorking("Thinking…");
    setStatus("Sent. Claude is working on it.");
    r.turnChanged = false;
    r.prompt = text;
    r.cmdRev = commandRev();
    try {
      await r.git?.idle(); // a source control step under way (going back, say): on the workspace it leaves
      if (r.stopped || r.gone) return; // stopped (or left) while it waited
      await r.agent.send(text);
      await commitTurn(text);
      if (!r.gone) onTurnEnd(r.turnChanged || commandRev() !== r.cmdRev);
    } finally {
      for (const decline of r.approvals) decline(); // its command is gone (stopped, timed out, or left running)
      if (r.approved && r.stopped) on({ type: "notice", text: "If the deploy had started uploading, it may still go live: check the app.", error: true });
      r.busy = false;
      setBusy(false);
      r.bubble = r.step = null;
      setWorking("");
      if (r.replied) setStatus(`Claude: ${r.replied}${r.failed ? ` (${r.failed})` : ""}`);
      else if (!r.failed) setStatus("Claude finished");
      if (!r.gone) void refreshCredits();
    }
  }

  /**
   * Linked to a repository: what the turn changed (files, or a command such as npm install), with any hand edits since
   * the last one, is committed as a change of the app's stack: a branch of its own on top of the one the workspace is
   * on (studio/git.ts commitChange). Kept here (and said) if that fails; the next turn's commit takes it too.
   */
  async function commitTurn(text: string) {
    const g = r.git;
    if (!g?.connected || r.gone) return;
    await new Promise((res) => setTimeout(res, 500)); // the file watcher reports a command's changes a moment later
    // This turn changed nothing (earlier or hand changes aren't its own): its tools didn't, nor did its commands.
    if (!g.state?.dirty || !(r.turnChanged || commandRev() !== r.cmdRev)) return;
    try {
      const onto = g.state!.activeBranch;
      const out = await g.commitChange(commitMessage(text), text);
      if (out.changed) {
        // (Update stack carrying on may have moved the workspace since: the branch committed to is the one it was on.)
        const s = { ...g.state!, ...(out.restacked ? { activeBranch: onto } : {}) };
        on({
          type: "notice",
          text: out.joined ? `The stack has ${out.change?.position} changes, its most: this request joined the top one, on ${s.activeBranch}. Deploy to land the stack, then new requests are changes of their own again.`
            : out.change ? `Committed as change ${out.change.position} of the stack, on ${s.activeBranch}. ${s.defaultBranch} stays as deployed until you deploy.`
            : `Committed to ${s.activeBranch}.`,
        });
        // The app submits its stack after each change: what GitHub refused is said.
        // A merge Update stack stopped at: it carried on (and may have stopped again).
        const rs = out.restacked;
        if (rs?.error) on({ type: "notice", text: `Committed; Update stack didn't carry on: ${rs.error}. Run Update stack again from the stack.`, error: true });
        else if (rs?.stopped) on({ type: "notice", text: `Update stack carried on and stopped at change ${rs.stopped.change.position}: merging ${rs.stopped.with} into it conflicts in ${rs.stopped.paths.join(", ")}. It's loaded here: resolve the conflict markers (ask me), and it carries on from there.`, error: true });
        else if (rs) on({ type: "notice", text: `Update stack finished: ${rs.updated.length + 1} ${rs.updated.length ? "changes" : "change"} updated, the workspace back where it was.` });
        const failed = out.submitted ? [...(out.submitted.error ? [out.submitted.error] : []), ...out.submitted.pulls.filter((p) => p.error).map((p) => `change ${p.position}: ${p.error}`)] : [];
        if (failed.length) on({ type: "notice", text: `The stack's pull requests weren't all updated (${failed.join("; ")}). Submit it again from the stack.`, error: true });
      }
    } catch (e) {
      if (gitCode(e) === "moved") {
        onStackStale();
        on({ type: "notice", text: `Not committed: ${errorMessage(e)}. Until then, requests aren't committed either. Pull it in or carry on from it in the stack above (either loads the branch as GitHub has it, over the changes here: copy any you want to keep).`, error: true });
        return;
      }
      on({ type: "notice", text: `Couldn't commit to GitHub: ${errorMessage(e)}. The changes are kept here (the next request's commit takes them too, or push them from the branch menu).`, error: true });
    }
  }

  useImperativeHandle(ref, () => ({
    running: () => tools.running > 0,
    actor: () => r.remoteAgent ?? "Claude",
    disconnectAgent: () => {
      r.bridge?.disconnect();
    },
    busy: () => r.busy || dispatcher.busy,
    turn: () => {
      if (r.busy && r.prompt) return { title: commitMessage(r.prompt), prompt: r.prompt };
      if (r.remoteAgent && (r.remoteChanged || r.commandRev() !== r.remoteCmdRev)) {
        return { title: `Changes from ${r.remoteAgent}`, prompt: `Deployed by ${r.remoteAgent}` };
      }
      return null;
    },
    focusIn: () => (sourceRef.current ? chatFocus() : setupFocus()),
    prefill(text) {
      setOpen(true, { focus: false });
      flushSync(() => setInput(text));
      if (sourceRef.current) chatFocus();
      else setupFocus();
    },
    approve(text, signal) {
      return new Promise<boolean>((resolve) => {
        if (signal?.aborted) return resolve(false);
        setOpen(true, { focus: false });
        let id = 0;
        const done = (ok: boolean) => {
          if (!r.approvals.delete(stop)) return; // already answered
          r.approved ||= ok;
          signal?.removeEventListener("abort", stop);
          if (r.gone) return resolve(false);
          const row = document.getElementById(`approval-${id}`);
          const hadFocus = !!row?.contains(document.activeElement);
          flushSync(() => update(id, (x) => ({ id: x.id, kind: "step", state: ok ? "ok" : "error", icon: ok ? "rocket" : "x", text: ok ? "Deploy approved" : "Deploy not approved" })));
          if (hadFocus) chatFocus();
          setStatus(ok ? "Deploy approved" : "Deploy not approved");
          setWorking(r.approvals.size ? "Waiting for your approval…" : !(r.busy || dispatcher.busy) ? "" : ok ? "Deploying…" : "Thinking…");
          resolve(ok);
        };
        const stop = () => done(false);
        // Focus stays where it is (a stray Enter mid-typing must not approve); the request is announced.
        id = add({ kind: "approval", text, answer: done });
        r.approvals.add(stop);
        signal?.addEventListener("abort", stop, { once: true });
        setWorking("Waiting for your approval…");
        setStatus(`${text} Approve or decline it in the AI builder.`);
      });
    },
  }));

  const remotePaired = bridgeState?.phase === "paired";
  const remotePending = bridgeState?.phase === "connecting" || bridgeState?.phase === "awaiting_approval";
  const showFeed = !!source || remotePaired || (items.length > 0 && !wantSetup);
  const setupShown = !showFeed, credited = source === "credits";
  // The chat as turns: a request and what followed it (notices before the first request stand alone).
  type Turn = { user: Extract<Item, { kind: "user" }> | null; items: Item[] };
  const turns: Turn[] = [];
  for (const x of items) {
    if (x.kind === "user") turns.push({ user: x, items: [] });
    else if (turns.length) turns.at(-1)!.items.push(x);
    else turns.push({ user: null, items: [x] });
  }
  const isLive = (t: Turn) => !!ship.at && !!t.user && t.user.at < ship.at;
  const live = turns.filter(isLive), draft = turns.filter((t) => !isLive(t));
  const lastTurn = turns.at(-1);
  const fill = (text: string) => {
    flushSync(() => setInput(text));
    chatFocus();
  };
  const host = ship.url?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const empty = !items.length && !stack;

  const entry = (x: Item) => {
    switch (x.kind) {
      case "user":
        return null;
      case "assistant":
        return <li key={x.id} className="msg assistant">{x.text}</li>;
      case "step":
        return <li key={x.id} className="step" data-state={x.state}><Icon name={x.icon} /><span>{x.text}</span>{x.failed ? <SrOnly> (failed)</SrOnly> : null}</li>;
      case "notice":
        return <li key={x.id} className="notice" data-error={x.error ? "" : undefined}>{x.text}</li>;
      case "approval":
        return (
          <li key={x.id} className="approval" id={`approval-${x.id}`}>
            <p>{x.text}</p>
            <div className="row start">
              <button type="button" className="btn primary sm" onClick={() => x.answer(true)}>Approve deploy</button>
              <button type="button" className="btn sm" onClick={() => x.answer(false)}>Decline</button>
            </div>
          </li>
        );
    }
  };
  const turn = (t: Turn, isLiveTurn: boolean) => {
    const running = busy && t === lastTurn;
    const failed = t.items.some((x) => (x.kind === "notice" && x.error) || (x.kind === "step" && x.state === "error" && x === t.items.filter((y) => y.kind === "step").at(-1)));
    const state = running ? "running" : failed ? "error" : "done";
    const key = t.user?.id ?? `n${t.items[0]?.id}`;
    if (!t.user) return <li key={key} className="turn" data-live={isLiveTurn ? "" : undefined} data-bare=""><ol className="turn-items">{t.items.map(entry)}</ol></li>;
    return (
      <li key={key} className="turn" data-state={state} data-live={isLiveTurn ? "" : undefined}>
        <span className="turn-node" aria-hidden="true">{running ? <span className="spinner" /> : <Icon name={failed ? "x" : "check"} />}</span>
        <p className="msg user">{t.user.text}</p>
        {t.items.length ? <ol className="turn-items" data-state={state}>{t.items.map(entry)}</ol> : null}
      </li>
    );
  };
  const shipLine = (
    <li className="ship" key="ship" data-state={ship.deploying ? "deploying" : ship.failed ? "failed" : ship.url ? "live" : "none"}>
      <span className="ship-beacon" aria-hidden="true" />
      {ship.deploying ? (
        <>
          <span className="ship-what">{`Deploying${ship.pending ? ` ${ship.pending} ${ship.pending === 1 ? "change" : "changes"}` : ""}`}</span>
          {ship.line ? <span className="ship-when mono">{ship.line}</span> : null}
        </>
      ) : ship.url ? (
        <>
          <span className="ship-what">Live</span>
          <span className="ship-when">{ship.at ? <>{"deployed "}<TimeAgo iso={ship.at} /></> : host}</span>
          {ship.failed && ship.line ? <span className="ship-fail small">{`The last deploy failed: ${ship.line}`}</span> : null}
          {ship.at && Date.now() - ship.at < 10 * 60_000 && !ship.pending ? (
            <span className="ship-acts"><ExtLink className="btn sm" href={ship.url}>Open the app</ExtLink></span>
          ) : null}
        </>
      ) : (
        <>
          <span className="ship-what">Not online yet</span>
          {ship.failed && ship.line ? <span className="ship-fail small">{`The deploy failed: ${ship.line}`}</span> : <span className="ship-when">Deploy puts it live at its own address.</span>}
        </>
      )}
    </li>
  );

  return (
    <section className="pane builder-pane" id="builder" aria-labelledby="builder-title" hidden={!open}>
      <div className="pane-head">
        <Icon name="sparkles" className="icon builder-mark" />
        <h2 id="builder-title" className="pane-title">Build with Claude</h2>
        <button className="icon-btn" id="builder-connect" type="button"
          aria-label="Connect desktop agent"
          title={!user ? "Log in to connect a desktop agent" : remotePaired ? `Connected to ${bridgeState.agent}` : "Connect desktop agent (cresslet connect)"}
          aria-expanded={connectOpen}
          disabled={!user || busy || remotePaired || remotePending}
          onClick={() => {
            setConnectOpen((v) => !v);
            setBridgeError("");
            setTimeout(() => bridgeCodeRef.current?.focus(), 0);
          }}>
          <Icon name="link" />
        </button>
        <button className="icon-btn" id="builder-new" type="button" aria-label="New chat" title="New chat" disabled={busy || bridgeBusy || remotePaired} onClick={() => {
          if (r.busy) return;
          // A new feature starts from the default branch: offer to go back to it (this branch stays on GitHub).
          const g = r.git, s = g?.connected ? g.state : undefined;
          if (s && s.activeBranch !== s.defaultBranch &&
              confirm(`Go back to ${s.defaultBranch} for the next change? ${s.activeBranch} stays on GitHub${s.dirty ? " (its changes here are pushed to it first)" : ""}.`)) {
            // Nothing is sent until the workspace holds the default branch.
            r.busy = true;
            setBusy(true);
            queueMicrotask(() => setWorking(`Switching to ${s.defaultBranch}…`)); // after the reset below
            void g!.switchTo(s.defaultBranch).then(
              () => setStatus(`On ${s.defaultBranch}`),
              (e) => add({ kind: "notice", text: `Couldn't switch to ${s.defaultBranch}: ${errorMessage(e)}`, error: true }),
            ).finally(() => {
              r.busy = false;
              setBusy(false);
              setWorking("");
            });
          }
          for (const decline of r.approvals) decline(); // e.g. from a process the builder left running
          setWorking("");
          r.agent = null;
          setItems([]);
          setStatus("New chat");
          chatFocus();
        }}>
          <Icon name="plus" />
        </button>
        <button className="icon-btn" id="builder-close" type="button" aria-label="Close AI builder" title="Close AI builder" onClick={() => setOpen(false)}>
          <Icon name="x" />
        </button>
      </div>
      <p className="sr-only" id="builder-status" role="status">{status}</p>
      {remotePaired ? (
        <div className="bridge-banner" id="bridge-connected" role="status">
          <span className="bridge-banner-text"><Icon name="link" /><span>Connected to <strong>{bridgeState.agent}</strong></span></span>
          <button className="btn sm" id="bridge-disconnect" type="button" onClick={() => r.bridge?.disconnect()}>Disconnect</button>
        </div>
      ) : null}
      {bridgeState?.phase === "awaiting_approval" ? (
        <div className="bridge-panel approval" id="bridge-approve-card">
          <p><strong>{bridgeState.agent}</strong> wants to control <strong>{appName}</strong>.</p>
          <p className="muted small">It can read and edit files and run commands in this project. Deploys still ask for your approval here.</p>
          <div className="row start">
            <button className="btn primary sm" id="bridge-allow" type="button" disabled={busy} onClick={() => !r.busy && r.bridge?.decide(true)}>Allow</button>
            <button className="btn sm" id="bridge-deny" type="button" onClick={() => r.bridge?.decide(false)}>Deny</button>
          </div>
        </div>
      ) : connectOpen && !remotePaired ? (
        <form className="bridge-panel" id="bridge-code-form" onSubmit={startBridge}>
          <div className="field">
            <label htmlFor="bridge-code">Pairing code from <code className="mono">cresslet connect</code></label>
            <div className="row start">
              <input id="bridge-code" ref={bridgeCodeRef} className="input mono" required placeholder="XXXX-XXXX" maxLength={16} autoComplete="off" autoCapitalize="characters" spellCheck={false}
                disabled={bridgeState?.phase === "connecting"}
                value={bridgeCode} onChange={(e) => {
                  setBridgeCode(e.target.value);
                  setBridgeError("");
                }} />
              <button className="btn primary sm" id="bridge-submit" type="submit" disabled={bridgeState?.phase === "connecting" || !bridgeCode.trim()}>
                {bridgeState?.phase === "connecting" ? "Connecting…" : "Connect"}
              </button>
              <button className="btn sm" type="button" onClick={() => {
                r.bridge?.disconnect();
                setConnectOpen(false);
                setBridgeError("");
              }}>Cancel</button>
            </div>
          </div>
          {bridgeError ? <p className="error small" id="bridge-error" role="alert">{bridgeError}</p> : null}
        </form>
      ) : null}
      <div id="builder-setup" className="builder-setup" hidden={!setupShown}>
        <p>Ask Claude to change this project. It edits files, runs commands in this tab's terminal and, when you ask, deploys with your session, like the CLI.</p>
        <div id="builder-credits-offer" className="builder-offer" hidden={!creditsOn || !!user}>
          <p id="builder-credits-text">Log in to use AI credits: no API key needed.</p>
          <div className="row start">
            <button className="btn primary" id="builder-login" type="button" ref={loginRef} onClick={() => void logIn(location.pathname + location.search)}><Icon name={loginIcon} />Log in</button>
          </div>
          <p className="muted small or" id="builder-or">Or use your own Anthropic API key:</p>
        </div>
        <form id="builder-key-form" onSubmit={(e) => {
          e.preventDefault();
          const v = keyValue.trim();
          if (!v) return;
          if (!apiKey.set(v)) return setKeyError("This browser blocked saving the key (site storage). Allow it and try again.");
          setKeyValue("");
          setKeyError("");
          setWantSetup(false);
          flushSync(() => setKeyVersion((n) => n + 1));
          chatFocus();
        }}>
          <div className="field">
            <label htmlFor="builder-key">Anthropic API key</label>
            <input id="builder-key" ref={keyRef} className="input mono" type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-…" required aria-describedby="builder-key-help builder-key-error"
              value={keyValue} onChange={(e) => {
                setKeyValue(e.target.value);
                setKeyError("");
              }} />
          </div>
          <p className="muted small" id="builder-key-help">Kept in this browser and sent only to Anthropic. Usage is billed to your Anthropic account. <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">Create a key<SrOnly> (opens in a new tab)</SrOnly></a></p>
          <p className="error small" id="builder-key-error" role="alert">{keyError}</p>
          <div className="row start">
            <button className="btn primary" type="submit">Save key</button>
          </div>
        </form>
      </div>
      <div id="builder-chat" className="builder-chat" hidden={setupShown}>
        <div className="thread" ref={logRef} tabIndex={0} role="region" aria-label="Changes and chat">
          {empty ? (
            <div className="thread-empty">
              <h3>{"What should "}<span className="nowrap">{appName}</span>{" do?"}</h3>
              <p>Say what to build or change. Claude reads the project, edits it and checks the dev server.</p>
              <ol className="how">
                <li><b>Describe a change</b><span>In your own words. No code needed.</span></li>
                <li><b>Watch the preview update</b><span>Each request becomes one change on this rail.</span></li>
                <li><b>Deploy when it looks right</b><span>{host ? `It goes live at ${host} in about a second.` : "It goes live at its own address in about a second."}</span></li>
              </ol>
              <div className="starters">
                {["Change the look: colors, fonts and spacing", "Add a page for an about section", "Save something new in the database"].map((t) => (
                  <button key={t} className="starter" type="button" onClick={() => fill(t)}><Icon name="sparkles" />{t}</button>
                ))}
              </div>
            </div>
          ) : null}
          <ol id="builder-log" className="builder-log rail" aria-labelledby="builder-title" hidden={empty}>
            {empty ? null : [
              ...live.map((t) => turn(t, true)),
              shipLine,
              ship.pending || draft.length || stack ? (
                <li className="rail-label" key="label">{"Not live yet"}{ship.pending ? <small>{` ${ship.pending} ${ship.pending === 1 ? "change" : "changes"}`}</small> : null}</li>
              ) : null,
              stack ? <li className="rail-stack" key="stack">{stack}</li> : null,
              ...draft.map((t) => turn(t, false)),
            ]}
          </ol>
        </div>
        <div className="working" id="builder-working" hidden={!working}><span className="spinner" aria-hidden="true" /><span id="builder-working-text">{working || "Working…"}</span></div>
        {remotePaired ? (
          <p className="bridge-foot muted small">Controlled by {bridgeState.agent}. Disconnect to chat with built-in Claude.</p>
        ) : !source ? (
          <div className="bridge-foot row between">
            <span className="muted small">No built-in Claude key configured.</span>
            <button className="btn sm" type="button" onClick={() => setWantSetup(true)}>Set up Claude</button>
          </div>
        ) : (
        <form id="builder-form" className="builder-form" ref={formRef} hidden={remotePending} onSubmit={(e) => void send(e)}>
          <label className="sr-only" htmlFor="builder-input">Message to Claude</label>
          <div className="composer">
            <textarea id="builder-input" ref={inputRef} rows={2} placeholder="Describe a change…"
              aria-describedby="builder-hint"
              value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  formRef.current?.requestSubmit();
                }
              }} />
            <div className="builder-actions">
              <span className="credits" id="builder-credits" hidden={!credited || !credits} title={credits?.title} data-low={credits?.low ? "" : undefined}>{credits?.text}</span>
              <p className="muted small" id="builder-hint"><kbd>Enter</kbd> sends<span className="hint-more">, <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a line</span></p>
              <button className="btn sm" id="builder-forget" type="button" hidden={source !== "key"} disabled={busy} onClick={() => {
                if (r.busy) return;
                apiKey.set(null);
                flushSync(() => setKeyVersion((n) => n + 1));
                if (creditsOn && user) {
                  void refreshCredits();
                  chatFocus();
                  setStatus("API key removed from this browser. Using your AI credits.");
                } else {
                  setupFocus();
                  setStatus("API key removed from this browser");
                }
              }}>Forget key</button>
              <button className="btn sm" id="builder-stop" type="button" hidden={!busy} onClick={() => {
                r.stopped = true;
                r.agent?.stop();
                inputRef.current?.focus(); // the Stop button hides
              }}><Icon name="x" />Stop</button>
              <button className="btn primary sm" id="builder-send" type="submit" disabled={busy || bridgeBusy} hidden={busy}><Icon name="arrow-up" />Send</button>
            </div>
          </div>
        </form>
        )}
      </div>
    </section>
  );
}
