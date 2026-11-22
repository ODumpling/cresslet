// Who's logged in: the token (localStorage, store.ts `auth`) and what /v1/me says about its account. A store outside
// React (the API client and non-React modules change it too), read in components with useSession().
import { useSyncExternalStore } from "react";
import { auth } from "../../store.ts";
import type * as API from "../../api-types.ts";
import { api, meta, setOnExpired } from "./api.ts";
import { toast } from "./toast.tsx";

export interface Session {
  token: string | null;
  /** The account's GitHub login, else its email (shown in the sidebar). */
  email: string | null;
  /** Tells your own row apart (Share, org members, admin users); null until /v1/me answers. */
  accountId: string | null;
  siteAdmin: boolean;
  /** Organizations you're in (the sidebar shows Organizations when there are any). */
  orgs: API.MyOrg[];
}

let state: Session = { token: auth.token, email: auth.email, accountId: null, siteAdmin: false, orgs: [] };
const listeners = new Set<() => void>();
function set(next: Partial<Session>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}
export const session = () => state;
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useSession = () => useSyncExternalStore(subscribe, session, session);

/** Another tab logged in or out: follow it (views keyed on the token reload, so no other account's data stays shown). */
if (typeof window !== "undefined") {
  addEventListener("storage", (e) => {
    if (e.key !== "cresslet.token" && e.key !== "cresslet.email" && e.key !== null) return;
    if (auth.token === state.token) return set({ email: auth.email });
    set({ token: auth.token, email: auth.email, accountId: null, siteAdmin: false, orgs: [] });
    if (auth.token) refreshAccount();
  });
}

/** Stores a login (`token`) or what /v1/me said about the current one. */
export function setAccount(r: { token?: string; account: API.Account }) {
  if (r.token) auth.token = r.token;
  auth.email = r.account.github ?? r.account.email;
  const changed = state.token !== auth.token;
  set({ token: auth.token, email: auth.email, accountId: r.account.id, siteAdmin: r.account.role === "SiteAdmin", ...(changed ? { orgs: [] } : {}) });
  void loadMyOrgs();
}

export function logOut() {
  auth.token = null;
  auth.email = null;
  set({ token: null, email: null, accountId: null, siteAdmin: false, orgs: [] });
}
setOnExpired(() => {
  logOut();
  toast("Your session expired. Log in again.");
});

/** Role can change server-side: refresh it (shows the admin links to site admins). */
export function refreshAccount() {
  if (!auth.token) return Promise.resolve(null);
  return api<{ account: API.Account }>("/v1/me").then((r) => (setAccount(r), r.account), () => null);
}

export async function loadMyOrgs() {
  const token = auth.token;
  const orgs = token ? await api<{ orgs: API.MyOrg[] }>("/v1/orgs").then((r) => r.orgs, (): API.MyOrg[] => []) : [];
  if (auth.token === token) set({ orgs });
  return orgs;
}

/** Where to go once logged in (a hash route), kept across the GitHub round trip. */
export function rememberAfterLogin(hash: string) {
  try {
    sessionStorage.setItem("cresslet.afterLogin", hash);
  } catch { /* storage blocked: login lands on the home page */ }
}
export function takeAfterLogin() {
  try {
    const after = sessionStorage.getItem("cresslet.afterLogin");
    sessionStorage.removeItem("cresslet.afterLogin");
    return after;
  } catch {
    return null; // storage blocked
  }
}

/** To GitHub (the server redirects back to /#cresslet_login=<one-time code>); `after`: where to come back to. */
export async function logIn(after?: string) {
  if (after) rememberAfterLogin(after);
  if ((await meta()).auth?.github) location.href = "/v1/auth/github";
  else toast("Login isn't set up on this server (operator: set CRESSLET_GITHUB_CLIENT_ID / _SECRET).");
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
/** Finishes a login callback, if the page was opened with one. Resolves to where to go next (a hash route), if anywhere. */
export async function finishLogin(): Promise<string | null> {
  const p = pending;
  pending = null;
  if (!p) return null;
  if ("error" in p) {
    toast(`GitHub login failed: ${p.error}`);
    return null;
  }
  try {
    setAccount(await api<{ token: string; account: API.Account }>("/v1/auth/exchange", { method: "POST", body: JSON.stringify({ code: p.code }) }));
  } catch (e) {
    toast(`GitHub login failed: ${(e as Error).message}`);
    return null;
  }
  // Back to what needed the login (a private page, a project, the CLI login, artifacts).
  const after = takeAfterLogin();
  if (after?.startsWith("#/view/") || after?.startsWith("#/p/") || after === "#/cli" || after === "#/artifacts") return after;
  toast(`Logged in as ${auth.email}`);
  return null;
}
