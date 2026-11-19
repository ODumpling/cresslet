import { Container } from "/vendor/cresslet-container/cresslet-container.js";
import { basicSetup, Compartment, css, EditorState, EditorView, html, indentWithTab, javascript, json, keymap, oneDark } from "/vendor/editor.js";
import { FitAddon, Terminal } from "/vendor/terminal.js";
import { auth, fromTree, ignored, projects, toTree } from "/store.js";
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
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? `${res.status}`);
  return body;
}

function renderAccount() {
  $("account-btn").textContent = auth.token ? (auth.email ?? "Account") : "Log in";
  $("account-btn").title = auth.token ? "Log out" : "Log in";
}

$("account-btn").addEventListener("click", () => {
  if (auth.token) {
    if (!confirm(`Log out of ${auth.email}?`)) return;
    auth.token = null;
    auth.email = null;
    renderAccount();
    route();
    return;
  }
  $("login-error").hidden = true;
  $("login-dialog").showModal();
});

$("login-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "ok") return;
  e.preventDefault();
  const email = String(new FormData(e.target).get("email")).trim();
  try {
    let r;
    if (email.startsWith("clv_acct_")) {
      const me = await fetch("/v1/me", { headers: { authorization: `Bearer ${email}` } });
      if (!me.ok) throw new Error("invalid access token");
      r = { token: email, ...(await me.json()) };
    } else {
      r = await api("/v1/accounts", { method: "POST", body: JSON.stringify({ email }) });
    }
    auth.token = r.token;
    auth.email = r.account.email;
    $("login-dialog").close();
    renderAccount();
    if (!$("home").hidden) renderHome();
    toast(`Logged in as ${r.account.email}`);
  } catch (err) {
    $("login-error").textContent = err.message;
    $("login-error").hidden = false;
  }
});

// ------------------------------------------------------------------ home
async function renderHome() {
  $("home").hidden = false;
  $("workspace").hidden = true;
  $("project-title").hidden = true;
  $("deploy-btn").hidden = true;
  $("deploy-link").hidden = true;
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
          el("span", { className: "meta", textContent: `updated ${new Date(a.updatedAt).toLocaleString()}` }))
      ));
    }).catch(() => {});
  }
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
  $("home").hidden = true;
  $("workspace").hidden = false;
  $("project-title").hidden = false;
  $("deploy-btn").hidden = false;
  $("project-name").value = project.name;
  document.title = `${project.name} · Cresslet Studio`;
  showDeployLink(project.deploy);

  $("project-name").onchange = async (e) => {
    project.name = e.target.value.trim() || project.name;
    await projects.put(project);
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
    c = await Container.boot({ serviceWorkerUrl: "/cresslet-sw.js" });
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
      await projects.put(project);
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
    $("preview-open").href = url;
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
  term.onData((d) => input.write(d));
  setStatus("Installing");
  $("preview-msg").textContent = "Installing dependencies…";
  input.write("npm install && cresslet dev\r");

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
  else renderHome();
}
addEventListener("hashchange", route);
renderAccount();
route();
