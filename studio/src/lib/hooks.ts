// Hooks every view uses: what the layout shows (useView), and data that loads (useLoad).
import { createContext, type DependencyList, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ApiError } from "./api.ts";

/**
 * Which view is showing: the layout's `data-view` (the landing and the workspace have no sidebar) and the sidebar
 * link marked current (`nav`, a key of Layout's NAV).
 */
export interface ViewInfo {
  view: string;
  nav?: string;
}
export const ViewContext = createContext<(v: ViewInfo) => void>(() => {});
/** Sets the layout for this view and the document title (`title`, without the " · Cresslet Studio"). */
export function useView(view: string, title: string | null, nav: string = view) {
  const set = useContext(ViewContext);
  useLayoutEffect(() => set({ view, nav }), [set, view, nav]);
  useEffect(() => {
    if (title !== null) document.title = title ? `${title} · Cresslet Studio` : "Cresslet Studio";
  }, [title]);
}

export interface Loaded<T> {
  data?: T;
  error?: ApiError;
  loading: boolean;
  /**
   * Loads again (keeping what's shown meanwhile). Resolves true once the new data is in the page (so a caller may move
   * focus), false if a later load or leaving the view superseded it.
   */
  reload: () => Promise<boolean>;
}
/**
 * `load` when the view mounts and whenever `deps` change; only the latest load's result is shown (an older, slower
 * one is dropped, as is anything that resolves after the view is gone). `keep`: keep the old data while reloading
 * after a deps change, and beside the error if that fails (otherwise it's cleared, so another app's or account's
 * data isn't shown meanwhile).
 */
export function useLoad<T>(load: () => Promise<T>, deps: DependencyList, { keep = false } = {}): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: true });
  const gen = useRef(0);
  const run = useCallback(load, deps);
  const reload = useCallback(async () => {
    const my = ++gen.current;
    try {
      const data = await run();
      if (my !== gen.current) return false;
      flushSync(() => setState({ data, loading: false }));
    } catch (e) {
      if (my !== gen.current) return false;
      flushSync(() => setState((s) => ({ ...(keep ? { data: s.data } : {}), error: e as ApiError, loading: false })));
    }
    return true;
  }, [run, keep]);
  useEffect(() => {
    setState((s) => (keep ? { ...s, loading: true } : { loading: true }));
    void reload();
    return () => void gen.current++;
  }, [reload, keep]);
  return { ...state, reload };
}

/** False once the component is gone: an action that resolves after the user left the view leaves the new one alone. */
export function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  return alive;
}
