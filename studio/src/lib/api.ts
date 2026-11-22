// The control-plane API (/v1) as the studio's views call it, and what GET /v1 says about this server.
import { auth } from "../../store.ts";
import type * as API from "../../api-types.ts";

/** An API error: the server's message, and the HTTP status. */
export type ApiError = Error & { status: number };
/** What was thrown, as its message (an Error, or the API's error). */
export const errorMessage = (e: unknown): string => (e as Error).message;
export const statusOf = (e: unknown): number | undefined => (e as Partial<ApiError>).status;

/** Called when the server refuses the stored token (revoked elsewhere): the session drops it (session.ts). */
let onExpired = () => {};
export const setOnExpired = (fn: () => void) => void (onExpired = fn);

type Init = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };
/** A JSON API call; `T`: the response's shape (api-types.ts). Throws an ApiError when it isn't ok. */
export async function api<T = unknown>(path: string, init: Init = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", ...init.headers };
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401 && headers.authorization && auth.token) {
    // Token revoked (e.g. regenerated elsewhere): drop it and retry logged out.
    onExpired();
    return api<T>(path, init);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message ?? `${res.status}`), { status: res.status });
  return body;
}
/** A JSON body for `api`. */
export const json = (method: string, body: unknown): Init => ({ method, body: JSON.stringify(body) });

let metaReq: Promise<API.Meta> | undefined;
/** GET /v1: this server's settings (`{}` if it fails: everything may be missing). Asked once per page. */
export const meta = (): Promise<API.Meta> => metaReq ??= fetch("/v1").then((r) => r.json()).catch(() => ({}));
/** Projects need a session when this server offers login; without login set up the studio stays usable logged out. */
export const loginRequired = () => meta().then((m) => !!m.auth?.github);
export const mustLogIn = async () => !auth.token && await loginRequired();
