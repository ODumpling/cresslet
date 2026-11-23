// /p/<id>: a project, as the Shipline: the AI builder's rail (what's live, the ship line, the changes not live yet and
// the chat) beside a stage with the app's preview, its code, both side by side (Split), or the preview's database.
// Two modes, one layout: Guided (preview and database, nothing to decode) and Studio (dense; code, Split, the
// terminal and deploy log in a dock, source control, a status bar). The theme (light or dark) is its own toggle.
// Both show the repo's branch (the topbar pill). Guided's dock starts closed but opens on request (the Terminal
// button, ⌘J). ⌘K runs any action. What was last shown is remembered in this browser.
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Container } from "../../../vendor/cresslet-container/cresslet-container.js";
import { projects, type Deploy, type StoredProject } from "../../../store.ts";
import type { CressletConfig } from "../../../cresslet-plugin.ts";
import type * as API from "../../../api-types.ts";
import { api, errorMessage, meta, mustLogIn } from "../../lib/api.ts";
import type { ProjectGitState, PullError, PullRequest, Stack, Submitted } from "../../../git.ts";
import { viewShown } from "../../lib/focus.ts";
import { useView } from "../../lib/hooks.ts";
import { projectsChanged } from "../../lib/projects.ts";
import { rememberAfterLogin, session, useSession } from "../../lib/session.ts";
import { toast } from "../../lib/toast.tsx";
import { ExtLink, Icon, SrOnly } from "../../ui/icons.tsx";
import { Builder, type BuilderHandle } from "./Builder.tsx";
import { type Command, CommandPalette, type PaletteHandle } from "./CommandPalette.tsx";
import { DatabaseView, type RunSql } from "./DatabaseView.tsx";
import { DeployDialog, type DeployDialogHandle } from "./DeployDialog.tsx";
import { GitDialog, type GitDialogHandle } from "./GitDialog.tsx";
import { StackPanel } from "./StackPanel.tsx";
import { Engine, type TreeItem } from "./engine.ts";

/** The project, once loaded; keyed by its id, so opening another project starts over (and disposes of this one). */
export function Workspace() {
  const { id } = useParams({ from: "/p/$id" });
  const navigate = useNavigate();
  const { token } = useSession();
  const [project, setProject] = useState<StoredProject | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      // Projects need the session when this server offers login: leave them for the landing page.
      if (await mustLogIn()) {
        if (!live) return;
        rememberAfterLogin(`/p/${id}`);
        return void navigate({ to: "/", replace: true });
      }
      const p = await projects.get(id);
      if (!live) return;
      if (!p) return void navigate({ to: "/", replace: true });
      setProject((old) => (old?.id === p.id ? old : p));
    })();
    return () => void (live = false);
  }, [id, token, navigate]);
  useView("workspace", project ? project.name : null);
  return project?.id === id ? <ProjectWorkspace key={id} project={project} /> : <main id="workspace" className="workspace" aria-labelledby="workspace-title"><h1 className="sr-only" id="workspace-title" tabIndex={-1}>Project</h1></main>;
}

const LAYOUT = "cresslet.workspace";
/** What the workspace last showed (`localStorage`, this page's own JSON). */
interface LayoutPrefs {
  view?: string;
  drawer?: boolean;
  chat?: boolean;
  mode?: string;
  theme?: string;
}
const layoutPrefs = (): LayoutPrefs => {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT)!) ?? {}; // JSON.parse(null): null
  } catch {
    return {};
  }
};
const saveLayout = (p: LayoutPrefs) => {
  try {
    localStorage.setItem(LAYOUT, JSON.stringify({ ...layoutPrefs(), ...p }));
  } catch { /* storage blocked: not remembered */ }
};
const VIEWS = ["preview", "split", "code", "database"] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, string> = { preview: "Preview", split: "Split", code: "Code", database: "Database" };
const VIEW_ICON: Record<View, string> = { preview: "window", split: "split", code: "code", database: "database" };
/** Guided shows what anyone reads (the dock only on request); Studio adds the code (Code, Split), the dock and source control. */
const MODES = ["guided", "studio"] as const;
type Mode = (typeof MODES)[number];
const STUDIO_ONLY: readonly View[] = ["split", "code"];
/** Light or dark, whichever mode; until one is picked, the system's. */
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];
const systemDark = () => matchMedia("(prefers-color-scheme: dark)");
const mac = typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform);
const MOD = mac ? "⌘" : "Ctrl+";
const TABS = ["terminal", "deploy-log"] as const;
type Tab = (typeof TABS)[number];

