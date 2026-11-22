// Relative imports: index.html loads this from /_v/<release>/ (server/main.ts), so modules stay in step.
import { Container } from "./vendor/cresslet-container/cresslet-container.js";
import { basicSetup, Compartment, css, EditorState, EditorView, html, indentWithTab, javascript, json, keymap, oneDark } from "./vendor/editor.js";
import { FitAddon, Terminal } from "./vendor/terminal.js";
import { auth, fromTree, ignored, migrateDeployKeys, projects, toTree } from "./store.js";
import { createCresslet } from "./cresslet-plugin.js";
import { anthropicClient, apiKey, createAgent, createTools, creditsClient, errorText } from "./builder.js";

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
}

// Login is GitHub only: the server redirects back to /#cresslet_login=<one-time code>.
const meta = fetch("/v1").then((r) => r.json()).catch(() => ({}));

// ------------------------------------------------------------------ subdomain picker
// A new app's or page's address: generated by the server (GET /v1/names?kind=…), editable, checked as you type
// (GET /v1/names/:name). Same rules as server/deploys.ts validName.
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
function slugField(input, kind) {
  const field = input.closest(".slug-field");
  const status = field.querySelector(".slug-status");
  meta.then((m) => {
    const [before, after] = (m.appUrlTemplate ?? "").split("{name}");
    field.querySelector(".js-slug-before").textContent = before ?? "";
    field.querySelector(".js-slug-after").textContent = after ?? "";
  });
  // `seq` counts edits: an answer for an older value is dropped. `last`: the latest check (or suggestion);
  // `retry` marks one that failed (network, 429), so submitting asks again.
  field.querySelector(".slug-input").addEventListener("mousedown", (e) => {
    if (e.target !== input) {
      e.preventDefault();
      input.focus();
    }
  });
  let seq = 0, timer = null, last = null;
  const show = (state, text) => {
    status.dataset.state = state;
    status.replaceChildren(...(state === "ok" ? [icon("check")] : state === "bad" ? [icon("x")] : []), text);
    input.setAttribute("aria-invalid", state === "bad" ? "true" : "false");
  };
  const settle = (my, name, ok, state, text) => {
    if (my === seq) show(state, text);
    return { name, ok };
  };
  const check = () => {
    clearTimeout(timer);
    const name = input.value, my = seq;
    if (!name) last = Promise.resolve(settle(my, name, false, "bad", "Enter an address."));
    else if (!NAME_RE.test(name) || name.includes("--")) {
      last = Promise.resolve(settle(my, name, false, "bad", "Use lowercase letters, numbers and single dashes, not at the start or end."));
    } else {
      show("", "Checking…");
      last = api(`/v1/names/${encodeURIComponent(name)}`).then(
        (r) => r.available
          ? settle(my, name, true, "ok", `${name} is available`)
          : settle(my, name, false, "bad", r.reason === "taken" ? `${name} is taken. Try another.` : r.message ?? "Not a valid address."),
        (e) => ({ ...settle(my, name, false, "bad", `Couldn't check this address: ${e.message}`), retry: true }),
      );
    }
    return last;
  };
  input.addEventListener("input", () => {
    // Lowercase as you type (subdomains are), keeping the caret where it was.
    const lower = input.value.toLowerCase().replace(/[\s_]/g, "-");
    if (lower !== input.value) {
      const at = input.selectionStart;
      input.value = lower;
      input.setSelectionRange(at, at);
    }
    seq++;
    last = null;
    show("", "");
    clearTimeout(timer);
    timer = setTimeout(check, 300);
  });
  return {
    /** Fills in a fresh generated address (free when suggested). Typing meanwhile wins. */
    suggest() {
      const my = ++seq;
      clearTimeout(timer);
      show("", "Picking an address…");
      last = api(`/v1/names?kind=${kind}`).then(
        ({ name }) => {
          if (my !== seq) return { name, ok: false };
          input.value = name;
          return settle(my, name, true, "ok", `${name} is available`);
        },
        (e) => settle(my, "", false, "bad", `Couldn't pick an address: ${e.message}`),
      );
      return last;
    },
    /** The address once it's checked and free, else null (the field says why). */
    async value() {
      let r = last && (await last);
      if (!r || r.retry || r.name !== input.value) r = await check();
      return r.ok && r.name === input.value ? r.name : null;
    },
  };
}
// What sharing an app lets each role do (the Share page swaps in an artifact's).
const INVITE_VIEWER_APP = $("invite-role").options[0].textContent;
let inviteAdminApp = $("invite-role-admin").textContent;
// Custom domains off on this server (CRESSLET_CUSTOM_DOMAINS=false): don't offer them in the role descriptions.
meta.then((m) => {
  if (m.customDomains !== false) return;
  inviteAdminApp = inviteAdminApp.replace(/,? domains\b/, "");
  for (const id of ["token-role-admin", "invite-role-admin"]) {
    const o = $(id);
    o.textContent = o.textContent.replace(/,? domains\b/, "");
  }
});

// Projects (home, recent, workspace) need a session when this server offers login; without login set up the studio
// stays usable logged out (local dev, self-hosts without GitHub OAuth).
const loginRequired = meta.then((m) => !!m.auth?.github);
const mustLogIn = async () => !auth.token && await loginRequired;
/** Back to the landing page; `after`: where to return once logged in. */
function toLanding(after) {
  try {
    if (after) sessionStorage.setItem("cresslet.afterLogin", after);
  } catch { /* storage blocked: login lands on the home page */ }
  location.hash = "#/";
}

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
  meta.then((m) => ($("admin-credits-item").hidden = !m.ai?.credits));
  renderAccount();
  loadMyOrgs();
}

