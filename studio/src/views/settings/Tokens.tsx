// /settings/tokens: the account's API tokens (the CLI's, CI's and agents'): the list (revoke), and a new one.
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type * as API from "../../../api-types.ts";
import { api, errorMessage, json, meta } from "../../lib/api.ts";
import { refocus } from "../../lib/focus.ts";
import { when } from "../../lib/format.ts";
import { useAlive, useLoad, useView } from "../../lib/hooks.ts";
import { logOut } from "../../lib/session.ts";
import { toast } from "../../lib/toast.tsx";
import { FormError } from "../../ui/bits.tsx";
import { Icon } from "../../ui/icons.tsx";
import { useCreatedToken } from "./Settings.tsx";

const ADMIN_ROLE = "Admin: everything, incl. secrets, domains, new apps, deleting apps";

/** API tokens: the list (revoke), and a new one (role, app scope) shown once. */
export function SettingsTokens() {
  useView("settings", "API tokens · Settings");
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
  const [created, setCreated] = useCreatedToken();
  const title = useRef<HTMLHeadingElement>(null);
  const appsBox = useRef<HTMLDivElement>(null);
  const newValue = useRef<HTMLInputElement>(null);
  const createBtn = useRef<HTMLButtonElement>(null);

  // A new token: the list shows it (also when it was created before this tab was opened again).
  const reloadTokens = tokens.reload;
  useEffect(() => void (created && reloadTokens()), [created, reloadTokens]);

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
      const made = { name: r.info.name, token: r.token };
      if (!alive.current) { // another settings tab is open: the secret waits in Settings (shown back on this tab)
        if (!setCreated(made)) toast(`Created ${made.name}, but you left Settings before it was shown: revoke it and create another.`);
        else if (location.pathname !== "/settings/tokens") toast(`Created ${made.name}: copy it from API tokens, you won't see it again.`);
        return;
      }
      flushSync(() => {
        setCreated(made);
        setName("");
        setRole("deploy");
        setScope("all");
        setPicked(new Set());
      });
      newValue.current?.focus();
      newValue.current?.select();
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
