// The admin pages' layout (also your organizations' pages): a heading, a subtitle, actions (Refresh), a body that
// shows Loading…, the load's error (403: only site admins), or the page. And the pieces they share: row actions,
// reloading after a change.
import { useNavigate } from "@tanstack/react-router";
import { type DependencyList, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ApiError } from "../../lib/api.ts";
import { errorMessage } from "../../lib/api.ts";
import { refocus } from "../../lib/focus.ts";
import { type Loaded, useAlive, useLoad } from "../../lib/hooks.ts";
import { useSession } from "../../lib/session.ts";
import { toast } from "../../lib/toast.tsx";
import { Icon } from "../../ui/icons.tsx";

/** The page's frame (`#admin`): title, subtitle, actions and body. */
export function AdminPage({ title, sub = "", actions, children }: { title: ReactNode; sub?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <main id="admin" className="page wide" aria-labelledby="admin-title">
      <header className="page-head">
        <div>
          <h1 id="admin-title" tabIndex={-1}>{title}</h1>
          <p className="muted" id="admin-sub">{sub}</p>
        </div>
        <div className="row start" id="admin-actions">{actions}</div>
      </header>
      <section id="admin-body" aria-labelledby="admin-title">{children}</section>
    </main>
  );
}

/** The first button in the page's actions (Refresh, after a Retry). */
const firstAction = () => document.querySelector<HTMLElement>("#admin-actions button");

/**
 * A page's data, loaded for the logged-in account (logged out: to the home page). Keyed on the session token, so
 * another account's data is never shown.
 */
export function useAdminLoad<T>(load: () => Promise<T>, deps: DependencyList = []): Loaded<T> {
  const { token } = useSession();
  const navigate = useNavigate();
  useEffect(() => {
    if (!token) void navigate({ to: "/", replace: true });
  }, [token, navigate]);
  return useLoad(() => (token ? load() : new Promise<T>(() => {})), [token, ...deps]);
}

/** After a change: load again, then (if the page is still here) move focus to `focus()`, else its twin or the heading. */
export function useAgain(reload: () => Promise<boolean>) {
  const alive = useAlive();
  return useCallback(async (focus?: () => HTMLElement | null) => {
    if (!alive.current) return;
    if (await reload()) refocus(focus?.());
  }, [reload, alive]);
}

/** Refresh: loads again, keeping focus on it. */
export function RefreshButton({ reload }: { reload: () => Promise<boolean> }) {
  return (
    <button className="btn" type="button" onClick={() => void reload().then((ok) => ok && refocus(firstAction()))}>
      <Icon name="refresh" />Refresh
    </button>
  );
}

/**
 * The page around a load: Loading…, its error (with Retry unless `retry` is false, or the API said 403), or
 * `children(data)`; `actions(data)` beside the title once it's loaded. `retryFocus`: after a Retry that worked, focus
 * the first action (lists) or the heading (one item).
 */
export function AdminView<T>({ loaded, title, sub, actions, children, errorText, retry = true, retryFocus = "action" }: {
  loaded: Loaded<T>;
  title: ReactNode;
  sub?: string;
  actions?: (d: T) => ReactNode;
  children: (d: T) => ReactNode;
  errorText?: (e: ApiError) => string;
  retry?: boolean;
  retryFocus?: "action" | "heading";
}) {
  const { data, error, reload } = loaded;
  const retryRef = useRef<HTMLButtonElement>(null);
  const showRetry = !!error && retry && error.status !== 403;
  useLayoutEffect(() => {
    if (error) refocus(retryRef.current); // the Refresh/Retry that was clicked is gone
  }, [error]);
  return (
    <AdminPage
      title={title}
      sub={sub}
      actions={error ? (showRetry ? (
        <button className="btn" type="button" ref={retryRef} onClick={() => void reload().then((ok) => ok && refocus(retryFocus === "action" ? firstAction() : null))}>
          <Icon name="refresh" />Retry
        </button>
      ) : null) : data !== undefined ? actions?.(data) : null}
    >
      {error ? <p className="error">{errorText ? errorText(error) : error.status === 403 ? "Only site admins can see this page." : `Could not load: ${error.message}`}</p>
        : data !== undefined ? children(data)
        : <p className="muted">Loading…</p>}
    </AdminPage>
  );
}

/** Thrown by a row action's `run` when its confirmation is declined (or it reported its own error): nothing to report. */
export const CANCELLED = Symbol("cancelled");

/**
 * A row action's button: disabled while `run` is in flight; then toasts `done` and calls `after`, or toasts the error
 * and is usable again (focus back on it).
 */
export function RowAction({ label, aria, run, done, after, danger, id }: {
  label: string;
  aria: string;
  run: () => Promise<unknown>;
  done?: string;
  after: () => unknown;
  danger?: boolean;
  id?: string;
}) {
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const alive = useAlive();
  async function click() {
    setBusy(true);
    try {
      await run();
    } catch (e) {
      if (e !== CANCELLED) toast(errorMessage(e));
      if (alive.current) {
        flushSync(() => setBusy(false));
        refocus(ref.current);
      }
      return;
    }
    if (done) toast(done);
    after();
  }
  return (
    <button ref={ref} className={`btn sm${danger ? " danger" : ""}`} type="button" id={id} aria-label={aria} disabled={busy} onClick={() => void click()}>
      {label}
    </button>
  );
}

/** Pluralized "n thing(s) shown", for the lists' sr-only status. */
export const shownText = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"} shown`;
