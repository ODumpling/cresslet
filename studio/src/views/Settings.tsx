// #/settings (logged in): the account, AI credits, API tokens (the CLI's, CI's and agents'), the defaults for new
// artifacts, and logging this browser out.
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { auth } from "../../store.ts";
import type * as API from "../../api-types.ts";
import { api, errorMessage, json, meta } from "../lib/api.ts";
import { refocus } from "../lib/focus.ts";
import { keepOptions, keepParse, keepText, keepValue, VIS_LABEL, when } from "../lib/format.ts";
import { useAlive, useLoad, useView } from "../lib/hooks.ts";
import { logOut, sessionExpired, setAccount, useSession } from "../lib/session.ts";
import { toast } from "../lib/toast.tsx";
import { FormError } from "../ui/bits.tsx";
import { Icon } from "../ui/icons.tsx";

export function Settings() {
  useView("settings", "Settings");
  const { token } = useSession();
  const navigate = useNavigate();
  // Opened logged out: to the landing page. Its session expired (a 401 dropped the token, maybe while this view
  // loaded): the page reloads for no account, and goes there if the account doesn't load (below).
  const [entered] = useState(() => !!token || sessionExpired());
  useEffect(() => {
    if (!entered) void navigate({ to: "/", replace: true });
  }, [entered, navigate]);
  if (!entered) return null;
  return <SettingsPage key={token ?? ""} />;
}

/** One account's settings (keyed on the token: another account's never stay shown). */
function SettingsPage() {
  const navigate = useNavigate();
  const account = useLoad(() => api<{ account: API.Account }>("/v1/me").then((r) => (setAccount(r), r.account)), []);
  useEffect(() => {
    if (!account.error) return;
    if (!auth.token) void navigate({ to: "/" }); // the session expired
    else toast(`Could not load account: ${account.error.message}`);
  }, [account.error, navigate]);

  return (
    <main id="settings" className="page narrow" aria-labelledby="settings-title">
      <header className="page-head">
        <div>
          <h1 id="settings-title" tabIndex={-1}>Settings</h1>
          <p className="muted">Your account and the tokens the CLI, CI and agents use.</p>
        </div>
      </header>
      <section className="block" aria-labelledby="account-title">
        <div className="block-head"><h2 id="account-title">Account</h2></div>
        <dl className="panel kv">
          <dt>GitHub</dt><dd id="set-github">{account.data ? account.data.github ?? "—" : "—"}</dd>
          <dt>Email</dt><dd id="set-email">{account.data?.email ?? "—"}</dd>
        </dl>
      </section>
      <Credits />
      <Tokens />
      <PageDefaults />
      <section className="block" aria-labelledby="session-title">
        <div className="block-head"><h2 id="session-title">Session</h2></div>
        <div className="panel split">
          <p className="muted small">Logs this browser out. Its token stays valid until you revoke it above.</p>
          <button className="btn" id="logout-btn" type="button" onClick={() => {
            logOut();
            void navigate({ to: "/" });
          }}><Icon name="logout" />Log out</button>
        </div>
      </section>
    </main>
  );
}

