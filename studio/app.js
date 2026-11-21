// Relative imports: index.html loads this from /_v/<release>/ (server/main.ts), so modules stay in step.
import { Container } from "./vendor/cresslet-container/cresslet-container.js";
import { basicSetup, Compartment, css, EditorState, EditorView, html, indentWithTab, javascript, json, keymap, oneDark } from "./vendor/editor.js";
import { FitAddon, Terminal } from "./vendor/terminal.js";
import { auth, fromTree, ignored, migrateDeployKeys, projects, toTree } from "./store.js";
import { createCresslet } from "./cresslet-plugin.js";
import { anthropicClient, apiKey, createAgent, createTools } from "./builder.js";

const $ = (id) => document.getElementById(id);
const el = (tag, { dataset, ...props } = {}, ...children) => {
  const n = Object.assign(document.createElement(tag), props);
  if (dataset) Object.assign(n.dataset, dataset);
  n.append(...children.filter((c) => c != null));
  return n;
};

const SVG = "http://www.w3.org/2000/svg";
/** A decorative icon from the sprite in index.html; the control around it carries the accessible name. */
const icon = (name, className = "icon") => {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
};
const srOnly = (text) => el("span", { className: "sr-only", textContent: text });
/** A link that opens in a new tab, and says so to screen readers. */
const extLink = (href, text, className = "ext") =>
  el("a", { href, target: "_blank", rel: "noopener", className }, text, srOnly(" (opens in a new tab)"), icon("external"));

// ------------------------------------------------------------------ shared UI
// The toast's body is a live region that stays in the page (one that appears with its message may not be
// announced). It stays open while hovered or focused (WCAG 2.2.1), and Escape or × dismisses it.
function toast(content, ms = 6000) {
  $("toast-body").replaceChildren(content);
  $("toast").dataset.open = "true";
  $("toast-close").hidden = false;
  toast.ms = ms;
  avoidFocus();
  armToast();
}
// Never cover the focused control (WCAG 2.4.11): if it's under the toast, the toast moves to the top edge; if
// it would be covered there too (tiny viewports), the toast turns transparent (still announced, still reachable by
// Tab, which brings it back) until focus moves or the page scrolls.
function avoidFocus() {
  const t = $("toast"), a = document.activeElement;
  if (a && t.contains(a)) {
    if (t.dataset.top === "hide") t.dataset.top = "false"; // Tab into a transparent toast: show it
    return; // otherwise stay put while it's used (a click focuses × before it lands)
  }
  t.dataset.top = "false";
  if (t.dataset.open !== "true" || !a || a === document.body) return;
  const r = a.getBoundingClientRect();
  const covers = () => {
    const q = t.getBoundingClientRect();
    if (r.height > q.height * 2 || r.width > q.width) return false; // a large area (log, editor) can't be hidden by it
    return r.bottom > q.top && r.top < q.bottom && r.right > q.left && r.left < q.right;
  };
  if (!covers()) return;
  t.dataset.top = "true";
  if (covers()) t.dataset.top = "hide";
}
{
  let frame = 0;
  const later = () => frame ||= requestAnimationFrame(() => { frame = 0; avoidFocus(); });
  addEventListener("focusin", avoidFocus);
  addEventListener("scroll", later, { capture: true, passive: true }); // scrolling can move focus under it
  addEventListener("resize", later);
}
function armToast() {
  clearTimeout(toast.timer);
  const t = $("toast");
  if (t.dataset.open === "true" && !t.matches(":hover") && !t.contains(document.activeElement)) {
    toast.timer = setTimeout(closeToast, toast.ms);
  }
}
function closeToast() {
  clearTimeout(toast.timer);
  const t = $("toast");
  const hadFocus = t.contains(document.activeElement);
  t.dataset.open = "false";
  $("toast-close").hidden = true;
  $("toast-body").replaceChildren();
  if (hadFocus) focusView();
}
{
  const t = $("toast");
  t.addEventListener("pointerenter", () => clearTimeout(toast.timer));
  t.addEventListener("pointerleave", armToast);
  t.addEventListener("focusin", () => clearTimeout(toast.timer));
  t.addEventListener("focusout", () => setTimeout(armToast));
  $("toast-close").addEventListener("click", closeToast);
  // Capture phase: xterm and CodeMirror stop Escape; the event still reaches them.
  addEventListener("keydown", (e) => e.key === "Escape" && t.dataset.open === "true" && closeToast(), true);
}

function setStatus(text, state = "busy") {
  $("status-text").textContent = text;
  $("status").dataset.state = state;
}

/** Moves focus to the visible view's heading (after navigation, so screen readers hear where they are). */
function focusView({ scroll = false } = {}) {
  const h = document.querySelector("main:not([hidden]) h1");
  h?.focus({ preventScroll: true });
  if (scroll) h?.scrollIntoView({ block: "nearest" });
}
// The last focused control, as a selector that still finds it after a re-render rebuilds it.
// (Per-item controls get unique ids, e.g. revoke-<token id>: labels like "Revoke Studio (GitHub login)" repeat.)
let lastFocusKey = null, lastFocusEl = null;
addEventListener("focusin", (e) => {
  const t = e.target, label = t.getAttribute?.("aria-label");
  lastFocusEl = t;
  lastFocusKey = t.id ? `#${CSS.escape(t.id)}` : label ? `[aria-label="${CSS.escape(label)}"]` : null;
});
/** After a re-render removed the focused control: focus its rebuilt twin if there is one, else `target`, else the
 *  view's heading. Does nothing if focus is still on a control in the page (the user moved it meanwhile). */
function refocus(target) {
  const a = document.activeElement;
  if (a && a !== document.body && a.isConnected) return;
  // only when the last focused control was removed (a click in Safari/Firefox doesn't focus buttons, so the
  // last focusin may be an older control that's still here)
  const twin = lastFocusEl && !lastFocusEl.isConnected && lastFocusKey && document.querySelector(`main:not([hidden]) ${lastFocusKey}`);
  if (twin) twin.focus();
  else if (target) target.focus();
  else focusView();
}
$("skip-link").addEventListener("click", (e) => {
  e.preventDefault(); // its #content href would be read as a route
  focusView({ scroll: true });
});

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
  $("account-label").replaceChildren(...(auth.token
    ? [auth.email ?? "Account", srOnly(": account settings")]
    : ["Log in with GitHub"]));
  $("nav-settings-item").hidden = !auth.token;
  $("nav-pages-item").hidden = !auth.token;
}

// Login is GitHub only: the server redirects back to /#cresslet_login=<one-time code>.
const meta = fetch("/v1").then((r) => r.json()).catch(() => ({}));
// Custom domains off on this server (CRESSLET_CUSTOM_DOMAINS=false): don't offer them in the role descriptions.
meta.then((m) => {
  if (m.customDomains !== false) return;
  for (const id of ["token-role-admin", "invite-role-admin"]) {
    const o = $(id);
    o.textContent = o.textContent.replace(/,? domains\b/, "");
  }
});

async function logIn() {
  if ((await meta).auth?.github) location.href = "/v1/auth/github";
  else toast("Login isn't set up on this server (operator: set CRESSLET_GITHUB_CLIENT_ID / _SECRET).");
}
$("account-btn").addEventListener("click", () => {
  if (auth.token) location.hash = "#/settings";
  else logIn();
});
$("landing-login").addEventListener("click", logIn);

let myAccountId = null; // tells your own row apart on the Share page
function setAccount(r) {
  auth.token = r.token ?? auth.token;
  myAccountId = r.account.id;
  auth.email = r.account.github ?? r.account.email;
  $("admin-item").hidden = r.account.role !== "SiteAdmin";
  renderAccount();
}

function logOut() {
  auth.token = null;
  myAccountId = null;
  auth.email = null;
  $("admin-item").hidden = true;
  renderAccount();
  if (!$("cli-login").hidden) route(); // its Authorize button needs the session
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
        // Back to what needed the login (a private page).
        let after = null;
        try {
          after = sessionStorage.getItem("cresslet.afterLogin");
          sessionStorage.removeItem("cresslet.afterLogin");
        } catch { /* storage blocked */ }
        if (after?.startsWith("#/view/") || after === "#/cli") {
          location.hash = after;
          return;
        }
        if (!$("home").hidden || !$("landing").hidden) renderHome();
        toast(`Logged in as ${auth.email}`);
      }, (e) => toast(`GitHub login failed: ${e.message}`));
    }
  }
}

