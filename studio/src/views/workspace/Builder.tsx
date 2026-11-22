// The AI builder: a chat with Claude that changes the open project (studio/builder.ts runs the conversation and the
// tools; this is only the chat). Claude is reached with the account's AI credits through this server, or with the
// user's own Anthropic API key from this browser.
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Container } from "../../../vendor/cresslet-container/cresslet-container.js";
import { anthropicClient, apiKey, createAgent, createTools, creditsClient, errorText, type AgentEvent } from "../../../builder.ts";
import type * as API from "../../../api-types.ts";
import { commitMessage, type GitWorkspace } from "../../../git.ts";
import { api, errorMessage, meta } from "../../lib/api.ts";
import { logIn, session, useSession } from "../../lib/session.ts";
import { Icon, SrOnly } from "../../ui/icons.tsx";

const STEP_ICON: Record<string, string> = { run_command: "terminal", read_dev_log: "terminal" };
/** A tool call's input as the model sent it (not validated yet). */
type ToolInput = { path?: string; command?: string } | null | undefined;
const runningText = (name: string, input: unknown) => ({
  list_files: "Listing files", read_file: `Reading ${(input as ToolInput)?.path ?? "a file"}`, write_file: `Writing ${(input as ToolInput)?.path ?? "a file"}`,
  edit_file: `Editing ${(input as ToolInput)?.path ?? "a file"}`, delete_file: `Deleting ${(input as ToolInput)?.path ?? "a file"}`,
  run_command: `Running ${(input as ToolInput)?.command ?? "a command"}`, read_dev_log: "Reading the dev server output",
} as Record<string, string>)[name] ?? name;

/** One entry in the chat log. */
type Item =
  | { id: number; kind: "user" | "assistant"; text: string }
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
  /** Focus into the pane (it was just opened). */
  focusIn(): void;
  /** Opens the pane with a message written for the user to send (or change first). */
  prefill(text: string): void;
}

