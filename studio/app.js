// Relative imports: index.html loads this from /_v/<release>/ (server/main.ts), so modules stay in step.
import { Container } from "./vendor/cresslet-container/cresslet-container.js";
import { basicSetup, Compartment, css, EditorState, EditorView, html, indentWithTab, javascript, json, keymap, oneDark } from "./vendor/editor.js";
import { FitAddon, Terminal } from "./vendor/terminal.js";
import { auth, fromTree, ignored, migrateDeployKeys, projects, toTree } from "./store.js";
import { createCresslet } from "./cresslet-plugin.js";

const $ = (id) => document.getElementById(id);
const el = (tag, { dataset, ...props } = {}, ...children) => {
  const n = Object.assign(document.createElement(tag), props);
  if (dataset) Object.assign(n.dataset, dataset);
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
  $("admin-link").hidden = r.account.role !== "SiteAdmin";
  renderAccount();
}

function logOut() {
  auth.token = null;
  auth.email = null;
  $("admin-link").hidden = true;
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
  for (const m of ["home", "settings", "admin", "workspace"]) $(m).hidden = m !== id;
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
  $("token-new").hidden = true;
  $("token-new-value").value = "";
  api("/v1/me").then(({ account }) => {
    $("set-github").textContent = account.github ?? "—";
    $("set-email").textContent = account.email;
    setAccount({ account });
  }, (e) => {
    if (!auth.token) location.hash = "#/";
    else toast(`Could not load account: ${e.message}`);
  });
  renderTokens();
  api("/v1/apps").then(({ apps }) => {
    $("token-apps").replaceChildren(...apps.map((a) =>
      el("label", { className: "inline" }, el("input", { type: "checkbox", value: a.name }), a.name)
    ));
  }, () => {});
}

const when = (iso) => iso ? new Date(iso).toLocaleString() : "never";

async function renderTokens() {
  let tokens;
  try {
    ({ tokens } = await api("/v1/me/tokens"));
  } catch (e) {
    $("tokens").replaceChildren(el("p", { className: "list-row error", textContent: `Could not load tokens: ${e.message}` }));
    return;
  }
  $("tokens").replaceChildren(...tokens.map((t) =>
    el("div", { className: "list-row" },
      el("div", { className: "tok" },
        el("strong", { textContent: t.name }, t.current ? el("span", { className: "badge", textContent: "this browser" }) : null),
        el("span", { className: "meta", textContent: `${t.role} · ${t.apps ? (t.apps.join(", ") || "no apps left") : "all apps"}` })),
      el("span", { className: "meta", textContent: `created ${when(t.createdAt)} · last used ${when(t.lastUsedAt)}` }),
      el("button", {
        className: "btn",
        textContent: "Revoke",
        ariaLabel: `Revoke ${t.name}`,
        onclick: () => revokeToken(t),
      }))
  ));
}

async function revokeToken(t) {
  const msg = t.current
    ? `Revoke "${t.name}"? This browser's session uses it, so you'll be logged out.`
    : `Revoke "${t.name}"? Anything using it stops working.`;
  if (!confirm(msg)) return;
  try {
    await api(`/v1/me/tokens/${encodeURIComponent(t.id)}`, { method: "DELETE" });
  } catch (e) {
    toast(`Could not revoke: ${e.message}`);
    return;
  }
  if (t.current) {
    logOut();
    location.hash = "#/";
    toast("Token revoked. You're logged out.");
    return;
  }
  toast(`Revoked ${t.name}`);
  renderTokens();
}

for (const r of document.querySelectorAll('input[name="token-scope"]')) {
  r.addEventListener("change", () => ($("token-apps").hidden = r.value === "all" ? r.checked : !r.checked));
}

$("token-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const some = document.querySelector('input[name="token-scope"]:checked').value === "some";
  const apps = some ? [...$("token-apps").querySelectorAll("input:checked")].map((x) => x.value) : null;
  if (some && !apps.length) {
    toast("Pick at least one app, or choose All apps.");
    return;
  }
  $("token-create").disabled = true;
  try {
    const r = await api("/v1/me/tokens", {
      method: "POST",
      body: JSON.stringify({ name: $("token-name").value, role: $("token-role").value, apps }),
    });
    $("token-new-name").textContent = r.info.name;
    $("token-new-value").value = r.token;
    $("token-new").hidden = false;
    $("token-form").reset();
    $("token-apps").hidden = true;
    renderTokens();
  } catch (err) {
    toast(`Could not create token: ${err.message}`);
  } finally {
    $("token-create").disabled = false;
  }
});

$("token-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("token-new-value").value);
    toast("Token copied");
  } catch {
    $("token-new-value").select();
    toast("Copy failed: select the token and copy it manually.");
  }
});