function logOut() {
  auth.token = null;
  myAccountId = null;
  auth.email = null;
  $("admin-item").hidden = true;
  $("nav-orgs-item").hidden = true;
  myOrgs = [];
  renderAccount();
  if (!$("cli-login").hidden) route(); // its Authorize button needs the session
  // Projects need the session: leave them for the landing page.
  loginRequired.then((req) => {
    if (!req || auth.token) return;
    if (booted) location.hash = "#/";
    else if (!$("home").hidden) renderHome();
  });
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
        if (after?.startsWith("#/view/") || after?.startsWith("#/p/") || after === "#/cli" || after === "#/artifacts") {
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
  for (const m of ["landing", "home", "pages", "settings", "share", "view", "cli-login", "admin", "site", "workspace"]) $(m).hidden = m !== id;
  $("app").dataset.view = id;
  $("topbar").hidden = id !== "workspace";
  $("site-nav").hidden = id !== "landing";
  $("project-title").hidden = true;
  $("deploy-btn").hidden = true;
  $("deploy-link").hidden = true;
  $("view-switch").hidden = true;
  $("drawer-btn").hidden = true;
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
  const list = await mustLogIn() ? [] : (await projects.list().catch(() => [])).slice(0, 6);
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
  renderCredits();
  renderPageDefaults();
  api("/v1/apps").then(({ apps }) => {
    $("token-apps").replaceChildren(...(apps.length ? apps.map((a) =>
      el("label", { className: "check" }, el("input", { type: "checkbox", value: a.name }), el("span", { textContent: a.name }))
    ) : [el("p", { className: "muted small", textContent: "No apps yet." })]));
  }, () => {});
}

const when = (iso) => iso ? new Date(iso).toLocaleString() : "never";

// AI credits (when the server offers them): what's left, this month's free credits, and recent use.
async function renderCredits() {
  const on = !!(await meta).ai?.credits;
  $("credits-section").hidden = !on;
  if (!on) return;
  let r;
  try {
    r = await api("/v1/me/credits");
  } catch (e) {
    $("credits-history").replaceChildren(el("li", { className: "list-row error", textContent: `Could not load AI credits: ${e.message}` }));
    return;
  }
  if (!r.enabled) return void ($("credits-section").hidden = true);
  const num = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const tokens = new Intl.NumberFormat();
  const amount = (x) => `${num.format(x)} ${num.format(x) === "1" ? "credit" : "credits"}`;
  $("credits-available").textContent = amount(Math.max(0, r.available));
  $("credits-monthly").textContent = r.monthly.allowance
    ? `${num.format(r.monthly.remaining)} of ${num.format(r.monthly.allowance)} left, renews ${new Date(r.monthly.resetsAt).toLocaleDateString()}`
    : "None on this server";
  $("credits-balance").textContent = `${amount(r.balance)}${r.balance < 0 ? " (the last request went over)" : ""}`;
  if (!r.history.length) {
    $("credits-history").replaceChildren(el("li", { className: "list-row muted", textContent: "No AI credits used yet." }));
    return;
  }
  $("credits-history").replaceChildren(...r.history.map((h) =>
    el("li", { className: "list-row" },
      el("div", { className: "tok" },
        el("strong", { textContent: h.kind === "usage" ? `AI builder (${h.model ?? "Claude"})` : h.credits > 0 ? "Credits added" : "Credits removed" }),
        el("span", {
          className: "meta",
          textContent: h.kind === "usage"
            ? `${tokens.format(h.inputTokens + h.cacheReadTokens + h.cacheWriteTokens)} tokens in, ${tokens.format(h.outputTokens)} out${h.estimated ? " (estimated: the reply was cut off)" : ""}`
            : h.note ?? "by the operator",
        })),
      el("span", { className: "meta", textContent: when(h.at) }),
      el("span", { className: "credit-delta", textContent: `${h.credits > 0 ? "+" : "−"}${num.format(Math.abs(h.credits))}` }))));
}

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

/** Resolves true if this render is still the current view (no later route or admin render), so callers may move focus.
 *  `credits`: the AI credits pages (`name`: an account id); `section` "users" or "orgs": those pages; else the
 *  sites pages (`name`: a site). */
async function renderAdmin(name, { credits = false, section = credits ? "credits" : "sites" } = {}) {
  if (!auth.token) {
    location.hash = "#/";
    return false;
  }
  const TITLES = { credits: "AI credits", users: "Users", orgs: "Organizations" };
  $("admin-title").replaceChildren(TITLES[section] ?? (name || "Sites")); // before showOnly() focuses it
  $("admin-sub").textContent = "";
  showOnly("admin");
  navCurrent(section === "sites" ? "admin" : `admin-${section}`);
  const gen = ++adminView.gen, route = routeGen;
  const current = () => gen === adminView.gen && route === routeGen;
  $("admin-actions").replaceChildren();
  $("admin-body").replaceChildren(el("p", { className: "muted", textContent: "Loading…" }));
  try {
    if (credits) await (name ? renderAdminCreditsAccount(name) : renderAdminCredits());
    else if (section === "users") await renderAdminUsers();
    else if (section === "orgs") await renderAdminOrgs();
    else if (name) await renderAdminSite(name);
    else await renderAdminSites();
  } catch (e) {
    if (!current()) return false;
    if (TITLES[section]) $("admin-title").replaceChildren(TITLES[section]);
    $("admin-body").replaceChildren(el("p", { className: "error", textContent: e.status === 403 ? "Only site admins can see this page." : `Could not load: ${e.message}` }));
    if (e.status !== 403) {
      const retry = el("button", { className: "btn", type: "button", onclick: () => renderAdmin(name, { credits, section }).then((ok) => ok && refocus(name ? null : $("admin-actions").querySelector("button"))) }, icon("refresh"), "Retry");
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
  const deploys = el("div", { className: "panel" }, el("h2", { textContent: "Deploys" }),
    tableOf(["Deploy", "Size", "When"], d.deploys.map((x) => [
      el("span", {}, el("span", { className: "mono", textContent: x.id }), x.current ? el("span", { className: "badge", textContent: "live" }) : null),
      fmtBytes(x.bytes),
      ago(x.createdAt),
    ]), "No deploys."));

  $("admin-body").replaceChildren(banner, stats,
    el("div", { className: "detail-grid" }, info, el("div", { className: "stack" }, deploys)));
}

// ------------------------------------------------------------------ app dashboard (#/apps/<name>[/<tab>[/<table>]])
// One deployed app: status, requests, storage, deploys (with rollback), its database, secrets and logs.
// Viewers see it all read only; the owner and admins can roll back and change secrets.
const SITE_TABS = [["", "Overview", "server"], ["database", "Database", "database"], ["secrets", "Secrets", "key"], ["logs", "Logs", "terminal"]];
/** `stop`: ends the open logs stream (set by the Logs tab, called on every route). */
const appDash = { gen: 0, stop: null, page: {} };
const siteHref = (name, ...rest) => `#/apps/${[name, ...rest].map(encodeURIComponent).join("/")}`;
const appPath = (name, rest = "") => `/v1/apps/${encodeURIComponent(name)}${rest}`;
const canManage = (access) => access === "owner" || access === "admin";
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Resolves true if this render is still current (no later route or re-render), so callers may move focus. */
async function renderSite(name, tab = "", arg = "") {
  if (!auth.token) {
    location.hash = "#/";
    return false;
  }
  const gen = ++appDash.gen, route = routeGen;
  const current = () => gen === appDash.gen && route === routeGen;
  $("site-title").replaceChildren(el("a", { href: "#/", textContent: "Projects" }), " / ", name);
  $("site-sub").textContent = "";
  $("site-actions").replaceChildren();
  $("site-tabs").replaceChildren(...SITE_TABS.map(([k, label, ico]) => {
    const a = el("a", { className: "site-tab", href: k ? siteHref(name, k) : siteHref(name) }, icon(ico), label);
    if (k === tab) a.setAttribute("aria-current", "page");
    return a;
  }));
  $("site-body").replaceChildren(el("p", { className: "muted", textContent: "Loading…" }));
  document.title = `${name} · Cresslet Studio`;
  showOnly("site");
  try {
    const d = await api(appPath(name));
    if (!current()) return false;
    const a = d.app;
    $("site-sub").textContent = [ACCESS_LABEL[a.access] ? `You're ${a.access === "owner" ? (a.org ? "an owner" : "the owner") : `${a.access === "admin" ? "an" : "a"} ${a.access}`}` : null,
      a.org ? `In ${a.org.title ?? a.org.name}` : null,
      a.config?.server ? "Server app" : "Static site", a.claimed ? null : `Unclaimed${a.expiresAt ? `, expires ${ago(a.expiresAt)}` : ""}`].filter(Boolean).join(" · ");
    const refresh = el("button", {
      className: "btn", type: "button", title: "Refresh",
      onclick: () => renderSite(name, tab, arg).then((ok) => ok && refocus($("site-actions").querySelector("button"))),
    }, icon("refresh"), srOnly("Refresh"));
    $("site-actions").replaceChildren(
      extLink(a.url, "Visit", "btn"),
      el("button", { className: "btn", type: "button", title: "Open the deployed source as a new project", onclick: () => openDeployed(a) }, icon("download"), "Open source"),
      canManage(a.access) ? el("a", { className: "btn", href: `#/share/${encodeURIComponent(name)}` }, icon("users"), "Share") : null,
      refresh);
    if (tab === "database") await siteDatabase(name, arg, current);
    else if (tab === "secrets") siteSecrets(name, d, current);
    else if (tab === "logs") siteLogs(name, current);
    else await siteOverview(name, d, current);
  } catch (e) {
    if (!current()) return false;
    $("site-body").replaceChildren(el("p", {
      className: "error",
      textContent: e.status === 404 || e.status === 403 ? `There's no app named ${name} that you can see.` : `Could not load: ${e.message}`,
    }));
    if (e.status !== 404 && e.status !== 403) {
      const retry = el("button", { className: "btn", type: "button", onclick: () => renderSite(name, tab, arg).then((ok) => ok && refocus($("site-actions").querySelector("button"))) }, icon("refresh"), "Retry");
      $("site-actions").replaceChildren(retry);
      refocus(retry);
    }
  }
  return current();
}

/** Requests per hour over the last 24 hours (the 5-minute buckets summed), errors shown at the foot of each bar. */
function requestChart(series, bucketMs) {
  const per = Math.max(1, Math.round(3_600_000 / bucketMs));
  const hours = [];
  for (let i = 0; i < series.length; i += per) {
    const part = series.slice(i, i + per);
    hours.push({ t: part[0].t, requests: part.reduce((n, b) => n + b.requests, 0), errors: part.reduce((n, b) => n + b.errors, 0) });
  }
  const max = Math.max(...hours.map((h) => h.requests));
  const total = hours.reduce((n, h) => n + h.requests, 0), errors = hours.reduce((n, h) => n + h.errors, 0);
  const fmt = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const peak = hours.reduce((a, h) => (h.requests > a.requests ? h : a), hours[0]);
  const label = max
    ? `Requests per hour over the last 24 hours: ${plural(total, "request")}, ${plural(errors, "server error")}; busiest hour from ${fmt(peak.t)} (${peak.requests.toLocaleString()})`
    : "No requests in the last 24 hours";
  return el("div", {},
    el("div", { className: "day-chart req-chart", role: "img", ariaLabel: label },
      ...hours.map((h) => {
        const b = el("span", { title: `${fmt(h.t)}: ${plural(h.requests, "request")}${h.errors ? `, ${plural(h.errors, "server error")}` : ""}` });
        b.style.height = max ? `${Math.max(h.requests ? 3 : 0, (h.requests / max) * 100)}%` : "0";
        if (h.errors) {
          const e = el("i", { className: "err" });
          e.style.height = `${Math.max(8, (h.errors / h.requests) * 100)}%`;
          b.append(e);
        }
        return b;
      })),
    el("div", { className: "day-axis", ariaHidden: "true" },
      el("span", { textContent: "24 hours ago" }), el("span", { textContent: max ? `peak ${peak.requests.toLocaleString()}/h` : "" }), el("span", { textContent: "Now" })));
}

const kvList = (pairs) => el("dl", { className: "kv" }, ...pairs.filter(Boolean).flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", {}, v)]));

async function siteOverview(name, d, current) {
  const m = await api(appPath(name, "/metrics"));
  if (!current()) return;
  const a = d.app, rt = d.runtime, dep = d.deploys.find((x) => x.current);
  const status = rt.running ? "running" : a.currentDeployId ? "idle" : "empty";
  const manage = canManage(a.access);
  const db = m.database;
  const rows = db.tables.reduce((n, t) => n + t.rows, 0);

  const banner = dep
    ? el("div", { className: "banner" }, statusPill("live", "Live"),
      el("span", {}, el("span", { className: "mono", textContent: dep.id }), ` deployed ${ago(dep.createdAt)} via ${dep.source}`))
    : el("div", { className: "banner" }, "Nothing deployed yet.");

  const t = m.totals;
  const stats = el("div", { className: "stats" },
    stat("Status", [STATUS[status]], rt.running ? `pid ${rt.pid}` : a.config?.server ? "Starts on the next request" : "Static site",
      el("i", { className: "dot", ariaHidden: "true", dataset: { s: status } })),
    stat("Requests", [t.requests.toLocaleString(), el("small", { textContent: "24h" })],
      `${plural(t.errors, "server error")} · ${t.requests ? Math.round((t.errors / t.requests) * 1000) / 10 : 0}% · ${t.clientErrors.toLocaleString()} 4xx`),
    stat("Response time", [t.avgMs === null ? "—" : `${t.avgMs.toLocaleString()} ms`],
      t.maxMs === null ? (a.config?.server ? "No server requests yet" : "Static files only") : `Average · slowest ${t.maxMs.toLocaleString()} ms`),
    stat("Storage", [fmtBytes(m.usage.total)],
      db.error ? "Database couldn't be read" : db.tables.length ? `Database ${fmtBytes(m.usage.database)} · ${plural(db.tables.length, "table")}` : "No database yet"));

  const sinceRestart = Date.now() - new Date(m.since) < 86_400_000;
  const traffic = el("div", { className: "panel" },
    el("div", { className: "panel-head" }, el("h2", { textContent: "Requests" }),
      el("span", { className: "muted small", textContent: sinceRestart ? `Counted since the server started ${ago(m.since)}` : "Last 24 hours" })),
    requestChart(m.series, m.bucketMs));

  const domains = m.domains.filter((x) => x.verified);
  const info = el("div", { className: "panel" }, el("h2", { textContent: "Overview" }), kvList([
    ["URL", extLink(a.url, a.url.replace(/^https?:\/\//, ""))],
    ["Domains", domains.length ? el("span", {}, ...domains.flatMap((x, i) => [i ? ", " : null, extLink(`https://${x.domain}`, x.domain)])) : "—"],
    ["Server", a.config?.server ? `Yes${a.config.crons?.length ? ` · ${plural(a.config.crons.length, "cron")}` : ""}` : "Static only"],
    ["Secrets", el("a", { href: siteHref(name, "secrets"), textContent: d.secrets.length ? plural(d.secrets.length, "secret") : "None" })],
    ["Egress", a.egress === null ? "Any public host" : a.egress.length ? a.egress.join(", ") : "None"],
    a.expiresAt ? ["Expires", ago(a.expiresAt)] : null,
    ["Created", new Date(a.createdAt).toLocaleString()],
    ["App ID", el("span", { className: "mono", textContent: a.id })],
  ]), el("h2", { className: "mt", textContent: "Storage" }), usageBar(m.usage));

  const tablesPanel = el("div", { className: "panel" },
    el("div", { className: "panel-head" }, el("h2", { textContent: "Database tables" }),
      db.tables.length ? el("a", { className: "small", href: siteHref(name, "database"), textContent: "Explore" }) : null),
    db.error ? el("p", { className: "error small", textContent: db.error })
      : db.tables.length
      ? el("div", { className: "scroll-x", tabIndex: 0, role: "region", ariaLabel: "Database tables" }, el("table", { className: "table" },
        el("thead", {}, el("tr", {}, el("th", { scope: "col", textContent: "Table" }), el("th", { scope: "col", className: "num", textContent: "Rows" }))),
        el("tbody", {}, ...db.tables.map((x) => el("tr", {},
          el("td", {}, el("a", { className: "mono", href: siteHref(name, "database", x.name), textContent: x.name })),
          el("td", { className: "num", textContent: x.rows.toLocaleString() })))),
        el("tfoot", {}, el("tr", {}, el("td", { className: "muted", textContent: "Total" }), el("td", { className: "num muted", textContent: rows.toLocaleString() })))))
      : el("p", { className: "muted small", textContent: a.config?.server ? "No database yet: it's made the first time the server uses env.db." : "Static sites have no database." }));

  const deploys = el("div", { className: "panel" },
    el("div", { className: "panel-head" }, el("h2", { id: "deploys-title", textContent: "Deploys" }),
      el("span", { className: "muted small", textContent: `${plural(d.deploys.length, "deploy")} kept` })),
    d.deploys.length
      ? el("div", { className: "scroll-x", tabIndex: 0, role: "region", ariaLabel: "Deploys" }, el("table", { className: "table" },
        el("thead", {}, el("tr", {}, ...["Deploy", "Actions"].map((h, i) =>
          el("th", { scope: "col", className: i ? "actions" : "" }, i ? srOnly(h) : h)))),
        el("tbody", {}, ...d.deploys.map((x) => el("tr", {},
          el("td", {}, el("span", { className: "mono", textContent: x.id }),
            x.current ? el("span", { className: "badge", textContent: "live" }) : null,
            el("span", { className: "sub" }, timeAgo(x.createdAt), ` · ${fmtBytes(x.bytes)} · ${plural(x.files, "file")} · via ${x.source}`)),
          el("td", { className: "actions" }, manage && !x.current
            ? el("button", { className: "btn sm", type: "button", id: `rollback-${x.id}`, ariaLabel: `Roll back to ${x.id}`, onclick: (e) => rollback(name, x, e.currentTarget) }, "Roll back")
            : null))))))
      : el("p", { className: "muted small", textContent: "No deploys." }));

  $("site-body").replaceChildren(banner, stats, traffic,
    el("div", { className: "detail-grid mt" }, info, el("div", { className: "stack" }, tablesPanel, deploys)));
}

async function rollback(name, dep, btn) {
  if (!confirm(`Roll ${name} back to ${dep.id} (deployed ${ago(dep.createdAt)})?\n\nIt serves that deploy's files and server from the next request. Its database, files and secrets stay as they are.`)) return;
  const gen = routeGen;
  btn.disabled = true;
  try {
    await api(appPath(name, "/rollback"), { method: "POST", body: JSON.stringify({ deployId: dep.id }) });
    toast(`${name} rolled back to ${dep.id}`);
    if (gen === routeGen) renderSite(name).then((ok) => ok && refocus($("deploys-title")));
  } catch (e) {
    toast(`Could not roll back: ${e.message}`);
    if (gen === routeGen && btn.isConnected) {
      btn.disabled = false;
      btn.focus();
    }
  }
}

// ---- database explorer
const DB_PAGE = 50;
const quoteIdent = (n) => `"${n.replace(/"/g, '""')}"`;

/** A cell's value: NULL, a blob's size, or the text (long text cut, the whole value in its title). */
function cellValue(v) {
  if (v === null || v === undefined) return el("span", { className: "null", textContent: "NULL" });
  if (typeof v === "object" && typeof v.$bytes === "string") {
    return el("span", { className: "null", textContent: `BLOB ${fmtBytes(Math.floor((v.$bytes.length * 3) / 4) - (v.$bytes.match(/=*$/)[0].length))}` });
  }
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 120 ? el("span", { title: s.slice(0, 4000), textContent: `${s.slice(0, 120)}…` }) : s;
}

function resultTable(rows, label, columns = null) {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  if (!cols.length) return el("p", { className: "muted small", textContent: "No rows." });
  return el("div", { className: "table-wrap result", tabIndex: 0, role: "region", ariaLabel: label },
    el("table", { className: "table data" },
      el("thead", {}, el("tr", {}, ...cols.map((c) => el("th", { scope: "col", textContent: typeof c === "string" ? c : c.name, className: /INT|REAL|FLOA|DOUB|NUM|DEC/i.test(c.type ?? "") ? "num" : "" },
        typeof c === "object" && (c.pk || c.type) ? el("span", { className: "col-type", textContent: [c.pk ? "PK" : null, c.type].filter(Boolean).join(" ") }) : null)))),
      el("tbody", {}, ...(rows.length
        ? rows.map((r) => el("tr", {}, ...cols.map((c) => {
          const v = r[typeof c === "string" ? c : c.name];
          return el("td", { className: typeof v === "number" ? "num" : "" }, cellValue(v));
        })))
        : [el("tr", {}, el("td", { colSpan: cols.length, className: "empty", textContent: "No rows." }))]))));
}

async function siteDatabase(name, table, current) {
  const db = await api(appPath(name, "/db?limit=0"));
  if (!current()) return;
  const tables = Object.entries(db.tables).map(([n, t]) => ({ name: n, ...t }));
  if (!tables.length) {
    $("site-body").replaceChildren(emptyState("No database yet", "It's made the first time the app's server uses env.db."));
    return;
  }
  const sel = tables.find((t) => t.name === table) ?? tables[0];
  const list = el("nav", { className: "db-tables panel", ariaLabel: "Tables" },
    el("h2", { textContent: "Tables" }),
    el("ul", {}, ...tables.map((t) => {
      const a = el("a", { href: siteHref(name, "database", t.name) }, el("span", { className: "mono", textContent: t.name }), el("span", { className: "muted", textContent: t.count.toLocaleString() }));
      if (t === sel) a.setAttribute("aria-current", "page");
      return el("li", {}, a);
    })),
    db.truncated ? el("p", { className: "muted small", textContent: "Some tables aren't listed (too many)." }) : null);

  // Browse: the selected table, a page at a time.
  const key = `${name}\n${sel.name}`;
  const grid = el("div", {}, el("p", { className: "muted small", textContent: "Loading rows…" }));
  const pagerStatus = el("span", { className: "muted small", role: "status" });
  const pager = el("div", { className: "row start pager" }, pagerStatus);
  let columns = null;
  async function page(offset, moved = false) {
    appDash.page[key] = offset;
    const gen = appDash.gen;
    try {
      const [cols, r] = await Promise.all([
        columns ?? api(appPath(name, "/db/query"), { method: "POST", body: JSON.stringify({ sql: "SELECT name, type, pk FROM pragma_table_info(?) ORDER BY cid", params: [sel.name] }) }).then((x) => x.rows),
        api(appPath(name, "/db/query"), { method: "POST", body: JSON.stringify({ sql: `SELECT * FROM ${quoteIdent(sel.name)} LIMIT ? OFFSET ?`, params: [DB_PAGE, offset] }) }),
      ]);
      if (gen !== appDash.gen || !grid.isConnected) return;
      columns = cols;
      grid.replaceChildren(resultTable(r.rows, `${sel.name} rows`, columns.length ? columns : null));
      const last = Math.min(offset + r.rows.length, sel.count);
      const prev = el("button", { className: "btn sm", type: "button", id: "db-prev", disabled: offset === 0, onclick: () => page(Math.max(0, offset - DB_PAGE), true) }, "Previous");
      const next = el("button", { className: "btn sm", type: "button", id: "db-next", disabled: offset + DB_PAGE >= sel.count, onclick: () => page(offset + DB_PAGE, true) }, "Next");
      pagerStatus.textContent = sel.count ? `Rows ${(offset + 1).toLocaleString()}–${last.toLocaleString()} of ${sel.count.toLocaleString()}` : "No rows";
      pager.replaceChildren(pagerStatus, prev, next);
      if (moved) refocus();
    } catch (e) {
      if (gen === appDash.gen && grid.isConnected) grid.replaceChildren(el("p", { className: "error small", textContent: `Could not read ${sel.name}: ${e.message}` }));
    }
  }
  const browse = el("div", { className: "panel" },
    el("div", { className: "panel-head" },
      el("h2", { className: "mono", textContent: sel.name }),
      el("span", { className: "muted small", textContent: plural(sel.count, "row") })),
    sel.schema ? el("details", { className: "schema" }, el("summary", { textContent: "Schema" }), el("pre", { className: "mono", textContent: sel.schema })) : null,
    grid, pager);

  // Query: any read-only SQL.
  const sql = el("textarea", {
    className: "input mono sql", id: "db-sql", rows: 4, spellcheck: false, ariaLabel: "SQL",
    value: `SELECT * FROM ${quoteIdent(sel.name)} LIMIT 100`,
  });
  const out = el("div", { className: "query-out", role: "status" });
  const run = el("button", { className: "btn primary", type: "submit" }, icon("zap"), "Run");
  const form = el("form", {
    className: "query",
    onsubmit: async (e) => {
      e.preventDefault();
      if (!sql.value.trim()) return;
      const gen = appDash.gen, started = performance.now();
      run.disabled = true;
      out.replaceChildren(el("p", { className: "muted small", textContent: "Running…" }));
      try {
        const r = await api(appPath(name, "/db/query"), { method: "POST", body: JSON.stringify({ sql: sql.value }) });
        if (gen !== appDash.gen) return;
        out.replaceChildren(
          el("p", { className: "muted small", textContent: `${plural(r.rows.length, "row")}${r.truncated ? " (cut off: at most 1,000 rows or 4 MB)" : ""} in ${Math.round(performance.now() - started)} ms` }),
          r.rows.length ? resultTable(r.rows, "Query result") : null);
      } catch (err) {
        if (gen === appDash.gen) out.replaceChildren(el("p", { className: "error small", textContent: err.message }));
      } finally {
        run.disabled = false;
      }
    },
  },
  sql,
  el("div", { className: "row start" }, run, el("span", { className: "muted small", textContent: "Read only · ⌘/Ctrl + Enter runs it · at most 1,000 rows, 5 seconds" })));
  sql.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  const query = el("div", { className: "panel" }, el("h2", { textContent: "Query" }), form, out);

  $("site-body").replaceChildren(el("div", { className: "db-grid" }, list, el("div", { className: "stack" }, browse, query)));
  await page(appDash.page[key] ?? 0);
}

// ---- secrets (values are write-only: they can be replaced, never read back)
const SECRET_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const labelled = (node, id) => (node.setAttribute("aria-labelledby", id), node);

function siteSecrets(name, d) {
  const a = d.app, manage = canManage(a.access) && a.claimed;
  let keys = d.secrets;
  const tbody = el("tbody");
  const status = el("p", { className: "sr-only", role: "status" });
  const keyIn = el("input", { className: "input mono", id: "secret-key", name: "key", required: true, autocomplete: "off", spellcheck: false, placeholder: "STRIPE_KEY", maxLength: 64 });
  const valIn = el("textarea", { className: "input mono", id: "secret-value", name: "value", rows: 2, autocomplete: "off", spellcheck: false, placeholder: "Value", maxLength: 32768 });
  const save = el("button", { className: "btn primary", type: "submit" }, "Add secret");
  const err = el("p", { className: "error small", role: "alert" });
  const formTitle = el("h2", { id: "secret-form-title", textContent: "Add a secret" });
  const setMode = () => {
    const k = keyIn.value.trim().toUpperCase();
    const exists = keys.includes(k);
    save.textContent = exists ? "Replace value" : "Add secret";
    formTitle.textContent = exists ? `Replace ${k}` : "Add a secret";
  };
  keyIn.addEventListener("input", () => {
    err.textContent = "";
    setMode();
  });

  async function put(body, msg) {
    const r = await api(appPath(name, "/secrets"), { method: "PUT", body: JSON.stringify(body) });
    keys = r.keys;
    draw();
    status.textContent = msg;
    toast(msg);
  }

  function draw() {
    tbody.replaceChildren(...(keys.length ? keys.map((k) => el("tr", {},
      el("td", {}, el("span", { className: "mono", textContent: k })),
      el("td", { className: "muted mono", ariaHidden: "true", textContent: "••••••••" }),
      el("td", { className: "actions" }, ...(manage ? [
        el("button", { className: "btn sm", type: "button", id: `replace-${k}`, ariaLabel: `Replace ${k}`, onclick: () => {
          keyIn.value = k;
          valIn.value = "";
          setMode();
          valIn.focus();
        } }, "Replace"),
        el("button", { className: "btn sm danger", type: "button", id: `delete-${k}`, ariaLabel: `Delete ${k}`, onclick: async (e) => {
          if (!confirm(`Delete secret ${k} from ${name}? The app restarts without it.`)) return;
          const b = e.currentTarget;
          b.disabled = true;
          try {
            await api(appPath(name, `/secrets/${encodeURIComponent(k)}`), { method: "DELETE" });
            keys = keys.filter((x) => x !== k);
            draw();
            setMode();
            status.textContent = `${k} deleted`;
            toast(`${k} deleted`);
            refocus($("secrets-title"));
          } catch (e2) {
            b.disabled = false;
            toast(`Could not delete ${k}: ${e2.message}`);
          }
        } }, icon("trash"), "Delete"),
      ] : []))))
      : [el("tr", {}, el("td", { colSpan: 3, className: "empty", textContent: "No secrets yet." }))]));
  }
  draw();

  const form = manage && el("form", {
    className: "panel secret-form",
    onsubmit: async (e) => {
      e.preventDefault();
      const k = keyIn.value.trim().toUpperCase();
      if (!SECRET_RE.test(k)) {
        err.textContent = "Use UPPER_SNAKE_CASE: letters, digits and underscores, starting with a letter or underscore (at most 64).";
        keyIn.focus();
        return;
      }
      const replacing = keys.includes(k);
      save.disabled = true;
      try {
        await put({ [k]: valIn.value }, replacing ? `${k} replaced` : `${k} added`);
        keyIn.value = valIn.value = "";
        setMode();
        keyIn.focus();
      } catch (e2) {
        err.textContent = `Could not save: ${e2.message}`;
      } finally {
        save.disabled = false;
      }
    },
  },
  formTitle,
  el("div", { className: "field" }, el("label", { htmlFor: "secret-key", textContent: "Name" }), keyIn),
  el("div", { className: "field" }, el("label", { htmlFor: "secret-value", textContent: "Value" }), valIn),
  err,
  el("div", { className: "row start" }, save, el("span", { className: "muted small", textContent: "Saving restarts the app with the new value." })));

  const note = !a.claimed
    ? el("p", { className: "muted small", textContent: "Secrets need a claimed app: run cresslet claim, or deploy it while logged in." })
    : !canManage(a.access) ? el("p", { className: "muted small", textContent: "Only the owner and admins can change secrets." }) : null;

  $("site-body").replaceChildren(...[
    el("p", { className: "muted lead" }, "Your server reads these with ", el("code", { textContent: 'secrets.get("NAME")' }),
      " (import { secrets } from \"cresslet\"). Values are write-only: you can replace or delete one, never read it back."),
    note,
    el("div", { className: manage ? "detail-grid" : "" },
      el("div", { className: "panel" },
        el("h2", { id: "secrets-title", tabIndex: -1, textContent: "Secrets" }),
        el("div", { className: "scroll-x" }, labelled(el("table", { className: "table" },
          el("thead", {}, el("tr", {}, el("th", { scope: "col", textContent: "Name" }), el("th", { scope: "col", textContent: "Value" }), el("th", { scope: "col", className: "actions" }, srOnly("Actions")))),
          tbody), "secrets-title"))),
      form ? labelled(form, "secret-form-title") : null),
    status].filter(Boolean));
}

// ---- logs: the last 200 lines, then live
function siteLogs(name, current) {
  const list = el("ol", { className: "log-lines mono", ariaLabel: "Log lines", tabIndex: 0 });
  const state = el("span", { className: "muted small", role: "status", textContent: "Connecting…" });
  const kinds = { all: "All", request: "Requests", app: "App output", system: "System" };
  let filter = "all";
  const seg = el("div", { className: "seg", role: "group", ariaLabel: "Show" },
    ...Object.entries(kinds).map(([k, l]) => el("button", { type: "button", textContent: l, dataset: { k }, onclick: () => {
      filter = k;
      for (const b of seg.children) b.setAttribute("aria-pressed", String(b.dataset.k === k));
      list.dataset.filter = k;
    } })));
  for (const b of seg.children) b.setAttribute("aria-pressed", String(b.dataset.k === filter));
  list.dataset.filter = filter;
  const clear = el("button", { className: "btn sm", type: "button", onclick: () => list.replaceChildren() }, "Clear");
  $("site-body").replaceChildren(el("div", { className: "toolbar flush" }, seg, clear, state), el("div", { className: "panel log-panel" }, list));

  const ctrl = new AbortController();
  appDash.stop = () => ctrl.abort();
  const add = (l) => {
    const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const kind = l.kind === "stdout" || l.kind === "stderr" ? "app" : l.kind;
    list.append(el("li", { dataset: { kind, k: l.kind } },
      el("time", { dateTime: new Date(l.t).toISOString(), textContent: new Date(l.t).toLocaleTimeString() }),
      el("span", { className: "kind", textContent: l.kind }),
      el("span", { className: "msg", textContent: l.msg })));
    while (list.children.length > 1000) list.firstChild.remove();
    if (atEnd) list.scrollTop = list.scrollHeight;
  };
  (async () => {
    try {
      const res = await fetch(appPath(name, "/logs?n=200&follow=1"), { headers: { authorization: `Bearer ${auth.token}` }, signal: ctrl.signal });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? `${res.status}`);
      if (current()) state.textContent = "Live";
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line) add(JSON.parse(line));
        }
      }
      if (current()) state.textContent = "Disconnected";
    } catch (e) {
      if (!ctrl.signal.aborted && current()) state.textContent = `Disconnected: ${e.message}`;
    }
  })();
}

// ------------------------------------------------------------------ admin: users (#/admin-users)
const ACCOUNT_STATUS = { active: ["live", "Active"], invited: ["idle", "Invited"], disabled: ["deleted", "Disabled"] };
const adminUsersView = { filter: "all", q: "" };
const field = (label, input, hint) => el("div", { className: "field" },
  el("label", { htmlFor: input.id, textContent: label }), input, hint ? el("p", { className: "muted small", id: `${input.id}-hint`, textContent: hint }) : null);
const formError = () => el("p", { className: "error small", role: "alert", hidden: true });
const showError = (err, text) => {
  err.textContent = text;
  err.hidden = !text;
};

/** Thrown by a row action's `run` when its confirmation is declined: nothing to report. */
const CANCELLED = Symbol("cancelled");
/** Runs a row action: disables the button meanwhile, toasts the outcome, re-renders on success. */
async function rowAction(b, run, done, after) {
  const gen = routeGen;
  b.disabled = true;
  try {
    await run();
  } catch (e) {
    if (e !== CANCELLED) toast(e.message);
    if (gen === routeGen) {
      b.disabled = false;
      refocus(b.isConnected ? b : null);
    }
    return;
  }
  toast(done);
  if (gen === routeGen) after();
}

async function renderAdminUsers() {
  document.title = "Users · Admin · Cresslet Studio";
  $("admin-title").replaceChildren("Users");
  $("admin-sub").textContent = "Every account on this server";
  const gen = adminView.gen, route = routeGen;
  const [d, orgs] = await Promise.all([api("/v1/admin/accounts"), api("/v1/admin/orgs").then((r) => r.orgs, () => [])]);
  if (gen !== adminView.gen || route !== routeGen) return;
  const again = (focus) => renderAdmin("", { section: "users" }).then((ok) => ok && refocus(focus?.()));
  $("admin-actions").replaceChildren(el("button", { className: "btn", type: "button", onclick: () => again(() => $("admin-actions").querySelector("button")) }, icon("refresh"), "Refresh"));

  const t = d.totals;
  const stats = el("div", { className: "stats" },
    stat("Accounts", [String(t.accounts)], `${t.siteAdmins} site admin${t.siteAdmins === 1 ? "" : "s"}`),
    stat("Active", [String(t.active)], "Signed in at least once"),
    stat("Invited", [String(t.invited)], "Not signed in yet"),
    stat("Disabled", [String(t.disabled)], "Can't sign in; their sites keep serving"));

  // Invite: sets up the account; they sign in with GitHub using that email (no email is sent).
  const email = el("input", { className: "input", id: "invite-account-email", type: "email", required: true, maxLength: 254, autocomplete: "off", spellcheck: false, placeholder: "name@example.com" });
  email.setAttribute("aria-describedby", "invite-account-email-hint");
  const asAdmin = el("input", { type: "checkbox", id: "invite-account-admin" });
  const org = el("select", { className: "input", id: "invite-account-org" },
    el("option", { value: "", textContent: "None" }), ...orgs.map((o) => el("option", { value: o.name, textContent: o.title ? `${o.title} (${o.name})` : o.name })));
  const orgRole = el("select", { className: "input", id: "invite-account-org-role" },
    el("option", { value: "member", textContent: "Member" }), el("option", { value: "admin", textContent: "Admin" }));
  const orgRoleField = field("Organization role", orgRole);
  orgRoleField.hidden = true;
  org.addEventListener("change", () => (orgRoleField.hidden = !org.value));
  const err = formError();
  const submit = el("button", { className: "btn primary", type: "submit" }, icon("plus"), "Invite");
  const form = el("form", { className: "panel form grant-form", ariaLabel: "Invite someone" },
    el("h2", { textContent: "Invite someone" }),
    field("Email", email, `They sign in with GitHub, with this as one of their verified emails${d.openSignup ? "" : ", even though signup is closed"}. No email is sent: let them know.`),
    orgs.length ? field("Organization (optional)", org) : null,
    orgs.length ? orgRoleField : null,
    el("label", { className: "check" }, asAdmin, el("span", { textContent: "Site admin" })),
    err,
    el("div", { className: "row start" }, submit));
  form.addEventListener("input", () => showError(err, ""));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError(err, "");
    const gen = routeGen;
    submit.disabled = true;
    try {
      const r = await api("/v1/admin/accounts", {
        method: "POST",
        body: JSON.stringify({ email: email.value.trim(), siteAdmin: asAdmin.checked, ...(org.value ? { org: org.value, orgRole: orgRole.value } : {}) }),
      });
      toast(`Invited ${r.account.email}. They can sign in with GitHub now.`);
      if (gen === routeGen) again(() => $("invite-account-email"));
    } catch (x) {
      if (gen !== routeGen) return;
      if (!form.isConnected) return void toast(`Could not invite: ${x.message}`);
      showError(err, `Could not invite: ${x.message}`);
      submit.disabled = false;
      email.focus();
    }
  });

  const actions = (a) => {
    const btn = (label, aria, run, done, danger) => el("button", {
      className: `btn sm${danger ? " danger" : ""}`, type: "button", textContent: label, ariaLabel: `${aria} ${a.email}`,
      onclick: (e) => rowAction(e.currentTarget, run, done, () => again()),
    });
    const patch = (input) => () => api(`/v1/admin/accounts/${encodeURIComponent(a.id)}`, { method: "PATCH", body: JSON.stringify(input) });
    const me = a.id === myAccountId, out = [];
    if (a.status === "invited") {
      out.push(btn("Withdraw invite", "Withdraw the invite for", async () => {
        if (!confirm(`Withdraw the invite for ${a.email}? They won't be able to sign in.`)) throw CANCELLED;
        await api(`/v1/admin/accounts/${encodeURIComponent(a.id)}`, { method: "DELETE" });
      }, `Withdrew the invite for ${a.email}`, true));
    }
    if (!me && !a.siteAdminFromConfig) {
      out.push(a.siteAdmin
        ? btn("Remove admin", "Remove the site admin role from", patch({ siteAdmin: false }), `${a.email} is no longer a site admin`)
        : btn("Make admin", "Make site admin:", patch({ siteAdmin: true }), `${a.email} is now a site admin`));
      if (a.status === "disabled") out.push(btn("Enable", "Enable", patch({ disabled: false }), `${a.email} can sign in again`));
      else if (a.status === "active") {
        out.push(btn("Disable", "Disable", async () => {
          if (!confirm(`Disable ${a.email}? They're signed out everywhere and can't sign in or deploy. Their sites keep serving.`)) throw CANCELLED;
          await patch({ disabled: true })();
        }, `${a.email} is disabled`, true));
      }
    }
    return out;
  };

  const tbody = el("tbody");
  const counts = { all: t.accounts, active: t.active, invited: t.invited, disabled: t.disabled };
  const seg = el("div", { className: "seg", role: "group", ariaLabel: "Show" },
    ...[["all", "All"], ["active", "Active"], ["invited", "Invited"], ["disabled", "Disabled"]].map(([k, l]) =>
      el("button", { type: "button", textContent: `${l} ${counts[k]}`, dataset: { k }, onclick: () => { adminUsersView.filter = k; draw(); } })));
  const search = el("input", { type: "search", className: "input", placeholder: "Search accounts, organizations", ariaLabel: "Search accounts", value: adminUsersView.q, oninput: () => { adminUsersView.q = search.value; draw(); } });
  const shown = el("p", { className: "sr-only", role: "status" });
  function draw() {
    for (const b of seg.children) b.setAttribute("aria-pressed", String(b.dataset.k === adminUsersView.filter));
    const q = adminUsersView.q.trim().toLowerCase();
    const rows = d.accounts.filter((a) => (adminUsersView.filter === "all" || a.status === adminUsersView.filter) &&
      (!q || [a.email, a.github, ...a.orgs.map((o) => o.name)].some((v) => v?.toLowerCase().includes(q))));
    shown.textContent = `${rows.length} account${rows.length === 1 ? "" : "s"} shown`;
    tbody.replaceChildren(...(rows.length ? rows.map((a) => {
      const [s, label] = ACCOUNT_STATUS[a.status];
      return el("tr", { dataset: a.status === "disabled" ? { deleted: "" } : {} },
        el("td", {},
          el("span", { textContent: a.email }, a.id === myAccountId ? el("span", { className: "badge", textContent: "you" }) : null),
          el("span", { className: "sub", textContent: a.github ? `@${a.github}` : a.invitedBy ? `invited by ${ownerText(a.invitedBy)}` : "no GitHub login yet" })),
        el("td", {}, statusPill(s, label)),
        el("td", {}, a.siteAdmin ? el("span", { textContent: "Site admin" }, a.siteAdminFromConfig ? el("span", { className: "sub", textContent: "in the server's config" }) : null) : el("span", { className: "muted", textContent: "—" })),
        el("td", { className: "orgs" }, a.orgs.length
          ? el("span", {}, ...a.orgs.flatMap((o, i) => [i ? ", " : null, el("a", { href: `#/orgs/${encodeURIComponent(o.name)}`, textContent: o.name }), o.role === "admin" ? " (admin)" : null]))
          : el("span", { className: "muted", textContent: "—" })),
        el("td", { className: "num", textContent: String(a.apps) }),
        el("td", {}, a.lastActiveAt ? timeAgo(a.lastActiveAt) : el("span", { className: "muted", textContent: "never" })),
        el("td", { className: "actions multi" }, ...actions(a)));
    }) : [el("tr", {}, el("td", { colSpan: 7, className: "empty", textContent: q ? "No accounts match." : "No accounts here." }))]));
  }
  draw();

  $("admin-body").replaceChildren(stats,
    el("div", { className: "detail-grid" },
      el("div", { className: "stack" },
        el("div", { className: "panel" }, el("h2", { textContent: "How accounts work" }),
          el("p", { className: "muted small", textContent: `Everyone signs in with GitHub. ${d.openSignup ? "Signup is open: anyone can create an account." : "Signup is closed: only invited people (and accounts that already exist) can sign in."} Disabling an account signs it out everywhere and blocks its login, tokens and deploys; its sites keep serving until you delete them on the Sites page.` }))),
      form),
    el("div", { className: "toolbar" }, el("h2", { className: "toolbar-title", textContent: "Accounts" }),
      el("div", { className: "search" }, icon("search"), search), seg, shown),
    el("div", { className: "table-wrap", tabIndex: 0, role: "region", ariaLabel: "Accounts table" },
      el("table", { className: "table" },
        el("caption", { className: "sr-only", textContent: "Accounts, oldest first" }),
        el("thead", {}, el("tr", {}, ...["Account", "Status", "Role", "Organizations", "Apps", "Last active", "Actions"].map((h, i) =>
          el("th", { scope: "col", className: i === 4 ? "num" : "" }, i === 6 ? srOnly(h) : h)))),
        tbody)),
    el("p", { className: "muted small", textContent: "Apps: apps and artifacts the account owns personally. Last active: the last time one of its tokens was used." }));
}

// ------------------------------------------------------------------ admin: organizations (#/admin-orgs)
async function renderAdminOrgs() {
  document.title = "Organizations · Admin · Cresslet Studio";
  $("admin-title").replaceChildren("Organizations");
  $("admin-sub").textContent = "Teams whose members share apps";
  const gen = adminView.gen, route = routeGen;
  const { orgs } = await api("/v1/admin/orgs");
  if (gen !== adminView.gen || route !== routeGen) return;
  const again = (focus) => renderAdmin("", { section: "orgs" }).then((ok) => ok && refocus(focus?.()));
  $("admin-actions").replaceChildren(el("button", { className: "btn", type: "button", onclick: () => again(() => $("admin-actions").querySelector("button")) }, icon("refresh"), "Refresh"));

  const name = el("input", { className: "input mono", id: "org-name", required: true, maxLength: 40, pattern: "[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]|[a-z0-9]", autocomplete: "off", spellcheck: false, placeholder: "acme" });
  name.setAttribute("aria-describedby", "org-name-hint");
  const title = el("input", { className: "input", id: "org-title", maxLength: 100, autocomplete: "off", placeholder: "Acme Inc." });
  const admin = el("input", { className: "input", id: "org-admin", type: "email", maxLength: 254, autocomplete: "off", spellcheck: false, placeholder: "name@example.com" });
  admin.setAttribute("aria-describedby", "org-admin-hint");
  const err = formError();
  const submit = el("button", { className: "btn primary", type: "submit" }, icon("plus"), "Create organization");
  const form = el("form", { className: "panel form grant-form", ariaLabel: "New organization" },
    el("h2", { textContent: "New organization" }),
    field("Name", name, "Lowercase letters, digits and single dashes, up to 40."),
    field("Display name (optional)", title),
    field("First admin (optional)", admin, "The email of an existing account. Admins add and remove members; invite new people on the Users page first."),
    err,
    el("div", { className: "row start" }, submit));
  form.addEventListener("input", () => showError(err, ""));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError(err, "");
    const gen = routeGen;
    submit.disabled = true;
    try {
      const r = await api("/v1/admin/orgs", {
        method: "POST",
        body: JSON.stringify({ name: name.value.trim(), ...(title.value.trim() ? { title: title.value.trim() } : {}), ...(admin.value.trim() ? { admin: admin.value.trim() } : {}) }),
      });
      toast(`Created ${r.org.name}`);
      if (gen === routeGen) again(() => $("org-name"));
    } catch (x) {
      if (gen !== routeGen) return;
      if (!form.isConnected) return void toast(`Could not create it: ${x.message}`);
      showError(err, `Could not create it: ${x.message}`);
      submit.disabled = false;
      (x.status === 404 ? admin : name).focus();
    }
  });

  const tbody = el("tbody", {}, ...(orgs.length ? orgs.map((o) =>
    el("tr", {},
      el("td", {}, el("a", { href: `#/orgs/${encodeURIComponent(o.name)}`, textContent: o.title ?? o.name }), o.title ? el("span", { className: "sub mono", textContent: o.name }) : null),
      el("td", { className: "num", textContent: String(o.members) }),
      el("td", { className: "num", textContent: String(o.apps) }),
      el("td", {}, timeAgo(o.createdAt)),
      el("td", { className: "actions" }, el("button", {
        className: "btn sm danger", type: "button", textContent: "Delete", ariaLabel: `Delete ${o.name}`,
        onclick: (e) => rowAction(e.currentTarget, async () => {
          if (!confirm(`Delete the organization ${o.name}? Its members lose its apps' access; apps must be moved out first.`)) throw CANCELLED;
          await api(`/v1/admin/orgs/${encodeURIComponent(o.name)}`, { method: "DELETE" });
        }, `Deleted ${o.name}`, () => again()),
      }))))
    : [el("tr", {}, el("td", { colSpan: 5, className: "empty", textContent: "No organizations yet." }))]));

  $("admin-body").replaceChildren(
    el("div", { className: "detail-grid" },
      el("div", { className: "stack" },
        el("div", { className: "panel" }, el("h2", { textContent: "How organizations work" }),
          el("p", { className: "muted small", textContent: "An app moved into an organization belongs to it: the organization's admins own it, and its members can deploy and change it. Admins manage members. As a site admin you manage organizations, but you don't get access to their apps unless you're a member." })),
        el("div", { className: "table-wrap", tabIndex: 0, role: "region", ariaLabel: "Organizations table" },
          el("table", { className: "table" },
            el("caption", { className: "sr-only", textContent: "Organizations" }),
            el("thead", {}, el("tr", {}, ...["Organization", "Members", "Apps", "Created", "Actions"].map((h, i) =>
              el("th", { scope: "col", className: i === 1 || i === 2 ? "num" : "" }, i === 4 ? srOnly(h) : h)))),
            tbody))),
      form));
}

