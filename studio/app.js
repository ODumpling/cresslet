import { Container } from "/vendor/cresslet-container/cresslet-container.js";
import { basicSetup, Compartment, css, EditorState, EditorView, html, indentWithTab, javascript, json, keymap, oneDark } from "/vendor/editor.js";
import { FitAddon, Terminal } from "/vendor/terminal.js";
import { auth, fromTree, ignored, migrateDeployKeys, projects, toTree } from "/store.js";
import { createCresslet } from "/cresslet-plugin.js";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...children.filter((c) => c != null));
  return n;
};

// ------------------------------------------------------------------ shared UI
function toast(content, ms = 5000) {
  const t = $("toast");
  t.replaceChildren(content);
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

function setStatus(text, state = "busy") {
  $("status").textContent = text;
  $("status").dataset.state = state;
}

async function api(path, init = {}) {
  const headers = { "content-type": "application/json", ...init.headers };
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401 && headers.authorization && auth.token) {
    // Token revoked (e.g. regenerated elsewhere): drop it and retry logged out.
    logOut();
    toast("Your session expired. Log in again.");
    return api(path, init);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message ?? `${res.status}`), { status: res.status });
  return body;
}

function renderAccount() {
  $("account-btn").textContent = auth.token ? (auth.email ?? "Account") : "Log in with GitHub";
  $("account-btn").title = auth.token ? "Settings" : "";
}

// Login is GitHub only: the server redirects back to /#cresslet_login=<one-time code>.
const meta = fetch("/v1").then((r) => r.json()).catch(() => ({}));

$("account-btn").addEventListener("click", async () => {
  if (auth.token) {
    location.hash = "#/settings";
    return;
  }
  if ((await meta).auth?.github) location.href = "/v1/auth/github";
  else toast("Login isn't set up on this server (operator: set CRESSLET_GITHUB_CLIENT_ID / _SECRET).");
});

function setAccount(r) {
  auth.token = r.token ?? auth.token;
  auth.email = r.account.github ?? r.account.email;
  renderAccount();
}

function logOut() {
  auth.token = null;
  auth.email = null;
  renderAccount();
}

{
  const h = new URLSearchParams(location.hash.slice(1));
  const code = h.get("cresslet_login"), err = h.get("cresslet_login_error");
  if (code || err) {
    history.replaceState(null, "", location.pathname + location.search);
    if (err) toast(`GitHub login failed: ${err}`);
    else {
      api("/v1/auth/exchange", { method: "POST", body: JSON.stringify({ code }) }).then((r) => {
        setAccount(r);
        if (!$("home").hidden) renderHome();
        toast(`Logged in as ${auth.email}`);
      }, (e) => toast(`GitHub login failed: ${e.message}`));
    }
  }
}

// ------------------------------------------------------------------ settings
function showOnly(id) {
  for (const m of ["home", "settings", "workspace"]) $(m).hidden = m !== id;
  $("project-title").hidden = true;
  $("deploy-btn").hidden = true;
  $("deploy-link").hidden = true;
}

function renderSettings() {
  if (!auth.token) {
    location.hash = "#/";
    return;
  }
  showOnly("settings");
  document.title = "Settings · Cresslet Studio";
  $("token").value = auth.token;
  $("token").type = "password";
  $("token-show").textContent = "Show";
  $("token-show").setAttribute("aria-pressed", "false");
  api("/v1/me").then(({ account }) => {
    $("set-github").textContent = account.github ?? "—";
    $("set-email").textContent = account.email;
    setAccount({ account });
  }, (e) => {
    if (!auth.token) location.hash = "#/";
    else toast(`Could not load account: ${e.message}`);
  });
}

$("token-show").addEventListener("click", () => {
  const show = $("token").type === "password";
  $("token").type = show ? "text" : "password";
  $("token-show").textContent = show ? "Hide" : "Show";
  $("token-show").setAttribute("aria-pressed", String(show));
});

$("token-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(auth.token);
    toast("Token copied");
  } catch {
    $("token").type = "text";
    $("token").select();
    toast("Copy failed: select the token and copy it manually.");
  }
});

$("token-regen").addEventListener("click", async () => {
  if (!confirm("Regenerate your token? Every existing token stops working, including the CLI and other browsers.")) return;
  try {
    setAccount(await api("/v1/me/token", { method: "POST", body: "{}" }));
    renderSettings();
    toast("New token generated. Update the CLI and any CI secrets.");
  } catch (e) {
    toast(`Could not regenerate: ${e.message}`);
  }
});