// ------------------------------------------------------------------ settings
let focusOnShow = false; // set by in-app navigation; the first page load keeps the browser's own focus
function showOnly(id) {
  for (const m of ["landing", "home", "pages", "settings", "share", "view", "cli-login", "admin", "workspace"]) $(m).hidden = m !== id;
  $("app").dataset.view = id;
  $("topbar").hidden = id !== "workspace";
  $("site-nav").hidden = id !== "landing";
  $("project-title").hidden = true;
  $("deploy-btn").hidden = true;
  $("deploy-link").hidden = true;
  for (const a of document.querySelectorAll("[data-nav]")) {
    if (a.dataset.nav === id) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (id !== "workspace") renderRecent();
  if (focusOnShow) {
    focusOnShow = false;
    scrollTo(0, 0);
    focusView();
  }
}

async function renderRecent() {
  const list = (await projects.list().catch(() => [])).slice(0, 6);
  $("recent-wrap").hidden = !list.length;
  $("recent").replaceChildren(...list.map((p) =>
    el("li", {}, el("a", { href: `#/p/${p.id}` }, icon("code"), el("span", { textContent: p.name })))));
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
  renderPageDefaults();
  api("/v1/apps").then(({ apps }) => {
    $("token-apps").replaceChildren(...(apps.length ? apps.map((a) =>
      el("label", { className: "check" }, el("input", { type: "checkbox", value: a.name }), el("span", { textContent: a.name }))
    ) : [el("p", { className: "muted small", textContent: "No apps yet." })]));
  }, () => {});
}

const when = (iso) => iso ? new Date(iso).toLocaleString() : "never";

async function renderTokens() {
  let tokens;
  try {
    ({ tokens } = await api("/v1/me/tokens"));
  } catch (e) {
    $("tokens").replaceChildren(el("li", { className: "list-row error", textContent: `Could not load tokens: ${e.message}` }));
    return;
  }
  if (!tokens.length) {
    $("tokens").replaceChildren(el("li", { className: "list-row muted", textContent: "No tokens yet." }));
    return;
  }
  $("tokens").replaceChildren(...tokens.map((t) =>
    el("li", { className: "list-row" },
      el("div", { className: "tok" },
        el("strong", { textContent: t.name }, t.current ? el("span", { className: "badge", textContent: "this browser" }) : null),
        el("span", { className: "meta", textContent: `${t.role} · ${t.apps ? (t.apps.join(", ") || "no apps left") : "all apps"}` })),
      el("span", { className: "meta", textContent: `created ${when(t.createdAt)} · last used ${when(t.lastUsedAt)}` }),
      el("button", {
        className: "btn sm danger",
        type: "button",
        textContent: "Revoke",
        ariaLabel: `Revoke ${t.name}`,
        id: `revoke-${t.id}`,
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
  await renderTokens();
  refocus($("tokens-title")); // the Revoke button is gone with its row
}

// Form errors stay beside the form (not a timed toast) until the user changes it.
function tokenError(text) {
  $("token-error").textContent = text;
  $("token-error").hidden = !text;
}
$("token-form").addEventListener("change", () => tokenError(""));
for (const r of document.querySelectorAll('input[name="token-scope"]')) {
  r.addEventListener("change", () => ($("token-apps").hidden = r.value === "all" ? r.checked : !r.checked));
}

$("token-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const some = document.querySelector('input[name="token-scope"]:checked').value === "some";
  const apps = some ? [...$("token-apps").querySelectorAll("input:checked")].map((x) => x.value) : null;
  if (some && !apps.length) {
    tokenError("Pick at least one app, or choose All apps.");
    $("token-apps").querySelector("input")?.focus();
    return;
  }
  tokenError("");
  $("token-create").disabled = true;
  try {
    const r = await api("/v1/me/tokens", {
      method: "POST",
      body: JSON.stringify({ name: $("token-name").value, role: $("token-role").value, apps }),
    });
    $("token-new-name").textContent = r.info.name;
    $("token-new-value").value = r.token;
    $("token-new").hidden = false;
    $("token-new-value").focus();
    $("token-new-value").select();
    $("token-form").reset();
    $("token-apps").hidden = true;
    renderTokens();
  } catch (err) {
    tokenError(`Could not create token: ${err.message}`);
  } finally {
    $("token-create").disabled = false;
    if (document.activeElement === document.body) $("token-create").focus(); // disabling it dropped focus
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
const statusPill = (s, text = STATUS[s] ?? s) => el("span", { className: "pill", dataset: { s } }, el("i", { className: "dot", ariaHidden: "true" }), text);
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
      className: `btn sm${danger ? " danger" : ""}`,
      type: "button",
      textContent: label,
      ariaLabel: `${label} ${site.name}`,
      onclick: async (e) => {
        const b = e.currentTarget; // null after the await
        const gen = routeGen;
        b.disabled = true;
        const done = await adminAction(site, action);
        if (gen !== routeGen) return; // navigated away meanwhile: leave the new view alone
        // (a Refresh meanwhile may show stale data: after() re-renders; its focus move checks it's still current)
        if (done) after(action);
        else {
          b.disabled = false;
          refocus(b.isConnected ? b : null);
        }
      },
    });
  return site.status === "deleted"
    ? [btn("Restore", "restore"), btn("Purge", "purge", true)]
    : [btn("Delete", "delete", true)];
}

/** Resolves true if this render is still the current view (no later route or admin render), so callers may move focus. */
async function renderAdmin(name) {
  if (!auth.token) {
    location.hash = "#/";
    return false;
  }
  $("admin-title").replaceChildren(name || "Sites"); // before showOnly() focuses it
  showOnly("admin");
  const gen = ++adminView.gen, route = routeGen;
  const current = () => gen === adminView.gen && route === routeGen;
  $("admin-actions").replaceChildren();
  $("admin-body").replaceChildren(el("p", { className: "muted", textContent: "Loading…" }));
  try {
    if (name) await renderAdminSite(name);
    else await renderAdminSites();
  } catch (e) {
    if (!current()) return false;
    $("admin-body").replaceChildren(el("p", { className: "error", textContent: e.status === 403 ? "Only site admins can see this page." : `Could not load: ${e.message}` }));
    if (e.status !== 403) {
      const retry = el("button", { className: "btn", type: "button", onclick: () => renderAdmin(name).then((ok) => ok && refocus(name ? null : $("admin-actions").querySelector("button"))) }, icon("refresh"), "Retry");
      $("admin-actions").replaceChildren(retry);
      refocus(retry); // the Refresh/Retry that was clicked is gone
    }
  }
  return current();
}

async function renderAdminSites() {
  document.title = "Sites · Admin · Cresslet Studio";
  $("admin-title").replaceChildren("Sites");
  $("admin-sub").textContent = "Every site on this server";
  const gen = adminView.gen, route = routeGen;
  const { totals, sites, retentionDays } = await api("/v1/admin/sites");
  if (gen !== adminView.gen || route !== routeGen) return; // navigated away or re-rendered meanwhile
  $("admin-actions").replaceChildren(el("button", {
    className: "btn",
    type: "button",
    onclick: () => renderAdmin().then((ok) => ok && refocus($("admin-actions").querySelector("button"))), // it's rebuilt
  }, icon("refresh"), "Refresh"));

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
      el("button", { type: "button", id: `filter-${k}`, textContent: `${l} ${counts[k]}`, dataset: { k }, onclick: () => { adminView.filter = k; draw(); } })));
  const search = el("input", { type: "search", className: "input", placeholder: "Search sites, owners, domains", ariaLabel: "Search sites", value: adminView.q, oninput: () => { adminView.q = search.value; draw(); } });
  const shown = el("p", { className: "sr-only", role: "status" });

  function draw() {
    for (const b of seg.children) b.setAttribute("aria-pressed", String(b.dataset.k === adminView.filter));
    const q = adminView.q.trim().toLowerCase();
    const rows = sites.filter((s) =>
      (adminView.filter === "all" || (adminView.filter === "deleted") === (s.status === "deleted")) &&
      (!q || [s.name, s.owner?.email, s.owner?.github, ...s.domains].some((v) => v?.toLowerCase().includes(q))));
    shown.textContent = `${rows.length} site${rows.length === 1 ? "" : "s"} shown`;
    tbody.replaceChildren(...(rows.length ? rows.map((s) =>
      el("tr", { dataset: s.status === "deleted" ? { deleted: "" } : {} },
        el("td", {},
          el("a", { href: `#/admin/${encodeURIComponent(s.name)}`, textContent: s.name }),
          el("span", { className: "sub", textContent: s.domains[0] ?? s.url.replace(/^https?:\/\//, "") })),
        el("td", { textContent: ownerText(s.owner), className: s.owner ? "" : "muted" }),
        el("td", {}, statusPill(s.status),
          s.status === "deleted" ? el("span", { className: "sub", textContent: `purged ${ago(s.purgeAt)}` }) : null),
        el("td", { className: "num", textContent: fmtBytes(s.usage.deploys + s.usage.files) }),
        el("td", { className: "num", textContent: s.usage.database ? fmtBytes(s.usage.database) : "—" }),
        el("td", {}, el("time", { dateTime: s.updatedAt, title: new Date(s.updatedAt).toLocaleString(), textContent: ago(s.updatedAt) })),
        el("td", { className: "actions" }, ...siteActions(s, () => renderAdmin().then((ok) => ok && refocus())))))
      : [el("tr", {}, el("td", { colSpan: 7, className: "empty", textContent: q ? "No sites match." : "No sites here." }))]));
  }
  draw();

  $("admin-body").replaceChildren(stats, storage,
    el("div", { className: "toolbar" }, el("div", { className: "search" }, icon("search"), search), seg, shown),
    el("div", { className: "table-wrap" },
      el("table", { className: "table" },
        el("caption", { className: "sr-only", textContent: "Sites" }),
        el("thead", {}, el("tr", {}, ...["Site", "Owner", "Status", "Site size", "Database", "Updated", "Actions"].map((h, i) =>
          el("th", { scope: "col", className: i === 3 || i === 4 ? "num" : "" }, i === 6 ? srOnly(h) : h)))),
        tbody)),
    el("p", { className: "muted small", textContent: `Deleted sites go offline and can be restored for ${retentionDays} days, then they're purged with their data.` }));
}

async function renderAdminSite(name) {
  document.title = `${name} · Admin · Cresslet Studio`;
  $("admin-title").replaceChildren(el("a", { href: "#/admin", textContent: "Sites" }), " / ", name);
  const gen = adminView.gen, route = routeGen;
  const [d, { customDomains }] = await Promise.all([api(`/v1/admin/sites/${encodeURIComponent(name)}`), meta]);
  if (gen !== adminView.gen || route !== routeGen) return;
  const s = d.site;
  $("admin-sub").textContent = s.owner ? `Owned by ${ownerText(s.owner)}` : "Anonymous site";
  const visit = extLink(s.url, "Visit", "btn");
  visit.hidden = s.status === "deleted";
  $("admin-actions").replaceChildren(visit,
    ...siteActions(s, (action) => (action === "purge" ? (location.hash = "#/admin") : renderAdmin(name).then((ok) => ok && refocus()))));

  const dep = s.currentDeploy;
  const banner = s.status === "deleted"
    ? el("div", { className: "banner deleted" }, statusPill("deleted"),
      el("span", { textContent: `${ago(s.deletedAt)}. Offline and hidden from its owner; purged with its data ${ago(s.purgeAt)} unless restored.` }))
    : dep
    ? el("div", { className: "banner" }, statusPill("live", "Live"),
      el("span", {}, el("span", { className: "mono", textContent: dep.id }), ` deployed ${ago(dep.createdAt)} via ${dep.source}`))
    : el("div", { className: "banner" }, "Nothing deployed yet.");

  const rt = d.runtime;
  const stats = el("div", { className: "stats" },
    stat("Status", [STATUS[s.status]], rt.running ? `pid ${rt.pid}` : s.server ? "Starts on the next request" : "Static site", el("i", { className: "dot", ariaHidden: "true", dataset: { s: s.status } })),
    stat("Site size", [fmtBytes(s.usage.deploys)], `${d.deploys.length} deploy${d.deploys.length === 1 ? "" : "s"} kept${dep ? ` · current ${fmtBytes(dep.bytes)}` : ""}`),
    // `database` is null unless you own the site or are one of its admins: site admins see its size, not its tables.
    stat("Database", [s.usage.database ? fmtBytes(s.usage.database) : "—"], !d.database ? (s.usage.database ? "Tables visible to the owner and its admins" : "No database yet") : d.database.error ? "Couldn't read" : !d.database.tables.length ? "No database yet" : `${d.database.tables.length} tables · ${d.database.tables.reduce((n, t) => n + t.rows, 0).toLocaleString()} rows`),
    stat("Files", [fmtBytes(s.usage.files)], `${fmtBytes(s.usage.total)} total on disk`));

  const kv = (pairs) => el("dl", { className: "kv" }, ...pairs.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", {}, v)]));
  const link = (href, text) => extLink(href, text);
  const info = el("div", { className: "panel" }, el("h2", { textContent: "Overview" }), kv([
    ["URL", s.status === "deleted" ? s.url : link(s.url, s.url.replace(/^https?:\/\//, ""))],
    ["Domains", d.domains.length
      ? el("span", {}, ...d.domains.flatMap((x, i) => [i ? ", " : null, x.verified ? link(`https://${x.domain}`, x.domain) : `${x.domain} (unverified)`]),
        customDomains === false ? " · custom domains are off on this server: none can be added or verified" : null)
      : customDomains === false ? "Custom domains are off on this server" : "—"],
    ["Owner", s.owner ? `${s.owner.email}${s.owner.github ? ` (@${s.owner.github})` : ""}` : `Anonymous${s.expiresAt ? `, expires ${ago(s.expiresAt)}` : ""}`],
    ["Server", s.server ? `Yes${s.crons ? ` · ${s.crons} cron${s.crons > 1 ? "s" : ""}` : ""}` : "Static only"],
    ["Secrets", String(d.secrets)],
    ["Created", new Date(s.createdAt).toLocaleString()],
    ["App ID", el("span", { className: "mono", textContent: s.id })],
  ]), el("h2", { className: "mt", textContent: "Storage" }), usageBar(s.usage));

  const tableOf = (heads, rows, empty) =>
    rows.length
      // Focusable, so a keyboard can scroll it when it's wider than the panel.
      ? el("div", { className: "scroll-x", tabIndex: 0, role: "region", ariaLabel: `${heads[0]}s` }, el("table", { className: "table" },
        el("thead", {}, el("tr", {}, ...heads.map((h, i) => el("th", { scope: "col", textContent: h, className: i ? "num" : "" })))),
        el("tbody", {}, ...rows.map((r) => el("tr", {}, ...r.map((c, i) => el("td", { className: i ? "num" : "" }, c)))))))
      : el("p", { className: "muted small", textContent: empty });
  const db = d.database && el("div", { className: "panel" }, el("h2", { textContent: "Database tables" }),
    d.database.error ? el("p", { className: "error small", textContent: d.database.error })
      : tableOf(["Table", "Rows"], d.database.tables.map((t) => [el("span", { className: "mono", textContent: t.name }), t.rows.toLocaleString()]), "No database yet."));
  const deploys = el("div", { className: "panel" }, el("h2", { textContent: "Deploys" }),
    tableOf(["Deploy", "Size", "When"], d.deploys.map((x) => [
      el("span", {}, el("span", { className: "mono", textContent: x.id }), x.current ? el("span", { className: "badge", textContent: "live" }) : null),
      fmtBytes(x.bytes),
      ago(x.createdAt),
    ]), "No deploys."));

  $("admin-body").replaceChildren(banner, stats,
    el("div", { className: "detail-grid" }, info, el("div", { className: "stack" }, db, deploys)));
}

// ------------------------------------------------------------------ home
const TEMPLATE_ICONS = { react: "atom", vanilla: "zap" };
const emptyState = (title, text) => el("div", { className: "empty-state" }, el("strong", { textContent: title }), el("span", { textContent: text }));
const timeAgo = (iso) => el("time", { dateTime: new Date(iso).toISOString(), title: new Date(iso).toLocaleString(), textContent: ago(iso) });
function dataTable(labelledBy, heads, rows) {
  const t = el("table", { className: "table" },
    el("thead", {}, el("tr", {}, ...heads.map(([h, cls, hide]) => el("th", { scope: "col", className: cls ?? "" }, hide ? srOnly(h) : h)))),
    el("tbody", {}, ...rows));
  t.setAttribute("aria-labelledby", labelledBy);
  // Focusable, so a keyboard can scroll it when it's wider than the page.
  return el("div", { className: "table-wrap", tabIndex: 0, role: "region", ariaLabel: `${$(labelledBy).textContent} table` }, t);
}

/** Its name is all its visible text (WCAG 2.5.3), with a pause between the template and its description. */
const templateCard = (t) =>
  el("button", { className: "card", type: "button", onclick: () => createProject(t.name) },
    el("span", { className: "card-icon" }, icon(TEMPLATE_ICONS[t.name] ?? "code")),
    el("strong", { textContent: t.name }),
    srOnly(": "),
    el("span", { className: "desc", textContent: t.description ?? "" }),
    icon("arrow", "icon go"));

let templatesReq;
function renderTemplates(into) {
  (templatesReq ??= api("/v1/templates")).then(({ templates }) => {
    into.replaceChildren(...templates.map(templateCard));
  }).catch((e) => {
    templatesReq = null; // try again next time
    into.replaceChildren(el("p", { className: "error", textContent: `Could not load templates: ${e.message}` }));
  });
}

/** #/: the landing page for new visitors (logged out, no local projects), else the projects dashboard. */
async function renderHome() {
  if (!auth.token) {
    const gen = routeGen;
    const local = await projects.list().catch(() => []);
    if (gen !== routeGen) return; // navigated away meanwhile
    if (!local.length) return renderLanding();
  }
  showOnly("home");
  document.title = "Cresslet Studio";
  renderTemplates($("templates"));
  await renderProjects();

  $("apps-section").hidden = !auth.token;
  $("invites-section").hidden = true;
  if (auth.token) {
    renderApps();
    renderInvites();
  }
}

/** Local projects only (after a delete, the rest of the home view stays as it is, focus included). */
async function renderProjects() {
  const list = await projects.list().catch(() => []);
  $("projects").replaceChildren(list.length
    ? dataTable("projects-title", [["Project"], ["Template"], ["Deployed to"], ["Edited"], ["Actions", "actions", true]], list.map((p) =>
      el("tr", { className: "list-row" },
        el("td", {}, el("div", { className: "name-cell" },
          el("span", { className: "file-ico" }, icon(TEMPLATE_ICONS[p.template] ?? "code")),
          el("a", { href: `#/p/${p.id}`, textContent: p.name }))),
        el("td", { className: "muted", textContent: p.template }),
        el("td", {}, p.deploy?.url ? extLink(p.deploy.url, p.deploy.url.replace(/^https?:\/\//, "")) : el("span", { className: "muted", textContent: "Not deployed" })),
        el("td", { className: "muted" }, timeAgo(p.updatedAt)),
        el("td", { className: "actions" }, el("button", {
          className: "icon-btn danger",
          type: "button",
          title: "Delete project",
          id: `delete-${p.id}`,
          ariaLabel: `Delete ${p.name}`,
          onclick: async () => {
            if (!confirm(`Delete local project ${p.name}? Deployed apps are not affected.`)) return;
            await projects.delete(p.id);
            toast(`Deleted ${p.name}`);
            await Promise.all([renderProjects(), renderRecent()]);
            refocus();
          },
        }, icon("trash"))))))
    : emptyState("No projects yet", "Pick a template above. Projects are saved in this browser as you edit."));
}

function renderApps() {
  return api("/v1/apps").then(({ apps }) => {
    $("apps").replaceChildren(apps.length
      ? dataTable("apps-title", [["App"], ["Access"], ["Updated"], ["Actions", "actions", true]], apps.map((a) =>
        el("tr", { className: "list-row" },
          el("td", {}, el("div", { className: "name-cell" },
            el("span", { className: "file-ico" }, icon("globe")),
            el("div", {}, extLink(a.url, a.name), el("span", { className: "sub", textContent: a.url.replace(/^https?:\/\//, "") })))),
          el("td", { className: "muted", textContent: ACCESS_LABEL[a.access] ?? "" }),
          el("td", { className: "muted" }, timeAgo(a.updatedAt)),
          el("td", { className: "actions" },
            el("button", { className: "btn sm", type: "button", title: "Open the deployed source as a new project", onclick: () => openDeployed(a) },
              icon("download"), "Open source"),
            a.access === "viewer" ? null
              : el("a", { className: "btn sm", href: `#/share/${encodeURIComponent(a.name)}` }, icon("users"), "Share", srOnly(` ${a.name}`)),
            a.access === "owner" ? null
              : el("button", { className: "btn sm danger", type: "button", id: `leave-${a.id}`, ariaLabel: `Leave ${a.name}`, onclick: () => leaveApp(a) }, "Leave")))))
      : emptyState("Nothing deployed yet", "Open a project and press Deploy, or run cresslet deploy."));
  }).catch((e) => $("apps").replaceChildren(el("p", { className: "error", textContent: `Could not load apps: ${e.message}` })));
}

// ------------------------------------------------------------------ pages (uploaded static HTML)
const VIS_LABEL = { private: "Private", link: "Anyone with the link", public: "Public" };
const keepText = (d) => (d === null ? "Forever" : d === 365 ? "1 year" : `${d} day${d === 1 ? "" : "s"}`);
const keepValue = (d) => (d === null ? "forever" : String(d));
const keepParse = (v) => (v === "forever" ? null : Number(v));
/** Selects `days`, adding an option for a value set elsewhere (CLI or API), in order. */
function setKeep(select, days) {
  const v = keepValue(days);
  if (![...select.options].some((o) => o.value === v)) {
    const after = [...select.options].find((o) => o.value === "forever" || Number(o.value) > days);
    select.add(new Option(keepText(days), v), after ?? null);
  }
  select.value = v;
}
const keepSelect = (attrs, days) => {
  const s = el("select", { className: "input role-select", ...attrs },
    ...["1", "7", "30", "90", "365", "forever"].map((v) => el("option", { value: v, textContent: keepText(keepParse(v)) })));
  setKeep(s, days);
  return s;
};
const visSelect = (attrs, value) =>
  el("select", { className: "input role-select", ...attrs },
    ...Object.entries(VIS_LABEL).map(([v, t]) => el("option", { value: v, textContent: t, selected: v === value })));
const pageName = (p) => p.title ?? p.name;
const untilText = (p) => (p.expiresAt ? `until ${new Date(p.expiresAt).toLocaleDateString()}` : "no expiry");

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied");
  } catch {
    toast(`Copy failed: ${url}`);
  }
}

/** #/pages: upload and manage static pages (logged in only). */
function renderPagesView() {
  if (!auth.token) {
    location.hash = "#/";
    return;
  }
  showOnly("pages");
  document.title = "Pages · Cresslet Studio";
  renderPages();
}

let pageFormTouched = false; // the upload form keeps a choice made before the list (re)loads
function renderPages() {
  return api("/v1/pages").then(({ pages, defaults }) => {
    if (!pageFormTouched) {
      $("page-visibility").value = defaults.visibility;
      setKeep($("page-retention"), defaults.retentionDays);
    }
    $("page-list").replaceChildren(pages.length
      ? dataTable("pages-title", [["Page"], ["Who can open it"], ["Keep for"], ["Actions", "actions", true]], pages.map(pageRow))
      : emptyState("No pages yet", "Upload an HTML file above, or run cresslet page upload <file>."));
  }).catch((e) => $("page-list").replaceChildren(el("p", { className: "error", textContent: `Could not load pages: ${e.message}` })));
}

function pageRow(p) {
  const manage = p.access === "owner" || p.access === "admin";
  const label = pageName(p);
  const until = el("span", { className: "sub", textContent: untilText(p) });
  const ico = el("span", { className: "file-ico" }, icon(p.visibility === "private" ? "shield" : "globe"));
  const vis = manage
    ? visSelect({ id: `vis-${p.id}`, ariaLabel: `Who can open ${label}`, onchange: () => changePage(p, { visibility: vis.value }, vis, until, ico) }, p.visibility)
    : el("span", { className: "muted", textContent: VIS_LABEL[p.visibility] });
  const keep = manage
    ? keepSelect({ id: `keep-${p.id}`, ariaLabel: `Keep ${label} for`, onchange: () => changePage(p, { retentionDays: keepParse(keep.value) }, keep, until) }, p.retentionDays)
    : el("span", { className: "muted", textContent: keepText(p.retentionDays) });
  const replace = el("input", { type: "file", className: "sr-only", accept: ".html,.htm,text/html", onchange: () => replacePage(p, replace) });
  const replaceDir = el("input", { type: "file", className: "sr-only", webkitdirectory: true, multiple: true, onchange: () => replacePage(p, replaceDir) });
  return el("tr", { className: "list-row" },
    el("td", {}, el("div", { className: "name-cell" },
      ico,
      el("div", {}, extLink(p.url, label), el("span", { className: "sub", textContent: p.url.replace(/^https?:\/\//, "") })))),
    el("td", {}, vis),
    el("td", {}, el("div", { className: "keep-cell" }, keep, until)),
    el("td", { className: "actions" },
      el("button", { className: "btn sm", type: "button", ariaLabel: `Copy link to ${label}`, onclick: () => copyLink(p.url) }, icon("copy"), "Copy link"),
      p.access === "viewer" ? null
        : el("label", { className: "icon-btn file-btn", title: "Replace with an HTML file (same link)" }, replace, icon("refresh"), srOnly(`Replace ${label} with an HTML file`)),
      p.access === "viewer" ? null
        : el("label", { className: "icon-btn file-btn", title: "Replace with a folder (same link)" }, replaceDir, icon("folder"), srOnly(`Replace ${label} with a folder`)),
      manage ? el("a", { className: "icon-btn", href: `#/share/${encodeURIComponent(p.name)}`, title: "Share" }, icon("users"), srOnly(`Share ${label}`)) : null,
      p.access === "owner"
        ? el("button", { className: "icon-btn danger", type: "button", id: `delete-page-${p.id}`, title: "Delete page", ariaLabel: `Delete ${label}`, onclick: () => deletePage(p) }, icon("trash"))
        : null));
}

async function changePage(p, change, select, until, ico) {
  select.disabled = true;
  try {
    const { page } = await api(`/v1/pages/${encodeURIComponent(p.name)}`, { method: "PATCH", body: JSON.stringify(change) });
    Object.assign(p, page);
    until.textContent = untilText(page);
    ico?.replaceChildren(icon(page.visibility === "private" ? "shield" : "globe"));
    toast(change.visibility
      ? `${pageName(page)}: ${VIS_LABEL[page.visibility].toLowerCase()}`
      : `${pageName(page)} is kept ${page.retentionDays === null ? "forever" : untilText(page)}`);
  } catch (e) {
    toast(`Could not change ${pageName(p)}: ${e.message}`);
    if (change.visibility) select.value = p.visibility;
    else setKeep(select, p.retentionDays);
  } finally {
    select.disabled = false;
  }
}

/** New files at the same link: one HTML file, or a folder (all of the page's files are replaced). */
async function replacePage(p, input) {
  if (!input.files.length) return;
  try {
    let content;
    if (input.webkitdirectory) {
      const { files } = folderFiles(input.files);
      if (!files.some((x) => x.path === "index.html")) throw new Error("that folder has no index.html at its top level");
      content = await folderBody(files);
    } else content = { html: await input.files[0].text() };
    await api(`/v1/pages/${encodeURIComponent(p.name)}`, { method: "PUT", body: JSON.stringify({ ...content, source: "studio" }) });
    toast(`Replaced ${pageName(p)} (same link)`);
  } catch (e) {
    toast(`Could not replace ${pageName(p)}: ${e.message}`);
  }
  input.value = "";
  await renderPages();
  refocus($("pages-title"));
}

async function deletePage(p) {
  if (!confirm(`Delete ${pageName(p)}? Its link stops working.`)) return;
  try {
    await api(`/v1/pages/${encodeURIComponent(p.name)}`, { method: "DELETE" });
  } catch (e) {
    toast(`Could not delete ${pageName(p)}: ${e.message}`);
    return;
  }
  toast(`Deleted ${pageName(p)}`);
  await renderPages();
  refocus($("pages-title"));
}

/** What the upload form will send: one HTML file, or a folder's files (its top directory stripped). */
let pagePick = null;
const b64 = async (file) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
function pageError(text) {
  $("page-error").textContent = text;
  $("page-error").hidden = !text;
}
$("page-file").addEventListener("change", () => {
  const f = $("page-file").files[0];
  $("page-dir").value = "";
  pagePick = f ? { title: f.name.replace(/\.html?$/i, ""), html: f } : null;
  $("page-picked").textContent = f ? f.name : "Nothing chosen";
  pageError("");
});
/** A picked folder's files, its top directory stripped; hidden files and folders (.git, .DS_Store) stay behind. */
function folderFiles(list) {
  const files = [...list]
    .map((f) => ({ f, path: f.webkitRelativePath.split("/").slice(1).join("/") }))
    .filter(({ path }) => path && !path.split("/").some((seg) => seg.startsWith(".")));
  return { dir: list[0]?.webkitRelativePath.split("/")[0] ?? null, files };
}
const folderBody = async (files) =>
  ({ files: await Promise.all(files.map(async ({ f, path }) => ({ path, data: await b64(f), encoding: "base64" }))) });
$("page-dir").addEventListener("change", () => {
  $("page-file").value = "";
  const { dir, files } = folderFiles($("page-dir").files);
  pagePick = files.length ? { title: dir, files } : null;
  $("page-picked").textContent = files.length ? `${dir}/ (${files.length} file${files.length === 1 ? "" : "s"})` : "Nothing chosen";
  pageError(files.length && !files.some((x) => x.path === "index.html") ? "That folder has no index.html at its top level." : "");
});
for (const id of ["page-visibility", "page-retention"]) $(id).addEventListener("change", () => (pageFormTouched = true));

$("page-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!pagePick) {
    pageError("Choose an HTML file or a folder first.");
    $("page-file").focus();
    return;
  }
  pageError("");
  $("page-upload").disabled = true;
  try {
    const content = pagePick.html
      ? { html: await pagePick.html.text() }
      : await folderBody(pagePick.files);
    const { page } = await api("/v1/pages", {
      method: "POST",
      body: JSON.stringify({
        ...content,
        title: pagePick.title,
        visibility: $("page-visibility").value,
        retentionDays: keepParse($("page-retention").value),
        source: "studio",
      }),
    });
    pagePick = null;
    pageFormTouched = false;
    $("page-form").reset();
    $("page-picked").textContent = "Nothing chosen";
    await renderPages();
    toast(el("span", {}, `Uploaded ${pageName(page)}: `, extLink(page.url, page.url.replace(/^https?:\/\//, "")), " ",
      el("button", { className: "btn sm", type: "button", onclick: () => copyLink(page.url) }, icon("copy"), "Copy link")));
  } catch (err) {
    pageError(`Could not upload: ${err.message}`);
  } finally {
    $("page-upload").disabled = false;
    if (document.activeElement === document.body) $("page-upload").focus();
  }
});

// Settings: the account's defaults for new pages.
function pageDefaultsError(text) {
  $("page-defaults-error").textContent = text;
  $("page-defaults-error").hidden = !text;
}
function showPageDefaults({ pages, defaults }) {
  $("def-visibility").value = pages.visibility;
  setKeep($("def-retention"), pages.retentionDays);
  $("def-server").textContent = `${VIS_LABEL[defaults.pages.visibility].toLowerCase()}, kept ${defaults.pages.retentionDays === null ? "forever" : `for ${keepText(defaults.pages.retentionDays).toLowerCase()}`}`;
}
function renderPageDefaults() {
  pageDefaultsError("");
  api("/v1/me/settings").then(showPageDefaults, (e) => pageDefaultsError(`Could not load your page defaults: ${e.message}`));
}
async function savePageDefaults(pages, done) {
  pageDefaultsError("");
  $("page-defaults-save").disabled = $("page-defaults-reset").disabled = true;
  try {
    showPageDefaults(await api("/v1/me/settings", { method: "PUT", body: JSON.stringify({ pages }) }));
    toast(done);
  } catch (e) {
    pageDefaultsError(`Could not save: ${e.message}`);
  } finally {
    $("page-defaults-save").disabled = $("page-defaults-reset").disabled = false;
  }
}
$("page-defaults-form").addEventListener("submit", (e) => {
  e.preventDefault();
  savePageDefaults({ visibility: $("def-visibility").value, retentionDays: keepParse($("def-retention").value) }, "Page defaults saved");
});
$("page-defaults-reset").addEventListener("click", () => savePageDefaults(null, "Using the server's page defaults"));

let cliToken = null; // the token renderCli named the account of
/**
 * #/cli: where `cresslet auth login` sends the browser. The user types the code from their terminal (it isn't in
 * the link, so a link someone else sent can't log their CLI in to this account), and the CLI's poll then gets a
 * new token for this account.
 */
function renderCli() {
  showOnly("cli-login");
  document.title = "Log in the CLI · Cresslet Studio";
  const text = (t) => ($("cli-login-text").textContent = t);
  const form = $("cli-login-form");
  form.hidden = true;
  form.reset();
  cliError("");
  $("cli-login-actions").replaceChildren();
  if (!auth.token) {
    text("Log in to let the Cresslet CLI use your account.");
    return $("cli-login-actions").replaceChildren(el("button", {
      className: "btn primary",
      type: "button",
      onclick: () => {
        try {
          sessionStorage.setItem("cresslet.afterLogin", "#/cli");
        } catch { /* storage blocked: login lands on the home page */ }
        logIn();
      },
    }, icon("github"), "Log in with GitHub"));
  }
  // Name the account this session's token belongs to, and approve only with that same token.
  const token = (cliToken = auth.token);
  text("Checking your account…");
  // Session changed meanwhile (another tab): start over with the current one.
  const stale = () => location.hash !== "#/cli" || (auth.token !== token && (renderCli(), true));
  api("/v1/me").then(({ account }) => {
    if (stale()) return;
    text(`Enter the code that cresslet auth login shows in your terminal. The CLI gets full access to ${account.github ?? account.email}. Only enter a code from a terminal you're using.`);
    form.hidden = false;
  }, (e) => {
    if (!stale()) text(`Could not load your account: ${e.message}`);
  });
}
function cliError(t) {
  $("cli-login-error").textContent = t;
  $("cli-login-error").hidden = !t;
}
$("cli-login-code").addEventListener("input", () => cliError(""));
$("cli-login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (auth.token !== cliToken) return renderCli();
  $("cli-login-approve").disabled = true;
  try {
    await api("/v1/auth/cli/approve", { method: "POST", body: JSON.stringify({ userCode: $("cli-login-code").value }) });
    $("cli-login-form").hidden = true;
    $("cli-login-text").textContent = "CLI logged in. You can close this tab and go back to your terminal.";
    focusView();
  } catch (err) {
    if (!auth.token) return renderCli(); // session expired: offer the login
    cliError(`Could not authorize: ${err.message}`);
    $("cli-login-code").focus();
  } finally {
    $("cli-login-approve").disabled = false;
  }
});

/**
 * #/view/<page>?path=…: where a private page sends a visitor without a session. Asks the server for a
 * one-time sign-in link to the page (owner and collaborators only) and goes there.
 */
async function renderView(name, path) {
  showOnly("view");
  document.title = "Private page · Cresslet Studio";
  const text = (t) => ($("view-text").textContent = t);
  $("view-actions").replaceChildren();
  if (!auth.token) {
    text("This page is private. Log in to open it, if its owner shared it with you.");
    $("view-actions").replaceChildren(el("button", {
      className: "btn primary",
      type: "button",
      onclick: () => {
        try {
          sessionStorage.setItem("cresslet.afterLogin", location.hash);
        } catch { /* storage blocked: login lands on the home page */ }
        logIn();
      },
    }, icon("github"), "Log in with GitHub"));
    return;
  }
  // A browser that drops the page's cookie would bounce between here and the page forever.
  const key = `cresslet.view.${name}`;
  let tries = [];
  try {
    tries = JSON.parse(sessionStorage.getItem(key) ?? "[]").filter((t) => Date.now() - t < 60_000);
    sessionStorage.setItem(key, JSON.stringify([...tries, Date.now()]));
  } catch { /* storage blocked */ }
  if (tries.length >= 3) {
    text("Your browser didn't keep this page's sign-in. Allow cookies for it, then try again.");
    $("view-actions").replaceChildren(el("button", {
      className: "btn",
      type: "button",
      onclick: () => {
        try {
          sessionStorage.removeItem(key);
        } catch { /* storage blocked */ }
        renderView(name, path);
      },
    }, icon("refresh"), "Try again"));
    return;
  }
  text("Opening…");
  try {
    const { url } = await api(`/v1/pages/${encodeURIComponent(name)}/view`, { method: "POST", body: JSON.stringify({ path }) });
    location.replace(url);
  } catch (e) {
    text(e.status === 404 ? "This page doesn't exist, or it expired."
      : e.status === 403 ? `You don't have access to this page (logged in as ${auth.email}). Ask its owner to share it with you.`
      : `Could not open the page: ${e.message}`);
    $("view-actions").replaceChildren(el("a", { className: "btn", href: "#/" }, "Go to Projects"));
  }
}

// ------------------------------------------------------------------ sharing (collaborators and invites)
const ACCESS_LABEL = { owner: "Owner", admin: "Admin", viewer: "Viewer" };
const personText = (p) => (p.github ? `${p.github} (${p.email})` : p.email);

/** Invitations to apps other people shared with you (home). */
async function renderInvites() {
  const gen = routeGen;
  let invites;
  try {
    ({ invites } = await api("/v1/me/invites"));
  } catch {
    invites = [];
  }
  if (gen !== routeGen) return;
  $("invites-section").hidden = !invites.length;
  $("invites").replaceChildren(...invites.map((i) =>
    el("li", { className: "list-row" },
      el("div", { className: "tok" },
        el("strong", { textContent: i.app }),
        el("span", { className: "meta", textContent: `${ACCESS_LABEL[i.role]}${i.invitedBy ? ` · invited by ${i.invitedBy.github ?? i.invitedBy.email}` : ""}` })),
      el("button", { className: "btn sm primary", type: "button", id: `accept-${i.id}`, textContent: "Accept", ariaLabel: `Accept invite to ${i.app}`, onclick: () => answerInvite(i, true) }),
      el("button", { className: "btn sm", type: "button", id: `decline-${i.id}`, textContent: "Decline", ariaLabel: `Decline invite to ${i.app}`, onclick: () => answerInvite(i, false) }))));
}

async function answerInvite(i, accept) {
  let r;
  try {
    r = await api(`/v1/me/invites/${encodeURIComponent(i.id)}${accept ? "/accept" : ""}`, accept ? { method: "POST", body: "{}" } : { method: "DELETE" });
  } catch (e) {
    // e.g. 404: cancelled, or re-sent with another role (a new invite): show the current ones.
    toast(`Could not ${accept ? "accept" : "decline"} the invite: ${e.message}`);
    await renderInvites();
    refocus($("invites-section").hidden ? $("apps-title") : $("invites-title"));
    return;
  }
  toast(accept ? `${i.app} is in your deployed apps (${ACCESS_LABEL[r.app.access]?.toLowerCase() ?? r.app.access})` : `Declined the invite to ${i.app}`);
  await Promise.all([renderInvites(), accept ? renderApps() : null]);
  refocus($("invites-section").hidden ? $("apps-title") : $("invites-title"));
}

async function leaveApp(a) {
  if (!confirm(`Leave ${a.name}? You lose access to it until someone invites you again.`)) return;
  try {
    const id = myAccountId ?? (await api("/v1/me")).account.id;
    await api(`/v1/apps/${encodeURIComponent(a.name)}/collaborators/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (e) {
    toast(`Could not leave ${a.name}: ${e.message}`);
    return;
  }
  toast(`You left ${a.name}`);
  await renderApps();
  refocus($("apps-title"));
}

/** #/share/<app>: who has access to an app (owner and admins only). */
let shareApp = null;
async function renderShare(name) {
  if (!auth.token) {
    location.hash = "#/";
    return;
  }
  shareApp = name;
  showOnly("share");
  document.title = `Share ${name} · Cresslet Studio`;
  $("share-title").replaceChildren(el("a", { href: "#/", textContent: "Projects" }), " / ", `Share ${name}`);
  $("share-sub").textContent = "Invite accounts to this app. Viewers see it; admins can also change it.";
  // A page: its title, and what sharing means for it.
  api(`/v1/pages/${encodeURIComponent(name)}`).then(({ page }) => {
    if (shareApp !== name) return;
    $("share-title").replaceChildren(el("a", { href: "#/pages", textContent: "Pages" }), " / ", `Share ${pageName(page)}`);
    $("share-sub").textContent = "Invite accounts to this page. Viewers can open it even when it's private; admins can also change it.";
  }, () => {});
  $("invite-form").reset();
  $("invite-form").hidden = true; // until the list loads: only the owner and admins may share
  $("invite-send").disabled = false; // an invite still in flight from another app's page doesn't hold this one
  inviteError("");
  $("people").replaceChildren(el("li", { className: "list-row muted", textContent: "Loading…" }));
  const gen = routeGen;
  if (!myAccountId) await api("/v1/me").then(setAccount, () => {});
  await renderPeople(gen);
}

async function renderPeople(gen = routeGen) {
  const name = shareApp;
  let d;
  try {
    d = await api(`/v1/apps/${encodeURIComponent(name)}/collaborators`);
  } catch (e) {
    if (gen === routeGen) $("people").replaceChildren(el("li", { className: "list-row error", textContent: `Could not load who has access: ${e.message}` }));
    return;
  }
  if (gen !== routeGen) return;
  $("invite-form").hidden = false;
  const who = (text, meta, badge) =>
    el("div", { className: "tok" },
      el("strong", { textContent: text }, badge ? el("span", { className: "badge", textContent: badge }) : null),
      el("span", { className: "meta", textContent: meta }));
  $("people").replaceChildren(
    el("li", { className: "list-row" }, who(personText(d.owner), "Owner", d.owner.id === myAccountId ? "you" : null)),
    ...d.collaborators.map((p) => {
      const me = p.id === myAccountId;
      const role = el("select", {
        className: "input role-select",
        id: `role-${p.id}`,
        ariaLabel: `Role for ${personText(p)}`,
        onchange: () => setRole(p, role),
      }, ...["viewer", "admin"].map((v) => el("option", { value: v, textContent: ACCESS_LABEL[v], selected: v === p.role })));
      return el("li", { className: "list-row" },
        who(personText(p), `added ${when(p.createdAt)}`, me ? "you" : null),
        role,
        el("button", {
          className: "btn sm danger",
          type: "button",
          id: `remove-${p.id}`,
          textContent: me ? "Leave" : "Remove",
          ariaLabel: me ? `Leave ${name}` : `Remove ${personText(p)}`,
          onclick: () => removePerson(p, me),
        }));
    }),
    ...d.invites.map((i) =>
      el("li", { className: "list-row" },
        who(i.email, `${ACCESS_LABEL[i.role]} · invited ${when(i.createdAt)}`, "pending"),
        el("button", {
          className: "btn sm",
          type: "button",
          id: `cancel-${i.id}`,
          textContent: "Cancel invite",
          ariaLabel: `Cancel invite for ${i.email}`,
          onclick: () => cancelInvite(i),
        }))),
  );
}

/** One role update per row at a time, in order (a select can fire change per arrow key); shows what the server stored. */
function setRole(p, select) {
  const role = select.value;
  // Demoting yourself ends your access to this page: only after a confirmation.
  if (p.id === myAccountId && role === "viewer" && !confirm(`Make yourself a viewer of ${shareApp}? You won't be able to change it or share it any more.`)) {
    select.value = p.role;
    return;
  }
  const url = `/v1/apps/${encodeURIComponent(shareApp)}/collaborators/${encodeURIComponent(p.id)}`;
  const version = p.version = (p.version ?? 0) + 1; // only the latest change updates the row
  const gen = routeGen, app = shareApp;
  p.saving = (p.saving ?? Promise.resolve()).then(async () => {
    if (p.demoted) return; // you made yourself a viewer: later changes would only be refused
    try {
      p.role = (await api(url, { method: "PUT", body: JSON.stringify({ role }) })).role;
    } catch (e) {
      toast(`Could not change the role: ${e.message}`);
      if (version === p.version) select.value = p.role;
      return;
    }
    if (p.id === myAccountId && p.role === "viewer") {
      p.demoted = true;
      if (gen === routeGen) location.hash = "#/"; // no longer allowed here (unless you already left the page)
      toast(`You're now a viewer of ${app}`);
      return;
    }
    if (version !== p.version) return;
    select.value = p.role;
    toast(`${personText(p)} is now ${ACCESS_LABEL[p.role].toLowerCase()}`);
  });
}

async function removePerson(p, me) {
  const name = shareApp, gen = routeGen;
  if (!confirm(me ? `Leave ${name}? You lose access to it until someone invites you again.` : `Remove ${personText(p)} from ${name}?`)) return;
  try {
    await api(`/v1/apps/${encodeURIComponent(name)}/collaborators/${encodeURIComponent(p.id)}`, { method: "DELETE" });
  } catch (e) {
    toast(`Could not remove: ${e.message}`);
    return;
  }
  toast(me ? `You left ${name}` : `Removed ${personText(p)}`);
  if (gen !== routeGen) return; // navigated away meanwhile
  if (me) {
    location.hash = "#/";
    return;
  }
  await renderPeople(gen);
  if (gen === routeGen) refocus($("people-title"));
}

async function cancelInvite(i) {
  const gen = routeGen;
  try {
    await api(`/v1/apps/${encodeURIComponent(shareApp)}/invites/${encodeURIComponent(i.id)}`, { method: "DELETE" });
  } catch (e) {
    toast(`Could not cancel the invite: ${e.message}`);
    return;
  }
  toast(`Cancelled the invite for ${i.email}`);
  if (gen !== routeGen) return;
  await renderPeople(gen);
  if (gen === routeGen) refocus($("people-title"));
}

function inviteError(text) {
  $("invite-error").textContent = text;
  $("invite-error").hidden = !text;
}
$("invite-form").addEventListener("input", () => inviteError(""));
$("invite-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  inviteError("");
  $("invite-send").disabled = true;
  const gen = routeGen; // the form is shared by every app's Share page: don't touch it after navigating
  try {
    const r = await api(`/v1/apps/${encodeURIComponent(shareApp)}/collaborators`, {
      method: "POST",
      body: JSON.stringify({ email: $("invite-email").value, role: $("invite-role").value }),
    });
    toast(`Invited ${r.invite.email} as ${ACCESS_LABEL[r.invite.role].toLowerCase()}`);
    if (gen !== routeGen) return;
    $("invite-form").reset();
    await renderPeople(gen);
  } catch (err) {
    if (gen === routeGen) inviteError(`Could not invite: ${err.message}`);
    else toast(`Could not invite: ${err.message}`);
  } finally {
    if (gen === routeGen) {
      $("invite-send").disabled = false;
      if (document.activeElement === document.body) $("invite-send").focus(); // disabling it dropped focus
    }
  }
});

async function copyCommand(cmd, fallback) {
  try {
    await navigator.clipboard.writeText(cmd);
    toast("Command copied");
  } catch {
    getSelection().selectAllChildren(fallback);
    toast("Copy failed: the command is selected, copy it manually.");
  }
}
$("cli-copy").addEventListener("click", () => copyCommand($("cli-cmd").lastChild.textContent.trim(), $("cli-cmd")));
for (const b of document.querySelectorAll("[data-copy]")) {
  b.addEventListener("click", () => copyCommand(b.dataset.copy, b.closest(".term").querySelector("code")));
}

// ------------------------------------------------------------------ landing
function renderLanding() {
  showOnly("landing");
  document.title = "Cresslet: build it in the browser, ship it in a second";
  renderTemplates($("landing-templates"));
  meta.then((m) => {
    // This server's own app domain, and what visitors can do without an account.
    if (m.appUrlTemplate) {
      const url = m.appUrlTemplate.replace("{name}", "my-app");
      for (const n of document.querySelectorAll(".js-app-url")) n.textContent = url;
      for (const n of document.querySelectorAll(".js-app-host")) n.textContent = url.replace(/^https?:\/\//, "");
    }
    const hours = Math.round((m.limits?.anonTtlMs ?? 0) / 3600_000);
    const keep = m.auth?.github ? " Log in with GitHub to keep them." : "";
    $("landing-note").textContent = m.anonDeploys
      ? `Free and open source. No account needed: apps deployed without one last ${hours} hours.${keep}`
      : `Free and open source. Try it without an account${m.auth?.github ? "; log in with GitHub to deploy" : ""}.`;
    $("landing-login").hidden = !m.auth?.github;
  });
}
/** "Start building": to the templates, with focus on their heading so keyboard users land there too. */
for (const b of document.querySelectorAll("[data-start]")) {
  b.addEventListener("click", () => {
    const h = $("landing-templates-title");
    h.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    h.focus({ preventScroll: true });
  });
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

async function openProject(id, gen) {
  const project = await projects.get(id);
  if (gen !== routeGen) return; // navigated elsewhere while it loaded
  if (!project) {
    location.hash = "#/";
    return;
  }
  if (booted) {
    // One runtime per page; switching projects reloads.
    reloadForRoute();
    return;
  }
  booted = true;
  $("workspace-title").textContent = `${project.name}: editor and preview`;
  showOnly("workspace");
  $("project-title").hidden = false;
  $("deploy-btn").hidden = false;
  $("deploy-btn").disabled = project.trusted === false; // locked from the start (gate() below takes over)
  $("project-name").value = project.name;
  document.title = `${project.name} · Cresslet Studio`;
  showDeployLink(project.deploy);

  $("project-name").onchange = async (e) => {
    project.name = e.target.value.trim() || project.name;
    e.target.value = project.name;
    document.title = `${project.name} · Cresslet Studio`;
    $("workspace-title").textContent = `${project.name}: editor and preview`;
    await projects.rename(project.id, project.name);
  };

  // Colors follow the light/dark preference; CSS tokens are the source of truth.
  const scheme = matchMedia("(prefers-color-scheme: dark)");
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
  const termTheme = () => {
    const v = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    return {
      ...ANSI[scheme.matches ? "dark" : "light"],
      background: v("--surface"), foreground: v("--text"), cursor: v("--accent-text"), cursorAccent: v("--surface"), selectionBackground: v("--accent-soft"),
    };
  };

  // terminal
  const term = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono"),
    fontSize: 12.5,
    screenReaderMode: true, // output is mirrored into a live region screen readers can read
    theme: termTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open($("terminal"));
  term.textarea?.setAttribute("aria-describedby", "terminal-help");
  // xterm sends Tab to the shell; Esc then Tab (or Shift+Tab) moves focus out instead, like the editor.
  let escaped = false;
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    if (e.key === "Tab" && escaped) {
      escaped = false;
      return false; // xterm ignores it: the browser moves focus
    }
    escaped = e.key === "Escape";
    return true;
  });
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
    $("preview-spinner").hidden = true;
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
    // `cresslet deploy` in a command the AI builder started: the user says yes first.
    builderRunning: () => builder.running(),
    approveDeploy: (target, signal) => builder.approve(`Claude wants to deploy ${target ? `to ${target}` : "this project as a new app"}. It goes live at once.`, signal),
  });

  // editor
  const lang = new Compartment();
  const theme = new Compartment();
  let current = null;
  let suppress = false;
  const view = new EditorView({
    parent: $("editor"),
    state: EditorState.create({
      doc: "",
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        theme.of(scheme.matches ? oneDark : []),
        EditorView.contentAttributes.of({ "aria-label": "Code", "aria-describedby": "editor-help" }),
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
      if (path === current) {
        // The open file is gone (deleted from the terminal or by the AI builder): don't let typing recreate it.
        current = null;
        suppress = true;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" }, effects: lang.reconfigure([]) });
        suppress = false;
        $("open-file").textContent = "No file open";
        view.contentDOM.setAttribute("aria-label", "Code");
        renderTree();
      }
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
    view.contentDOM.setAttribute("aria-label", `Code: ${path}`);
    renderTree();
  }
  scheme.addEventListener("change", () => {
    view.dispatch({ effects: theme.reconfigure(scheme.matches ? oneDark : []) });
    term.options.theme = termTheme();
  });

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

  // Folders are labels, files are buttons named by their full path (the indent alone shows nesting).
  async function renderTree() {
    const items = await listFiles().catch(() => []);
    const focused = document.activeElement?.closest?.("#tree") ? document.activeElement.dataset.path : null;
    $("tree").replaceChildren(el("ul", {}, ...items.map((f) => {
      const item = f.dir
        ? el("span", { className: "dir" }, icon("folder"), el("span", { textContent: f.name }))
        : el("button", { type: "button", dataset: { path: f.path }, onclick: () => openFile(f.path) },
          icon("file"), el("span", { textContent: f.name }), f.depth ? srOnly(` in ${f.path.slice(0, -f.name.length - 1)}`) : null);
      item.style.setProperty("--depth", f.depth);
      if (!f.dir && f.path === current) item.setAttribute("aria-current", "true");
      return el("li", {}, item);
    })));
    if (focused) $("tree").querySelector(`button[data-path="${CSS.escape(focused)}"]`)?.focus();
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
      // the open file removed (a command, the AI builder): openFile clears the editor
      const open = current;
      if (open) c.fs.exists(`${wd}/${open}`).then((ok) => ok || openFile(open), () => {});
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
    const hadFocus = $("preview-empty").contains(document.activeElement); // e.g. the message after Run it
    $("preview-empty").hidden = true;
    $("preview").hidden = false;
    if (hadFocus) $("preview-path").focus();
    $("preview-spinner").hidden = false;
    setStatus("Running", "ready");
    loadPreview();
  });
  c.on("error", (e) => term.writeln(`\x1b[31m${e?.message ?? e}\x1b[0m`));
  $("preview-reload").onclick = loadPreview;
  $("preview-path").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadPreview();
  });

  // shell
  const shell = await c.spawn("jsh", [], { cwd: wd, terminal: true });
  let termOut = ""; // the terminal's latest output, for the AI builder's read_dev_log
  shell.output.pipeTo(new WritableStream({ write: (d) => {
    term.write(d);
    termOut = (termOut + d).slice(-64_000);
  } }));
  const input = shell.input.getWriter();
  // an untrusted project's shell takes no input until "Run it" (a command could run its code: npm scripts, a build's
  // PostCSS/Tailwind plugins)
  let locked = project.trusted === false;
  term.onData((d) => {
    if (!locked) input.write(d);
  });
  const start = () => {
    setStatus("Installing");
    $("preview-msg").replaceChildren("Installing dependencies…");
    input.write("npm install && cresslet dev\r");
  };
  // Opened from a deployed app's source: its code (and npm deps, and a deploy's build: PostCSS/Tailwind plugins)
  // would run in this browser. Nothing runs, Deploy included, until the user says so.
  const builder = mountBuilder({
    c,
    devLog: () => termOut,
    // A file the builder changed is the one in the editor: show the new contents.
    onChange: (path) => path === current && openFile(path),
  });
  const gate = (on) => {
    locked = on;
    $("deploy-btn").disabled = on;
    $("deploy-btn").title = on ? "Run the project first" : "";
    builder.lock(on); // its commands would run the project's code too
  };
  gate(project.trusted === false);
  if (project.trusted === false) {
    setStatus("Not running", "idle");
    $("preview-spinner").hidden = true;
    const btn = el("button", { className: "btn primary", type: "button", textContent: "Run it", onclick: async () => {
      project.trusted = true;
      await projects.put(project);
      gate(false);
      $("preview-spinner").hidden = false;
      start(); // replaces the message, button included: keep focus on the message
      $("preview-msg").focus();
    } });
    $("preview-msg").replaceChildren(
      "This project was opened from a deployed app's source. Review it, then ",
      btn,
      " to install its dependencies and start it here (the terminal, Deploy and the AI builder unlock then).",
    );
  } else start();

  // deploy
  $("deploy-btn").onclick = async () => {
    const btn = $("deploy-btn");
    btn.disabled = true;
    $("deploy-btn-label").textContent = "Deploying…";
    const log = $("deploy-log");
    log.textContent = "";
    selectTab("deploy-log");
    if (document.activeElement === btn) log.focus(); // the disabled button would drop focus to <body>
    try {
      // A shared app you only view: say so before building (the API would refuse the upload).
      const target = project.deploy?.name;
      if (target && auth.token && !project.deploy.deployKey) {
        const info = await api(`/v1/apps/${encodeURIComponent(target)}`).catch(() => null);
        if (info?.app.access === "viewer") throw new Error(`you're a viewer of ${target}: only its owner and admins can deploy it`);
      }
      const r = await cresslet.deploy((line) => (log.textContent += line + "\n"));
      toast(el("span", {}, "Deployed: ", extLink(r.app.url, r.app.url)), 10000);
    } catch (e) {
      log.textContent += `\nerror: ${e.message}\n`;
      toast(`Deploy failed: ${e.message}`, 10000);
    } finally {
      btn.disabled = false;
      $("deploy-btn-label").textContent = "Deploy";
    }
  };
}

// ------------------------------------------------------------------ AI builder
// The chat pane (studio/builder.js runs the conversation and the tools).
const STEP_ICON = { run_command: "terminal", read_dev_log: "terminal" };
const runningText = (name, input) => ({
  list_files: "Listing files", read_file: `Reading ${input?.path ?? "a file"}`, write_file: `Writing ${input?.path ?? "a file"}`,
  edit_file: `Editing ${input?.path ?? "a file"}`, delete_file: `Deleting ${input?.path ?? "a file"}`,
  run_command: `Running ${input?.command ?? "a command"}`, read_dev_log: "Reading the dev server output",
})[name] ?? name;

function mountBuilder({ c, devLog, onChange }) {
  const btn = $("builder-btn"), pane = $("builder"), log = $("builder-log"), input = $("builder-input");
  const approvals = new Set(); // decline functions of the deploy approvals waiting for the user
  const tools = createTools(c, { devLog, onChange, paused: () => approvals.size > 0 });
  let agent = null, locked = false, busy = false;
  let approved = false, stopped = false; // this request: a deploy was approved; the user pressed Stop
  let bubble = null, step = null; // the assistant text and the tool step being written
  let replied = "", failed = ""; // this request's latest reply text (read out when it ends), and its error
  btn.hidden = false;

  const announce = (text) => ($("builder-status").textContent = text);
  const working = (text) => {
    $("builder-working").hidden = !text;
    if (text) $("builder-working-text").textContent = text;
  };
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  function add(node) {
    const stick = nearBottom();
    log.append(node);
    if (stick) log.scrollTop = log.scrollHeight;
    return node;
  }

  function showView() {
    const has = !!apiKey.get();
    $("builder-key-form").hidden = has;
    $("builder-chat").hidden = !has;
    return has;
  }
  // Where focus goes in the chat: the message field, or the heading while it's locked (a disabled field can't take it).
  const chatFocus = () => (locked ? $("builder-title") : input).focus();
  function setOpen(open, { focus = true } = {}) {
    pane.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    $("workspace").dataset.builder = open ? "open" : "";
    const chat = showView();
    if (!focus) return;
    if (!open) btn.focus();
    else if (chat) chatFocus();
    else $("builder-key").focus();
  }
  btn.onclick = () => setOpen(pane.hidden);
  $("builder-close").onclick = () => setOpen(false);

  function render() {
    $("builder-send").disabled = busy || locked;
    $("builder-stop").hidden = !busy;
    $("builder-new").disabled = busy;
    input.disabled = locked;
    $("builder-locked").hidden = !locked;
    input.setAttribute("aria-describedby", locked ? "builder-locked builder-hint" : "builder-hint");
  }

  $("builder-key-form").onsubmit = (e) => {
    e.preventDefault();
    const v = $("builder-key").value.trim();
    if (!v) return;
    if (!apiKey.set(v)) {
      $("builder-key-error").textContent = "This browser blocked saving the key (site storage). Allow it and try again.";
      return;
    }
    $("builder-key").value = "";
    $("builder-key-error").textContent = "";
    showView();
    chatFocus();
  };
  $("builder-key").oninput = () => ($("builder-key-error").textContent = "");
  $("builder-forget").onclick = () => {
    agent?.stop();
    apiKey.set(null);
    showView();
    $("builder-key").focus();
    announce("API key removed from this browser");
  };
  $("builder-new").onclick = () => {
    if (busy) return;
    for (const decline of approvals) decline(); // e.g. from a process the builder left running
    working("");
    agent = null;
    log.replaceChildren();
    announce("New chat");
    chatFocus();
  };
  $("builder-stop").onclick = () => {
    stopped = true;
    agent?.stop();
    input.focus(); // the Stop button hides
  };

  function on(ev) {
    switch (ev.type) {
      case "turn":
        bubble = null;
        working("Thinking…");
        break;
      case "thinking":
        working("Thinking…");
        break;
      case "retry": // the partial reply is sent again in full
        bubble?.remove();
        bubble = null;
        replied = "";
        break;
      case "text":
        bubble ??= add(el("li", { className: "msg assistant" }));
        bubble.textContent += ev.delta;
        replied = bubble.textContent;
        if (nearBottom()) log.scrollTop = log.scrollHeight;
        working("Writing…");
        break;
      case "tool":
        bubble = null;
        step = add(el("li", { className: "step", dataset: { state: "running" } }, icon(STEP_ICON[ev.name] ?? "file"), el("span", { textContent: runningText(ev.name, ev.input) })));
        working(`${runningText(ev.name, ev.input)}…`);
        break;
      case "tool-done":
        if (step) {
          step.dataset.state = ev.error ? "error" : "ok";
          step.replaceChildren(icon(ev.error ? "x" : STEP_ICON[ev.name] ?? "check"), el("span", { textContent: ev.summary }), ...(ev.error ? [srOnly(" (failed)")] : []));
        }
        step = null;
        if (ev.name === "run_command" && !stopped) approved = false; // an approved deploy in it has finished
        announce(ev.error ? `${ev.summary} (failed)` : ev.summary);
        working("Thinking…");
        break;
      case "notice":
        add(el("li", { className: "notice", textContent: ev.text, dataset: ev.error ? { error: "" } : undefined }));
        if (ev.error) announce(ev.text);
        if (ev.error) failed = ev.text;
        break;
    }
  }

  $("builder-form").onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy || locked) return;
    const key = apiKey.get();
    if (!key) return void showView();
    agent ??= createAgent({ client: () => anthropicClient(apiKey.get()), tools, on });
    add(el("li", { className: "msg user", textContent: text }));
    log.scrollTop = log.scrollHeight;
    input.value = "";
    replied = "";
    failed = "";
    approved = stopped = false;
    const fromSend = document.activeElement === $("builder-send");
    busy = true;
    render();
    if (fromSend) input.focus(); // Send is disabled while Claude works
    working("Thinking…");
    announce("Sent. Claude is working on it.");
    try {
      await agent.send(text);
    } finally {
      for (const decline of approvals) decline(); // its command is gone (stopped, timed out, or left running)
      if (approved && stopped) on({ type: "notice", text: "If the deploy had started uploading, it may still go live: check the app.", error: true });
      busy = false;
      bubble = step = null;
      working("");
      render();
      if (replied) announce(`Claude: ${replied}${failed ? ` (${failed})` : ""}`);
      else if (!failed) announce("Claude finished");
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("builder-form").requestSubmit();
    }
  });

  /** Asks the user to approve a deploy the builder started. Resolves to true if approved; false if declined or stopped. */
  function approve(text, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve(false);
      if (pane.hidden) setOpen(true, { focus: false });
      const done = (ok) => {
        if (!approvals.delete(stop)) return; // already answered
        approved ||= ok;
        signal?.removeEventListener("abort", stop);
        const hadFocus = row.contains(document.activeElement);
        row.className = "step";
        row.dataset.state = ok ? "ok" : "error";
        row.replaceChildren(icon(ok ? "rocket" : "x"), el("span", { textContent: ok ? "Deploy approved" : "Deploy not approved" }));
        if (hadFocus) chatFocus();
        announce(ok ? "Deploy approved" : "Deploy not approved");
        working(approvals.size ? "Waiting for your approval…" : !busy ? "" : ok ? "Deploying…" : "Thinking…");
        resolve(ok);
      };
      const stop = () => done(false);
      // Focus stays where it is (a stray Enter mid-typing must not approve); the request is announced.
      const row = add(el("li", { className: "approval" },
        el("p", { textContent: text }),
        el("div", { className: "row start" },
          el("button", { type: "button", className: "btn primary sm", textContent: "Approve deploy", onclick: () => done(true) }),
          el("button", { type: "button", className: "btn sm", textContent: "Decline", onclick: () => done(false) }))));
      approvals.add(stop);
      signal?.addEventListener("abort", stop, { once: true });
      working("Waiting for your approval…");
      announce(`${text} Approve or decline it in the AI builder.`);
    });
  }

  render();
  return {
    approve,
    running: () => tools.running > 0,
    lock(on) {
      locked = on;
      render();
    },
  };
}

function showDeployLink(deploy) {
  const a = $("deploy-link");
  a.hidden = !deploy?.url;
  if (deploy?.url) {
    a.href = deploy.url;
    a.replaceChildren(icon("globe"), el("span", { className: "deploy-url", textContent: deploy.url.replace(/^https?:\/\//, "") }), srOnly(" (live app, opens in a new tab)"));
  }
}

// Tabs (ARIA tabs pattern): one tab stop, arrows/Home/End move between tabs and select them.
const tabs = [...document.querySelectorAll(".tab")];
function selectTab(name, focus = false) {
  for (const t of tabs) {
    const on = t.dataset.tab === name;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    if (on && focus) t.focus();
  }
  for (const p of document.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== name;
}
for (const t of tabs) {
  t.addEventListener("click", () => selectTab(t.dataset.tab));
  t.addEventListener("keydown", (e) => {
    const i = tabs.indexOf(t);
    const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (j === undefined) return;
    e.preventDefault();
    selectTab(tabs[(j + tabs.length) % tabs.length].dataset.tab, true);
  });
}

// ------------------------------------------------------------------ routing
let routeGen = 0;
function route() {
  const gen = ++routeGen;
  const m = location.hash.match(/^#\/p\/([\w-]+)/);
  if (m) openProject(m[1], gen);
  else if (booted) reloadForRoute();
  else if (location.hash === "#/settings") renderSettings();
  else if (location.hash === "#/pages") renderPagesView();
  else if (location.hash.startsWith("#/share/")) renderShare(decodeURIComponent(location.hash.slice("#/share/".length)));
  else if (location.hash.startsWith("#/view/")) {
    const [n, q] = location.hash.slice("#/view/".length).split("?");
    renderView(decodeURIComponent(n), new URLSearchParams(q ?? "").get("path") ?? "/");
  }
  else if (location.hash === "#/cli") renderCli();
  else if (location.hash.startsWith("#/admin")) renderAdmin(decodeURIComponent(location.hash.slice("#/admin/".length)));
  else renderHome();
}
addEventListener("hashchange", () => {
  focusOnShow = true;
  route();
});
renderAccount();
// Role can change server-side: refresh it (shows the Admin link to site admins).
if (auth.token) api("/v1/me").then(setAccount, () => {});
// Leaving or switching a project reloads the page (one runtime per page): the next view still gets focus.
function reloadForRoute() {
  try {
    sessionStorage.setItem("cresslet.focusView", "1");
  } catch { /* storage blocked: focus starts at the top, as on any page load */ }
  location.reload();
}
try {
  if (sessionStorage.getItem("cresslet.focusView")) {
    sessionStorage.removeItem("cresslet.focusView");
    focusOnShow = true;
  }
} catch { /* storage blocked */ }
route();
