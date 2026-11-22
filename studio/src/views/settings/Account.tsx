// /settings: the account (its GitHub login and email), and logging this browser out.
import { Link, useNavigate } from "@tanstack/react-router";
import { useView } from "../../lib/hooks.ts";
import { logOut } from "../../lib/session.ts";
import { Icon } from "../../ui/icons.tsx";
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
