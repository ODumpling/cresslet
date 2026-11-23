// The control-plane API (/v1) as the studio's views call it, and what GET /v1 says about this server.
import { auth } from "../../store.ts";
import type * as API from "../../api-types.ts";

/** An API error: the server's message, and the HTTP status. */
export type ApiError = Error & { status: number; code?: string; body?: Record<string, unknown> };
/** What was thrown, as its message (an Error, or the API's error). */
export const errorMessage = (e: unknown): string => (e as Error).message;
export const statusOf = (e: unknown): number | undefined => (e as Partial<ApiError>).status;

/** Called when the server refuses this browser's session (revoked elsewhere): the session drops it (session.ts). */
let onExpired = () => {};
export const setOnExpired = (fn: () => void) => void (onExpired = fn);

type Init = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };
/** A JSON API call; `T`: the response's shape (api-types.ts). Throws an ApiError when it isn't ok. */
export function api<T = unknown>(path: string, init: Init = {}): Promise<T> {
  return call<T>(path, init, false);
}
/**
 * `anonymous`: without the session cookie (the retry after it was refused). Logged out, it isn't sent either (unless
 * `init.credentials` says: a login, whose answer sets it), so it never acts for a tab that shows no login.
 */
async function call<T>(path: string, init: Init, anonymous: boolean): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", ...init.headers };
  const sent = anonymous ? null : auth.user;
  const res = await fetch(path, { ...init, headers, credentials: init.credentials ?? (sent ? "same-origin" : "omit") });
  // GitHub access expired (source control): the Cresslet session is fine, the user reconnects GitHub.
  const gitReauth = res.status === 401 && (await res.clone().json().catch(() => null))?.error === "git_reauth_required";
  if (res.status === 401 && sent && auth.user === sent && !gitReauth) {
    // Session revoked (logged out elsewhere, its token revoked in API tokens): drop it and retry logged out. (If the session changed meanwhile,
    // the refusal was for the old account: it's reported below, never sent again as the new one.)
    onExpired();
    return call<T>(path, init, true); // logged out, even if another tab logs in meanwhile
  }
  const body = await res.json().catch(() => ({}));
  // `code`: the API's error code (`body`: the rest of the error, e.g. a merge conflict's paths).
  if (!res.ok) throw Object.assign(new Error(body.message ?? `${res.status}`), { status: res.status, code: body.error, body });
  return body;
}
/** A JSON body for `api`. */
export const json = (method: string, body: unknown): Init => ({ method, body: JSON.stringify(body) });

let metaReq: Promise<API.Meta> | undefined;
/** GET /v1: this server's settings (`{}` if it fails: everything may be missing). Asked once per page. */
export const meta = (): Promise<API.Meta> => metaReq ??= fetch("/v1", { credentials: "omit" }).then((r) => r.json()).catch(() => {
  metaReq = undefined; // a failure isn't kept: the next call asks again
  return {};
});
/** Projects need a session when this server offers login; without login set up the studio stays usable logged out. */
export const loginRequired = () => meta().then((m) => !!m.auth?.github || !!m.auth?.password);
export const mustLogIn = async () => !auth.user && await loginRequired();