// ------------------------------------------------------------------ organizations (#/orgs[/<name>])
const ORG_ROLE_LABEL = { admin: "Admin", member: "Member" };
let myOrgs = [];
async function loadMyOrgs() {
  myOrgs = auth.token ? await api("/v1/orgs").then((r) => r.orgs, () => []) : [];
  $("nav-orgs-item").hidden = !myOrgs.length;
  return myOrgs;
}

/** Your organizations, or one of them (members, apps; admins manage members). Uses the admin page's layout. */
async function renderOrg(name) {
  if (!auth.token) {
    location.hash = "#/";
    return false;
  }
  $("admin-title").replaceChildren(name || "Organizations");
  $("admin-sub").textContent = "";
  showOnly("admin");
  navCurrent("orgs");
  const gen = ++adminView.gen, route = routeGen;
  const current = () => gen === adminView.gen && route === routeGen;
  $("admin-actions").replaceChildren();
  $("admin-body").replaceChildren(el("p", { className: "muted", textContent: "Loading…" }));
  try {
    if (!name) {
      document.title = "Organizations · Cresslet Studio";
      const orgs = await loadMyOrgs();
      if (!current()) return false;
      $("admin-sub").textContent = "Organizations you belong to";
      $("admin-body").replaceChildren(orgs.length
        ? el("ul", { className: "list" }, ...orgs.map((o) => el("li", { className: "list-row" },
          el("div", { className: "tok" }, el("a", { href: `#/orgs/${encodeURIComponent(o.name)}`, textContent: o.title ?? o.name }),
            el("span", { className: "meta", textContent: `${o.name} · ${ORG_ROLE_LABEL[o.role]}` })))))
        : el("div", { className: "empty-state" }, el("strong", { textContent: "You're not in an organization" }),
          el("span", { textContent: "A site admin creates organizations, and their admins add members." })));
      return current();
    }
    const d = await api(`/v1/orgs/${encodeURIComponent(name)}`);
    if (!current()) return false;
    drawOrg(d);
  } catch (e) {
    if (!current()) return false;
    $("admin-body").replaceChildren(el("p", { className: "error", textContent: e.status === 404 ? "This organization doesn't exist, or you're not in it." : `Could not load: ${e.message}` }));
  }
  return current();
}

