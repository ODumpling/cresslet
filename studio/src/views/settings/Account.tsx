// /settings: the account (its GitHub login and email), its password, and logging this browser out.
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type * as API from "../../../api-types.ts";
import { api, errorMessage, json, meta } from "../../lib/api.ts";
import { useAlive, useLoad, useView } from "../../lib/hooks.ts";
import { FormError } from "../../ui/bits.tsx";
import { toast } from "../../lib/toast.tsx";
import { connectGithub } from "../workspace/GitDialog.tsx";
import { logOut } from "../../lib/session.ts";
import { ExtLink, Icon } from "../../ui/icons.tsx";
import { useAccount } from "./Settings.tsx";

export function SettingsAccount() {
  useView("settings", "Account · Settings");
  const navigate = useNavigate();
  const account = useAccount();
  return (
    <>
      <section className="block" aria-labelledby="account-title">
        <div className="block-head"><h2 id="account-title">Account</h2></div>
        <dl className="panel kv">
          <dt>GitHub</dt><dd id="set-github">{account.data ? account.data.github ?? "—" : "—"}</dd>
          <dt>Email</dt><dd id="set-email">{account.data?.email ?? "—"}</dd>
        </dl>
      </section>
      <Password account={account.data} reload={account.reload} />
      <SourceControl />
      <section className="block" aria-labelledby="session-title">
        <div className="block-head"><h2 id="session-title">Session</h2></div>
        <div className="panel split">
          <p className="muted small">Logs this browser out. Its token stays valid until you revoke it in <Link to="/settings/tokens">API tokens</Link>.</p>
          <button className="btn" id="logout-btn" type="button" onClick={() => {
            logOut();
            void navigate({ to: "/" });
          }}><Icon name="logout" />Log out</button>
        </div>
      </section>
    </>
  );
}

/** Sets or changes the account's password (email + password login), when the server has that login. */
function Password({ account, reload }: { account?: API.Account; reload: () => Promise<unknown> }) {
  const [on, setOn] = useState(false);
  useEffect(() => void meta().then((m) => setOn(!!m.auth?.password)), []);
  const alive = useAlive();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  if (!on || !account) return null;
  const has = !!account.password;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/v1/me/password", json("PUT", has ? { password: next, currentPassword: current } : { password: next }));
      if (!alive.current) return;
      setCurrent("");
      setNext("");
      await reload();
      toast(has ? "Password changed" : "Password set: you can log in with your email and it");
    } catch (err) {
      if (alive.current) flushSync(() => setError(errorMessage(err)));
      form.current?.querySelector<HTMLInputElement>(has ? "#pw-current" : "#pw-new")?.focus();
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <section className="block" aria-labelledby="pw-title">
      <div className="block-head"><h2 id="pw-title">Password</h2></div>
      <form className="panel form" id="pw-form" ref={form} onSubmit={(e) => void save(e)}>
        <p className="muted small" id="pw-text">{has
          ? `You can log in with ${account.email} and your password.`
          : `Set a password to also log in with ${account.email}.`}</p>
        {/* For password managers: the account this password is for. */}
        <input type="email" hidden readOnly autoComplete="username" value={account.email} />
        {has ? (
          <div className="field">
            <label htmlFor="pw-current">Current password</label>
            <input className="input" id="pw-current" type="password" required autoComplete="current-password" aria-describedby="pw-error"
              value={current} onChange={(e) => (setCurrent(e.target.value), setError(""))} />
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="pw-new">{has ? "New password" : "Password"}</label>
          <input className="input" id="pw-new" type="password" required minLength={8} maxLength={256} autoComplete="new-password" aria-describedby="pw-hint pw-error"
            value={next} onChange={(e) => (setNext(e.target.value), setError(""))} />
          <p className="muted small" id="pw-hint">At least 8 characters.</p>
        </div>
        <FormError id="pw-error" text={error} />
        <div className="row start"><button className="btn primary" id="pw-save" type="submit" disabled={busy}>{has ? "Change password" : "Set password"}</button></div>
      </form>
    </section>
  );
}

/** The account's own GitHub connection for source control (apps sync with repositories as this user). */
function SourceControl() {
  const git = useLoad(() => api<API.MeGit>("/v1/me/git"), []);
  const [busy, setBusy] = useState(false);
  // Back from GitHub (server/git.ts puts the outcome in the hash).
  useEffect(() => {
    const h = new URLSearchParams(location.hash.slice(1));
    const ok = h.get("cresslet_git"), err = h.get("cresslet_git_error");
    if (!ok && !err) return;
    history.replaceState(null, "", location.pathname + location.search);
    toast(err ? `GitHub didn't connect: ${err}` : "GitHub connected", 8000);
  }, []);
  const g = git.data;
  if (!g?.available) return null;
  const start = async () => {
    setBusy(true);
    try {
      await connectGithub();
    } catch (e) {
      toast(`Couldn't connect GitHub: ${errorMessage(e)}`, 8000);
      setBusy(false);
    }
  };
  return (
    <section className="block" aria-labelledby="git-title">
      <div className="block-head"><h2 id="git-title">Source control</h2></div>
      <div className="panel split">
        <div>
          <p id="set-git">{g.connected
            ? g.status === "expired" ? `GitHub access for ${g.login} expired or was revoked: connect again.` : `Connected to GitHub as ${g.login}.`
            : "Connect GitHub to keep projects in repositories. Commits are yours; the token stays on the server."}</p>
          {g.connected && g.installUrl ? <p className="muted small"><ExtLink href={g.installUrl}>Choose which repositories Cresslet can reach</ExtLink></p> : null}
        </div>
        <div className="row">
          {!g.connected || g.status === "expired"
            ? <button className="btn primary" id="git-connect" type="button" disabled={busy} onClick={() => void start()}><Icon name="github" />{g.connected ? "Reconnect" : "Connect GitHub"}</button>
            : null}
          {g.connected ? (
            <button className="btn" id="git-disconnect" type="button" disabled={busy} onClick={async () => {
              if (!confirm("Disconnect GitHub? Linked apps stay linked; you'll connect again to sync them.")) return;
              setBusy(true);
              try {
                await api("/v1/me/git/github", { method: "DELETE" });
                await git.reload();
                toast("GitHub disconnected");
              } catch (e) {
                toast(`Couldn't disconnect: ${errorMessage(e)}`, 8000);
              } finally {
                setBusy(false);
              }
            }}>Disconnect</button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