/** AI credits (when the server offers them): what's left, this month's free credits, and recent use. */
function Credits() {
  const c = useLoad(async () => ((await meta()).ai?.credits ? api<API.MyCredits>("/v1/me/credits") : null), []);
  const r = c.data;
  const shown = !!c.error || !!r?.enabled;
  const num = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const tokens = new Intl.NumberFormat();
  const amount = (x: number) => `${num.format(x)} ${num.format(x) === "1" ? "credit" : "credits"}`;
  return (
    <section className="block" id="credits-section" hidden={!shown} aria-labelledby="credits-title">
      <div className="block-head">
        <h2 id="credits-title">AI credits</h2>
        <p className="muted small" id="credits-hint">The AI builder spends credits on what Claude reads and writes. This month's free credits go first.</p>
      </div>
      <dl className="panel kv credits-kv">
        <dt>Available</dt><dd id="credits-available">{r?.enabled ? amount(Math.max(0, r.available)) : "—"}</dd>
        <dt>Free this month</dt><dd id="credits-monthly">{!r?.enabled ? "—" : r.monthly.allowance
          ? `${num.format(r.monthly.remaining)} of ${num.format(r.monthly.allowance)} left, renews ${new Date(r.monthly.resetsAt).toLocaleDateString()}`
          : "None on this server"}</dd>
        <dt>Granted</dt><dd id="credits-balance">{r?.enabled ? `${amount(r.balance)}${r.balance < 0 ? " (the last request went over)" : ""}` : "—"}</dd>
      </dl>
      <h3 className="sub-title" id="credits-history-title">Recent use</h3>
      <ul className="list" id="credits-history" aria-labelledby="credits-history-title">
        {c.error ? <li className="list-row error">Could not load AI credits: {c.error.message}</li>
          : !r?.enabled ? null
          : !r.history.length ? <li className="list-row muted">No AI credits used yet.</li>
          : r.history.map((h, i) => (
            <li className="list-row" key={i}>
              <div className="tok">
                <strong>{h.kind === "usage" ? `AI builder (${h.model ?? "Claude"})` : h.credits > 0 ? "Credits added" : "Credits removed"}</strong>
                <span className="meta">{h.kind === "usage"
                  ? `${tokens.format(h.inputTokens + h.cacheReadTokens + h.cacheWriteTokens)} tokens in, ${tokens.format(h.outputTokens)} out${h.estimated ? " (estimated: the reply was cut off)" : ""}`
                  : h.note ?? "by the operator"}</span>
              </div>
              <span className="meta">{when(h.at)}</span>
              <span className="credit-delta">{`${h.credits > 0 ? "+" : "−"}${num.format(Math.abs(h.credits))}`}</span>
            </li>
          ))}
      </ul>
    </section>
  );
}

const ADMIN_ROLE = "Admin: everything, incl. secrets, domains, new apps, deleting apps";

