import { createHashHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";
import { takeLoginCallback } from "./lib/session.ts";

/**
 * The studio's router: hash URLs (`#/p/<id>`, `#/settings`), so every link from outside keeps working (the GitHub
 * login callback, the private-page redirect, CLI login, bookmarks). Server-side (the prerendered shell) it's never
 * shown: the root route is client-only.
 */
export function getRouter() {
  if (typeof window !== "undefined") {
    // The login callback's #cresslet_login=… isn't a route: read it and take it off the address first.
    takeLoginCallback();
    // `_r`: a page from an earlier release reloaded into this one (server/studio.ts); it's done its job.
    const u = new URL(location.href);
    if (u.searchParams.has("_r")) {
      u.searchParams.delete("_r");
      history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    }
  }
  return createRouter({
    routeTree,
    history: typeof window === "undefined" ? undefined : createHashHistory(),
    defaultPreload: false,
    // Search params as plain strings (`?path=/x`), as the server writes them (server/host.ts), not JSON.
    parseSearch: (s) => Object.fromEntries(new URLSearchParams(s)),
    stringifySearch: (o) => {
      const q = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
      return q ? `?${q}` : "";
    },
    // Views keep their own scroll and focus (Layout: focus the heading on navigation).
    scrollRestoration: false,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