$("logout-btn").addEventListener("click", () => {
  logOut();
  location.hash = "#/";
});

// ------------------------------------------------------------------ home
async function renderHome() {
  showOnly("home");
  document.title = "Cresslet Studio";

  api("/v1/templates").then(({ templates }) => {
    $("templates").replaceChildren(...templates.map((t) =>
      el("button", { className: "card", onclick: () => createProject(t.name) },
        el("strong", { textContent: t.name }), el("span", { textContent: t.description ?? "" }))
    ));
  }).catch((e) => $("templates").replaceChildren(el("p", { className: "error", textContent: `Could not load templates: ${e.message}` })));

  const list = await projects.list().catch(() => []);
  $("projects").replaceChildren(...list.map((p) =>
    el("div", { className: "list-row" },
      el("a", { href: `#/p/${p.id}`, textContent: p.name }),
      el("span", { className: "meta", textContent: `${p.template} · edited ${new Date(p.updatedAt).toLocaleString()}` }),
      el("button", {
        className: "icon-btn",
        title: "Delete project",
        ariaLabel: `Delete ${p.name}`,
        textContent: "×",
        onclick: async () => {
          if (!confirm(`Delete local project ${p.name}? Deployed apps are not affected.`)) return;
          await projects.delete(p.id);
          renderHome();
        },
      }))
  ));

  $("apps-section").hidden = !auth.token;
  if (auth.token) {
    api("/v1/apps").then(({ apps }) => {
      $("apps").replaceChildren(...apps.map((a) =>
        el("div", { className: "list-row" },
          el("a", { href: a.url, target: "_blank", rel: "noopener", textContent: a.name }),
          el("span", { className: "meta", textContent: `updated ${new Date(a.updatedAt).toLocaleString()}` }),
          el("button", { className: "btn", textContent: "Open source", title: "Open the deployed source as a new project", onclick: () => openDeployed(a) }))
      ));
    }).catch(() => {});
  }
}

/** New local project from the source uploaded with the app's current deploy (CLI or studio). */
async function openDeployed({ name, url }) {
  let src;
  try {
    src = await api(`/v1/apps/${encodeURIComponent(name)}/source`);
  } catch (e) {
    alert(`Could not open ${name}: ${e.message}`);
    return;
  }
  const files = Object.create(null); // any file name, incl. "__proto__"
  for (const f of src.files) {
    files[f.path] = f.encoding === "base64" ? Uint8Array.from(atob(f.data), (ch) => ch.charCodeAt(0)) : f.data;
  }
  const id = crypto.randomUUID().slice(0, 8);
  // Whoever holds the app's deploy key may have uploaded this source: don't run it until the user says so.
  await projects.put({ id, name, template: "deployed", files, deploy: { name, url }, trusted: false });
  location.hash = `#/p/${id}`;
}

async function createProject(template) {
  const t = await api(`/v1/templates/${template}`);
  const files = {};
  for (const f of t.files) {
    files[f.path] = f.encoding === "base64" ? Uint8Array.from(atob(f.data), (ch) => ch.charCodeAt(0)) : f.data;
  }
  const id = crypto.randomUUID().slice(0, 8);
  await projects.put({ id, name: `${template}-${id.slice(0, 4)}`, template, files, deploy: null });
  location.hash = `#/p/${id}`;
}

// ------------------------------------------------------------------ workspace
let booted = false;