function drawOrg(d) {
  const o = d.org, name = o.name;
  document.title = `${o.title ?? name} · Organizations · Cresslet Studio`;
  $("admin-title").replaceChildren(el("a", { href: "#/orgs", textContent: "Organizations" }), " / ", o.title ?? name);
  $("admin-sub").textContent = [o.title ? name : null, d.role ? `You're ${d.role === "admin" ? "an admin" : "a member"}` : "You manage it as a site admin"].filter(Boolean).join(" · ");
  const again = (focus) => renderOrg(name).then((ok) => ok && refocus(focus?.()));
  $("admin-actions").replaceChildren(el("button", { className: "btn", type: "button", onclick: () => again(() => $("admin-actions").querySelector("button")) }, icon("refresh"), "Refresh"));
  const memberUrl = (id) => `/v1/orgs/${encodeURIComponent(name)}/members/${encodeURIComponent(id)}`;

  const members = el("ul", { className: "list", ariaLabel: "Members" }, ...d.members.map((m) => {
    const me = m.id === myAccountId;
    const meta = [ORG_ROLE_LABEL[m.role], m.disabled ? "disabled" : null, `added ${when(m.createdAt)}`].filter(Boolean).join(" · ");
    const row = [el("div", { className: "tok" },
      el("strong", { textContent: personText(m) }, me ? el("span", { className: "badge", textContent: "you" }) : null),
      el("span", { className: "meta", textContent: meta }))];
    if (d.canManage) {
      const role = el("select", { className: "input role-select", ariaLabel: `Role for ${personText(m)}` },
        ...["member", "admin"].map((v) => el("option", { value: v, textContent: ORG_ROLE_LABEL[v], selected: v === m.role })));
      role.addEventListener("change", async () => {
        if (me && role.value === "member" && !confirm(`Make yourself a member of ${name}? You won't be able to manage it any more.`)) return void (role.value = m.role);
        const gen = routeGen;
        try {
          m.role = (await api(memberUrl(m.id), { method: "PUT", body: JSON.stringify({ role: role.value }) })).role;
          toast(`${personText(m)} is now ${ORG_ROLE_LABEL[m.role].toLowerCase()}`);
          if (me && gen === routeGen) again();
        } catch (e) {
          toast(`Could not change the role: ${e.message}`);
          role.value = m.role;
        }
      });
      row.push(role);
    }
    if (d.canManage || me) {
      row.push(el("button", {
        className: "btn sm danger", type: "button", textContent: me ? "Leave" : "Remove", ariaLabel: me ? `Leave ${name}` : `Remove ${personText(m)}`,
        onclick: (e) => rowAction(e.currentTarget, async () => {
          if (!confirm(me ? `Leave ${name}? You lose access to its apps.` : `Remove ${personText(m)} from ${name}? They lose access to its apps.`)) throw CANCELLED;
          await api(memberUrl(m.id), { method: "DELETE" });
        }, me ? `You left ${name}` : `Removed ${personText(m)}`, () => {
          if (me && !d.canManage) {
            loadMyOrgs();
            location.hash = "#/orgs";
          } else again(() => $("org-members-title"));
        }),
      }));
    }
    return el("li", { className: "list-row" }, ...row);
  }));

  let form = null;
  if (d.canManage) {
    const email = el("input", { className: "input", id: "org-member-email", type: "email", required: true, maxLength: 254, autocomplete: "off", spellcheck: false });
    email.setAttribute("aria-describedby", "org-member-email-hint");
    const role = el("select", { className: "input", id: "org-member-role" },
      el("option", { value: "member", textContent: "Member: deploy and change the organization's apps" }),
      el("option", { value: "admin", textContent: "Admin: also own them and manage members" }));
    const err = formError();
    const submit = el("button", { className: "btn primary", type: "submit" }, icon("plus"), "Add member");
    form = el("form", { className: "panel form grant-form", ariaLabel: "Add a member" },
      el("h2", { textContent: "Add a member" }),
      field("Email", email, "The email on their Cresslet account. Someone new to this server needs a site admin's invite first."),
      field("Role", role),
      err,
      el("div", { className: "row start" }, submit));
    form.addEventListener("input", () => showError(err, ""));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      showError(err, "");
      const gen = routeGen;
      submit.disabled = true;
      try {
        const r = await api(`/v1/orgs/${encodeURIComponent(name)}/members`, { method: "POST", body: JSON.stringify({ email: email.value.trim(), role: role.value }) });
        toast(`Added ${r.member.email} as ${ORG_ROLE_LABEL[r.member.role].toLowerCase()}`);
        if (gen === routeGen) again(() => $("org-member-email"));
      } catch (x) {
        if (gen !== routeGen) return;
        if (!form.isConnected) return void toast(`Could not add them: ${x.message}`);
        showError(err, x.message);
        submit.disabled = false;
        email.focus();
      }
    });
  }

  const apps = d.apps.length
    ? el("ul", { className: "list", ariaLabel: "Apps" }, ...d.apps.map((a) => el("li", { className: "list-row" },
      el("div", { className: "tok" },
        d.role ? el("a", { href: a.kind === "page" ? `#/share/${encodeURIComponent(a.name)}` : siteHref(a.name), textContent: a.name }) : el("strong", { textContent: a.name }),
        el("span", { className: "meta", textContent: `${a.kind === "page" ? "Artifact" : "App"} · updated ${when(a.updatedAt)}` })),
      extLink(a.url, "Visit", "btn sm"))))
    : el("p", { className: "muted small", textContent: "No apps yet. An app's owner moves it in from its Share page." });

  $("admin-body").replaceChildren(el("div", { className: "detail-grid" },
    el("div", { className: "stack" },
      el("div", { className: "panel" }, el("h2", { id: "org-members-title", tabIndex: -1, textContent: `Members (${d.members.length})` }), members),
      el("div", { className: "panel" }, el("h2", { textContent: `Apps (${d.apps.length})` }), apps)),
    form));
}