$("logout-btn").addEventListener("click", () => {
  logOut();
  location.hash = "#/";
});

// ------------------------------------------------------------------ admin (site admins only)
const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
};
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const ago = (iso) => {
  if (!iso) return "—";
  const s = (new Date(iso) - Date.now()) / 1000;
  for (const [unit, sec] of [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), unit);
  }
  return rtf.format(Math.round(s), "second");
};
const STATUS = { running: "Running", idle: "Idle", empty: "Not deployed", deleted: "Deleted" };
const statusPill = (s) => el("span", { className: "pill" }, el("i", { className: "dot", dataset: { s } }), STATUS[s] ?? s);
const ownerText = (o) => (o ? o.github ?? o.email : "Anonymous");
const stat = (label, value, sub, extra) =>
  el("div", { className: "stat" },
    el("div", { className: "label", textContent: label }),
    el("div", { className: "value" }, extra, ...[].concat(value)),
    el("div", { className: "sub", textContent: sub }));

function usageBar(u) {
  const parts = [["deploys", "Site"], ["database", "Database"], ["files", "Files"]];
  const total = u.total || 1;
  return el("div", {},
    el("div", { className: "usage-bar", role: "img", ariaLabel: parts.map(([k, l]) => `${l} ${fmtBytes(u[k])}`).join(", ") },
      ...parts.filter(([k]) => u[k] > 0).map(([k]) => {
        const s = el("span", { className: `seg-${k}` });
        s.style.flex = String(u[k] / total);
        return s;
      })),
    el("div", { className: "legend" },
      ...parts.map(([k, l]) => el("span", {}, el("i", { className: `seg-${k}` }), `${l} ${fmtBytes(u[k])}`))));
}

const adminView = { filter: "live", q: "", gen: 0 };

async function adminAction(site, action) {
  try {
    if (action === "delete") {
      if (!confirm(`Delete ${site.name}? It goes offline now and can be restored until it's purged.`)) return false;
      await api(`/v1/admin/sites/${encodeURIComponent(site.name)}`, { method: "DELETE" });
      toast(`${site.name} deleted`);
    } else if (action === "restore") {
      await api(`/v1/admin/sites/${encodeURIComponent(site.name)}/restore`, { method: "POST", body: "{}" });
      toast(`${site.name} restored`);
    } else if (action === "purge") {
      const typed = prompt(`Permanently delete ${site.name}, its database and files? This can't be undone.\n\nType the site name to confirm:`);
      if (typed === null) return false;
      if (typed.trim() !== site.name) {
        toast("Name didn't match. Nothing was deleted.");
        return false;
      }
      await api(`/v1/admin/sites/${encodeURIComponent(site.name)}?purge=1`, { method: "DELETE" });
      toast(`${site.name} permanently deleted`);
    }
    return true;
  } catch (e) {
    toast(`Could not ${action} ${site.name}: ${e.message}`);
    return false;
  }
}

function siteActions(site, after) {
  const btn = (label, action, danger) =>
    el("button", {
      className: `btn${danger ? " danger" : ""}`,
      textContent: label,
      ariaLabel: `${label} ${site.name}`,
      onclick: async (e) => {
        e.currentTarget.disabled = true;
        if (await adminAction(site, action)) after(action);
        else e.currentTarget.disabled = false;
      },
    });
  return site.status === "deleted"
    ? [btn("Restore", "restore"), btn("Purge", "purge", true)]
    : [btn("Delete", "delete", true)];
}

async function renderAdmin(name) {
  if (!auth.token) {
    location.hash = "#/";
    return;
  }
  showOnly("admin");
  adminView.gen++;
  $("admin-actions").replaceChildren();
  $("admin-body").replaceChildren(el("p", { className: "muted", textContent: "Loading…" }));
  try {
    if (name) await renderAdminSite(name);
    else await renderAdminSites();
  } catch (e) {
    $("admin-body").replaceChildren(el("p", { className: "error", textContent: e.status === 403 ? "Only site admins can see this page." : `Could not load: ${e.message}` }));
  }
}