function ProjectWorkspace({ project }: { project: StoredProject }) {
  const [name, setName] = useState(project.name);
  useView("workspace", name);
  useLayoutEffect(viewShown, []);
  const [status, setStatus] = useState({ text: "Idle", state: "idle" });
  const [prefs] = useState(layoutPrefs);
  const [view, setViewState] = useState<View>(VIEWS.find((v) => v === prefs.view) ?? "preview");
  const [mode, setModeState] = useState<Mode>(MODES.find((m) => m === prefs.mode) ?? "guided");
  const studio = mode === "studio";
  const [picked, setPicked] = useState<Theme | undefined>(THEMES.find((t) => t === prefs.theme));
  const [sysDark, setSysDark] = useState(() => systemDark().matches);
  useEffect(() => {
    const q = systemDark(), on = () => setSysDark(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  const theme: Theme = picked ?? (sysDark ? "dark" : "light");
  const themeNow = useRef(theme); // the palette's command may outlive a system change
  themeNow.current = theme;
  // What's on screen: Guided has no code views (they're kept for Studio).
  const shown: View = !studio && STUDIO_ONLY.includes(view) ? "preview" : view;
  // The dock: Studio's is remembered; Guided's starts closed every time (opened by hand when it's needed).
  const [studioDrawer, setStudioDrawer] = useState(prefs.drawer === true);
  const [guidedDrawer, setGuidedDrawer] = useState(false);
  const dock = studio ? studioDrawer : guidedDrawer;
  const [chat, setChat] = useState(prefs.chat !== false);
  const [tab, setTab] = useState<Tab>("terminal");
  const [tree, setTree] = useState<TreeItem[]>([]);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [deploy, setDeploy] = useState<Deploy | null>(project.deploy);
  const [deploying, setDeploying] = useState(false);
  const [deployLog, setDeployLog] = useState("");
  const [deployFailed, setDeployFailed] = useState<string | null>(null);
  // Requests that changed the workspace since the last deploy (not linked to a repository: its stack counts them then).
  const [turnsSince, setTurnsSince] = useState(0);
  // The preview (the draft: this tab's dev server) at desktop or phone width. (The live app can't be framed here:
  // this page is cross-origin isolated, and apps don't opt in to being embedded.)
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const palette = useRef<PaletteHandle>(null);
  const [container, setContainer] = useState<Container | null>(null);
  const [preview, setPreview] = useState<{ ready: boolean; spinner: boolean; msg: ReactNode }>({ ready: false, spinner: true, msg: "Booting runtime…" });
  const [previewPath, setPreviewPath] = useState("/");
  // Source control: whether this server has it, and the project's repository and branch.
  const [gitOn, setGitOn] = useState(false);
  const [gitState, setGitState] = useState<ProjectGitState | undefined>(project.git);
  const gitDialog = useRef<GitDialogHandle>(null);

  const editorEl = useRef<HTMLDivElement>(null), termEl = useRef<HTMLDivElement>(null), drawerEl = useRef<HTMLElement>(null);
  const iframe = useRef<HTMLIFrameElement>(null), previewEmpty = useRef<HTMLDivElement>(null);
  const previewPathEl = useRef<HTMLInputElement>(null), deployBtn = useRef<HTMLButtonElement>(null), drawerBtn = useRef<HTMLButtonElement>(null);
  const builderBtn = useRef<HTMLButtonElement>(null), logEl = useRef<HTMLPreElement>(null), nameEl = useRef<HTMLInputElement>(null);
  const builder = useRef<BuilderHandle>(null), dialog = useRef<DeployDialogHandle>(null);
  const engine = useRef<Engine | null>(null);
  const previewBase = useRef<string | null>(null);
  const navigate = useNavigate();
  const { token } = useSession();
  // The preview's database, through the running `cresslet dev` (null until the container is up).
  const runSql = useCallback<RunSql>(async (sql) => {
    const e = engine.current;
    if (!e?.cresslet) throw new Error("the project isn't running");
    return e.cresslet.sql(sql, e.previewPort); // the database of the dev server the preview shows
  }, []);
  const sqlRunner = container ? runSql : null;
  const [dbChanges, setDbChanges] = useState(0); // writes to the preview's database (an open Database view relists)

  // Logged out (or the session expired) on a server where projects need it: back to the landing page.
  useEffect(() => {
    let live = true;
    if (!token) {
      void mustLogIn().then((must) => {
        if (live && must) void navigate({ to: "/" });
      });
    }
    return () => void (live = false);
  }, [token, navigate]);

  const loadPreview = useCallback(() => {
    if (!previewBase.current || !iframe.current) return;
    const path = previewPathEl.current?.value.trim() || "/";
    iframe.current.src = previewBase.current.replace(/\/$/, "") + (path.startsWith("/") ? path : "/" + path);
  }, []);

  // The mode and theme are the page's (dialogs and toasts too) while the project is open; the editor and terminal
  // take the theme.
  useLayoutEffect(() => {
    document.documentElement.dataset.ws = mode;
  }, [mode]);
  useLayoutEffect(() => {
    document.documentElement.dataset.wsTheme = theme;
    engine.current?.setDark(theme === "dark");
  }, [theme]);
  useLayoutEffect(() => () => {
    delete document.documentElement.dataset.ws;
    delete document.documentElement.dataset.wsTheme;
  }, []);

  useEffect(() => {
    const e = new Engine(project, {
      status: (text, state = "busy") => setStatus({ text, state }),
      previewReady(url) {
        previewBase.current = url;
        const hadFocus = !!previewEmpty.current?.contains(document.activeElement);
        flushSync(() => setPreview((p) => ({ ...p, ready: true, spinner: true })));
        if (hadFocus) previewPathEl.current?.focus();
        loadPreview();
      },
      previewFailed: (msg) => setPreview({ ready: false, spinner: false, msg }),
      tree: setTree,
      openFile: setOpenFile,
      booted(c) {
        setContainer(c);
        setPreview((p) => ({ ...p, msg: "Installing dependencies…" }));
      },
      deployed(d) {
        d.at = Date.now();
        void projects.put(project);
        setDeploy({ ...d });
        setTurnsSince(0);
        setDeployFailed(null);
      },
      git: setGitState,
      dbChanged: () => setDbChanges((n) => n + 1),
      builderRunning: () => builder.current?.running() ?? false,
      builderTurn: () => builder.current?.turn() ?? null,
      approveDeploy: (text, signal) => builder.current?.approve(text, signal) ?? Promise.resolve(false),
    }, editorEl.current!); // mounted
    engine.current = e;
    e.setDark(document.documentElement.dataset.wsTheme === "dark");
    void e.boot();
    return () => {
      e.dispose();
      engine.current = null;
      projectsChanged(); // its edits and when it was saved
    };
  }, [project, loadPreview]);

  useEffect(() => {
    let live = true;
    void meta().then((m) => live && setGitOn(!!m.git?.github));
    return () => void (live = false);
  }, []);
  // Checked every minute: the default branch moved on GitHub (a webhook said: GET /v1/apps/:name `repo.upstreamSha`),
  // and the active branch's pull request (its review and checks).
  const [upstream, setUpstream] = useState<string | null>(null);
  const [pull, setPull] = useState<PullRequest | null>(null);
  const [gitTick, setGitTick] = useState(0);
  const onBranch = !!gitState && gitState.activeBranch !== gitState.defaultBranch;
  useEffect(() => {
    const name = deploy?.name;
    setPull(null);
    if (!gitState || !token || !name) return;
    let live = true;
    const check = () => {
      void api<API.AppDetail>(`/v1/apps/${encodeURIComponent(name)}`).then((d) => live && setUpstream(d.repo?.upstreamSha ?? null), () => {});
      if (onBranch) void engine.current?.git.pullRequest().then((p) => live && setPull(p), () => {});
    };
    check();
    const t = setInterval(check, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [gitState?.owner, gitState?.repo, gitState?.activeBranch, token, deploy?.name, gitTick]);
  const upstreamMoved = !!gitState && !!upstream && ![gitState.baseSha, gitState.headSha, gitState.mergeParent].includes(upstream);
  // The app's stack (server/stack.ts): the one the workspace is on, else the newest open one. Read again when the
  // workspace moves (a turn committed a change) and with the checks above.
  const [stack, setStack] = useState<Stack | null>(null);
  const [stackBusy, setStackBusy] = useState(false);
  /** Pull requests GitHub wouldn't close or reopen, said (going back again tries the closing again). */
  const pullsSaid = (errors: PullError[] | undefined, what: string) =>
    errors?.length ? ` Pull requests not ${what}: ${errors.map((x) => `change ${x.position} (${x.error})`).join(", ")}.` : "";
  // Its pull requests' review and checks (read when it has some).
  const [stackPulls, setStackPulls] = useState<Record<string, PullRequest>>({});
  const pulled = stack?.changes.filter((c) => c.pull).map((c) => `${c.id}:${c.pull}`).join(",") ?? "";
  useEffect(() => {
    const g = engine.current?.git;
    if (!stack || !pulled || !g) return setStackPulls({});
    let live = true;
    const read = () => void g.stackPulls(stack.id).then((p) => live && setStackPulls(p), () => {});
    read();
    const t = setInterval(read, 60_000); // reviews and checks finish on GitHub meanwhile
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [stack?.id, pulled, gitTick, gitState?.headSha]);
  useEffect(() => {
    const g = engine.current?.git;
    if (!gitState || !token || !deploy?.name || !g) return setStack(null);
    let live = true;
    void g.stacks().then((r) => live && setStack(r.current ?? r.stacks[0] ?? null), () => {});
    return () => void (live = false);
  }, [gitState?.owner, gitState?.repo, gitState?.activeBranch, gitState?.headSha, token, deploy?.name, gitTick, upstream]); // (main moved: Update stack)

  // Back from connecting GitHub (server/git.ts redirects here with the outcome in the hash): once the project runs,
  // the dialog opens again where it left off.
  useEffect(() => {
    if (!container) return;
    const h = new URLSearchParams(location.hash.slice(1));
    const ok = h.get("cresslet_git"), err = h.get("cresslet_git_error");
    if (!ok && !err) return;
    history.replaceState(null, "", location.pathname + location.search);
    if (err) toast(`GitHub didn't connect: ${err}`, 10000);
    else gitDialog.current?.open();
  }, [container]);

  // The project's name: saved on change (blur or Enter), as the input's change event.
  useEffect(() => {
    const el = nameEl.current!; // mounted
    const change = async () => {
      project.name = el.value.trim() || project.name;
      el.value = project.name;
      setName(project.name);
      await projects.rename(project.id, project.name);
      projectsChanged();
    };
    el.addEventListener("change", change);
    return () => el.removeEventListener("change", change);
  }, [project]);

  function setView(v: View) {
    if (!studio && STUDIO_ONLY.includes(v)) setMode("studio");
    flushSync(() => setViewState(v));
    saveLayout({ view: v });
    if (v === "code" || v === "split") engine.current?.measureEditor();
  }
  function setMode(m: Mode) {
    flushSync(() => setModeState(m));
    saveLayout({ mode: m });
    if (m === "studio" ? studioDrawer : guidedDrawer) engine.current?.openTerminal(termEl.current!); // mounted
    engine.current?.measureEditor();
  }
  function toggleTheme() {
    const t: Theme = themeNow.current === "dark" ? "light" : "dark";
    setPicked(t);
    saveLayout({ theme: t });
  }
  function setDrawer(open: boolean, { focus = false } = {}) {
    const had = !!drawerEl.current?.contains(document.activeElement);
    flushSync(() => (studio ? setStudioDrawer : setGuidedDrawer)(open));
    if (studio) saveLayout({ drawer: open });
    if (open) engine.current?.openTerminal(termEl.current!); // mounted
    if (!open && (focus || had)) drawerBtn.current?.focus();
  }
  // The terminal opens with the drawer: also when it was left open last time.
  useEffect(() => {
    if (dock && container) engine.current?.openTerminal(termEl.current!); // mounted
  }, [dock, container]);
  useEffect(() => {
    if (shown === "code" || shown === "split") engine.current?.measureEditor();
  }, [shown]);

  function setBuilderOpen(open: boolean, { focus = true } = {}) {
    flushSync(() => setChat(open));
    saveLayout({ chat: open });
    if (!focus) return;
    if (!open) builderBtn.current?.focus();
    else builder.current?.focusIn();
  }

  // Tabs (ARIA tabs pattern): one tab stop, arrows/Home/End move between tabs and select them.
  function selectTab(t: Tab, focus = false) {
    flushSync(() => setTab(t));
    if (focus) document.getElementById(`tab-${t}`)?.focus();
  }

  /** Loads the default branch merged into this one, conflicts marked, and asks the AI builder to resolve them. */
  async function resolveConflicts() {
    const g = engine.current?.git;
    if (!g?.connected) return;
    try {
      const paths = await g.resolveConflicts();
      const s = g.state!;
      if (!paths.length) return toast(`${s.defaultBranch} merged into ${s.activeBranch} without conflicts: deploy again`, 8000);
      builder.current?.prefill(`Merging ${s.defaultBranch} into ${s.activeBranch} conflicts in ${paths.join(", ")}. Each of those files holds both versions between <<<<<<< ${s.activeBranch}, ======= and >>>>>>> ${s.defaultBranch} lines. Resolve them: keep what both sides meant, remove the marker lines, and check the dev server builds. Then I'll deploy.`);
      toast(`Conflicts in ${paths.join(", ")}: resolve them (the AI builder can), then deploy`, 10000);
    } catch (e) {
      // Loaded, but npm install failed (not because of a conflicted package.json): resolve, then fix the install.
      if ((e as { filesWritten?: boolean }).filesWritten && g.state?.conflicts?.length) {
        builder.current?.prefill(`Merging ${g.state.defaultBranch} into ${g.state.activeBranch} conflicts in ${g.state.conflicts.join(", ")}: resolve them (remove the conflict markers). npm install also failed: check the terminal.`);
      }
      toast(`Couldn't load the merge: ${errorMessage(e)}`, 10000);
    }
  }
  async function openPullRequest() {
    const g = engine.current?.git;
    if (!g?.connected) return;
    try {
      const pr = await g.openPullRequest();
      setGitTick((n) => n + 1);
      toast(<span>{`Pull request #${pr.number}: `}<ExtLink href={pr.url}>{pr.title}</ExtLink>
        {pr.stackErrors?.length ? ` (problems in its stack: ${pr.stackErrors.map((x) => `change ${x.position}: ${x.error}`).join("; ")})` : null}</span>, 15000);
    } catch (e) {
      toast(`Couldn't open a pull request: ${errorMessage(e)}`, 10000);
    }
  }

  /** A new app's address, reserved with nothing deployed (to link a repository first). */
  async function reserveApp(): Promise<string | null> {
    const name = await dialog.current!.ask({ reserve: true }); // mounted
    if (!name) return null;
    const r = await api<{ app: { name: string; url: string } }>("/v1/apps", { method: "POST", body: JSON.stringify({ name }) });
    project.deploy = { name: r.app.name, url: r.app.url };
    await projects.put(project);
    setDeploy(project.deploy);
    return r.app.name;
  }

  async function onDeploy() {
    const btn = deployBtn.current!, e = engine.current;
    if (!e?.cresslet) return;
    // Linked: what the AI builder is changing becomes its request's change when the request ends; deployed now, it'd
    // go into the change before.
    if (e.git.connected && builder.current?.busy()) return void toast("Wait for the AI builder to finish this request, then deploy.", 6000);
    // A new app: the user keeps the generated address or picks their own first. (A cresslet.json that won't parse
    // skips this: the deploy below reports it.)
    let cfg: CressletConfig | undefined, newApp: { app: string; create: boolean } | undefined;
    if (!project.deploy?.name) {
      cfg = await e.config();
      if (cfg && !cfg.name) {
        const app = await dialog.current!.ask(); // mounted
        if (!app) return btn.focus();
        newApp = { app, create: true };
      }
    }
    const wasFocused = document.activeElement === btn;
    flushSync(() => {
      setDeploying(true);
      setDeployLog("");
      setDeployFailed(null);
      if (!chat) setChat(true); // the ship line shows it going live
    });
    if (studio) {
      setDrawer(true);
      selectTab("deploy-log");
    }
    // The disabled button would drop focus to <body>: the deploy log, or (Guided) the rail with the ship line.
    if (wasFocused) (studio ? logEl.current : document.querySelector<HTMLElement>("#builder .thread"))?.focus();
    try {
      // A shared app you only view: say so before building (the API would refuse the upload).
      const target = project.deploy?.name;
      if (target && session().token && !project.deploy!.deployKey) { // target: it has a deploy
        const info = await api<API.AppDetail>(`/v1/apps/${encodeURIComponent(target)}`).catch(() => null);
        if (info?.app.access === "viewer") throw new Error(`you're a viewer of ${target}: only its owner and admins can deploy it`);
      }
      const r = await e.cresslet.deploy((line) => setDeployLog((l) => l + line + "\n"), undefined, cfg, newApp);
      toast(<span>Deployed: <ExtLink href={r.app.url}>{r.app.url}</ExtLink></span>, 10000);
    } catch (err) {
      setDeployLog((l) => l + `\nerror: ${errorMessage(err)}\n`);
      setDeployFailed(errorMessage(err));
      // A merge that can't go through (conflict, protected branch): nothing was deployed. A conflict can be resolved
      // here (the AI builder, or by hand); a protected branch takes a pull request.
      const code = (err as { code?: string }).code;
      if (code === "land_next") toast(errorMessage(err), 15000);
      else if (code === "merge_conflict" || code === "branch_protected") {
        toast(<span>{`Not deployed: ${errorMessage(err).split(". ")[0]}. `}
          {code === "merge_conflict" ? <><button type="button" className="btn sm" onClick={() => void resolveConflicts()}>Resolve with the AI builder</button>{" "}</> : null}
          <button type="button" className="btn sm" onClick={() => void openPullRequest()}>Open a pull request</button>
        </span>, 20000);
      } else toast(`Deploy failed: ${errorMessage(err)}`, 10000);
    } finally {
      setDeploying(false);
    }
  }

  // Not live yet: the stack's changes when linked, else the requests that changed something since the last deploy.
  const stackShown = !!(stack && gitState && gitOn && token);
  const pending = stackShown ? stack!.changes.length : turnsSince;
  const lastLine = deployLog.trimEnd().split("\n").at(-1) ?? "";
  const gitReady = gitOn && !!token && !!container;

  // Shortcuts: ⌘K commands, ⌘. Guided/Studio, ⌘J the dock, ⌘B the AI builder.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === "k") palette.current?.toggle();
    else if (k === ".") setMode(studio ? "guided" : "studio");
    else if (k === "j") setDrawer(!dock, { focus: true });
    else if (k === "b" && container) setBuilderOpen(!chat);
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    addEventListener("keydown", on, true); // before the editor and terminal take it
    return () => removeEventListener("keydown", on, true);
  }, []);
  const commands = (): Command[] => {
    const list: Command[] = [];
    const add = (id: string, group: string, icon: string, label: string, run: () => void, keys?: string) => list.push({ id, group, icon, label, run, keys });
    add("deploy", "Actions", "ship", pending ? `Deploy ${pending} ${pending === 1 ? "change" : "changes"}` : "Deploy", () => deployBtn.current?.click());
    if (container) add("builder", "Actions", "sparkles", chat ? "Hide the AI builder" : "Ask Claude for a change", () => setBuilderOpen(!chat), `${MOD}B`);
    add("reload", "Actions", "refresh", "Reload the preview", () => (setView("preview"), loadPreview()));
    if (deploy?.url) add("live", "Actions", "globe", "Open the live app", () => void open(deploy.url, "_blank", "noopener"));
    if (gitReady) add("git", "Actions", "branch", gitState ? "Source control" : "Connect Git", () => gitDialog.current?.open());
    add("mode", "Layout", studio ? "sparkles" : "code", studio ? "Switch to Guided" : "Switch to Studio", () => setMode(studio ? "guided" : "studio"), `${MOD}.`);
    add("theme", "Layout", "moon", "Toggle dark theme", toggleTheme);
    for (const v of VIEWS) if (v !== shown) add(`view-${v}`, "Layout", VIEW_ICON[v], `Show ${VIEW_LABEL[v]}`, () => setView(v));
    add("dock", "Layout", "terminal", dock ? "Hide the terminal" : "Show the terminal", () => setDrawer(!dock, { focus: !dock }), `${MOD}J`);
    for (const f of tree) if (!f.dir) add(`file-${f.path}`, "Files", "file", f.path, () => (shown !== "code" && shown !== "split" && setView("code"), void engine.current?.openFile(f.path)));
    return list;
  };

  return (
    <>
      <header className="topbar" id="topbar">
        <Link className="topbar-home" to="/">
          <Icon name="logo" className="brand-mark" />
          <SrOnly>Cresslet: all projects</SrOnly>
        </Link>
        <div className="project-title" id="project-title">
          <input id="project-name" ref={nameEl} aria-label="Project name" spellCheck={false} autoComplete="off" defaultValue={project.name} />
          <span className="status" id="status" data-state={status.state} role="status"><span className="status-dot" aria-hidden="true" /><span id="status-text">{status.text}</span></span>
          {deploy?.url ? (
            <a className="deploy-link" id="deploy-link" target="_blank" rel="noopener" href={deploy.url}>
              <span className="deploy-url">{deploy.url.replace(/^https?:\/\//, "")}</span><Icon name="external" /><SrOnly> (live app, opens in a new tab)</SrOnly>
            </a>
          ) : <span className="deploy-link muted" aria-hidden="true">Not live yet</span>}
        </div>
        <button className="palette-btn" id="palette-btn" type="button" aria-haspopup="dialog" onClick={() => palette.current?.open()}>
          <Icon name="search" /><span>Search or run a command</span><kbd aria-hidden="true">{`${MOD}K`}</kbd>
        </button>
        <div className="topbar-right">
          {gitReady ? (
            gitState ? (
              <button className="btn git-pill" id="git-btn" type="button" title={`${gitState.owner}/${gitState.repo}`} onClick={() => gitDialog.current?.open()}>
                <Icon name="branch" /><span id="git-btn-branch" className="mono">{gitState.activeBranch}</span>
                {gitState.dirty ? <span className="git-dirty" aria-hidden="true" /> : null}
                {upstreamMoved ? <span className="git-upstream" title={`${gitState.defaultBranch} was updated on GitHub`}>{`↓ ${gitState.defaultBranch}`}</span> : null}
                {upstreamMoved ? <SrOnly>{` (${gitState.defaultBranch} was updated on GitHub: pull, or deploy to merge it)`}</SrOnly> : null}
                <SrOnly>{gitState.dirty ? " (changes not pushed)" : ""}</SrOnly><SrOnly>: source control</SrOnly>
              </button>
            ) : (
              <button className="btn s-only" id="git-btn" type="button" onClick={() => gitDialog.current?.open()}><Icon name="branch" />Connect Git</button>
            )
          ) : null}
          {pull && gitReady ? (
            <ExtLink className="btn git-pr s-only" id="git-pr-link" href={pull.url} title={`${pull.title} · ${pull.review.replace("_", " ")} · checks ${pull.checks}`}>
              {`PR #${pull.number}`}<span className="muted small">{` · ${pull.review.replace("_", " ")} · checks ${pull.checks}`}</span>
            </ExtLink>
          ) : null}
          <button className="icon-btn" id="drawer-btn" type="button" ref={drawerBtn} aria-expanded={dock} aria-controls="drawer" title={`Terminal (${MOD}J)`} aria-label="Terminal" onClick={() => setDrawer(!dock)}>
            <Icon name="terminal" />
          </button>
          <button className="icon-btn" id="builder-btn" type="button" ref={builderBtn} aria-expanded={chat} aria-controls="builder" hidden={!container} title={`AI builder (${MOD}B)`} aria-label="AI builder" onClick={() => setBuilderOpen(!chat)}>
            <Icon name="sparkles" />
          </button>
          <button className="icon-btn" id="theme-btn" type="button" title="Dark theme" aria-label="Dark theme" aria-pressed={theme === "dark"} onClick={toggleTheme}>
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
          <div className="seg mode-switch" id="mode-switch" role="group" aria-label="Mode" title={`Switch mode (${MOD}.)`}>
            <button type="button" id="mode-guided" aria-pressed={!studio} onClick={() => setMode("guided")}>Guided</button>
            <button type="button" id="mode-studio" aria-pressed={studio} onClick={() => setMode("studio")}>Studio</button>
          </div>
          <button className="deploy-btn" id="deploy-btn" type="button" ref={deployBtn} disabled={deploying || !container}
            data-state={deploying ? "deploying" : deployFailed ? "failed" : !pending && deploy?.at ? "live" : "ready"} onClick={() => void onDeploy()}>
            {deploying ? <span className="spinner" aria-hidden="true" /> : <Icon name={!pending && deploy?.at && !deployFailed ? "check" : "ship"} />}
            <span id="deploy-btn-label">{deploying ? "Deploying…" : "Deploy"}</span>
            {pending && !deploying ? <span className="deploy-count">{`${pending} ${pending === 1 ? "change" : "changes"}`}</span> : null}
          </button>
        </div>
      </header>

      <main id="workspace" className="workspace" aria-labelledby="workspace-title" data-mode={mode} data-view={shown} data-drawer={dock ? "open" : ""} data-builder={container && chat ? "open" : ""}>
        <h1 className="sr-only" id="workspace-title" tabIndex={-1}>{`${name}: AI builder, preview, code and database`}</h1>
        {/* What the stage shows: the running app, its code, both, or its database. */}
        <div className="stagebar" id="stagebar">
          <div className="seg view-switch" id="view-switch" role="group" aria-label="Show">
            {VIEWS.map((v) => (
              <button key={v} type="button" id={`view-${v}`} data-view={v} className={STUDIO_ONLY.includes(v) ? "s-only" : undefined} aria-pressed={shown === v} onClick={() => setView(v)}>
                <Icon name={VIEW_ICON[v]} />{VIEW_LABEL[v]}
              </button>
            ))}
          </div>
          <span className="stage-note muted small">
            {shown === "database" ? "The preview's own database, not the live app's"
              : pending ? `Draft: ${pending} ${pending === 1 ? "change" : "changes"} not live yet` : "Draft"}
          </span>
        </div>
        {container ? (
          <Builder ref={builder} c={container} open={chat} setOpen={setBuilderOpen} git={engine.current?.git ?? null} commandRev={() => engine.current?.commandRev ?? 0}
            onStackStale={() => setGitTick((n) => n + 1)} appName={name}
            ship={{ url: deploy?.url, at: deploy?.at, deploying, pending, line: deploying ? lastLine : deployFailed ?? undefined, failed: !!deployFailed }}
            onTurnEnd={(changed) => changed && setTurnsSince((n) => n + 1)}
            stack={stack && gitState && stackShown ? (
              <StackPanel stack={stack} state={gitState} busy={stackBusy || deploying} pulls={stackPulls}
              onSubmit={() => {
                const g = engine.current?.git;
                if (!g) return;
                setStackBusy(true);
                const said = (p: Submitted[]) => {
                  const failed = p.filter((x) => x.error);
                  const made = p.filter((x) => x.created).length, merged = p.filter((x) => x.merged);
                  if (failed.length) toast(`Pull requests: ${failed.map((x) => `change ${x.position}: ${x.error}`).join("; ")}`, 15000);
                  else toast(`Submitted: ${p.length} ${p.length === 1 ? "pull request" : "pull requests"}${made ? ` (${made} new)` : ""}${merged.length ? `; already merged: ${merged.map((x) => `#${x.number}`).join(", ")}` : ""}`, 8000);
                };
                void g.submitStack(stack.id).then((r) => said(r.pulls), (e) => toast(`Couldn't submit the stack: ${errorMessage(e)}`, 10000))
                  .finally(() => (setStackBusy(false), setGitTick((n) => n + 1)));
              }}
              onUndo={(change) => {
                const g = engine.current?.git;
                if (!g) return;
                if (builder.current?.busy()) return void toast("Wait for the AI builder to finish this request first.", 6000);
                const top = stack.changes.at(-1)!;
                // The top change is undone by going back to the one below (no new change needed).
                if (change.id === top.id) {
                  const below = stack.changes[stack.changes.indexOf(change) - 1];
                  if (!below || !confirm(`Undo the top change, "${change.title}"? That's going back to change ${below.position}: "${change.title}" is set aside (restorable until something is committed on change ${below.position}).`)) return;
                  setStackBusy(true);
                  void g.goBack(below, top).then(() => toast(`Back on change ${below.position}`, 8000), (e) => toast(`Couldn't go back: ${errorMessage(e)}`, 10000))
                    .finally(() => (setStackBusy(false), setGitTick((n) => n + 1)));
                  return;
                }
                const later = stack.changes.length - 1 - stack.changes.indexOf(change);
                if (!confirm(`Undo change ${change.position}, "${change.title}"? A new change on top reverses it, keeping the ${later} after it.${gitState.dirty ? " Changes not pushed yet are committed first." : ""}`)) return;
                setStackBusy(true);
                void g.undo(change, top).then((r) => {
                  if (!r.conflicts.length) return void toast(r.committed ? `Committed "${r.title}" as a new change` : `Nothing to undo: the later changes already undid "${change.title}"`, 8000);
                  // Conflicts: the workspace holds them with markers; the AI builder is offered to resolve them.
                  toast(`"${r.title}" has conflicts in ${r.conflicts.join(", ")}: resolve them (the AI builder can), then it's committed with the next request or Push.`, 15000);
                  builder.current?.prefill(`Resolve the conflict markers in ${r.conflicts.join(", ")}: this undoes "${change.title}" while keeping the later changes.`);
                }, (e) => {
                  // Loaded, but npm install failed (not because of a conflicted package.json): resolve, then fix the install.
                  // Or loaded, but its commit failed: held here, committed with the next request or Push.
                  const { filesWritten, held } = e as { filesWritten?: boolean; held?: boolean };
                  const u = filesWritten || held ? g.state?.undo : undefined;
                  if (u?.conflicts.length) builder.current?.prefill(`Resolve the conflict markers in ${u.conflicts.join(", ")}: this undoes "${change.title}" while keeping the later changes. npm install also failed: check the terminal.`);
                  toast(!u ? `Not undone: ${errorMessage(e)}`
                    : held && (e as { code?: string }).code !== "stack_gone" ? `"${u.title}" is loaded but not committed (${errorMessage(e)}): it's committed with the next request or Push; Pull drops it.`
                    : `"${u.title}" is loaded, but: ${errorMessage(e)}`, 15000);
                }).finally(() => (setStackBusy(false), setGitTick((n) => n + 1)));
              }}
              onFold={(change) => {
                const g = engine.current?.git;
                if (!g) return;
                if (builder.current?.busy()) return void toast("Wait for the AI builder to finish this request first.", 6000);
                const below = stack.changes[stack.changes.indexOf(change) - 1];
                if (!below) return;
                if (!confirm(`Fold change ${change.position}, "${change.title}", into change ${below.position}, "${below.title}"?\n\n` +
                  `They're one change after it, titled "${below.title}" (both requests in its description). ${change.branch} takes its place; ${below.branch} and its pull request go (kept if something still needs them: you'll be told). No commit changes.`)) return;
                setStackBusy(true);
                void g.fold(change, below).then(
                  (r) => toast(`Folded into one change: ${r.change.position} · ${r.change.title}.${pullsSaid(r.pullErrors, "updated")}`, r.pullErrors?.length ? 15000 : 8000),
                  (e) => toast(`Not folded: ${errorMessage(e)}`, 10000),
                ).finally(() => (setStackBusy(false), setGitTick((n) => n + 1)));
              }}
              onLand={(change) => {
                const g = engine.current?.git;
                if (!g) return;
                if (builder.current?.busy()) return void toast("Wait for the AI builder to finish this request first.", 6000);
                const n = stack.changes.filter((c) => c.position <= change.position).length;
                if (!confirm(`Land ${n === 1 ? `change ${change.position}` : `changes ${stack.changes[0].position}–${change.position}`} in ${gitState.defaultBranch}?\n\n` +
                  `${gitState.defaultBranch} moves to ${n === 1 ? "it" : "them"}, one at a time (their pull requests show as merged), and ${n === 1 ? "its branch goes" : "their branches go"}. Nothing is deployed: Deploy puts ${gitState.defaultBranch} live.`)) return;
                setStackBusy(true);
                void g.land(change, stack.changes.at(-1)!.branch).then(
                  (r) => toast(`Landed ${r.landed.length} ${r.landed.length === 1 ? "change" : "changes"} in ${gitState.defaultBranch} @ ${r.sha.slice(0, 7)}. Not deployed yet: ${gitState.defaultBranch} is ahead of what's live (Deploy puts it live).${pullsSaid(r.pullErrors, "moved onto " + gitState.defaultBranch)}`, 12000),
                  (e) => toast(`Not landed: ${errorMessage(e)}`, 12000),
                ).finally(() => (setStackBusy(false), setGitTick((n) => n + 1)));
              }}
              onLandNext={(change) => {
                const g = engine.current?.git;
                if (!g) return;
                if (builder.current?.busy()) return void toast("Wait for the AI builder to finish this request first.", 6000);
                const next = stack.changes[1];
                if (!confirm(`Land change ${change.position} in ${gitState.defaultBranch} through pull request #${change.pull}?\n\n` +
                  `GitHub merges it (a merge commit, or squashed where the repository allows only that), with ${gitState.defaultBranch}'s reviews, checks and rules applied, and its branch goes.` +
                  `${next ? ` Change ${next.position}'s pull request moves onto ${gitState.defaultBranch}.` : ""} Nothing is deployed: Deploy puts ${gitState.defaultBranch} live.`)) return;
                setStackBusy(true);
                void g.landNext(change, stack.changes.at(-1)!.branch).then((r) => {
                  const p = r.next?.pull;
                  const then = !r.next ? "" : !p ? ` Change ${next?.position} is the bottom now.`
                    : p.review === "approved" ? ` Change ${next?.position} is the bottom now (approved).`
                    : ` Change ${next?.position} is the bottom now, waiting for review (an approval given before may have been dismissed when its pull request moved onto ${gitState.defaultBranch}).`;
                  toast(`Landed change ${change.position} in ${gitState.defaultBranch} @ ${r.sha.slice(0, 7)}.${then} Not deployed yet.${pullsSaid(r.pullErrors, "moved onto " + gitState.defaultBranch)}`, 15000);
                }, (e) => toast((e as { landed?: unknown }).landed ? `${errorMessage(e)}.` : `Not landed: ${errorMessage(e)}`, 12000)).finally(() => (setStackBusy(false), setGitTick((n) => n + 1)));
              }}
              onUpdate={(change) => {
                const g = engine.current?.git;
                if (!g) return;
                if (builder.current?.busy()) return void toast("Wait for the AI builder to finish this request first.", 6000);
                if (!confirm(`Update change ${change.position} with ${gitState.defaultBranch}? ${gitState.defaultBranch} is merged into its branch (a merge commit, nothing forced), as GitHub's "Update branch" does.`)) return;
                setStackBusy(true);
                void g.updateBottom(change).then(
                  (c) => toast(`Change ${change.position} is up to date with ${gitState.defaultBranch} @ ${c.sha.slice(0, 7)}. Its checks run again on GitHub.`, 10000),
                  (e) => toast((e as { updated?: unknown }).updated ? `${errorMessage(e)}.` : `Not updated: ${errorMessage(e)}`, 12000),
                ).finally(() => (setStackBusy(false), setGitTick((n) => n + 1)));
              }}
              onUpdateStack={() => {
                const g = engine.current?.git;
                if (!g) return;
                if (builder.current?.busy()) return void toast("Wait for the AI builder to finish this request first.", 6000);
                if (!confirm(`Update stack? ${gitState.defaultBranch} is merged into change ${stack.changes[0].position}, then each change into the one above (merge commits, nothing forced). A conflict stops it at that change, loaded here to resolve; it carries on once that's pushed.`)) return;
                setStackBusy(true);
                void g.updateStack(stack.id).then((r) => {
                  if (!r.stopped) return void toast(r.updated.length ? `Updated ${r.updated.length} ${r.updated.length === 1 ? "change" : "changes"} with ${gitState.defaultBranch}.` : `Already up to date with ${gitState.defaultBranch}.`, 8000);
                  const s = r.stopped;
                  toast(`Update stack stopped at change ${s.change.position}: merging ${s.with} into it conflicts in ${s.paths.join(", ")}. Resolve them (the AI builder can), then push: it carries on from there.`, 15000);
                  builder.current?.prefill(`Merging ${s.with} into ${s.change.branch} (Update stack) conflicts in ${s.paths.join(", ")}. Each of those files holds both versions between <<<<<<< and >>>>>>> lines. Resolve them: keep what both sides meant, remove the marker lines.`);
                }, (e) => toast(`Not updated: ${errorMessage(e)}`, 12000)).finally(() => (setStackBusy(false), setGitTick((n) => n + 1)));
              }}
              onOutside={(how, change) => {
                const g = engine.current?.git;
                if (!g) return;
                if (builder.current?.busy()) return void toast("Wait for the AI builder to finish this request first.", 6000);
                const above = stack.changes.filter((c) => c.position > change.position).length;
                const text = how === "pull-in"
                  ? `Pull in ${change.branch} as GitHub has it, as the top of the stack?${above ? ` The ${above} ${above === 1 ? "change" : "changes"} above it are set aside for good (they don't hold that push; their branches stay).` : ""}`
                  : `Carry on from ${change.branch} as a branch of its own? The stack ends: its changes leave it (branches kept), and new requests commit to ${change.branch} as one branch.`;
                if (!confirm(`${text}${gitState.dirty ? "\n\nThis workspace's changes not pushed yet are dropped." : ""}`)) return;
                setStackBusy(true);
                void g.takeOutside(how, change, gitState.dirty).then(
                  (r) => toast(`${how === "pull-in" ? `Pulled in ${change.branch}: the next request goes on it.` : `On ${change.branch}, as a branch of its own.`}${pullsSaid(r.pullErrors, "closed")}`, r.pullErrors?.length ? 15000 : 8000),
                  (e) => toast(`Couldn't load ${change.branch}: ${errorMessage(e)}`, 10000),
                ).finally(() => (setStackBusy(false), setGitTick((n) => n + 1)));
              }}
              onContinue={(branch) => {
                const g = engine.current?.git;
                if (!g) return;
                if (builder.current?.busy()) return void toast("Wait for the AI builder to finish this request first.", 6000);
                if (!confirm(`Load ${branch} (the top of ${stack.name}) into this workspace?${gitState.dirty ? " Changes not pushed yet are pushed first." : ""}`)) return;
                setStackBusy(true);
                void g.switchTo(branch).then(() => toast(`On ${branch}`), (e) => toast(`Couldn't load ${branch}: ${errorMessage(e)}`, 10000)).finally(() => setStackBusy(false));
              }}
              onBack={(change) => {
                const g = engine.current?.git;
                if (!g) return;
                if (builder.current?.busy()) return void toast("Wait for the AI builder to finish this request first.", 6000);
                const above = stack.changes.filter((c) => c.position > change.position);
                const top = stack.changes.at(-1)!;
                // Edits here are committed first, on the top: with changes set aside above it already, that drops them.
                const dropped = gitState.dirty && stack.setAside.length;
                if (!confirm(`Go back to change ${change.position}, "${change.title}"?\n\n` +
                  `${above.length} later ${above.length === 1 ? "change is" : "changes are"} set aside: kept on GitHub, and you can restore them until something is committed on change ${change.position}.` +
                  `${gitState.dirty ? ` Changes not pushed yet are committed first, as a change on ${top.position}, set aside with them.` : ""}` +
                  `${dropped ? ` That's a commit on ${top.position}: the ${stack.setAside.length} set aside before can't be restored after it.` : ""}\n\n` +
                  "The preview's database isn't taken back: tables and rows from later changes stay.")) return;
                setStackBusy(true);
                void g.goBack(change).then(
                  (r) => toast(`Back on change ${change.position}. The next request starts a new change from here.${pullsSaid(r.pullErrors, "closed")}`, r.pullErrors?.length ? 15000 : 8000),
                  (e) => toast(`Couldn't go back: ${errorMessage(e)}`, 10000),
                ).finally(() => (setStackBusy(false), setGitTick((n) => n + 1)));
              }}
              onRestore={() => {
                const g = engine.current?.git;
                if (!g) return;
                if (builder.current?.busy()) return void toast("Wait for the AI builder to finish this request first.", 6000);
                const discard = gitState.dirty;
                if (discard && !confirm("This workspace has changes not pushed yet. Restoring loads the top change and drops them. Restore anyway?")) return;
                setStackBusy(true);
                void g.restore(stack.id, stack.setAside.at(-1)!, discard).then(
                  (r) => toast(`Restored ${r.restored} ${r.restored === 1 ? "change" : "changes"}: on change ${r.change.position}.${pullsSaid(r.pullErrors, "reopened")}`, r.pullErrors?.length ? 15000 : 8000),
                  (e) => toast(`Couldn't restore: ${errorMessage(e)}`, 10000),
                ).finally(() => (setStackBusy(false), setGitTick((n) => n + 1)));
              }} />
            ) : null}
            devLog={() => engine.current?.termOut ?? ""}
            // A file the builder changed is the one in the editor: show the new contents.
            onChange={(path) => {
              engine.current?.changed(); // counted at once (the watcher's report may fall in a pull's quiet window)
              return path === engine.current?.current && engine.current.openFile(path);
            }} />
        ) : null}
        <section className="pane files" id="files-pane" aria-labelledby="files-title" hidden={shown !== "code" && shown !== "split"}>
          <div className="pane-head">
            <h2 id="files-title" className="pane-title">Files</h2>
            <button className="icon-btn" id="new-file" type="button" aria-label="New file" title="New file" onClick={() => {
              const path = prompt("New file path (e.g. src/components/Button.tsx)")?.trim().replace(/^\/+/, "");
              if (!path || path.split("/").includes("..")) return;
              void engine.current?.newFile(path);
            }}>
              <Icon name="plus" />
            </button>
          </div>
          <Tree items={tree} current={openFile} open={(p) => void engine.current?.openFile(p)} />
        </section>
        <section className="pane editor-pane" id="editor-pane" aria-labelledby="editor-title" hidden={shown !== "code" && shown !== "split"}>
          <div className="pane-head">
            <h2 className="sr-only" id="editor-title">Code editor</h2>
            <Icon name="file" />
            <span id="open-file" className="mono crumb">{openFile ?? "No file open"}</span>
          </div>
          <div id="editor" className="editor" ref={editorEl} />
          <p className="pane-foot" id="editor-help">Tab indents. Press <kbd>Esc</kbd> then <kbd>Tab</kbd> to leave the editor.</p>
        </section>
        <section className="pane preview-pane" id="preview-pane" aria-labelledby="preview-title" hidden={shown !== "preview" && shown !== "split"}>
          <div className="pane-head preview-head">
            <h2 className="sr-only" id="preview-title">Preview</h2>
            <button className="icon-btn" id="preview-reload" type="button" aria-label="Reload preview" title="Reload preview" onClick={loadPreview}>
              <Icon name="refresh" />
            </button>
            <div className="urlbar">
              <span className="env-tag" aria-hidden="true" title="Your draft: what you change here, before it's deployed">Draft</span>
              <input id="preview-path" ref={previewPathEl} className="mono" value={previewPath} aria-label="Preview path" spellCheck={false} autoComplete="off"
                onChange={(e) => setPreviewPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && loadPreview()} />
            </div>
            <div className="seg device-switch" role="group" aria-label="Screen size">
              <button type="button" aria-pressed={device === "desktop"} aria-label="Desktop width" title="Desktop" onClick={() => setDevice("desktop")}><Icon name="monitor" /></button>
              <button type="button" aria-pressed={device === "phone"} aria-label="Phone width" title="Phone" onClick={() => setDevice("phone")}><Icon name="phone" /></button>
            </div>
          </div>
          <div className="preview-body" data-device={device}>
            {/* No top navigation or popups: app server code runs in workers on this origin and could mint blob: URLs
                here; a preview must not be able to open one as a top-level document. Hidden (out of the tab order)
                until its dev server is ready. */}
            <iframe id="preview" ref={iframe} hidden={!preview.ready} title="App preview" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-pointer-lock" />
            <div className="preview-empty" id="preview-empty" ref={previewEmpty} hidden={preview.ready}>
              <div className="preview-empty-inner">
                <span className="spinner" id="preview-spinner" aria-hidden="true" hidden={!preview.spinner} />
                <p id="preview-msg" tabIndex={-1}>{preview.msg}</p>
              </div>
            </div>
          </div>
        </section>
        <DatabaseView run={sqlRunner} shown={shown === "database"} changes={dbChanges} />
        <section className="pane bottom-pane" id="drawer" aria-label="Output" hidden={!dock} ref={drawerEl}>
          <div className="pane-head drawer-head">
            <div className="tabs" role="tablist" aria-label="Output">
              {TABS.map((t, i) => (
                <button key={t} role="tab" className="tab" id={`tab-${t}`} type="button" aria-selected={tab === t} aria-controls={t} data-tab={t} tabIndex={tab === t ? 0 : -1}
                  onClick={() => selectTab(t)}
                  onKeyDown={(e) => {
                    const j = ({ ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 } as Record<string, number>)[e.key];
                    if (j === undefined) return;
                    e.preventDefault();
                    selectTab(TABS[(j + TABS.length) % TABS.length]!, true);
                  }}>
                  <Icon name={t === "terminal" ? "terminal" : "rocket"} />{t === "terminal" ? "Terminal" : "Deploy log"}
                </button>
              ))}
            </div>
            <button className="icon-btn" id="drawer-close" type="button" aria-label="Close terminal" title="Close terminal" onClick={() => setDrawer(false, { focus: true })}>
              <Icon name="x" />
            </button>
          </div>
          <div id="terminal" className="terminal" ref={termEl} data-panel="terminal" role="tabpanel" aria-labelledby="tab-terminal" aria-describedby="terminal-help" hidden={tab !== "terminal"} />
          <pre id="deploy-log" className="deploy-log mono" ref={logEl} data-panel="deploy-log" role="tabpanel" aria-labelledby="tab-deploy-log" tabIndex={0} hidden={tab !== "deploy-log"}>{deployLog || <span className="deploy-log-empty">No deploys yet in this session. Press Deploy to see its output here.</span>}</pre>
          <p className="pane-foot" id="terminal-help" data-panel="terminal" hidden={tab !== "terminal"}>Press <kbd>Esc</kbd> then <kbd>Tab</kbd> to leave the terminal.</p>
        </section>
        <footer className="statusline s-only" id="statusline">
          <span className="statusline-item"><span className="status-dot" data-state={status.state} aria-hidden="true" />{status.text}</span>
          {gitState ? <span className="statusline-item mono"><Icon name="branch" />{gitState.activeBranch}{gitState.dirty ? " •" : ""}</span> : null}
          <span className="statusline-item">{pending ? `${pending} not live yet` : deploy?.url ? "Everything is live" : "Not deployed yet"}</span>
          <span className="statusline-push">
            <button type="button" className="statusline-item" onClick={() => palette.current?.open()}><kbd>{`${MOD}K`}</kbd>Commands</button>
            <button type="button" className="statusline-item" onClick={() => setDrawer(!dock)}><kbd>{`${MOD}J`}</kbd>Terminal</button>
            <button type="button" className="statusline-item" onClick={() => setMode("guided")}><kbd>{`${MOD}.`}</kbd>Guided</button>
          </span>
        </footer>
      </main>
      <CommandPalette ref={palette} commands={commands} />
      <DeployDialog ref={dialog} />
      <GitDialog ref={gitDialog} git={engine.current?.git ?? null} app={deploy?.name}
        files={() => engine.current!.sources()} hydrate={(f) => engine.current!.hydrate(f)} reserve={reserveApp}
        onPull={() => setGitTick((n) => n + 1)} />
    </>
  );
}

/** Folders are labels, files are buttons named by their full path (the indent alone shows nesting). */
function Tree({ items, current, open }: { items: TreeItem[]; current: string | null; open: (path: string) => void }) {
  return (
    <nav id="tree" className="tree" aria-labelledby="files-title">
      <ul>
        {items.map((f) => (
          <li key={f.path}>
            {f.dir
              ? <span className="dir" style={{ "--depth": String(f.depth) } as React.CSSProperties}><Icon name="folder" /><span>{f.name}</span></span>
              : (
                <button type="button" data-path={f.path} style={{ "--depth": String(f.depth) } as React.CSSProperties} aria-current={f.path === current ? "true" : undefined} onClick={() => open(f.path)}>
                  <Icon name="file" /><span>{f.name}</span>{f.depth ? <SrOnly>{` in ${f.path.slice(0, -f.name.length - 1)}`}</SrOnly> : null}
                </button>
              )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