/** API tokens: the list (revoke), and a new one (role, app scope) shown once. */
function Tokens() {
  const navigate = useNavigate();
  const alive = useAlive();
  const tokens = useLoad(() => api<{ tokens: API.Token[] }>("/v1/me/tokens").then((r) => r.tokens), []);
  const apps = useLoad(() => api<{ apps: API.AppSummary[] }>("/v1/apps").then((r) => r.apps), []);
  // Custom domains off on this server (CRESSLET_CUSTOM_DOMAINS=false): don't offer them in the role description.
  const [noDomains, setNoDomains] = useState(false);
  useEffect(() => void meta().then((m) => setNoDomains(m.customDomains === false)), []);

  const [name, setName] = useState("");
  const [role, setRole] = useState("deploy");
  const [scope, setScope] = useState<"all" | "some">("all");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const appsBox = useRef<HTMLDivElement>(null);
  const newValue = useRef<HTMLInputElement>(null);
  const createBtn = useRef<HTMLButtonElement>(null);

  async function revoke(t: API.Token) {
    const msg = t.current
      ? `Revoke "${t.name}"? This browser's session uses it, so you'll be logged out.`
      : `Revoke "${t.name}"? Anything using it stops working.`;
    if (!confirm(msg)) return;
    try {
      await api(`/v1/me/tokens/${encodeURIComponent(t.id)}`, { method: "DELETE" });
    } catch (e) {
      toast(`Could not revoke: ${errorMessage(e)}`);
      return;
    }
    if (t.current) {
      logOut();
      void navigate({ to: "/" });
      toast("Token revoked. You're logged out.");
      return;
    }
    toast(`Revoked ${t.name}`);
    if (await tokens.reload()) refocus(title.current); // the Revoke button is gone with its row
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    const some = scope === "some";
    const list = some ? (apps.data ?? []).map((a) => a.name).filter((n) => picked.has(n)) : null;
    if (list && !list.length) {
      setError("Pick at least one app, or choose All apps.");
      appsBox.current?.querySelector("input")?.focus();
      return;
    }
    setError("");
    setBusy(true);
    try {
      const r = await api<{ info: API.Token; token: string }>("/v1/me/tokens", json("POST", { name, role, apps: list }));
      if (!alive.current) return;
      flushSync(() => {
        setCreated({ name: r.info.name, token: r.token });
        setName("");
        setRole("deploy");
        setScope("all");
        setPicked(new Set());
      });
      newValue.current?.focus();
      newValue.current?.select();
      void tokens.reload();
    } catch (err) {
      if (alive.current) setError(`Could not create token: ${errorMessage(err)}`);
    } finally {
      if (alive.current) {
        flushSync(() => setBusy(false));
        if (document.activeElement === document.body) createBtn.current?.focus(); // disabling it dropped focus
      }
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(newValue.current?.value ?? "");
      toast("Token copied");
    } catch {
      newValue.current?.select();
      toast("Copy failed: select the token and copy it manually.");
    }
  }

  return (
    <section className="block" aria-labelledby="tokens-title">
      <div className="block-head">
        <h2 id="tokens-title" tabIndex={-1} ref={title}>API tokens</h2>
        <p className="muted small">Give each tool its own token with only the access it needs, so you can revoke it alone.</p>
      </div>
      <ul className="list" id="tokens" aria-labelledby="tokens-title">
        {tokens.error ? <li className="list-row error">Could not load tokens: {tokens.error.message}</li>
          : !tokens.data ? null
          : !tokens.data.length ? <li className="list-row muted">No tokens yet.</li>
          : tokens.data.map((t) => (
            <li className="list-row" key={t.id}>
              <div className="tok">
                <strong>{t.name}{t.current ? <span className="badge">this browser</span> : null}</strong>
                <span className="meta">{`${t.role} · ${t.apps ? (t.apps.join(", ") || "no apps left") : "all apps"}`}</span>
              </div>
              <span className="meta">{`created ${when(t.createdAt)} · last used ${when(t.lastUsedAt)}`}</span>
              <button className="btn sm danger" type="button" aria-label={`Revoke ${t.name}`} id={`revoke-${t.id}`} onClick={() => void revoke(t)}>Revoke</button>
            </li>
          ))}
      </ul>
      <div id="token-new" className="panel callout token-new" hidden={!created} role="region" aria-labelledby="token-new-heading">
        <p id="token-new-heading"><strong id="token-new-name">{created?.name}</strong>: copy it now, you won't see it again.</p>
        <div className="token-row">
          <input id="token-new-value" ref={newValue} className="input mono" readOnly aria-label="New API token" spellCheck={false} value={created?.token ?? ""} />
          <button className="btn" id="token-copy" type="button" onClick={() => void copy()}><Icon name="copy" />Copy</button>
        </div>
        <p className="muted small">CLI: <code>cresslet login --token &lt;token&gt;</code> or <code>export CRESSLET_TOKEN=&lt;token&gt;</code></p>
      </div>
      {/* Form errors stay beside the form (not a timed toast) until the user changes it. */}
      <form id="token-form" className="panel form" aria-labelledby="token-form-title" onSubmit={(e) => void create(e)} onChange={() => setError("")}>
        <h3 id="token-form-title">New token</h3>
        <div className="field">
          <label htmlFor="token-name">Name</label>
          <input className="input" id="token-name" required maxLength={64} placeholder="GitHub Actions" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="token-role">Access</label>
          <select className="input" id="token-role" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="read">Read: view apps, logs, source and data</option>
            <option value="deploy">Deploy: read, plus deploy and roll back (deployed code can read secrets)</option>
            <option value="admin" id="token-role-admin">{noDomains ? ADMIN_ROLE.replace(/,? domains\b/, "") : ADMIN_ROLE}</option>
          </select>
        </div>
        <fieldset className="field" aria-describedby="token-error">
          <legend>Apps</legend>
          <label className="check"><input type="radio" name="token-scope" value="all" checked={scope === "all"} onChange={() => setScope("all")} /> All apps (and new ones)</label>
          <label className="check"><input type="radio" name="token-scope" value="some" checked={scope === "some"} onChange={() => setScope("some")} /> Only these apps</label>
          <div id="token-apps" className="token-apps" hidden={scope !== "some"} ref={appsBox}>
            {!apps.data ? null : apps.data.length ? apps.data.map((a) => (
              <label className="check" key={a.name}>
                <input type="checkbox" value={a.name} checked={picked.has(a.name)} onChange={(e) => {
                  const on = e.target.checked;
                  setPicked((s) => {
                    const next = new Set(s);
                    if (on) next.add(a.name);
                    else next.delete(a.name);
                    return next;
                  });
                }} />
                <span>{a.name}</span>
              </label>
            )) : <p className="muted small">No apps yet.</p>}
          </div>
        </fieldset>
        <FormError id="token-error" text={error} />
        <div className="row start"><button className="btn primary" id="token-create" type="submit" ref={createBtn} disabled={busy}>Create token</button></div>
      </form>
    </section>
  );
}

