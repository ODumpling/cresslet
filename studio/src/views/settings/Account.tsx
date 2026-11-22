// /settings: the account (its GitHub login and email), and logging this browser out.
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type * as API from "../../../api-types.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { useLoad, useView } from "../../lib/hooks.ts";
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