/** Marks the sidebar link for `key` (its data-nav) as the current page. */
function navCurrent(key) {
  for (const a of document.querySelectorAll("[data-nav]")) {
    if (a.dataset.nav === key) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

// ------------------------------------------------------------------ admin: AI credits (#/admin-credits[/<account id>])
const creditNum = (x) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(x); // millicredits: exact
const creditsText = (x) => `${creditNum(x)} ${creditNum(x) === "1" ? "credit" : "credits"}`;
const signed = (x) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${creditNum(Math.abs(x))}`;
const usd = (x) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: x && Math.abs(x) < 1 ? 4 : 2 }).format(x);
const tokenNum = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const ledgerWhat = (h) => h.kind === "usage"
  ? [h.model ?? "Claude",
    `${tokenNum.format(h.inputTokens + h.cacheReadTokens + h.cacheWriteTokens)} in · ${tokenNum.format(h.outputTokens)} out${h.usd != null ? ` · ${usd(h.usd)}` : ""}${h.free ? ` · ${creditNum(h.free)} free` : ""}${h.estimated ? " · estimated (cut off)" : ""}`]
  : [h.credits > 0 ? "Credits given" : "Credits taken back", [h.by && `by ${h.by}`, h.note].filter(Boolean).join(": ") || "by the operator"];

let grantBusy = false;
/** Give (or, negative, take back) credits. `email` fixed: for one account's page; else typed, with `emails` suggested. */
function grantForm({ email = null, emails = [], after }) {
  const field = (label, input, hint) => el("div", { className: "field" },
    el("label", { htmlFor: input.id, textContent: label }), input, hint && el("p", { className: "muted small", id: `${input.id}-hint`, textContent: hint }));
  const err = el("p", { className: "error small", role: "alert", hidden: true });
  const to = el("input", { className: "input", id: "grant-email", type: "email", required: true, autocomplete: "off", spellcheck: false, placeholder: "name@example.com" });
  to.setAttribute("list", "grant-emails");
  const amount = el("input", { className: "input", id: "grant-credits", type: "number", required: true, step: "any", placeholder: "100" });
  amount.setAttribute("aria-describedby", "grant-credits-hint");
  const note = el("input", { className: "input", id: "grant-note", maxLength: 200, autocomplete: "off", placeholder: "Beta tester" });
  const submit = el("button", { className: "btn primary", type: "submit" }, icon("plus"), "Give credits");
  const form = el("form", { className: "panel form grant-form", ariaLabel: email ? `Give credits to ${email}` : "Give credits" },
    el("h2", { textContent: email ? "Give credits" : "Give credits to an account" }),
    email ? null : field("Account email", to),
    email ? null : el("datalist", { id: "grant-emails" }, ...emails.map((e) => el("option", { value: e }))),
    field("Credits", amount, "A negative number takes credits back."),
    field("Note (optional)", note),
    err,
    el("div", { className: "row start" }, submit));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const who = email ?? to.value.trim();
    const credits = Math.round(Number(amount.value) * 1000) / 1000; // the server keeps millicredits
    err.hidden = true;
    if (!who) return void to.focus();
    if (grantBusy) { // a grant from before a Refresh is still being sent
      err.textContent = "A grant is still being sent. Try again in a moment.";
      err.hidden = false;
      return;
    }
    if (!Number.isFinite(credits) || credits === 0) {
      err.textContent = "Enter a number of credits other than 0 (at most 3 decimal places).";
      err.hidden = false;
      return void amount.focus();
    }
    if (credits < 0 && !confirm(`Take ${creditsText(-credits)} back from ${who}?`)) return;
    const gen = routeGen;
    submit.disabled = grantBusy = true;
    try {
      const r = await api("/v1/admin/accounts/credits", { method: "POST", body: JSON.stringify({ email: who, credits, ...(note.value.trim() ? { note: note.value.trim() } : {}) }) });
      toast(`${credits > 0 ? "Gave" : "Took back"} ${creditsText(Math.abs(credits))} ${credits > 0 ? "to" : "from"} ${r.account.email}. Granted balance: ${creditNum(r.balance)}.`);
      if (gen === routeGen) after();
    } catch (x) {
      if (gen !== routeGen) return;
      const msg = x.status === 404 ? `No account with the email ${who}.` : `Could not give credits: ${x.message}`;
      if (!form.isConnected) return void toast(msg); // a Refresh replaced this form meanwhile
      err.textContent = msg;
      err.hidden = false;
      submit.disabled = false;
      (x.status === 404 && !email ? to : amount).focus();
    } finally {
      grantBusy = false;
    }
  });
  return Object.assign(form, { fill: (e) => { to.value = e; amount.focus(); } });
}

/** Credits used per day: bars, named by a summary (and each bar's own title). */
function dayChart(days) {
  const max = Math.max(...days.map((d) => d.credits));
  const total = days.reduce((n, d) => n + d.credits, 0);
  const fmt = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const peak = days.reduce((a, d) => (d.credits > a.credits ? d : a), days[0]);
  const label = max
    ? `Credits used per day, ${fmt(days[0].date)} to ${fmt(days.at(-1).date)}: ${creditsText(total)} in all, most on ${fmt(peak.date)} (${creditNum(peak.credits)})`
    : "No credits used in the last 30 days";
  return el("div", {},
    el("div", { className: "day-chart", role: "img", ariaLabel: label },
      ...days.map((d) => {
        const b = el("span", { title: `${fmt(d.date)}: ${creditsText(d.credits)}, ${d.requests} request${d.requests === 1 ? "" : "s"}` });
        b.style.height = max ? `${Math.max(d.credits ? 3 : 0, (d.credits / max) * 100)}%` : "0";
        return b;
      })),
    el("div", { className: "day-axis", ariaHidden: "true" },
      el("span", { textContent: fmt(days[0].date) }), el("span", { textContent: max ? `peak ${creditNum(max)}` : "" }), el("span", { textContent: "Today" })),
    // Each day's numbers, for keyboards, touch and screen readers (the bars' titles need a pointer).
    max ? el("details", { className: "day-table" }, el("summary", { textContent: "Days with use" }),
      el("table", { className: "table" },
        el("thead", {}, el("tr", {}, ...["Day", "Credits", "Requests"].map((h, i) => el("th", { scope: "col", className: i ? "num" : "", textContent: h })))),
        el("tbody", {}, ...days.filter((d) => d.requests).reverse().map((d) => el("tr", {},
          el("td", { textContent: fmt(d.date) }),
          el("td", { className: "num", textContent: creditNum(d.credits) }),
          el("td", { className: "num", textContent: d.requests.toLocaleString() })))))) : null);
}

const ledgerTable = (rows, { account = false } = {}) =>
  el("div", { className: "table-wrap", tabIndex: 0, role: "region", ariaLabel: "Credit activity" },
    el("table", { className: "table" },
      el("caption", { className: "sr-only", textContent: "Credit activity, newest first" }),
      el("thead", {}, el("tr", {}, ...["When", ...(account ? ["Account"] : []), "Activity", "Credits"].map((h) =>
        el("th", { scope: "col", className: h === "Credits" ? "num" : "", textContent: h })))),
      el("tbody", {}, ...(rows.length ? rows.map((h) => {
        const [what, sub] = ledgerWhat(h);
        return el("tr", {},
          el("td", {}, timeAgo(h.at)),
          account ? el("td", {}, el("a", { href: `#/admin-credits/${encodeURIComponent(h.account.id)}`, textContent: h.account.email })) : null,
          el("td", { className: "wrap" }, el("span", { textContent: what }), el("span", { className: "sub", textContent: sub })),
          el("td", { className: `num credit-delta${h.credits > 0 ? " plus" : ""}`, textContent: signed(h.credits) }));
      }) : [el("tr", {}, el("td", { colSpan: account ? 4 : 3, className: "empty", textContent: "No credit activity yet." }))]))));