/** The account's defaults for new artifacts. */
function PageDefaults() {
  const alive = useAlive();
  const loaded = useLoad(() => api<API.Settings>("/v1/me/settings"), []);
  const [settings, setSettings] = useState<API.Settings | null>(null);
  const [vis, setVis] = useState("private");
  const [keep, setKeep] = useState("1");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const show = (s: API.Settings) => {
    setSettings(s);
    setVis(s.pages.visibility);
    setKeep(keepValue(s.pages.retentionDays));
  };
  useEffect(() => {
    if (loaded.data) show(loaded.data);
    else if (loaded.error) setError(`Could not load your artifact defaults: ${loaded.error.message}`);
  }, [loaded.data, loaded.error]);

  async function save(pages: { visibility: string; retentionDays: number | null } | null, done: string) {
    setError("");
    setBusy(true);
    try {
      const s = await api<API.Settings>("/v1/me/settings", json("PUT", { pages }));
      if (!alive.current) return;
      show(s);
      toast(done);
    } catch (e) {
      if (alive.current) setError(`Could not save: ${errorMessage(e)}`);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const d = settings?.defaults.pages;
  // The retention choices, plus the saved one if it was set elsewhere (CLI or API) and isn't one of them.
  const options = keepOptions(settings ? settings.pages.retentionDays : 1);
  return (
    <section className="block" aria-labelledby="page-defaults-title">
      <div className="block-head">
        <h2 id="page-defaults-title">Artifact defaults</h2>
        <p className="muted small">Used for new artifacts unless you pick something else when you deploy one. Change any artifact later.</p>
      </div>
      <form id="page-defaults-form" className="panel form" aria-labelledby="page-defaults-title" onSubmit={(e) => {
        e.preventDefault();
        void save({ visibility: vis, retentionDays: keepParse(keep) }, "Artifact defaults saved");
      }}>
        <div className="field">
          <label htmlFor="def-visibility">Who can open new artifacts</label>
          <select className="input" id="def-visibility" aria-describedby="vis-hint-def" value={vis} onChange={(e) => setVis(e.target.value)}>
            <option value="private">Private</option>
            <option value="link">Anyone with the link</option>
            <option value="public">Public</option>
          </select>
          <p className="muted small" id="vis-hint-def">Private: you and people you share it with, logged in. Anyone with the link: not listed by search engines. Public: anyone, search engines too.</p>
        </div>
        <div className="field">
          <label htmlFor="def-retention">Keep new artifacts for</label>
          <select className="input" id="def-retention" aria-describedby="def-hint" value={keep} onChange={(e) => setKeep(e.target.value)}>
            {options.map((v) => <option key={v} value={v}>{keepText(keepParse(v))}</option>)}
          </select>
          <p className="muted small" id="def-hint">Server default: <span id="def-server">{d
            ? `${VIS_LABEL[d.visibility].toLowerCase()}, kept ${d.retentionDays === null ? "forever" : `for ${keepText(d.retentionDays).toLowerCase()}`}`
            : "—"}</span>. Expired artifacts are deleted.</p>
        </div>
        <FormError id="page-defaults-error" text={error} />
        <div className="row start">
          <button className="btn primary" id="page-defaults-save" type="submit" disabled={busy}>Save defaults</button>
          <button className="btn" id="page-defaults-reset" type="button" disabled={busy} onClick={() => void save(null, "Using the server's artifact defaults")}>Use server defaults</button>
        </div>
      </form>
    </section>
  );
}
