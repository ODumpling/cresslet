// Who's logged in: this browser's session (an HttpOnly cookie the page never reads; `auth.user` in localStorage says
// it's there, and whose) and what /v1/me says about its account. A store outside React (the API client and non-React
// modules change it too), read in components with useSession().
import { useEffect, useState, useSyncExternalStore } from "react";
import { auth } from "../../store.ts";
import type * as API from "../../api-types.ts";
import { api, meta, setOnExpired } from "./api.ts";
import { toast } from "./toast.tsx";

export interface Session {
  /** The logged-in account's id as this browser stored it at login (not a credential), or null: logged out. */
  user: string | null;
  /** The account's GitHub login, else its email (shown in the sidebar). */
  email: string | null;
  /** Tells your own row apart (Share, org members, admin users); null until /v1/me answers. */
  accountId: string | null;
  siteAdmin: boolean;
  /** Organizations you're in (the sidebar shows Organizations when there are any). */
  orgs: API.MyOrg[];
}

let state: Session = { user: auth.user, email: auth.email, accountId: null, siteAdmin: false, orgs: [] };
const listeners = new Set<() => void>();
function set(next: Partial<Session>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}
/**
 * The session, as stored: localStorage's login (a write there in this tab counts too: `session()` and each navigation
 * pick it up).
 */
