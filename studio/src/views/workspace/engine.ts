// A project's running parts, imperative (#78): the container (files, shell, dev server), the terminal and the editor.
// The workspace creates one when it mounts and disposes of it when it unmounts (leaving the project, or opening
// another), so no container workers, relay frame or processes outlive the view. The view's state around them (the
// file tree, the open file, the preview, the status) goes back to React through `Callbacks`.
import { Container } from "../../../vendor/cresslet-container/cresslet-container.js";
import { basicSetup, Compartment, css, EditorState, EditorView, html, indentWithTab, javascript, json, keymap, oneDark } from "../../../vendor/editor.js";
import { FitAddon, Terminal } from "../../../vendor/terminal.js";
import { fromTree, ignored, migrateDeployKeys, projects, toTree, type Deploy, type StoredProject } from "../../../store.ts";
import { createCresslet, localOnly, mergeDotenv, privateDotenvLines, projectSources, sourceDigest, type CressletConfig } from "../../../cresslet-plugin.ts";
import { createGitWorkspace, type GitFile, type GitWorkspace, type ProjectGitState } from "../../../git.ts";
import { api, errorMessage, meta } from "../../lib/api.ts";
import { session } from "../../lib/session.ts";

export interface TreeItem {
  path: string;
  name: string;
  depth: number;
  dir: boolean;
}

export interface Callbacks {
  status(text: string, state?: string): void;
  /** The preview: where the dev server listens (null: not yet), the message shown meanwhile, the spinner. */
  previewReady(url: string): void;
  previewFailed(message: string): void;
  tree(items: TreeItem[]): void;
  openFile(path: string | null): void;
  /** The container is up: the AI builder and Deploy need it. */
  booted(c: Container, cresslet: ReturnType<typeof createCresslet>): void;
  deployed(d: Deploy): void;
  /** The AI builder: whether one of its commands runs, and asking the user to approve a deploy. */
  builderRunning(): boolean;
  /**
   * The request it's working on: a deploy while one of its commands runs commits that turn as a change first (one
   * started by hand meanwhile too: the turn's edits are in it).
   */
  builderTurn(): { title: string; prompt: string } | null;
  approveDeploy(text: string, signal?: AbortSignal): Promise<boolean>;
  /** Source control: the project's repository and branch changed (or it was linked or unlinked). */
  git(state: ProjectGitState | undefined): void;
}

// ANSI colors too: xterm's defaults are made for black and fail AA on these surfaces (≥ 4.5:1 here).
const ANSI = {
  dark: {
    black: "#a1a1aa", red: "#ff7a7a", green: "#4ade94", yellow: "#f5b84a", blue: "#7aa2ff", magenta: "#d0a4ff", cyan: "#5ee0e6", white: "#ededf0",
    brightBlack: "#8e8e98", brightRed: "#ff9b9b", brightGreen: "#7beab0", brightYellow: "#f8cb78", brightBlue: "#a3bfff", brightMagenta: "#e0c2ff", brightCyan: "#8debef", brightWhite: "#ffffff",
  },
  light: {
    black: "#18181b", red: "#c42b2b", green: "#0f7a52", yellow: "#8f5a00", blue: "#1d4ed8", magenta: "#9333ea", cyan: "#0e7490", white: "#55555f",
    brightBlack: "#63636e", brightRed: "#a61f1f", brightGreen: "#0b6343", brightYellow: "#754a00", brightBlue: "#1e40af", brightMagenta: "#7e22ce", brightCyan: "#155e75", brightWhite: "#18181b",
  },
};
const langFor = (p: string) =>
  /\.(ts|tsx)$/.test(p) ? javascript({ typescript: true, jsx: p.endsWith("x") })
  : /\.(js|jsx|mjs)$/.test(p) ? javascript({ jsx: true })
  : p.endsWith(".html") ? html()
  : p.endsWith(".css") ? css()
  : p.endsWith(".json") ? json()
  : [];