function creditsOff() {
  $("admin-title").replaceChildren("AI credits");
  $("admin-body").replaceChildren(el("div", { className: "empty-state" },
    el("strong", { textContent: "AI credits are off on this server" }),
    el("span", { textContent: "Set CRESSLET_ANTHROPIC_API_KEY to let accounts use the AI builder on the server's key, metered in credits." })));
}

const adminCreditsView = { q: "" };

async function renderAdminCredits() {
  document.title = "AI credits · Admin · Cresslet Studio";
  $("admin-title").replaceChildren("AI credits");
  $("admin-sub").textContent = "Credit use across every account on this server";
  const gen = adminView.gen, route = routeGen;
  const d = await api("/v1/admin/credits");
  if (gen !== adminView.gen || route !== routeGen) return;
  const again = () => renderAdmin("", { credits: true }).then((ok) => ok && refocus());
  $("admin-actions").replaceChildren(el("button", {
    className: "btn", type: "button",
    onclick: () => renderAdmin("", { credits: true }).then((ok) => ok && refocus($("admin-actions").querySelector("button"))),
  }, icon("refresh"), "Refresh"));
  if (!d.enabled) return creditsOff();

  const t = d.totals;
  const resets = new Date(d.resetsAt).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const stats = el("div", { className: "stats" },
    stat("Used this month", [creditNum(t.used)], `${usd(t.usd)} at list price · ${t.requests.toLocaleString()} request${t.requests === 1 ? "" : "s"}`),
    stat("From free credits", [creditNum(t.free)], d.monthlyCredits ? `${creditNum(d.monthlyCredits)} free per account a month · renews ${resets}` : "No free credits on this server"),
    stat("Granted this month", [signed(t.granted)], `${t.grants} grant${t.grants === 1 ? "" : "s"} · ${creditNum(t.balance)} granted left${t.overdrawn ? ` · ${creditNum(t.overdrawn)} overdrawn` : ""}`),
    stat("Accounts", [String(t.active), el("small", { textContent: `of ${t.accounts}` })], "Used AI this month, of those with credits"));

  const form = grantForm({ emails: d.accounts.map((a) => a.email), after: again });
  const chart = el("div", { className: "panel" }, el("h2", { textContent: "Last 30 days" }), dayChart(d.days));
  const models = el("div", { className: "panel" }, el("h2", { textContent: "By model this month" }),
    d.models.length
      ? el("div", { className: "scroll-x", tabIndex: 0, role: "region", ariaLabel: "Models" }, el("table", { className: "table" },
        el("thead", {}, el("tr", {}, ...["Model", "Requests", "Tokens in / out", "Cost", "Credits"].map((h, i) => el("th", { scope: "col", className: i ? "num" : "", textContent: h })))),
        el("tbody", {}, ...d.models.map((m) => el("tr", {},
          el("td", { className: "mono", textContent: m.model }),
          el("td", { className: "num", textContent: m.requests.toLocaleString() }),
          el("td", { className: "num", textContent: `${tokenNum.format(m.inputTokens)} / ${tokenNum.format(m.outputTokens)}` }),
          el("td", { className: "num", textContent: usd(m.usd) }),
          el("td", { className: "num", textContent: creditNum(m.credits) }))))))
      : el("p", { className: "muted small", textContent: "No AI use this month." }));

  const tbody = el("tbody");
  const search = el("input", { type: "search", className: "input", placeholder: "Search accounts", ariaLabel: "Search accounts", value: adminCreditsView.q, oninput: () => { adminCreditsView.q = search.value; draw(); } });
  const shown = el("p", { className: "sr-only", role: "status" });
  function draw() {
    const q = adminCreditsView.q.trim().toLowerCase();
    const rows = d.accounts.filter((a) => !q || [a.email, a.github].some((v) => v?.toLowerCase().includes(q)));
    shown.textContent = `${rows.length} account${rows.length === 1 ? "" : "s"} shown`;
    tbody.replaceChildren(...(rows.length ? rows.map((a) =>
      el("tr", {},
        el("td", {},
          el("a", { href: `#/admin-credits/${encodeURIComponent(a.id)}`, textContent: a.email }),
          a.github ? el("span", { className: "sub", textContent: `@${a.github}` }) : null),
        el("td", { className: `num${a.available <= 0 ? " error" : ""}`, textContent: creditNum(Math.max(0, a.available)) }),
        el("td", { className: "num", textContent: creditNum(a.balance) }),
        el("td", { className: "num", textContent: d.monthlyCredits ? `${creditNum(a.monthlyUsed)} / ${creditNum(d.monthlyCredits)}` : "—" }),
        el("td", { className: "num", textContent: creditNum(a.used) }),
        el("td", { className: "num", textContent: a.requests.toLocaleString() }),
        el("td", {}, a.lastUsedAt ? timeAgo(a.lastUsedAt) : el("span", { className: "muted", textContent: "never" })),
        el("td", { className: "actions" }, el("button", {
          className: "btn sm", type: "button", textContent: "Give", ariaLabel: `Give credits to ${a.email}`,
          onclick: () => { form.fill(a.email); form.scrollIntoView({ block: "nearest" }); },
        }))))
      : [el("tr", {}, el("td", { colSpan: 8, className: "empty", textContent: q ? "No accounts match." : "No account has used or been given credits yet." }))]));
  }
  draw();

  $("admin-body").replaceChildren(stats,
    el("div", { className: "detail-grid" }, el("div", { className: "stack" }, chart, models), form),
    el("div", { className: "toolbar" }, el("h2", { className: "toolbar-title", textContent: "Accounts" }),
      el("div", { className: "search" }, icon("search"), search), shown),
    el("div", { className: "table-wrap", tabIndex: 0, role: "region", ariaLabel: "Accounts table" },
      el("table", { className: "table" },
        el("caption", { className: "sr-only", textContent: "Accounts with AI credits, most used this month first" }),
        el("thead", {}, el("tr", {}, ...["Account", "Available", "Granted left", "Free used", "Used this month", "Requests", "Last used", "Actions"].map((h, i) =>
          el("th", { scope: "col", className: i && i < 6 ? "num" : "" }, i === 7 ? srOnly(h) : h)))),
        tbody)),
    el("p", { className: "muted small", textContent: "Available: this month's free credits left plus granted credits left. Accounts appear here once they use AI credits or are given some." }),
    el("h2", { className: "section-title", textContent: "Recent activity" }),
    ledgerTable(d.recent, { account: true }));
}

async function renderAdminCreditsAccount(id) {
  document.title = "AI credits · Admin · Cresslet Studio";
  $("admin-title").replaceChildren(el("a", { href: "#/admin-credits", textContent: "AI credits" }), " / …");
  const gen = adminView.gen, route = routeGen;
  const d = await api(`/v1/admin/credits/accounts/${encodeURIComponent(id)}`);
  if (gen !== adminView.gen || route !== routeGen) return;
  const again = () => renderAdmin(id, { credits: true }).then((ok) => ok && refocus());
  $("admin-actions").replaceChildren(el("button", {
    className: "btn", type: "button",
    onclick: () => renderAdmin(id, { credits: true }).then((ok) => ok && refocus($("admin-actions").querySelector("button"))),
  }, icon("refresh"), "Refresh"));
  if (!d.enabled) return creditsOff();
  const a = d.account;
  document.title = `${a.email} · AI credits · Admin · Cresslet Studio`;
  $("admin-title").replaceChildren(el("a", { href: "#/admin-credits", textContent: "AI credits" }), " / ", a.email);
  $("admin-sub").textContent = [a.github && `@${a.github}`, a.siteAdmin && "Site admin"].filter(Boolean).join(" · ") || "Account";
  const resets = new Date(d.resetsAt).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const stats = el("div", { className: "stats" },
    stat("Available", [creditNum(Math.max(0, a.available))], a.available <= 0 ? "Out of credits: AI requests are refused" : "Free credits left plus granted credits"),
    stat("Granted left", [creditNum(a.balance)], a.balance < 0 ? "Overdrawn" : "Doesn't expire"),
    stat("Free this month", [creditNum(Math.max(0, d.monthlyCredits - a.monthlyUsed)), el("small", { textContent: `of ${creditNum(d.monthlyCredits)}` })], `Renews ${resets}`),
    stat("Used this month", [creditNum(a.used)], `${a.requests.toLocaleString()} request${a.requests === 1 ? "" : "s"} · last ${a.lastUsedAt ? ago(a.lastUsedAt) : "never"}`));
  $("admin-body").replaceChildren(stats,
    el("div", { className: "detail-grid" },
      el("div", { className: "stack" }, el("h2", { className: "section-title flush", textContent: "Activity" }), ledgerTable(d.history),
        d.history.length === 200 ? el("p", { className: "muted small", textContent: "The latest 200 entries." }) : null),
      grantForm({ email: a.email, after: again })));
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
    // `studio: false`: a CLI-only template (its framework's build doesn't run in the browser runtime)
    into.replaceChildren(...templates.filter((t) => t.studio !== false).map(templateCard));
  }).catch((e) => {
    templatesReq = null; // try again next time
    into.replaceChildren(el("p", { className: "error", textContent: `Could not load templates: ${e.message}` }));
  });
}

/** #/: the landing page when logged out (and, on servers without login, for new visitors with no local projects),
 *  else the projects dashboard. */