async function openProject(id) {
  const project = await projects.get(id);
  if (!project) {
    location.hash = "#/";
    return;
  }
  if (booted) {
    // One runtime per page; switching projects reloads.
    location.reload();
    return;
  }
  booted = true;
  showOnly("workspace");
  $("project-title").hidden = false;
  $("deploy-btn").hidden = false;
  $("project-name").value = project.name;
  document.title = `${project.name} · Cresslet Studio`;
  showDeployLink(project.deploy);

  $("project-name").onchange = async (e) => {
    project.name = e.target.value.trim() || project.name;
    await projects.rename(project.id, project.name);
  };

  // terminal
  const term = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono"),
    fontSize: 12.5,
    theme: { background: "#151a18", foreground: "#e4ebe7", cursor: "#3fb560", selectionBackground: "#3fb56055" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open($("terminal"));
  fit.fit();
  new ResizeObserver(() => fit.fit()).observe($("terminal"));

  setStatus("Booting");
  let c;
  try {
    // Previews on their own origin: preview code can't read this page's storage (the API token).
    // Fail closed: never fall back to running previews on this origin.
    const { previewOrigin } = await meta;
    let po;
    try {
      po = new URL(previewOrigin).origin;
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
    setStatus("Runtime failed", "error");
    $("preview-msg").textContent = `Could not start the runtime: ${e.message}`;
    term.writeln(`\x1b[31m${e.stack ?? e.message}\x1b[0m`);
    return;
  }
  const wd = c.workdir;
  await c.mount(toTree(project.files));

  // persistence: debounce export of source files into IndexedDB
  let saveTimer;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const tree = await c.export(wd, { excludes: ["node_modules/**", "dist/**", ".cresslet/**"] });
      project.files = Object.fromEntries(Object.entries(fromTree(tree)).filter(([p]) => !ignored(p)));
      await projects.put(project);
      renderTree();
    }, 400);
  };
  addEventListener("beforeunload", () => clearTimeout(saveTimer));

  const cresslet = createCresslet(c, {
    auth: () => ({ token: auth.token }),
    project: () => project,
    onDeployed: async (r) => {
      project.deploy = { name: r.app.name, deployKey: r.deployKey ?? project.deploy?.deployKey, url: r.app.url };
      const saved = await projects.put(project).catch(() => false);
      if (!saved && project.deploy.deployKey) {
        // Site storage refused the key; it's not kept anywhere app code can read, so hand it over.
        prompt("This browser blocked saving the app's deploy key. Copy it now (needed to redeploy without logging in):", project.deploy.deployKey);
      }
      showDeployLink(project.deploy);
    },
  });

  // editor
  const lang = new Compartment();
  let current = null;
  let suppress = false;
  const view = new EditorView({
    parent: $("editor"),
    state: EditorState.create({
      doc: "",
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        oneDark,
        lang.of([]),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged || suppress || !current) return;
          c.fs.writeFile(`${wd}/${current}`, u.state.doc.toString());
          save();
        }),
      ],
    }),
  });
  const langFor = (p) =>
    /\.(ts|tsx)$/.test(p) ? javascript({ typescript: true, jsx: p.endsWith("x") })
    : /\.(js|jsx|mjs)$/.test(p) ? javascript({ jsx: true })
    : p.endsWith(".html") ? html()
    : p.endsWith(".css") ? css()
    : p.endsWith(".json") ? json()
    : [];

  async function openFile(path) {
    let text;
    try {
      text = await c.fs.readFile(`${wd}/${path}`, "utf8");
    } catch {
      return;
    }
    current = path;
    suppress = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      effects: lang.reconfigure(langFor(path)),
    });
    suppress = false;
    $("open-file").textContent = path;
    renderTree();
  }

  async function listFiles(dir = "", depth = 0, out = []) {
    const entries = await c.fs.readdir(`${wd}${dir ? "/" + dir : ""}`, { withFileTypes: true });
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      const path = dir ? `${dir}/${e.name}` : e.name;
      if (ignored(path)) continue;
      if (e.isDirectory()) {
        out.push({ path, name: e.name, depth, dir: true });
        await listFiles(path, depth + 1, out);
      } else out.push({ path, name: e.name, depth, dir: false });
    }
    return out;
  }

  async function renderTree() {
    const items = await listFiles().catch(() => []);
    $("tree").replaceChildren(...items.map((f) => {
      const b = el("button", { textContent: f.dir ? `${f.name}/` : f.name, className: f.dir ? "dir" : "" });
      b.style.setProperty("--depth", f.depth);
      if (f.dir) b.tabIndex = -1;
      else {
        b.onclick = () => openFile(f.path);
        if (f.path === current) b.setAttribute("aria-current", "true");
      }
      return b;
    }));
  }

  $("new-file").onclick = async () => {
    const path = prompt("New file path (e.g. src/components/Button.tsx)")?.trim().replace(/^\/+/, "");
    if (!path || path.split("/").includes("..")) return;
    await c.fs.writeFile(`${wd}/${path}`, "");
    save();
    await renderTree();
    openFile(path);
  };

  // keep tree in sync with terminal changes
  let treeTimer;
  c.fs.watch(wd, { recursive: true }, (_e, filename) => {
    if (filename && ignored(filename.replace(`${wd}/`, ""))) return;
    clearTimeout(treeTimer);
    treeTimer = setTimeout(() => {
      renderTree();
      save();
    }, 300);
  });

  await renderTree();
  await openFile(project.files["src/App.tsx"] !== undefined ? "src/App.tsx"
    : project.files["src/main.ts"] !== undefined ? "src/main.ts" : "index.html");

  // preview
  let previewBase = null;
  const loadPreview = () => {
    if (!previewBase) return;
    const path = $("preview-path").value.trim() || "/";
    const url = previewBase.replace(/\/$/, "") + (path.startsWith("/") ? path : "/" + path);
    $("preview").src = url;
  };
  c.on("server-ready", (port, url) => {
    if (port !== 3000 && previewBase) return;
    previewBase = url;
    $("preview-empty").hidden = true;
    setStatus("Running", "ready");
    loadPreview();
  });
  c.on("error", (e) => term.writeln(`\x1b[31m${e?.message ?? e}\x1b[0m`));
  $("preview-reload").onclick = loadPreview;
  $("preview-path").onkeydown = (e) => e.key === "Enter" && loadPreview();

  // shell
  const shell = await c.spawn("jsh", [], { cwd: wd, terminal: true });
  shell.output.pipeTo(new WritableStream({ write: (d) => term.write(d) }));
  const input = shell.input.getWriter();
  // an untrusted project's shell takes no input until "Run it" (a command could run its code: npm scripts, a build's
  // PostCSS/Tailwind plugins)
  let locked = project.trusted === false;
  term.onData((d) => {
    if (!locked) input.write(d);
  });
  const start = () => {
    setStatus("Installing");
    $("preview-msg").textContent = "Installing dependencies…";
    input.write("npm install && cresslet dev\r");
  };
  // Opened from a deployed app's source: its code (and npm deps, and a deploy's build: PostCSS/Tailwind plugins)
  // would run in this browser. Nothing runs, Deploy included, until the user says so.
  const gate = (on) => {
    locked = on;
    $("deploy-btn").disabled = on;
    $("deploy-btn").title = on ? "Run the project first" : "";
  };
  gate(project.trusted === false);
  if (project.trusted === false) {
    setStatus("Not running");
    const btn = el("button", { className: "btn", textContent: "Run it", onclick: async () => {
      project.trusted = true;
      await projects.put(project);
      btn.remove();
      gate(false);
      start();
    } });
    $("preview-msg").replaceChildren(
      "This project was opened from a deployed app's source. Review it, then ",
      btn,
      " to install its dependencies and start it here (the terminal and Deploy unlock then).",
    );
  } else start();

  // deploy
  $("deploy-btn").onclick = async () => {
    const btn = $("deploy-btn");
    btn.disabled = true;
    btn.textContent = "Deploying…";
    const log = $("deploy-log");
    log.textContent = "";
    selectTab("deploy-log");
    try {
      const r = await cresslet.deploy((line) => (log.textContent += line + "\n"));
      toast(el("span", {}, "Deployed: ", el("a", { href: r.app.url, target: "_blank", rel: "noopener", textContent: r.app.url })), 8000);
    } catch (e) {
      log.textContent += `\nerror: ${e.message}\n`;
      toast(`Deploy failed: ${e.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "Deploy";
    }
  };
}

function showDeployLink(deploy) {
  const a = $("deploy-link");
  a.hidden = !deploy?.url;
  if (deploy?.url) {
    a.href = deploy.url;
    a.textContent = deploy.url.replace(/^https?:\/\//, "");
  }
}

function selectTab(name) {
  for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-selected", String(t.dataset.tab === name));
  for (const p of document.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== name;
}
for (const t of document.querySelectorAll(".tab")) t.addEventListener("click", () => selectTab(t.dataset.tab));

// ------------------------------------------------------------------ routing
function route() {
  const m = location.hash.match(/^#\/p\/([\w-]+)/);
  if (m) openProject(m[1]);
  else if (booted) location.reload();
  else if (location.hash === "#/settings") renderSettings();
  else renderHome();
}
addEventListener("hashchange", route);
renderAccount();
route();