export function Builder({ c, devLog, onChange, locked, open, setOpen, git, commandRev = () => 0, ref }: {
  c: Container;
  /** Source control: the project's repository, when linked (changes go on a branch; a finished turn is committed). */
  git: GitWorkspace | null;
  /** Workspace changes that weren't hand edits (a command's), counted (engine.ts). */
  commandRev?: () => number;
  devLog: () => string;
  onChange: (path: string) => unknown;
  locked: boolean;
  open: boolean;
  setOpen: (open: boolean, opts?: { focus?: boolean }) => void;
  ref: Ref<BuilderHandle>;
}) {
  const { token } = useSession();
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

  const inputRef = useRef<HTMLTextAreaElement>(null), logRef = useRef<HTMLOListElement>(null);
  const keyRef = useRef<HTMLInputElement>(null), loginRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // This request's state: the agent, whether a deploy was approved, Stop pressed; the assistant text and tool step
  // being written; the latest reply text (read out when it ends) and its error.
  const r = useRef({
    agent: null as ReturnType<typeof createAgent> | null,
    approvals: new Set<() => void>(), // decline functions of the deploy approvals waiting for the user
    approved: false, stopped: false, busy: false, locked,
    bubble: null as number | null, step: null as number | null,
    replied: "", failed: "", id: 0, stick: false,
    prompt: "", git, // the message being worked on (a new branch is named after it); the project's repository
    // This turn changed files (its file tools); branching failed; the count of non-hand changes when it was sent
    // (commands': `commandRev`, studio/src/views/workspace/engine.ts).
    turnChanged: false, branchFailed: false, cmdRev: 0,
    gone: false, // unmounted (the user left the project): no more UI updates
  }).current;
  r.locked = locked;
  r.git = git;
  const [tools] = useState(() => createTools(c, {
    devLog,
    onChange: (path) => {
      r.turnChanged = true;
      return onChange(path);
    },
    // Branch first: on the default branch of a linked repository, a new branch before the first change. If GitHub
    // can't be reached the change still happens here (nothing reaches GitHub unpushed); the turn's commit tries again.
    beforeChange: async () => {
      try {
        const b = await r.git?.ensureBranch("feat", r.prompt);
        if (b) on({ type: "notice", text: `Working on a new branch, ${b}. ${r.git!.state!.defaultBranch} stays as deployed until you deploy.` });
      } catch (e) {
        if (!r.branchFailed) on({ type: "notice", text: `Couldn't start a branch on GitHub (${errorMessage(e)}): changing files here only.`, error: true });
        r.branchFailed = true;
      }
    },
    paused: () => r.approvals.size > 0,
  }));

  // Where Claude is reached: "key" (the user's own key), "credits" (this server; logged in), or null (set one up).
  void keyVersion;
  const source = apiKey.get() ? "key" : creditsOn && token ? "credits" : null;
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
  useEffect(() => void refreshCredits(), [source, token]);
  // Leaving the project: the conversation stops with it (no more requests, tools or credits spent), and a deploy
  // waiting for approval is declined.
  useEffect(() => {
    r.gone = false; // (mounted again: React's StrictMode does that in dev)
    return () => {
      r.gone = true;
      r.stopped = true;
      r.agent?.stop();
      for (const decline of r.approvals) decline();
    };
  }, [r]);

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

  // Where focus goes in the chat: the message field (it takes a draft while locked; only sending waits).
  const chatFocus = () => inputRef.current?.focus();
  const setupFocus = () => (creditsOn && !token ? loginRef.current : keyRef.current)?.focus();

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
    if (!text || r.busy || r.locked) return;
    if (!sourceRef.current) return;
    // Each request goes the way chosen when it's sent (the key can be forgotten or entered mid-chat).
    r.agent ??= createAgent({
      // (each source has its secret: "key" a stored key, "credits" a session token)
      client: () => (sourceRef.current === "key" ? anthropicClient(apiKey.get()!) : creditsClient(session().token ?? "")),
      errorText: (x) => errorText(x, { credits: sourceRef.current !== "key" }),
      tools,
      on,
      context: () => {
        const s = r.git?.connected ? r.git.state : undefined;
        return s ? `[Source control: this project is linked to the GitHub repository ${s.owner}/${s.repo}. The workspace is on branch ${s.activeBranch} (default branch: ${s.defaultBranch})${s.dirty ? ", with changes not committed yet" : ""}.]` : null;
      },
    });
    r.stick = true;
    add({ kind: "user", text });
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
    r.prompt = text;
    r.turnChanged = r.branchFailed = false;
    r.cmdRev = commandRev();
    try {
      await r.agent.send(text);
      await commitTurn(text);
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
   * Linked to a repository: what the turn changed (files, or a command such as npm install) is committed to the
   * active branch, which is a new one if the turn started on the default branch. Kept here (and said) if that fails.
   */
  async function commitTurn(text: string) {
    const g = r.git;
    if (!g?.connected || r.gone) return;
    await new Promise((res) => setTimeout(res, 500)); // the file watcher reports a command's changes a moment later
    // This turn changed nothing (earlier or hand changes aren't its own): its tools didn't, nor did its commands.
    if (!g.state?.dirty || !(r.turnChanged || commandRev() !== r.cmdRev)) return;
    try {
      await g.ensureBranch("feat", text);
      const out = await g.sync(commitMessage(text));
      if (out.changed) on({ type: "notice", text: `Committed to ${g.state!.activeBranch}.` });
    } catch (e) {
      on({ type: "notice", text: `Couldn't commit to GitHub: ${errorMessage(e)}. The changes are kept here (push them from the branch menu).`, error: true });
    }
  }

  useImperativeHandle(ref, () => ({
    running: () => tools.running > 0,
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
          setWorking(r.approvals.size ? "Waiting for your approval…" : !r.busy ? "" : ok ? "Deploying…" : "Thinking…");
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

  const setupShown = !source, credited = source === "credits";
  return (
    <section className="pane builder-pane" id="builder" aria-labelledby="builder-title" hidden={!open}>
      <div className="pane-head">
        <h2 id="builder-title" className="pane-title">AI builder</h2>
        <button className="icon-btn" id="builder-new" type="button" aria-label="New chat" title="New chat" disabled={busy} onClick={() => {
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
        <span className="credits" id="builder-credits" hidden={!credited || !credits} title={credits?.title} data-low={credits?.low ? "" : undefined}>{credits?.text}</span>
        <button className="icon-btn" id="builder-close" type="button" aria-label="Close AI builder" title="Close AI builder" onClick={() => setOpen(false)}>
          <Icon name="x" />
        </button>
      </div>
      <p className="sr-only" id="builder-status" role="status">{status}</p>
      <div id="builder-setup" className="builder-setup" hidden={!setupShown}>
        <p>Ask Claude to change this project. It edits files, runs commands in this tab's terminal and, when you ask, deploys with your session, like the CLI.</p>
        <div id="builder-credits-offer" className="builder-offer" hidden={!creditsOn || !!token}>
          <p id="builder-credits-text">Log in to use AI credits: no API key needed.</p>
          <div className="row start">
            <button className="btn primary" id="builder-login" type="button" ref={loginRef} onClick={() => void logIn(location.pathname + location.search)}><Icon name="github" />Log in</button>
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
        <ol id="builder-log" className="builder-log" aria-labelledby="builder-title" tabIndex={0} ref={logRef}>
          {items.map((x) => {
            switch (x.kind) {
              case "user":
              case "assistant":
                return <li key={x.id} className={`msg ${x.kind}`}>{x.text}</li>;
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
          })}
        </ol>
        <div className="working" id="builder-working" hidden={!working}><span className="spinner" aria-hidden="true" /><span id="builder-working-text">{working || "Working…"}</span></div>
        <form id="builder-form" className="builder-form" ref={formRef} onSubmit={(e) => void send(e)}>
          <label className="sr-only" htmlFor="builder-input">Message to Claude</label>
          <p className="muted small" id="builder-locked" hidden={!locked}>Run the project first (see the preview): sending unlocks with the terminal and Deploy.</p>
          <textarea id="builder-input" ref={inputRef} className="input" rows={3} placeholder="Describe a change…"
            aria-describedby={locked ? "builder-locked builder-hint" : "builder-hint"}
            value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                formRef.current?.requestSubmit();
              }
            }} />
          <div className="builder-actions">
            <p className="muted small" id="builder-hint"><kbd>Enter</kbd> sends, <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a line.</p>
            <button className="btn sm" id="builder-forget" type="button" hidden={source !== "key"} disabled={busy} onClick={() => {
              if (r.busy) return;
              apiKey.set(null);
              flushSync(() => setKeyVersion((n) => n + 1));
              if (creditsOn && token) {
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
            }}>Stop</button>
            <button className="btn primary sm" id="builder-send" type="submit" disabled={busy || locked}>Send</button>
          </div>
        </form>
      </div>
    </section>
  );
}