async function renderHome() {
  if (!auth.token) {
    const gen = routeGen;
    const local = await mustLogIn() ? [] : await projects.list().catch(() => []);
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
            el("div", {}, el("a", { href: siteHref(a.name), textContent: a.name }), el("span", { className: "sub", textContent: a.url.replace(/^https?:\/\//, "") })))),
          el("td", { className: "muted", textContent: ACCESS_LABEL[a.access] ?? "" }),
          el("td", { className: "muted" }, timeAgo(a.updatedAt)),
          el("td", { className: "actions" },
            el("a", { className: "btn sm", href: a.url, target: "_blank", rel: "noopener" }, icon("external"), "Visit", srOnly(` ${a.name} (opens in a new tab)`)),
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

/** #/artifacts (was #/pages): deploy and manage artifacts, static HTML with a visibility and a retention. Logged out: what they are, and a login. */
function renderPagesView() {
  showOnly("pages");
  document.title = "Artifacts · Cresslet Studio";
  $("pages-login").hidden = !!auth.token;
  $("pages-main").hidden = !auth.token;
  $("page-new").hidden = !auth.token;
  if (auth.token) renderPages();
}
$("pages-login-btn").addEventListener("click", () => {
  try {
    sessionStorage.setItem("cresslet.afterLogin", "#/artifacts");
  } catch { /* storage blocked: login lands on the home page */ }
  logIn();
});

let pageUploading = false; // the dialog stays open (Escape, Cancel, × do nothing) while a deploy is in flight
const PAGE_BUSY = ["page-upload", "page-cancel", "page-close", "page-file", "page-dir"]; // disabled while deploying
let pageUploadGen = 0; // the latest deploy: an earlier one finishing later doesn't unlock the dialog it no longer owns
const pageSlug = slugField($("page-name"), "page");
let pagesReq = 0; // only the latest list request is shown (an older, slower one would hide a newer artifact)
function renderPages() {
  const mine = ++pagesReq;
  return api("/v1/pages").then(({ pages }) => {
    if (mine !== pagesReq) return;
    // Closed before their rows go, so their scroll/resize listeners go with them.
    for (const m of $("page-list").querySelectorAll(".menu:popover-open")) m.hidePopover();
    $("page-list").replaceChildren(pages.length
      ? el("ul", { className: "list art-list", ariaLabel: "Your artifacts" }, ...pages.map(pageRow))
      : el("div", { className: "empty-state" },
        el("strong", { textContent: "No artifacts yet" }),
        el("span", {}, "Deploy an HTML file or a folder, or run ", el("code", { textContent: "npx cresslet@latest deploy report.html" }), "."),
        el("button", { className: "btn primary sm", type: "button", ariaHasPopup: "dialog", onclick: openPageDialog }, icon("plus"), "New artifact")));
  }).catch((e) => mine === pagesReq && $("page-list").replaceChildren(el("p", { className: "error", textContent: `Could not load artifacts: ${e.message}` })));
}

/** A popover menu under its button (native popover: Escape and a click outside close it, focus returns to the button). */
function rowMenu(id, label, items) {
  const menu = el("div", { id, className: "menu" }, ...items);
  menu.setAttribute("popover", "");
  const btn = el("button", { className: "icon-btn row-more", type: "button", title: "More actions", ariaLabel: `More actions for ${label}` }, icon("more"));
  btn.setAttribute("popovertarget", id);
  const unlisten = () => {
    removeEventListener("scroll", hide, true);
    removeEventListener("resize", hide);
  };
  // A list re-render can remove an open menu without a toggle event: its listeners go then.
  function hide() {
    if (menu.isConnected && menu.matches(":popover-open")) menu.hidePopover();
    else unlisten();
  }
  // Placed before it shows (under the button, right edges lined up), flipped above if there's no room below.
  menu.addEventListener("beforetoggle", (e) => {
    if (e.newState !== "open") return;
    const r = btn.getBoundingClientRect();
    menu.style.right = `${Math.max(8, document.documentElement.clientWidth - r.right)}px`;
    menu.style.top = `${r.bottom + 4}px`;
  });
  menu.addEventListener("toggle", (e) => {
    if (e.newState !== "open") return unlisten();
    const r = btn.getBoundingClientRect();
    if (r.bottom + 4 + menu.offsetHeight > innerHeight) menu.style.top = `${Math.max(8, r.top - 4 - menu.offsetHeight)}px`;
    addEventListener("scroll", hide, true); // placed once: it closes rather than drift away from its row
    addEventListener("resize", hide);
    menu.querySelector("button, a")?.focus();
  });
  // Closed before the item acts, so a confirm() or a file picker isn't drawn over an open menu.
  menu.addEventListener("click", (e) => e.target.closest("button, a") && hide(), true);
  // Tabbing out of it closes it too, so it doesn't sit over the rows focus moved on to.
  menu.addEventListener("focusout", (e) => e.relatedTarget && !menu.contains(e.relatedTarget) && e.relatedTarget !== btn && hide());
  btn.addEventListener("focusout", (e) => e.relatedTarget && !menu.contains(e.relatedTarget) && hide());
  return [btn, menu];
}
const menuItem = (iconName, text, srText, attrs = {}) =>
  el(attrs.href ? "a" : "button", { className: "menu-item", ...(attrs.href ? {} : { type: "button" }), ...attrs }, icon(iconName), text, srText ? srOnly(srText) : null);

function pageRow(p) {
  const manage = p.access === "owner" || p.access === "admin";
  const label = pageName(p);
  const until = el("span", { textContent: untilText(p) });
  const ico = el("span", { className: "file-ico", title: VIS_LABEL[p.visibility] }, icon(p.visibility === "private" ? "shield" : "globe"));
  const vis = manage
    ? visSelect({ id: `vis-${p.id}`, title: "Who can open it", ariaLabel: `Who can open ${label}`, onchange: () => changePage(p, { visibility: vis.value }, vis, until, ico) }, p.visibility)
    : el("span", { className: "muted small", textContent: VIS_LABEL[p.visibility] });
  const keep = manage
    ? keepSelect({ id: `keep-${p.id}`, title: "Keep for", ariaLabel: `Keep ${label} for`, onchange: () => changePage(p, { retentionDays: keepParse(keep.value) }, keep, until) }, p.retentionDays)
    : el("span", { className: "muted small", textContent: keepText(p.retentionDays) });
  const replace = el("input", { type: "file", hidden: true, accept: ".html,.htm,text/html", onchange: () => replacePage(p, replace) });
  const replaceDir = el("input", { type: "file", hidden: true, webkitdirectory: true, multiple: true, onchange: () => replacePage(p, replaceDir) });
  const items = [
    p.access === "viewer" ? null : menuItem("refresh", "Replace with an HTML file", ` (${label}, same link)`, { onclick: () => replace.click() }),
    p.access === "viewer" ? null : menuItem("folder", "Replace with a folder", ` (${label}, same link)`, { onclick: () => replaceDir.click() }),
    manage ? menuItem("users", "Share", ` ${label}`, { href: `#/share/${encodeURIComponent(p.name)}` }) : null,
    p.access === "owner" ? el("hr", { className: "menu-sep" }) : null,
    p.access === "owner" ? menuItem("trash", "Delete", ` ${label}`, { id: `delete-page-${p.id}`, className: "menu-item danger", onclick: () => deletePage(p) }) : null,
  ].filter(Boolean);
  return el("li", { className: "art-row" },
    el("div", { className: "art-main" },
      ico,
      el("div", { className: "art-text" },
        extLink(p.url, el("span", { className: "truncate", textContent: label }), "ext art-title"),
        el("span", { className: "sub" }, el("span", { className: "truncate", textContent: p.url.replace(/^https?:\/\//, "") }), el("span", { ariaHidden: "true", textContent: "·" }), until))),
    el("div", { className: "art-controls" }, vis, keep),
    el("div", { className: "art-actions" },
      el("button", { className: "btn sm", type: "button", title: "Copy link", ariaLabel: `Copy link to ${label}`, onclick: () => copyLink(p.url) }, icon("copy"), el("span", { className: "lbl", textContent: "Copy link" })),
      ...(items.length ? rowMenu(`more-${p.id}`, label, items) : []),
      replace, replaceDir));
}

async function changePage(p, change, select, until, ico) {
  select.disabled = true;
  try {
    const { page } = await api(`/v1/pages/${encodeURIComponent(p.name)}`, { method: "PATCH", body: JSON.stringify(change) });
    Object.assign(p, page);
    until.textContent = untilText(page);
    if (ico) {
      ico.replaceChildren(icon(page.visibility === "private" ? "shield" : "globe"));
      ico.title = VIS_LABEL[page.visibility];
    }
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

/** What the new-artifact dialog will send: one HTML file, or a folder's files (its top directory stripped). */
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
const VIS_HINT = {
  private: "Only you and the people you share it with, logged in.",
  link: "Anyone who has the link. Search engines don't list it.",
  public: "Anyone. Search engines can list it.",
};
const showVisHint = () => ($("vis-hint").textContent = VIS_HINT[$("page-visibility").value]);
$("page-visibility").addEventListener("change", showVisHint);
function showPick(title, sub) {
  $("page-picked").textContent = title;
  $("page-picked-sub").textContent = sub;
  $("page-drop").dataset.picked = String(!!pagePick);
}
const NO_PICK = ["Nothing chosen", "Drop an HTML file here, or choose one."];
function pickHtml(f) {
  $("page-dir").value = "";
  pagePick = f ? { title: f.name.replace(/\.html?$/i, ""), html: f } : null;
  showPick(...(f ? [f.name, f.size < 1024 ? `${f.size} bytes` : `${(f.size / 1024).toFixed(f.size < 10240 ? 1 : 0)} KB`] : NO_PICK));
  pageError("");
}
$("page-file").addEventListener("change", () => pickHtml($("page-file").files[0]));
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
  const noIndex = files.length && !files.some((x) => x.path === "index.html");
  pagePick = files.length && !noIndex ? { title: dir, files } : null;
  showPick(...(pagePick ? [`${dir}/`, `${files.length} file${files.length === 1 ? "" : "s"}`] : NO_PICK));
  pageError(noIndex ? "That folder has no index.html at its top level." : "");
});
// Dropping a file: an HTML file is picked; a folder needs the Folder button (a dropped folder can't be read as one here).
const drop = $("page-drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.dataset.over = "true";
});
drop.addEventListener("dragleave", (e) => !drop.contains(e.relatedTarget) && delete drop.dataset.over);
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  delete drop.dataset.over;
  if (pageUploading) return;
  const item = e.dataTransfer.items?.[0];
  const f = e.dataTransfer.files[0];
  if (item?.webkitGetAsEntry?.()?.isDirectory) return pageError("To deploy a folder, choose it with the Folder button.");
  if (!f || !/\.html?$/i.test(f.name)) return pageError("Drop an .html file.");
  $("page-file").value = "";
  pickHtml(f);
});

/** Opens the new-artifact dialog at the account's defaults (asked for each time, so a change in Settings or
 * elsewhere counts, and it never starts at the first option), with a new generated address. */
let pageDialogOpening = false;
async function openPageDialog() {
  const dlg = $("page-dialog");
  if (dlg.open || pageDialogOpening) return;
  // Left the page mid-deploy and came back: that deploy still owns the dialog (it closes it and clears its pick).
  if (pageUploading) return toast("Still deploying your last artifact…");
  pageDialogOpening = true;
  let defaults;
  try {
    defaults = (await api("/v1/me/settings")).pages;
  } catch (e) {
    return toast(`Could not load your artifact defaults: ${e.message}`);
  } finally {
    pageDialogOpening = false;
  }
  if (dlg.open || location.hash !== "#/artifacts") return; // left the page meanwhile
  $("page-form").reset();
  pagePick = null;
  showPick(...NO_PICK);
  pageError("");
  for (const id of PAGE_BUSY) $(id).disabled = false; // a finished deploy may not have yet
  $("page-name").value = "";
  $("page-visibility").value = defaults.visibility;
  setKeep($("page-retention"), defaults.retentionDays);
  showVisHint();
  dlg.showModal();
  pageSlug.suggest();
}
$("page-new").addEventListener("click", openPageDialog);
for (const id of ["page-cancel", "page-close"]) $(id).addEventListener("click", () => !pageUploading && $("page-dialog").close());
$("page-dialog").addEventListener("cancel", (e) => pageUploading && e.preventDefault());
// A file dropped anywhere in the dialog but the drop zone would make the browser open it, leaving the studio.
for (const type of ["dragover", "drop"]) {
  $("page-dialog").addEventListener(type, (e) => e.dataTransfer?.types.includes("Files") && e.preventDefault());
}

$("page-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!pagePick) {
    if ($("page-error").hidden) pageError("Choose an HTML file or a folder first."); // else: why the pick was refused
    $("page-file").focus();
    return;
  }
  pageError("");
  const dlg = $("page-dialog");
  const mine = ++pageUploadGen;
  const pick = pagePick; // what was chosen when Deploy was pressed (the file inputs are disabled meanwhile)
  pageUploading = true;
  for (const id of PAGE_BUSY) $(id).disabled = true;
  try {
    const name = await pageSlug.value();
    if (!name) {
      $("page-name").focus();
      return;
    }
    const content = pick.html
      ? { html: await pick.html.text() }
      : await folderBody(pick.files);
    const { page } = await api("/v1/pages", {
      method: "POST",
      body: JSON.stringify({
        ...content,
        name,
        title: pick.title,
        visibility: $("page-visibility").value,
        retentionDays: keepParse($("page-retention").value),
        source: "studio",
      }),
    });
    pagePick = null;
    pageUploading = false;
    dlg.close();
    toast(el("span", {}, `Deployed ${pageName(page)}: `, extLink(page.url, page.url.replace(/^https?:\/\//, "")), " ",
      el("button", { className: "btn sm", type: "button", onclick: () => copyLink(page.url) }, icon("copy"), "Copy link")));
    await renderPages();
    refocus($("page-new")); // from the empty state's button, which the list replaced
  } catch (err) {
    if (dlg.open) pageError(`Could not deploy: ${err.message}`);
    else toast(`Could not deploy: ${err.message}`); // closed by leaving the page meanwhile
  } finally {
    if (mine === pageUploadGen) {
      pageUploading = false;
      for (const id of PAGE_BUSY) $(id).disabled = false;
      if (dlg.open && !dlg.contains(document.activeElement)) $("page-upload").focus(); // disabling Deploy dropped focus
    }
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
  api("/v1/me/settings").then(showPageDefaults, (e) => pageDefaultsError(`Could not load your artifact defaults: ${e.message}`));
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
  savePageDefaults({ visibility: $("def-visibility").value, retentionDays: keepParse($("def-retention").value) }, "Artifact defaults saved");
});
$("page-defaults-reset").addEventListener("click", () => savePageDefaults(null, "Using the server's artifact defaults"));

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
  document.title = "Private artifact · Cresslet Studio";
  const text = (t) => ($("view-text").textContent = t);
  $("view-actions").replaceChildren();
  if (!auth.token) {
    text("This artifact is private. Log in to open it, if its owner shared it with you.");
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
    text("Your browser didn't keep this artifact's sign-in. Allow cookies for it, then try again.");
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
    text(e.status === 404 ? "This artifact doesn't exist, or it expired."
      : e.status === 403 ? `You don't have access to this artifact (logged in as ${auth.email}). Ask its owner to share it with you.`
      : `Could not open the artifact: ${e.message}`);
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
  // An invite can be to an app (Deployed apps) or an artifact (Artifacts).
  toast(accept ? `Joined ${i.app} as ${ACCESS_LABEL[r.app.access]?.toLowerCase() ?? r.app.access}: it's in Deployed apps or Artifacts` : `Declined the invite to ${i.app}`);
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
  $("invite-role").options[0].textContent = INVITE_VIEWER_APP;
  $("invite-role-admin").textContent = inviteAdminApp;
  // An artifact: its title, and what sharing means for it.
  api(`/v1/pages/${encodeURIComponent(name)}`).then(({ page }) => {
    if (shareApp !== name) return;
    $("share-title").replaceChildren(el("a", { href: "#/artifacts", textContent: "Artifacts" }), " / ", `Share ${pageName(page)}`);
    $("share-sub").textContent = "Invite accounts to this artifact. Viewers can open it even when it's private; admins can also change it.";
    $("invite-role").options[0].textContent = "Viewer: open it, even when it's private";
    $("invite-role-admin").textContent = "Admin: also replace its files, change who can open it and how long it's kept, and share it (not deleting it)";
  }, () => {});
  $("invite-form").reset();
  $("invite-form").hidden = true; // until the list loads: only the owner and admins may share
  $("invite-send").disabled = false; // an invite still in flight from another app's page doesn't hold this one
  inviteError("");
  $("people").replaceChildren(el("li", { className: "list-row muted", textContent: "Loading…" }));
  const gen = routeGen;
  if (!myAccountId) await api("/v1/me").then(setAccount, () => {});
  $("org-block").hidden = true;
  await Promise.all([renderPeople(gen), renderOrgBlock(gen)]);
}

/** Moving the app into one of your organizations, or back out: for its owner (in an organization: an org admin). */
async function renderOrgBlock(gen = routeGen) {
  const name = shareApp;
  let app, orgs;
  try {
    [{ app }, orgs] = await Promise.all([api(`/v1/apps/${encodeURIComponent(name)}`), loadMyOrgs()]);
  } catch {
    return;
  }
  if (gen !== routeGen || shareApp !== name) return;
  $("org-block").hidden = app.access !== "owner" || (!orgs.length && !app.org);
  const sel = $("org-select");
  const inMine = !app.org || orgs.some((o) => o.name === app.org.name);
  sel.replaceChildren(
    el("option", { value: "", textContent: app.org ? "Nobody: make it my personal app" : "Nobody: my personal app" }),
    ...(inMine ? [] : [el("option", { value: app.org.name, textContent: app.org.title ?? app.org.name })]),
    ...orgs.map((o) => el("option", { value: o.name, textContent: o.title ? `${o.title} (${o.name})` : o.name })));
  sel.value = app.org?.name ?? "";
  $("org-form-text").textContent = app.org
    ? `In ${app.org.title ?? app.org.name}: its admins own it and its members can deploy and change it. Moved out, it becomes your personal app.`
    : "Move it into an organization you're in: the organization's admins will own it, and its members can deploy and change it. People you've shared it with keep their access.";
  $("org-form").dataset.current = app.org?.name ?? "";
}
$("org-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = shareApp, to = $("org-select").value || null, gen = routeGen;
  if ((to ?? "") === $("org-form").dataset.current) return void toast("It's already there.");
  if (!confirm(to ? `Move ${name} into ${to}? Its admins will own it.` : `Make ${name} your personal app? The organization's members lose access to it.`)) return;
  $("org-move").disabled = true;
  try {
    await api(`/v1/apps/${encodeURIComponent(name)}/org`, { method: "PUT", body: JSON.stringify({ org: to }) });
    toast(to ? `Moved ${name} into ${to}` : `${name} is your personal app now`);
  } catch (x) {
    toast(`Could not move it: ${x.message}`);
  } finally {
    $("org-move").disabled = false;
  }
  if (gen !== routeGen) return;
  await Promise.all([renderPeople(gen), renderOrgBlock(gen)]);
});

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
    d.org
      // In an organization: its admins own it (`owner` is just who last held it).
      ? el("li", { className: "list-row" }, who(d.org.title ?? d.org.name, "Organization: its admins own this, its members can change it"),
        el("a", { className: "btn sm", href: `#/orgs/${encodeURIComponent(d.org.name)}`, textContent: "Members", ariaLabel: `Members of ${d.org.name}` }))
      : el("li", { className: "list-row" }, who(personText(d.owner), "Owner", d.owner.id === myAccountId ? "you" : null)),
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
    if (m.auth?.github) {
      $("landing-note").textContent = $("cta-note").textContent = "Free and open source. Log in with GitHub to start building.";
    } else {
      $("landing-note").textContent = m.anonDeploys
        ? `Free and open source. No account needed: apps deployed without one last ${hours} hours.`
        : "Free and open source. Try it without an account.";
    }
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
  if (await mustLogIn()) return logIn();
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

// Chat first: the AI builder beside the app's preview, the code (files + editor) when asked for, and the terminal and
// deploy log in a drawer under them. What was last shown is remembered in this browser.
const LAYOUT = "cresslet.workspace";
const layoutPrefs = () => {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT)) ?? {};
  } catch {
    return {};
  }
};
const saveLayout = (p) => {
  try {
    localStorage.setItem(LAYOUT, JSON.stringify({ ...layoutPrefs(), ...p }));
  } catch { /* storage blocked: not remembered */ }
};

/** The view switch (Preview | Code) and the drawer. `onCode`: the code was shown; `onDrawer`: the drawer was opened. */
function mountLayout({ onCode, onDrawer }) {
  const ws = $("workspace");
  const switches = [...$("view-switch").querySelectorAll("button")];
  function setView(v) {
    ws.dataset.view = v;
    $("files-pane").hidden = $("editor-pane").hidden = v !== "code";
    $("preview-pane").hidden = v !== "preview";
    for (const b of switches) b.setAttribute("aria-pressed", String(b.dataset.view === v));
    saveLayout({ view: v });
    if (v === "code") onCode();
  }
  function setDrawer(open, { focus = false } = {}) {
    const had = $("drawer").contains(document.activeElement);
    $("drawer").hidden = !open;
    ws.dataset.drawer = open ? "open" : "";
    $("drawer-btn").setAttribute("aria-expanded", String(open));
    saveLayout({ drawer: open });
    if (open) onDrawer();
    if (!open && (focus || had)) $("drawer-btn").focus();
  }
  for (const b of switches) b.onclick = () => setView(b.dataset.view);
  $("drawer-btn").onclick = () => setDrawer($("drawer").hidden);
  $("drawer-close").onclick = () => setDrawer(false, { focus: true });
  $("view-switch").hidden = false;
  $("drawer-btn").hidden = false;
  const prefs = layoutPrefs();
  setView(prefs.view === "code" ? "code" : "preview");
  setDrawer(prefs.drawer === true);
  return { setView, setDrawer };
}

async function openProject(id, gen) {
  if (await mustLogIn()) {
    if (gen === routeGen) toLanding(location.hash);
    return;
  }
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
  $("workspace-title").textContent = `${project.name}: AI builder, preview and code`;
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
    $("workspace-title").textContent = `${project.name}: AI builder, preview and code`;
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
  // Opened the first time the drawer shows (xterm measures its cells on open); output before that is kept.
  let termOpen = false;
  const openTerm = () => {
    if (termOpen) return;
    termOpen = true;
    term.open($("terminal"));
    term.textarea?.setAttribute("aria-describedby", "terminal-help");
    fit.fit();
    new ResizeObserver(() => fit.fit()).observe($("terminal"));
  };
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
  let showCode = () => {}; // the editor measures itself once it's created and shown
  const layout = mountLayout({ onCode: () => showCode(), onDrawer: openTerm });

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
  showCode = () => view.requestMeasure();
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
    // A new app: the user keeps the generated address or picks their own first. (A cresslet.json that won't
    // parse skips this: the deploy below reports it.)
    let cfg, newApp;
    if (!project.deploy?.name) {
      cfg = await cresslet.config().catch(() => undefined);
      if (cfg && !cfg.name) {
        const app = await pickAppName();
        if (!app) return btn.focus();
        newApp = { app, create: true };
      }
    }
    btn.disabled = true;
    $("deploy-btn-label").textContent = "Deploying…";
    const log = $("deploy-log");
    log.textContent = "";
    layout.setDrawer(true);
    selectTab("deploy-log");
    if (document.activeElement === btn) log.focus(); // the disabled button would drop focus to <body>
    try {
      // A shared app you only view: say so before building (the API would refuse the upload).
      const target = project.deploy?.name;
      if (target && auth.token && !project.deploy.deployKey) {
        const info = await api(`/v1/apps/${encodeURIComponent(target)}`).catch(() => null);
        if (info?.app.access === "viewer") throw new Error(`you're a viewer of ${target}: only its owner and admins can deploy it`);
      }
      const r = await cresslet.deploy((line) => (log.textContent += line + "\n"), undefined, cfg, newApp);
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

  // Where Claude is reached: "key" (the user's own Anthropic API key, from this browser), "credits" (this server, on
  // the account's AI credits; when it offers them and the user is logged in), or null (set one up first).
  let creditsOn = false;
  const source = () => (apiKey.get() ? "key" : creditsOn && auth.token ? "credits" : null);
  function showView() {
    const src = source();
    $("builder-setup").hidden = !!src;
    $("builder-chat").hidden = !src;
    $("builder-credits-offer").hidden = !creditsOn || !!auth.token;
    $("builder-forget").hidden = src !== "key";
    $("builder-credits").hidden = src !== "credits";
    return !!src;
  }
  const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  async function refreshCredits() {
    if (source() !== "credits") return;
    const r = await api("/v1/me/credits").catch(() => null);
    if (!r) return;
    if (!r.enabled) {
      creditsOn = false;
      return void showView();
    }
    const left = Math.max(0, r.available);
    const label = $("builder-credits");
    const unit = fmt.format(left) === "1" ? "credit" : "credits";
    label.textContent = `${fmt.format(left)} ${unit}`;
    label.title = `${fmt.format(left)} AI ${unit} left`;
    if (left <= 0) label.dataset.low = "";
    else delete label.dataset.low;
  }
  meta.then((m) => {
    creditsOn = !!m.ai?.credits;
    showView();
    refreshCredits();
  });
  // Where focus goes in the chat: the message field, or the heading while it's locked (a disabled field can't take it).
  const chatFocus = () => (locked ? $("builder-title") : input).focus();
  const setupFocus = () => ($("builder-credits-offer").hidden ? $("builder-key") : $("builder-login")).focus();
  function setOpen(open, { focus = true, remember = true } = {}) {
    pane.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    $("workspace").dataset.builder = open ? "open" : "";
    if (remember) saveLayout({ chat: open });
    const chat = showView();
    if (!focus) return;
    if (!open) btn.focus();
    else if (chat) chatFocus();
    else setupFocus();
  }
  btn.onclick = () => setOpen(pane.hidden);
  $("builder-close").onclick = () => setOpen(false);

  function render() {
    $("builder-send").disabled = busy || locked;
    $("builder-stop").hidden = !busy;
    $("builder-new").disabled = busy;
    $("builder-forget").disabled = busy;
    input.disabled = locked;
    $("builder-locked").hidden = !locked;
    input.setAttribute("aria-describedby", locked ? "builder-locked builder-hint" : "builder-hint");
  }

  $("builder-login").onclick = () => {
    try {
      sessionStorage.setItem("cresslet.afterLogin", location.hash); // back to this project
    } catch { /* storage blocked: back to the home page */ }
    logIn();
  };
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
    if (busy) return;
    apiKey.set(null);
    if (showView()) {
      refreshCredits();
      chatFocus();
      announce("API key removed from this browser. Using your AI credits.");
    } else {
      setupFocus();
      announce("API key removed from this browser");
    }
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
    if (!source()) return void showView();
    // Each request goes the way chosen when it's sent (the key can be forgotten or entered mid-chat).
    agent ??= createAgent({
      client: () => (source() === "key" ? anthropicClient(apiKey.get()) : creditsClient(auth.token)),
      errorText: (e) => errorText(e, { credits: source() !== "key" }),
      tools,
      on,
    });
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
      refreshCredits();
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
  setOpen(layoutPrefs().chat !== false, { focus: false, remember: false });
  return {
    approve,
    running: () => tools.running > 0,
    lock(on) {
      locked = on;
      render();
    },
  };
}

const deploySlug = slugField($("deploy-name"), "app");
/** Asks for a new app's address (a generated one to start with). Resolves to the name, or null if cancelled. */
let appNameAsks = 0;
function pickAppName() {
  const dlg = $("deploy-dialog");
  const ask = ++appNameAsks;
  return new Promise((resolve) => {
    let picked = null;
    $("deploy-confirm").disabled = false; // a cancelled ask may have left it disabled mid-check
    $("deploy-form").onsubmit = async (e) => {
      e.preventDefault();
      $("deploy-confirm").disabled = true;
      const name = await deploySlug.value().catch(() => null);
      if (ask !== appNameAsks || !dlg.open) return; // cancelled while checking (or asked again since)
      $("deploy-confirm").disabled = false;
      if (!name) return $("deploy-name").focus();
      picked = name;
      dlg.close();
      resolve(name); // now, not on "close" (dispatched later): the deploy starts while focus is back on Deploy
    };
    $("deploy-cancel").onclick = () => dlg.close();
    const onClose = () => {
      if (dlg.open) return; // an earlier close's event (it's dispatched later), delivered after this one opened
      dlg.removeEventListener("close", onClose);
      resolve(picked);
    };
    dlg.addEventListener("close", onClose);
    dlg.showModal();
    deploySlug.suggest().then(() => dlg.open && $("deploy-name").select());
  });
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
  // A link inside the new-artifact dialog or a row's menu (Settings, Share) leaves the page: they don't come along.
  if ($("page-dialog").open) $("page-dialog").close();
  for (const m of document.querySelectorAll(".menu:popover-open")) m.hidePopover();
  appDash.stop?.(); // a Logs tab's stream
  appDash.stop = null;
  const m = location.hash.match(/^#\/p\/([\w-]+)/);
  if (m) openProject(m[1], gen);
  else if (booted) reloadForRoute();
  else if (location.hash === "#/settings") renderSettings();
  else if (location.hash === "#/artifacts") renderPagesView();
  else if (location.hash === "#/pages") location.replace("#/artifacts"); // artifacts were called pages
  else if (location.hash.startsWith("#/share/")) renderShare(decodeURIComponent(location.hash.slice("#/share/".length)));
  else if (location.hash.startsWith("#/view/")) {
    const [n, q] = location.hash.slice("#/view/".length).split("?");
    renderView(decodeURIComponent(n), new URLSearchParams(q ?? "").get("path") ?? "/");
  }
  else if (location.hash === "#/cli") renderCli();
  else if (location.hash.startsWith("#/apps/")) {
    const [n, tab = "", arg = ""] = location.hash.slice("#/apps/".length).split("/").map(decodeURIComponent);
    renderSite(n, tab, arg);
  }
  else if (location.hash === "#/admin-users") renderAdmin("", { section: "users" });
  else if (location.hash === "#/admin-orgs") renderAdmin("", { section: "orgs" });
  else if (location.hash === "#/orgs" || location.hash.startsWith("#/orgs/")) renderOrg(decodeURIComponent(location.hash.slice("#/orgs/".length)));
  else if (location.hash.startsWith("#/admin-credits")) renderAdmin(decodeURIComponent(location.hash.slice("#/admin-credits/".length)), { credits: true });
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