export class Engine {
  c: Container | null = null;
  cresslet: ReturnType<typeof createCresslet> | null = null;
  /** The open file. */
  current: string | null = null;
  /** The terminal's latest output, for the AI builder's read_dev_log. */
  termOut = "";
  private disposed = false;
  private term: Terminal;
  private fit = new FitAddon();
  private termOpen = false;
  private termResize: ResizeObserver | null = null;
  private view: EditorView;
  private lang = new Compartment();
  private theme = new Compartment();
  private suppress = false;
  private scheme = matchMedia("(prefers-color-scheme: dark)");
  /** The workspace's mode sets the scheme (Studio dark, Guided light); null follows the system's. */
  private forceDark: boolean | null = null;
  private get dark() {
    return this.forceDark ?? this.scheme.matches;
  }
  private onScheme = () => {};
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private treeTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | null = null;
  /** A file changed (a command, the AI builder) and the save that follows hasn't started yet. */
  private dirty = false;
  private input: WritableStreamDefaultWriter<string> | null = null;
  private cleanups: (() => void)[] = [];

  private project: StoredProject;
  private cb: Callbacks;
  /** Source control (studio/git.ts): its app's repository, when linked. */
  readonly git: GitWorkspace;
  /** Paths a pull or merge just wrote (until when): the watcher's reports of those aren't the user's changes. */
  private quiet = new Map<string, number>();
  /** Paths the editor just wrote (until when): the watcher's reports of those are hand edits. */
  private hand = new Map<string, number>();
  /** Changes the watcher saw that weren't hand edits (a command's, or the AI builder's tools'). */
  commandRev = 0;
  /** A `cresslet deploy` command was declined: the rest are refused (until the project is opened again). */
  private deploysRefused = false;
  /** The last hydrate's npm install failed. */
  private installFailed = false;
  /** Counts the workspace's changes (studio/git.ts: a sync is clean only if none came in meanwhile). */
  private rev = 0;

