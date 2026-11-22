// /settings[/credits|/tokens|/artifacts] (logged in): the account's settings, one tab each: the account and logging
// this browser out, AI credits, API tokens (the CLI's, CI's and agents'), and the defaults for new artifacts.
import { Link, Outlet, useLocation, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { auth } from "../../../store.ts";
import type * as API from "../../../api-types.ts";
import { api, meta } from "../../lib/api.ts";
import { type Loaded, useAlive, useLoad, useView } from "../../lib/hooks.ts";
import { rememberAfterLogin, session, sessionExpired, setAccount, useSession } from "../../lib/session.ts";
import { toast } from "../../lib/toast.tsx";
import { Icon } from "../../ui/icons.tsx";

/** The account, loaded once for every tab (the Account tab shows it). */
const AccountContext = createContext<Loaded<API.Account> | null>(null);
export function useAccount(): Loaded<API.Account> {
  const c = useContext(AccountContext);
  if (!c) throw new Error("useAccount outside Settings");
  return c;
}

/**
 * A new API token's secret, until the user leaves Settings: it's shown once, so it outlasts switching tabs mid-create.
 * `keep` returns false when Settings is gone (the secret is lost). `creating`: a create is under way (one at a time,
 * also across switching tabs, so a second can't replace the first's secret).
 */
type Created = { name: string; token: string } | null;
type CreatedState = { secret: Created; keep: (c: Created) => boolean; creating: boolean; setCreating: (on: boolean) => void };
const CreatedContext = createContext<CreatedState | null>(null);
export function useCreatedToken(): CreatedState {
  const c = useContext(CreatedContext);
  if (!c) throw new Error("useCreatedToken outside Settings");
  return c;
}

/** Where to come back to once logged in: the tab that was open. */
const here = () => (location.pathname.startsWith("/settings/") ? location.pathname : "/settings");

export function Settings() {
  useView("settings", null); // each tab sets the title
  const { token } = useSession();
  const navigate = useNavigate();
  // Opened logged out: to the landing page. Its session expired (a 401 dropped the token, maybe while this view
  // loaded): the page reloads for no account, and goes there if the account doesn't load (below).
  const [entered] = useState(() => !!token || sessionExpired());
  useEffect(() => {
    if (entered) return;
    rememberAfterLogin(here()); // back here once logged in (#82)
    void navigate({ to: "/", replace: true });
  }, [entered, navigate]);
  if (!entered) return null;
  return <SettingsPage key={token ?? ""} />;
}

/** One account's settings (keyed on the token: another account's never stay shown). */
function SettingsPage() {
  const navigate = useNavigate();
  const [secret, setSecret] = useState<Created>(null);
  const [creating, setCreating] = useState(false);
  const alive = useAlive();
  const created: CreatedState = { secret, keep: (c) => (alive.current ? (setSecret(c), true) : false), creating, setCreating };
  const account = useLoad(() => {
    const sent = session().token;
    return api<{ account: API.Account }>("/v1/me").then((r) => (setAccount(r, sent), r.account));
  }, []);
  useEffect(() => {
    if (!account.error) return;
    if (!auth.token) {
      rememberAfterLogin(here()); // the session expired: back here once logged in again
      void navigate({ to: "/" });
    }
    else toast(`Could not load account: ${account.error.message}`);
  }, [account.error, navigate]);

  return (
    <main id="settings" className="page narrow" aria-labelledby="settings-title">
      <header className="page-head">
        <div>
          <h1 id="settings-title" tabIndex={-1}>Settings</h1>
          <p className="muted">Your account, AI credits, the tokens the CLI, CI and agents use, and defaults for new artifacts.</p>
        </div>
      </header>
      <Tabs />
      <AccountContext value={account}><CreatedContext value={created}><Outlet /></CreatedContext></AccountContext>
    </main>
  );
}

/** The tabs: deep links, the open one marked current. AI credits when the server offers them (or it's open). */
function Tabs() {
  const credits = useLoad(() => meta().then((m) => !!m.ai?.credits), []);
  const onCredits = !!useMatchRoute()({ to: "/settings/credits" });
  // On a narrow screen the tab row scrolls: keep the open tab in view (a deep link to the last one, say).
  const { pathname } = useLocation();
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname, credits.data]);
  const p = { className: "site-tab", activeProps: {}, activeOptions: { exact: true } } as const;
  return (
    <nav className="site-tabs" id="settings-tabs" aria-label="Settings sections" ref={nav}>
      <Link {...p} to="/settings"><Icon name="users" />Account</Link>
      {credits.data || onCredits ? <Link {...p} to="/settings/credits" id="settings-tab-credits"><Icon name="sparkles" />AI credits</Link> : null}
      <Link {...p} to="/settings/tokens"><Icon name="key" />API tokens</Link>
      <Link {...p} to="/settings/artifacts"><Icon name="file" />Artifact defaults</Link>
    </nav>
  );
}
