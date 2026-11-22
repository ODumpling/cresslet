// /p/<id>: a project. Chat first: the AI builder beside the app's preview, the code (files + editor) when asked for,
// and the terminal and deploy log in a drawer under them. What was last shown is remembered in this browser.
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Container } from "../../../vendor/cresslet-container/cresslet-container.js";
import { projects, type Deploy, type StoredProject } from "../../../store.ts";
import type { CressletConfig } from "../../../cresslet-plugin.ts";
import type * as API from "../../../api-types.ts";
import { api, errorMessage, meta, mustLogIn } from "../../lib/api.ts";
import type { ProjectGitState } from "../../../git.ts";
import { viewShown } from "../../lib/focus.ts";
import { useView } from "../../lib/hooks.ts";
import { projectsChanged } from "../../lib/projects.ts";
import { rememberAfterLogin, session, useSession } from "../../lib/session.ts";
import { toast } from "../../lib/toast.tsx";
import { ExtLink, Icon, SrOnly } from "../../ui/icons.tsx";
import { Builder, type BuilderHandle } from "./Builder.tsx";
import { DeployDialog, type DeployDialogHandle } from "./DeployDialog.tsx";
import { GitDialog, type GitDialogHandle } from "./GitDialog.tsx";
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
const TABS = ["terminal", "deploy-log"] as const;
type Tab = (typeof TABS)[number];