async function renderAdminSites() {
  document.title = "Sites · Admin · Cresslet Studio";
  $("admin-title").replaceChildren("Sites");
  $("admin-sub").textContent = "Every site on this server";
  const gen = adminView.gen;
  const { totals, sites, retentionDays } = await api("/v1/admin/sites");
  if (gen !== adminView.gen) return; // navigated away meanwhile
  $("admin-actions").replaceChildren(el("button", { className: "btn", textContent: "Refresh", onclick: () => renderAdmin() }));

  const u = totals.usage;
  const stats = el("div", { className: "stats" },
    stat("Sites", [String(totals.live)], `${totals.anonymous} anonymous · ${totals.deleted} deleted`),
    stat("Running", [String(totals.running), el("small", { textContent: `of ${totals.live}` })], "Idle sites stop after a few minutes"),
    stat("Disk used", [fmtBytes(u.total)], `Site ${fmtBytes(u.deploys)} · files ${fmtBytes(u.files)}`),
    stat("Databases", [fmtBytes(u.database)], `Across ${sites.filter((s) => s.usage.database > 0).length} sites`));
  const storage = el("div", { className: "panel" }, el("h2", { textContent: "Storage" }), usageBar(u));

  const tbody = el("tbody");
  const counts = { live: totals.live, deleted: totals.deleted, all: totals.sites };
  const seg = el("div", { className: "seg", role: "group", ariaLabel: "Show" },
    ...[["live", "Live"], ["deleted", "Deleted"], ["all", "All"]].map(([k, l]) =>
      el("button", { textContent: `${l} ${counts[k]}`, dataset: { k }, onclick: () => { adminView.filter = k; draw(); } })));
  const search = el("input", { type: "search", placeholder: "Search sites, owners, domains", ariaLabel: "Search sites", value: adminView.q, oninput: () => { adminView.q = search.value; draw(); } });

  function draw() {
    for (const b of seg.children) b.setAttribute("aria-pressed", String(b.dataset.k === adminView.filter));
    const q = adminView.q.trim().toLowerCase();
    const rows = sites.filter((s) =>
      (adminView.filter === "all" || (adminView.filter === "deleted") === (s.status === "deleted")) &&
      (!q || [s.name, s.owner?.email, s.owner?.github, ...s.domains].some((v) => v?.toLowerCase().includes(q))));
    tbody.replaceChildren(...(rows.length ? rows.map((s) =>
      el("tr", { dataset: s.status === "deleted" ? { deleted: "" } : {} },
        el("td", {},
          el("a", { href: `#/admin/${encodeURIComponent(s.name)}`, textContent: s.name }),
          el("span", { className: "muted small", textContent: s.domains[0] ?? s.url.replace(/^https?:\/\//, "") })),
        el("td", { textContent: ownerText(s.owner), className: s.owner ? "" : "muted" }),
        el("td", {}, statusPill(s.status),
          s.status === "deleted" ? el("span", { className: "muted small", textContent: `purged ${ago(s.purgeAt)}` }) : null),
        el("td", { className: "num", textContent: fmtBytes(s.usage.deploys + s.usage.files) }),
        el("td", { className: "num", textContent: s.usage.database ? fmtBytes(s.usage.database) : "—" }),
        el("td", { textContent: ago(s.updatedAt), title: new Date(s.updatedAt).toLocaleString() }),
        el("td", { className: "actions" }, ...siteActions(s, () => renderAdmin()))))
      : [el("tr", {}, el("td", { colSpan: 7, className: "empty", textContent: q ? "No sites match." : "No sites here." }))]));
  }
  draw();

  $("admin-body").replaceChildren(stats, storage,
    el("div", { className: "toolbar" }, search, seg),
    el("div", { className: "table-wrap" },
      el("table", { className: "table" },
        el("thead", {}, el("tr", {}, ...["Site", "Owner", "Status", "Site size", "Database", "Updated", ""].map((h, i) =>
          el("th", { textContent: h, className: i === 3 || i === 4 ? "num" : "" })))),
        tbody)),
    el("p", { className: "muted small", textContent: `Deleted sites go offline and can be restored for ${retentionDays} days, then they're purged with their data.` }));
}

async function renderAdminSite(name) {
  document.title = `${name} · Admin · Cresslet Studio`;
  $("admin-title").replaceChildren(el("a", { href: "#/admin", textContent: "Sites" }), " / ", name);
  const gen = adminView.gen;
  const d = await api(`/v1/admin/sites/${encodeURIComponent(name)}`);
  if (gen !== adminView.gen) return;
  const s = d.site;
  $("admin-sub").textContent = s.owner ? `Owned by ${ownerText(s.owner)}` : "Anonymous site";
  const visit = el("a", { className: "btn", href: s.url, target: "_blank", rel: "noopener", textContent: "Visit ↗" });
  visit.hidden = s.status === "deleted";
  $("admin-actions").replaceChildren(visit,
    ...siteActions(s, (action) => (action === "purge" ? (location.hash = "#/admin") : renderAdmin(name))));

  const dep = s.currentDeploy;
  const banner = s.status === "deleted"
    ? el("div", { className: "banner deleted" }, el("strong", { textContent: "Deleted" }),
      `${ago(s.deletedAt)}. Offline and hidden from its owner; purged with its data ${ago(s.purgeAt)} unless restored.`)
    : dep
    ? el("div", { className: "banner" }, el("strong", { textContent: "Live" }),
      el("span", { className: "mono", textContent: dep.id }), ` deployed ${ago(dep.createdAt)} via ${dep.source}`)
    : el("div", { className: "banner" }, "Nothing deployed yet.");

  const rt = d.runtime;
  const stats = el("div", { className: "stats" },
    stat("Status", [STATUS[s.status]], rt.running ? `pid ${rt.pid}` : s.server ? "Starts on the next request" : "Static site", el("i", { className: "dot", dataset: { s: s.status } })),
    stat("Site size", [fmtBytes(s.usage.deploys)], `${d.deploys.length} deploy${d.deploys.length === 1 ? "" : "s"} kept${dep ? ` · current ${fmtBytes(dep.bytes)}` : ""}`),
    stat("Database", [s.usage.database ? fmtBytes(s.usage.database) : "—"], d.database.error ? "Couldn't read" : !d.database.tables.length ? "No database yet" : `${d.database.tables.length} tables · ${d.database.tables.reduce((n, t) => n + t.rows, 0).toLocaleString()} rows`),
    stat("Files", [fmtBytes(s.usage.files)], `${fmtBytes(s.usage.total)} total on disk`));

  const kv = (pairs) => el("dl", { className: "kv" }, ...pairs.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", {}, v)]));
  const link = (href, text) => el("a", { href, target: "_blank", rel: "noopener", textContent: text });
  const info = el("div", { className: "panel" }, el("h2", { textContent: "Overview" }), kv([
    ["URL", s.status === "deleted" ? s.url : link(s.url, s.url.replace(/^https?:\/\//, ""))],
    ["Domains", d.domains.length ? el("span", {}, ...d.domains.flatMap((x, i) => [i ? ", " : null, x.verified ? link(`https://${x.domain}`, x.domain) : `${x.domain} (unverified)`])) : "—"],
    ["Owner", s.owner ? `${s.owner.email}${s.owner.github ? ` (@${s.owner.github})` : ""}` : `Anonymous${s.expiresAt ? `, expires ${ago(s.expiresAt)}` : ""}`],
    ["Server", s.server ? `Yes${s.crons ? ` · ${s.crons} cron${s.crons > 1 ? "s" : ""}` : ""}` : "Static only"],
    ["Secrets", String(d.secrets)],
    ["Created", new Date(s.createdAt).toLocaleString()],
    ["App ID", el("span", { className: "mono", textContent: s.id })],
  ]), el("h2", { textContent: "Storage", style: "margin-top:20px" }), usageBar(s.usage));

  const tableOf = (heads, rows, empty) =>
    rows.length
      ? el("div", { className: "scroll-x" }, el("table", { className: "table" },
        el("thead", {}, el("tr", {}, ...heads.map((h, i) => el("th", { textContent: h, className: i ? "num" : "" })))),
        el("tbody", {}, ...rows.map((r) => el("tr", {}, ...r.map((c, i) => el("td", { className: i ? "num" : "" }, c)))))))
      : el("p", { className: "muted small", textContent: empty });
  const db = el("div", { className: "panel" }, el("h2", { textContent: "Database tables" }),
    d.database.error ? el("p", { className: "error small", textContent: d.database.error })
      : tableOf(["Table", "Rows"], d.database.tables.map((t) => [el("span", { className: "mono", textContent: t.name }), t.rows.toLocaleString()]), "No database yet."));
  const deploys = el("div", { className: "panel" }, el("h2", { textContent: "Deploys" }),
    tableOf(["Deploy", "Size", "When"], d.deploys.map((x) => [
      el("span", {}, el("span", { className: "mono", textContent: x.id }), x.current ? el("span", { className: "muted small", textContent: "live" }) : null),
      fmtBytes(x.bytes),
      ago(x.createdAt),
    ]), "No deploys."));

  $("admin-body").replaceChildren(banner, stats,
    el("div", { className: "detail-grid" }, info, el("div", { className: "stack" }, db, deploys)));
}

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
  $("deploy-btn").disabled = project.trusted === false; // locked from the start (gate() below takes over)
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
  else if (location.hash.startsWith("#/admin")) renderAdmin(decodeURIComponent(location.hash.slice("#/admin/".length)));
  else renderHome();
}
addEventListener("hashchange", route);
renderAccount();
// Role can change server-side: refresh it (shows the Admin link to site admins).
if (auth.token) api("/v1/me").then(setAccount, () => {});
route();