  constructor(project: StoredProject, cb: Callbacks, editorEl: HTMLElement) {
    this.project = project;
    this.cb = cb;
    this.git = createGitWorkspace({
      app: () => project.deploy?.name,
      api: (path, init) => api(path, init),
      state: () => project.git,
      save: async (s) => {
        project.git = s;
        await projects.put(project);
        if (!this.disposed) cb.git(s);
      },
      files: () => projectSources(this.c!), // booted: the workspace's tools run after
      hydrate: (files) => this.hydrate(files),
      revision: () => this.rev,
      log: (line) => this.term.writeln(`\x1b[36m${line}\x1b[0m`),
    });
    this.term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono"),
      fontSize: 12.5,
      screenReaderMode: true, // output is mirrored into a live region screen readers can read
      theme: this.termTheme(),
    });
    this.term.loadAddon(this.fit);
    // xterm sends Tab to the shell; Esc then Tab (or Shift+Tab) moves focus out instead, like the editor.
    let escaped = false;
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.key === "Tab" && escaped) {
        escaped = false;
        return false; // xterm ignores it: the browser moves focus
      }
      escaped = e.key === "Escape";
      return true;
    });
    this.term.onData((d) => {
      void this.input?.write(d);
    });

    this.view = new EditorView({
      parent: editorEl,
      state: EditorState.create({
        doc: "",
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          this.theme.of(this.dark ? oneDark : []),
          EditorView.contentAttributes.of({ "aria-label": "Code", "aria-describedby": "editor-help" }),
          this.lang.of([]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || this.suppress || !this.current || !this.c) return;
            this.hand.set(this.current, Date.now() + 1500);
            void this.c.fs.writeFile(`${this.c.workdir}/${this.current}`, u.state.doc.toString());
            this.save();
            this.changed();
          }),
        ],
      }),
    });
    // Colors follow the light/dark preference; CSS tokens are the source of truth.
    const onScheme = this.onScheme = () => {
      this.view.dispatch({ effects: this.theme.reconfigure(this.dark ? oneDark : []) });
      this.term.options.theme = this.termTheme();
    };
    this.scheme.addEventListener("change", onScheme);
    this.cleanups.push(() => this.scheme.removeEventListener("change", onScheme));
    // A reload or closing the tab mid-debounce: don't start an export the page won't finish.
    const unload = () => clearTimeout(this.saveTimer);
    addEventListener("beforeunload", unload);
    this.cleanups.push(() => removeEventListener("beforeunload", unload));
  }

  private termTheme() {
    const v = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    return {
      ...ANSI[this.dark ? "dark" : "light"],
      background: v("--surface"), foreground: v("--text"), cursor: v("--accent-text"), cursorAccent: v("--surface"), selectionBackground: v("--accent-soft"),
    };
  }

  /** Opened the first time the drawer shows (xterm measures its cells on open); output before that is kept. */
  openTerminal(el: HTMLElement) {
    if (this.termOpen || this.disposed) return;
    this.termOpen = true;
    this.term.open(el);
    this.term.textarea?.setAttribute("aria-describedby", "terminal-help");
    this.fit.fit();
    this.termResize = new ResizeObserver(() => this.fit.fit());
    this.termResize.observe(el);
  }
  /** The editor and terminal take the workspace's scheme (its CSS tokens are already set): dark, light, or null (the system's). */
  setDark(dark: boolean | null) {
    if (dark === this.forceDark) return;
    this.forceDark = dark;
    this.onScheme();
  }
  /** The editor was shown: it measures itself. */
  measureEditor() {
    this.view.requestMeasure();
  }

  async boot() {
    const cb = this.cb;
    cb.status("Booting");
    let c: Container;
    try {
      // Previews on their own origin: preview code can't read this page's storage (the API token).
      // Fail closed: never fall back to running previews on this origin.
      const { previewOrigin } = await meta();
      let po;
      try {
        po = new URL(String(previewOrigin)).origin; // (URL stringifies it too: a missing one throws)
      } catch {
        throw new Error("the server didn't say where previews run (GET /v1 → previewOrigin); refusing to run them on the studio's origin");
      }
      if (po === location.origin) throw new Error("previewOrigin must differ from the studio's origin");
      // Earlier versions registered the container's worker on this origin: drop it (only that one), and
      // reload once if it still controls this page.
      let dropped = false;
      for (const r of await navigator.serviceWorker?.getRegistrations?.() ?? []) {
        const w = r.active ?? r.waiting ?? r.installing;
        if (w && new URL(w.scriptURL).origin === location.origin && new URL(w.scriptURL).pathname === "/cresslet-sw.js") {
          dropped = (await r.unregister()) || dropped;
        }
      }
      const ctl = navigator.serviceWorker?.controller;
      if (dropped && ctl && new URL(ctl.scriptURL).origin === location.origin && new URL(ctl.scriptURL).pathname === "/cresslet-sw.js") {
        return void location.reload();
      }
      // All local projects' deploy keys out of IndexedDB before any app code runs (workers can read it).
      if (await migrateDeployKeys()) {
        throw new Error("couldn't move deploy keys out of IndexedDB into localStorage (is site storage blocked for this site?). Not starting app code until it can; allow site storage and reload");
      }
      c = await Container.boot({ previewOrigin: po });
    } catch (e) {
      if (this.disposed) return;
      cb.status("Runtime failed", "error");
      cb.previewFailed(`Could not start the runtime: ${errorMessage(e)}`);
      this.term.writeln(`\x1b[31m${(e as Error).stack ?? errorMessage(e)}\x1b[0m`);
      return;
    }
    if (this.disposed) return c.teardown(); // left while it booted
    this.c = c;
    const wd = c.workdir, project = this.project;
    await c.mount(toTree(project.files));
    if (this.disposed) return;

    /** What a `cresslet deploy` command will do, as the user is asked it. */
    const deploying = (target: string | null) => {
      const g = this.git.connected ? project.git! : null;
      return g && target && g.activeBranch !== g.defaultBranch
        ? `merge ${g.activeBranch} into ${g.defaultBranch} and deploy ${target} from ${g.defaultBranch}`
        : `deploy ${target ? `to ${target}` : "this project as a new app"}${g ? ` from ${g.defaultBranch}` : ""}`;
    };
    this.cresslet = createCresslet(c, {
      auth: () => ({ token: session().token }),
      project: () => project,
      onDeployed: async (r) => {
        const deploy: Deploy = project.deploy = { name: r.app.name, deployKey: r.deployKey ?? project.deploy?.deployKey, url: r.app.url };
        const saved = await projects.put(project).catch(() => false);
        if (!saved && deploy.deployKey) {
          // Site storage refused the key; it's not kept anywhere app code can read, so hand it over.
          prompt("This browser blocked saving the app's deploy key. Copy it now (needed to redeploy without logging in):", deploy.deployKey);
        }
        cb.deployed(deploy);
      },
      // `cresslet deploy` in a command the AI builder started: the user says yes first.
      builderRunning: () => cb.builderRunning(),
      approveDeploy: (target, signal) => cb.approveDeploy(`Claude wants to ${deploying(target)}. It goes live at once.`, signal),
      // `cresslet deploy` from the terminal or the project's own code (which runs as it opens): the user types "deploy"
      // to say yes, so an Enter meant for something else (the editor, the terminal) can't. Once declined, the rest are
      // refused until the project is opened again: code that keeps asking gets one try. The Deploy button still deploys.
      confirmDeploy: async (target) => {
        if (this.deploysRefused) return false;
        const ok = prompt(`A command in this project's terminal wants to ${deploying(target)}. It goes live at once.\n\nType deploy to go ahead. (Anything else refuses terminal deploys until the project is opened again; the Deploy button still works.)`)?.trim().toLowerCase() === "deploy";
        this.deploysRefused = !ok;
        return ok;
      },
      // Linked to a repository: Deploy commits the branch, merges it into the default branch and deploys that.
      beforeDeploy: async (log, signal, app) => {
        if (this.git.connected && (!app || app === project.deploy?.name)) {
          // Where it came from, as it was asked for (a builder command's, approved; or by hand): not when its queued
          // step runs, when another command of a request started since may be running.
          const fromBuilder = cb.builderRunning();
          const { files, ...p } = await this.git.prepareDeploy(log, signal, { turn: () => cb.builderTurn(), running: () => fromBuilder });
          return { ...p, source: sourceDigest(files) };
        }
        // Linked to a repository elsewhere (another browser, the CLI), not here: deploying this workspace would skip it.
        const name = app ?? project.deploy?.name;
        const linked = name && session().token
          ? await api<{ repo?: { fullName: string } | null }>(`/v1/apps/${encodeURIComponent(name)}`).then((d) => d.repo, () => null)
          : null;
        if (linked) throw new Error(`${name} is linked to ${linked.fullName}, but this workspace isn't: open Source control (the branch button) to load it first`);
        return null;
      },
    });

    // keep the tree in sync with terminal changes
    const watcher = c.fs.watch(wd, { recursive: true }, (_e, filename) => {
      if (filename && ignored(filename.replace(`${wd}/`, ""))) return;
      this.dirty = true; // saved below, or when the view goes before that
      const rel = filename?.replace(`${wd}/`, "");
      if (!(rel && ((this.quiet.get(rel) ?? 0) > Date.now() || localOnly(rel)))) {
        this.changed();
        // A command the AI builder runs (not a terminal command, the file tree, or the editor).
        if (this.cb.builderRunning() && (!rel || (this.hand.get(rel) ?? 0) <= Date.now())) this.commandRev++;
      }
      clearTimeout(this.treeTimer);
      this.treeTimer = setTimeout(() => {
        void this.renderTree();
        this.save();
        // the open file removed (a command, the AI builder): openFile clears the editor
        const open = this.current;
        if (open) c.fs.exists(`${wd}/${open}`).then((ok): unknown => ok || this.openFile(open), () => {});
      }, 300);
    });
    this.cleanups.push(() => watcher.close());

    await this.renderTree();
    await this.openFile(["src/App.tsx", "src/main.ts", "src/routes/index.tsx"].find((f) => project.files[f] !== undefined) ?? "index.html");
    if (this.disposed) return;

    c.on("server-ready", (port, url) => {
      if (port !== 3000 && this.previewBase) return;
      this.previewBase = url;
      this.previewPort = port;
      cb.status("Running", "ready");
      cb.previewReady(url);
    });
    c.on("error", (e) => this.term.writeln(`\x1b[31m${e?.message ?? e}\x1b[0m`));

    // shell
    const shell = await c.spawn("jsh", [], { cwd: wd, terminal: true });
    if (this.disposed) return;
    void shell.output.pipeTo(new WritableStream({ write: (d) => {
      this.term.write(d);
      this.termOut = (this.termOut + d).slice(-64_000);
    } })).catch(() => {});
    this.input = shell.input.getWriter();
    cb.booted(c, this.cresslet);
    this.start();
  }
  private previewBase: string | null = null;
  /** The port the preview shows (the one `cresslet dev` starts on, until a server is ready). */
  previewPort = 3000;

  /** Installs the dependencies and starts the dev server (the preview): every project runs as it opens. */
  private start() {
    this.cb.status("Installing");
    void this.input?.write("npm install && cresslet dev\r");
  }

  /** The project's source files into IndexedDB, debounced. */
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveNow(), 400);
  }
  private saveNow() {
    const c = this.c;
    if (!c) return Promise.resolve();
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.dirty = false;
    const run = (async () => {
      const tree = await c.export(c.workdir, { excludes: ["node_modules/**", "dist/**", ".cresslet/**"] });
      this.project.files = Object.fromEntries(Object.entries(fromTree(tree)).filter(([p]) => !ignored(p)));
      await projects.put(this.project);
      if (!this.disposed) await this.renderTree();
    })();
    const done: Promise<void> = run.catch(() => {}).finally(() => {
      if (this.saving === done) this.saving = null;
    });
    return (this.saving = done);
  }

  private async listFiles(dir = "", depth = 0, out: TreeItem[] = []) {
    const c = this.c!; // booted
    const entries = await c.fs.readdir(`${c.workdir}${dir ? "/" + dir : ""}`, { withFileTypes: true });
    entries.sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name));
    for (const e of entries) {
      const path = dir ? `${dir}/${e.name}` : e.name;
      if (ignored(path)) continue;
      if (e.isDirectory()) {
        out.push({ path, name: e.name, depth, dir: true });
        await this.listFiles(path, depth + 1, out);
      } else out.push({ path, name: e.name, depth, dir: false });
    }
    return out;
  }
  async renderTree() {
    if (!this.c) return;
    const items = await this.listFiles().catch(() => []);
    if (!this.disposed) this.cb.tree(items);
  }

  async openFile(path: string) {
    const c = this.c;
    if (!c) return;
    let text;
    try {
      text = await c.fs.readFile(`${c.workdir}/${path}`, "utf8");
    } catch {
      if (path === this.current) {
        // The open file is gone (deleted from the terminal or by the AI builder): don't let typing recreate it.
        this.current = null;
        this.suppress = true;
        this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: "" }, effects: this.lang.reconfigure([]) });
        this.suppress = false;
        this.view.contentDOM.setAttribute("aria-label", "Code");
        this.cb.openFile(null);
      }
      return;
    }
    if (this.disposed) return;
    this.current = path;
    this.suppress = true;
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text }, effects: this.lang.reconfigure(langFor(path)) });
    this.suppress = false;
    this.view.contentDOM.setAttribute("aria-label", `Code: ${path}`);
    this.cb.openFile(path);
  }

  /** The workspace changed (the user, or the AI builder's tools). */
  changed() {
    this.rev++;
    this.git.markDirty();
  }

  async newFile(path: string) {
    const c = this.c;
    if (!c) return;
    await c.fs.writeFile(`${c.workdir}/${path}`, "");
    this.save();
    await this.renderTree();
    await this.openFile(path);
  }

  /** The project's source as it would be committed (no local secrets). */
  sources(): Promise<GitFile[]> {
    if (!this.c) return Promise.reject(new Error("the runtime isn't running"));
    return projectSources(this.c);
  }

  /**
   * Makes the workspace hold `files` (a branch pulled, or a merge that brought the default branch's commits): changed
   * ones written, ones it no longer has removed, dependencies installed again if package.json or its lockfile
   * changed. Local-only files (.env.local, .dev.vars…) stay. A dotenv file takes the repository's public entries and
   * keeps its own private ones (the repository never has those). If only installing fails, the error says
   * `filesWritten`.
   */
  async hydrate(files: GitFile[]) {
    const c = this.c;
    if (!c) throw new Error("the runtime isn't running");
    const wd = c.workdir;
    const dotenv = /(?:^|\/)\.env[^/]*$/i;
    const want = new Map(files.map((f) => [f.path, f]));
    const quiet = (rel: string, ms = 2000) => {
      for (let p = rel; p; p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") this.quiet.set(p, Date.now() + ms);
    };
    /** A dotenv file's own lines, those the repository never has (the deploy filter's own reading of it). */
    const privateLines = privateDotenvLines;
    /** Any file under a folder (empty folders don't count). */
    const hasFiles = async (dir: string): Promise<boolean> => {
      for (const e of await c.fs.readdir(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || await hasFiles(`${dir}/${e.name}`)) return true;
      }
      return false;
    };
    const isDir = (path: string) => c.fs.stat(path).then((st) => st.isDirectory(), () => false);
    let deps = false;
    for (const f of await projectSources(c)) {
      if (want.has(f.path)) continue;
      quiet(f.path);
      if (dotenv.test(f.path)) {
        // Gone from the repository: its public entries go, its private ones stay.
        const own = privateLines(await c.fs.readFile(`${wd}/${f.path}`, "utf8").catch(() => ""));
        if (own.length) {
          await c.fs.writeFile(`${wd}/${f.path}`, own.join("\n") + "\n");
          continue;
        }
      }
      await c.fs.rm(`${wd}/${f.path}`).catch(() => {});
      deps ||= /^package(?:-lock)?\.json$/.test(f.path);
    }
    for (const f of files) {
      if (localOnly(f.path)) continue;
      const path = `${wd}/${f.path}`;
      let data: string | Uint8Array = f.encoding === "base64" ? Uint8Array.from(atob(f.data), (ch) => ch.charCodeAt(0)) : f.data;
      // A directory where a file now goes (foo/index.ts → foo): it's emptied of source above; local files keep it.
      if (await isDir(path)) {
        if (await hasFiles(path)) throw new Error(`${f.path} is a file now, but this workspace has local files in a folder of that name`);
        quiet(f.path);
        await c.fs.rm(path, { recursive: true });
      }
      const exists = await c.fs.exists(path).catch(() => false);
      if (exists) {
        const now = await c.fs.readFile(path, typeof data === "string" ? "utf8" : undefined).catch(() => null);
        if (dotenv.test(f.path) && typeof now === "string" && typeof data === "string") {
          // The repository's public entries, exactly, and this file's own private lines; if they can't both be kept,
          // the file is left as it is (its secrets aren't dropped).
          data = mergeDotenv(now, data) ?? now;
        }
        if (typeof data === "string" ? now === data : now instanceof Uint8Array && now.length === data.length && now.every((b, i) => b === (data as Uint8Array)[i])) continue;
      }
      const i = f.path.lastIndexOf("/");
      quiet(f.path); // and its folders, before mkdir reports them
      if (i > 0) await c.fs.mkdir(`${wd}/${f.path.slice(0, i)}`, { recursive: true });
      await c.fs.writeFile(path, data);
      deps ||= /^package(?:-lock)?\.json$/.test(f.path);
    }
    await this.saveNow();
    if (this.current) await this.openFile(this.current);
    if (deps || this.installFailed) {
      this.term.writeln("\x1b[36mdependencies changed: npm install\x1b[0m");
      // A lockfile it rewrites is a change to commit (it differs from the commit loaded), even inside the quiet window.
      const lock = () => c.fs.readFile(`${wd}/package-lock.json`, "utf8").catch(() => null);
      const before = await lock();
      const p = await c.spawn("jsh", ["-c", "npm install"], { cwd: wd });
      void p.output.pipeTo(new WritableStream({ write: (d) => this.term.write(d) })).catch(() => {});
      await p.input.close().catch(() => {});
      this.installFailed = await p.exit !== 0; // tried again on the next pull, even if nothing changes then
      if (await lock() !== before) this.changed();
      if (this.installFailed) throw Object.assign(new Error("npm install failed (see the terminal)"), { filesWritten: true });
    }
  }

  writeln(text: string) {
    this.term.writeln(text);
  }

  /** Reads the project config (cresslet.json) for Deploy. */
  config(): Promise<CressletConfig | undefined> {
    return this.cresslet ? this.cresslet.config().catch(() => undefined) : Promise.resolve(undefined);
  }

  /** Stops everything: its edits saved first (an in-app navigation away), then the container, terminal and editor. */
  dispose() {
    if (this.disposed) return;
    const pending = this.saveTimer !== undefined || this.dirty ? this.saveNow() : this.saving;
    this.disposed = true;
    clearTimeout(this.treeTimer);
    for (const f of this.cleanups.splice(0)) {
      try {
        f();
      } catch { /* already gone */ }
    }
    this.termResize?.disconnect();
    this.view.destroy();
    this.term.dispose();
    void this.input?.close().catch(() => {});
    const c = this.c;
    if (c) void Promise.resolve(pending).finally(() => c.teardown());
  }
}