export const session = () => {
  const user = auth.user;
  if (user !== state.user) state = { user, email: auth.email, accountId: null, siteAdmin: false, orgs: [] };
  return state;
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useSession = () => useSyncExternalStore(subscribe, session, session);

/**
 * Another tab logged in or out, or this tab's storage changed before a navigation: follow it (views keyed on the login
 * reload, so no other account's data stays shown). The layout loads the new login's account.
 */
if (typeof window !== "undefined") {
  const sync = () => {
    const before = state;
    if (session() !== before) for (const l of listeners) l();
    else if (auth.email !== state.email && auth.user) set({ email: auth.email });
  };
  addEventListener("storage", (e) => (e.key === "cresslet.user" || e.key === "cresslet.email" || e.key === null) && sync());
  addEventListener("hashchange", sync);
  addEventListener("popstate", sync);
}

/**
 * A login (the server set the session cookie: no `sentWith`), or what /v1/me said about the current one; `sentWith`:
 * the login that /v1/me call was sent with (an answer about an account this tab has since left is dropped).
 */
export function setAccount(account: API.Account, sentWith?: string | null) {
  if (sentWith !== undefined && sentWith !== auth.user) return;
  auth.user = account.id;
  auth.email = account.github ?? account.email;
  const changed = state.user !== auth.user;
  set({ user: auth.user, email: auth.email, accountId: account.id, siteAdmin: account.role === "SiteAdmin", ...(changed ? { orgs: [] } : {}) });
  void loadMyOrgs();
}

/** Forgets the login here (every tab follows); the server already ended the session (it refused it). */
function forget() {
  auth.user = null;
  auth.email = null;
  set({ user: null, email: null, accountId: null, siteAdmin: false, orgs: [] });
}

/** Logs this browser out: the server revokes the session's token and drops its cookie. */
export async function logOut() {
  forget();
  const res = await fetch("/v1/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => null);
  if (!res?.ok) toast("Couldn't end the session on the server: revoke it in Settings › API tokens.");
}
let expired = false;
/**
 * The server refused this page's session (revoked elsewhere) since the page loaded: a view opened meanwhile may still
 * show (Settings: it checks the account itself, as the old studio did).
 */
export const sessionExpired = () => expired;
setOnExpired(() => {
  expired = true;
  forget();
  toast("Your session expired. Log in again.");
});

let migrating: Promise<void> | undefined;
/**
 * A token stored in localStorage before session cookies: handed to the server, which keeps it in the cookie, and
 * dropped from storage. Started as the page loads; the layout shows no view until it's done (none loads logged out).
 */
function moveLegacyToken(): Promise<void> | undefined {
  const token = auth.legacyToken;
  if (!token) return migrating;
  return migrating ??= (async () => {
    try {
      const res = await fetch("/v1/auth/session", { method: "POST", headers: { authorization: `Bearer ${token}` }, credentials: "same-origin" });
      if (res.ok) {
        auth.legacyToken = null;
        setAccount(((await res.json()) as { account: API.Account }).account);
      } else if (res.status === 401 || res.status === 403) {
        auth.legacyToken = null; // revoked, or not a full-access token: log in again
        if (auth.user) forget();
      }
      // Otherwise (the server's down): kept for the next page load.
    } catch { /* offline: next time */ }
    migrating = undefined;
  })();
}
if (typeof window !== "undefined") void moveLegacyToken();
/** True while a stored token moves to the session cookie (see moveLegacyToken). */
export function useMovingSession() {
  const [moving, setMoving] = useState(!!migrating);
  useEffect(() => void migrating?.then(() => setMoving(false)), []);
  return moving;
}

/** Role can change server-side: refresh it (shows the admin links to site admins). */
export function refreshAccount() {
  const sent = auth.user;
  if (!sent) return Promise.resolve(null);
  return api<{ account: API.Account }>("/v1/me").then((r) => (setAccount(r.account, sent), r.account), () => null);
}

export async function loadMyOrgs() {
  const user = auth.user;
  const orgs = user ? await api<{ orgs: API.MyOrg[] }>("/v1/orgs").then((r) => r.orgs, (): API.MyOrg[] => []) : [];
  if (auth.user === user) set({ orgs });
  return orgs;
}

/** Where to go once logged in (a studio path), kept across the GitHub round trip. */
export function rememberAfterLogin(path: string) {
  try {
    sessionStorage.setItem("cresslet.afterLogin", path);
  } catch { /* storage blocked: login lands on the home page */ }
}
export function takeAfterLogin() {
  try {
    const after = sessionStorage.getItem("cresslet.afterLogin");
    sessionStorage.removeItem("cresslet.afterLogin");
    return after?.replace(/^#/, "") ?? null; // `#/…`: stored before the studio's routes were paths
  } catch {
    return null; // storage blocked
  }
}

/**
 * To the login page (/login: email + password, and GitHub if the server has both), or straight to GitHub (the server
 * redirects back to /#cresslet_login=<one-time code>); `after`: where to come back to.
 */
export async function logIn(after?: string) {
  if (after) rememberAfterLogin(after);
  const m = await meta();
  if (m.auth?.password) location.href = "/login";
  else if (m.auth?.github) location.href = "/v1/auth/github";
  else toast("Login isn't set up on this server (operator: set CRESSLET_GITHUB_CLIENT_ID / _SECRET, or CRESSLET_PASSWORD_LOGIN).");
}

/**
 * How a login button reads: "Log in" when the server has password login (the login page offers the rest), else
 * "Log in with GitHub" (GitHub's icon), as before GET /v1 answers.
 */
export function useLoginButton(): { icon: string; label: string } {
  const [password, setPassword] = useState(false);
  useEffect(() => void meta().then((m) => setPassword(!!m.auth?.password)), []);
  return password ? { icon: "login", label: "Log in" } : { icon: "github", label: "Log in with GitHub" };
}

/** Where a finished login goes back to (what needed it: a private page, a project, the CLI login, artifacts), if anywhere. */
export function afterLoginPath(): string | null {
  const after = takeAfterLogin();
  return after?.startsWith("/view/") || after?.startsWith("/p/") || after === "/cli" || after === "/artifacts" || after === "/settings" || after?.startsWith("/settings/") ? after : null;
}

/** The login callback's hash, read (and removed from the address) before the router starts: src/router.tsx. */
let pending: { code: string } | { error: string } | null = null;
export function takeLoginCallback() {
  const h = new URLSearchParams(location.hash.slice(1));
  const code = h.get("cresslet_login"), error = h.get("cresslet_login_error");
  if (!code && !error) return;
  history.replaceState(null, "", location.pathname + location.search);
  pending = error ? { error } : { code: code! }; // one of them is set
}
/** Finishes a login callback, if the page was opened with one. Resolves to where to go next (a studio path), if anywhere. */
export async function finishLogin(): Promise<string | null> {
  const p = pending;
  pending = null;
  if (!p) return null;
  if ("error" in p) {
    toast(`GitHub login failed: ${p.error}`);
    return null;
  }
  try {
    setAccount((await api<{ account: API.Account }>("/v1/auth/exchange", { method: "POST", body: JSON.stringify({ code: p.code }), credentials: "same-origin" })).account);
  } catch (e) {
    toast(`GitHub login failed: ${(e as Error).message}`);
    return null;
  }
  const after = afterLoginPath();
  if (after) return after;
  toast(`Logged in as ${auth.email}`);
  return null;
}