function ProjectWorkspace({ project }: { project: StoredProject }) {
  const [name, setName] = useState(project.name);
  useView("workspace", name);
  useLayoutEffect(viewShown, []);
  const [status, setStatus] = useState({ text: "Idle", state: "idle" });
  const [prefs] = useState(layoutPrefs);
  const [view, setViewState] = useState(prefs.view === "code" ? "code" : "preview");
  const [drawer, setDrawerState] = useState(prefs.drawer === true);
  const [chat, setChat] = useState(prefs.chat !== false);
  const [tab, setTab] = useState<Tab>("terminal");
  const [tree, setTree] = useState<TreeItem[]>([]);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [deploy, setDeploy] = useState<Deploy | null>(project.deploy);
  const [deploying, setDeploying] = useState(false);
  const [deployLog, setDeployLog] = useState("");
  const [locked, setLocked] = useState(project.trusted === false);
  const [container, setContainer] = useState<Container | null>(null);
  const [preview, setPreview] = useState<{ ready: boolean; spinner: boolean; msg: ReactNode }>({ ready: false, spinner: true, msg: "Booting runtime…" });
  const [previewPath, setPreviewPath] = useState("/");
  // Source control: whether this server has it, and the project's repository and branch.
  const [gitOn, setGitOn] = useState(false);
  const [gitState, setGitState] = useState<ProjectGitState | undefined>(project.git);
  const gitDialog = useRef<GitDialogHandle>(null);

  const editorEl = useRef<HTMLDivElement>(null), termEl = useRef<HTMLDivElement>(null), drawerEl = useRef<HTMLElement>(null);
  const iframe = useRef<HTMLIFrameElement>(null), previewMsg = useRef<HTMLParagraphElement>(null), previewEmpty = useRef<HTMLDivElement>(null);
  const previewPathEl = useRef<HTMLInputElement>(null), deployBtn = useRef<HTMLButtonElement>(null), drawerBtn = useRef<HTMLButtonElement>(null);
  const builderBtn = useRef<HTMLButtonElement>(null), logEl = useRef<HTMLPreElement>(null), nameEl = useRef<HTMLInputElement>(null);
  const builder = useRef<BuilderHandle>(null), dialog = useRef<DeployDialogHandle>(null);
  const engine = useRef<Engine | null>(null);
  const previewBase = useRef<string | null>(null);
  const navigate = useNavigate();
  const { token } = useSession();

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

  useEffect(() => {
    const e = new Engine(project, {
      status: (text, state = "busy") => setStatus({ text, state }),
      previewReady(url) {
        previewBase.current = url;
        const hadFocus = !!previewEmpty.current?.contains(document.activeElement); // e.g. the message after Run it
        flushSync(() => setPreview((p) => ({ ...p, ready: true, spinner: true })));
        if (hadFocus) previewPathEl.current?.focus();
        loadPreview();
      },
      previewFailed: (msg) => setPreview({ ready: false, spinner: false, msg }),
      tree: setTree,
      openFile: setOpenFile,
      booted(c) {
        setContainer(c);
        if (project.trusted !== false) setPreview((p) => ({ ...p, msg: "Installing dependencies…" }));
      },
      deployed: setDeploy,
      git: setGitState,
      notice: (text) => toast(text, 8000),
      builderRunning: () => builder.current?.running() ?? false,
      approveDeploy: (text, signal) => builder.current?.approve(text, signal) ?? Promise.resolve(false),
    }, editorEl.current!); // mounted
    engine.current = e;
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

  // Opened from a deployed app's source: its code (and npm deps, and a deploy's build: PostCSS/Tailwind plugins)
  // would run in this browser. Nothing runs, Deploy and the AI builder included, until the user says so.
  useEffect(() => {
    if (engine.current) engine.current.locked = locked;
  }, [locked]);
  useEffect(() => {
    if (project.trusted !== false) return;
    setStatus({ text: "Not running", state: "idle" });
    setPreview({
      ready: false, spinner: false, msg: (
        <>
          {"This project was opened from a deployed app's source. Review it, then "}
          <button className="btn primary" type="button" onClick={async () => {
            project.trusted = true;
            await projects.put(project);
            flushSync(() => {
              setLocked(false);
              setPreview({ ready: false, spinner: true, msg: "Installing dependencies…" });
            });
            engine.current?.start(); // replaced the message, button included: keep focus on the message
            previewMsg.current?.focus();
          }}>Run it</button>
          {" to install its dependencies and start it here (the terminal, Deploy and the AI builder unlock then)."}
        </>
      ),
    });
  }, [project]);

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

  function setView(v: string) {
    flushSync(() => setViewState(v));
    saveLayout({ view: v });
    if (v === "code") engine.current?.measureEditor();
  }
  function setDrawer(open: boolean, { focus = false } = {}) {
    const had = !!drawerEl.current?.contains(document.activeElement);
    flushSync(() => setDrawerState(open));
    saveLayout({ drawer: open });
    if (open) engine.current?.openTerminal(termEl.current!); // mounted
    if (!open && (focus || had)) drawerBtn.current?.focus();
  }
  // The terminal opens with the drawer: also when it was left open last time.
  useEffect(() => {
    if (drawer && container) engine.current?.openTerminal(termEl.current!); // mounted
  }, [drawer, container]);
  useEffect(() => {
    if (view === "code") engine.current?.measureEditor();
  }, [view]);

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
    });
    setDrawer(true);
    selectTab("deploy-log");
    if (wasFocused) logEl.current?.focus(); // the disabled button would drop focus to <body>
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
      // A merge that can't go through (conflict, protected branch): nothing was deployed; a pull request can do it.
      const compare = (err as { compare?: string }).compare;
      toast(compare
        ? <span>{`Not deployed: ${errorMessage(err).split(". ")[0]}. `}<ExtLink href={compare}>Open a pull request</ExtLink></span>
        : `Deploy failed: ${errorMessage(err)}`, 12000);
    } finally {
      setDeploying(false);
    }
  }

  return (
    <>
      <header className="topbar" id="topbar">
        <Link className="topbar-home" to="/">
          <Icon name="logo" className="brand-mark" />
          <SrOnly>Cresslet: all projects</SrOnly>
        </Link>
        <div className="project-title" id="project-title">
          <span className="crumb-sep" aria-hidden="true">/</span>
          <input id="project-name" ref={nameEl} aria-label="Project name" spellCheck={false} autoComplete="off" defaultValue={project.name} />
          <span className="status" id="status" data-state={status.state} role="status"><span className="status-dot" aria-hidden="true" /><span id="status-text">{status.text}</span></span>
        </div>
        {/* What the main area shows next to the chat: the running app, or its code. */}
        <div className="view-switch" id="view-switch" role="group" aria-label="Show">
          <button type="button" id="view-preview" data-view="preview" aria-pressed={view === "preview"} onClick={() => setView("preview")}><Icon name="window" />Preview</button>
          <button type="button" id="view-code" data-view="code" aria-pressed={view === "code"} onClick={() => setView("code")}><Icon name="code" />Code</button>
        </div>
        <div className="spacer" />
        {deploy?.url ? (
          <a className="deploy-link" id="deploy-link" target="_blank" rel="noopener" href={deploy.url}>
            <Icon name="globe" /><span className="deploy-url">{deploy.url.replace(/^https?:\/\//, "")}</span><SrOnly> (live app, opens in a new tab)</SrOnly>
          </a>
        ) : null}
        {gitOn && token && container && !locked ? (
          gitState ? (
            <button className="btn git-pill" id="git-btn" type="button" title={`${gitState.owner}/${gitState.repo}`} onClick={() => gitDialog.current?.open()}>
              <Icon name="branch" /><span id="git-btn-branch">{gitState.activeBranch}</span>
              {gitState.dirty ? <span className="git-dirty" aria-hidden="true" /> : null}
              <SrOnly>{gitState.dirty ? " (changes not pushed)" : ""}</SrOnly><span aria-hidden="true">· Sync</span><SrOnly>: source control</SrOnly>
            </button>
          ) : (
            <button className="btn" id="git-btn" type="button" onClick={() => gitDialog.current?.open()}><Icon name="branch" />Connect Git</button>
          )
        ) : null}
        <button className="btn" id="builder-btn" type="button" ref={builderBtn} aria-expanded={chat} aria-controls="builder" hidden={!container} onClick={() => setBuilderOpen(!chat)}>
          <Icon name="sparkles" />AI builder
        </button>
        <button className="btn" id="drawer-btn" type="button" ref={drawerBtn} aria-expanded={drawer} aria-controls="drawer" onClick={() => setDrawer(!drawer)}>
          <Icon name="terminal" />Terminal
        </button>
        <button className="btn primary" id="deploy-btn" type="button" ref={deployBtn} disabled={locked || deploying || !container} title={locked ? "Run the project first" : ""} onClick={() => void onDeploy()}>
          <Icon name="rocket" /><span id="deploy-btn-label">{deploying ? "Deploying…" : "Deploy"}</span>
        </button>
      </header>

      <main id="workspace" className="workspace" aria-labelledby="workspace-title" data-view={view} data-drawer={drawer ? "open" : ""} data-builder={container && chat ? "open" : ""}>
        <h1 className="sr-only" id="workspace-title" tabIndex={-1}>{`${name}: AI builder, preview and code`}</h1>
        {container ? (
          <Builder ref={builder} c={container} locked={locked} open={chat} setOpen={setBuilderOpen} git={engine.current?.git ?? null}
            devLog={() => engine.current?.termOut ?? ""}
            // A file the builder changed is the one in the editor: show the new contents.
            onChange={(path) => {
              engine.current?.changed(); // counted at once (the watcher's report may fall in a pull's quiet window)
              return path === engine.current?.current && engine.current.openFile(path);
            }} />
        ) : null}
        <section className="pane files" id="files-pane" aria-labelledby="files-title" hidden={view !== "code"}>
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
        <section className="pane editor-pane" id="editor-pane" aria-labelledby="editor-title" hidden={view !== "code"}>
          <div className="pane-head">
            <h2 className="sr-only" id="editor-title">Code editor</h2>
            <Icon name="file" />
            <span id="open-file" className="mono crumb">{openFile ?? "No file open"}</span>
          </div>
          <div id="editor" className="editor" ref={editorEl} />
          <p className="pane-foot" id="editor-help">Tab indents. Press <kbd>Esc</kbd> then <kbd>Tab</kbd> to leave the editor.</p>
        </section>
        <section className="pane preview-pane" id="preview-pane" aria-labelledby="preview-title" hidden={view !== "preview"}>
          <div className="pane-head">
            <h2 className="sr-only" id="preview-title">Preview</h2>
            <button className="icon-btn" id="preview-reload" type="button" aria-label="Reload preview" title="Reload preview" onClick={loadPreview}>
              <Icon name="refresh" />
            </button>
            <div className="urlbar">
              <Icon name="globe" />
              <input id="preview-path" ref={previewPathEl} className="mono" value={previewPath} aria-label="Preview path" spellCheck={false} autoComplete="off"
                onChange={(e) => setPreviewPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && loadPreview()} />
            </div>
          </div>
          <div className="preview-body">
            {/* No top navigation or popups: app server code runs in workers on this origin and could mint blob: URLs
                here; a preview must not be able to open one as a top-level document. Hidden (out of the tab order)
                until its dev server is ready. */}
            <iframe id="preview" ref={iframe} hidden={!preview.ready} title="App preview" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-pointer-lock" />
            <div className="preview-empty" id="preview-empty" ref={previewEmpty} hidden={preview.ready}>
              <div className="preview-empty-inner">
                <span className="spinner" id="preview-spinner" aria-hidden="true" hidden={!preview.spinner} />
                <p id="preview-msg" tabIndex={-1} ref={previewMsg}>{preview.msg}</p>
              </div>
            </div>
          </div>
        </section>
        <section className="pane bottom-pane" id="drawer" aria-label="Output" hidden={!drawer} ref={drawerEl}>
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
          <pre id="deploy-log" className="deploy-log mono" ref={logEl} data-panel="deploy-log" role="tabpanel" aria-labelledby="tab-deploy-log" tabIndex={0} hidden={tab !== "deploy-log"}>{deployLog}</pre>
          <p className="pane-foot" id="terminal-help" data-panel="terminal" hidden={tab !== "terminal"}>Press <kbd>Esc</kbd> then <kbd>Tab</kbd> to leave the terminal.</p>
        </section>
      </main>
      <DeployDialog ref={dialog} />
      <GitDialog ref={gitDialog} git={engine.current?.git ?? null} app={deploy?.name}
        files={() => engine.current!.sources()} hydrate={(f) => engine.current!.hydrate(f)} reserve={reserveApp} />
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
