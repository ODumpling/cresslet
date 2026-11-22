import { ClientOnly, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Layout } from "../ui/Layout.tsx";
import "../../vendor/xterm.css";
import "../../styles.css";

export const Route = createRootRoute({
  // Nothing renders server-side: the prerendered shell is just the document (the app needs the browser: hash routes,
  // localStorage, IndexedDB, the container).
  ssr: false,
  head: () => ({
    meta: [
      { charSet: "UTF-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1.0" },
      { name: "color-scheme", content: "dark light" },
      { title: "Cresslet Studio" },
    ],
    links: [{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }],
  }),
  shellComponent: Shell,
  component: () => <ClientOnly><Layout /></ClientOnly>,
});

/**
 * A script of this release that a newer one replaced (a cached shell or chunk asking for a hashed file that's gone):
 * the server answers with a reload module, but an import that needs its exports fails before that runs, at start-up
 * (a link error) or later (a route's chunk). Either way: load the current release, once a minute at most (a chunk
 * that's really broken doesn't reload forever). Inline and first, so it's listening before the app's modules load.
 */
const RECOVER = `(() => {
  const reload = () => {
    try {
      if (Date.now() - Number(sessionStorage.getItem("cresslet.reloadedAt") ?? 0) < 60000) return false;
      sessionStorage.setItem("cresslet.reloadedAt", String(Date.now()));
    } catch { return false; }
    const u = new URL(location.href);
    u.searchParams.set("_r", String(Date.now()));
    location.replace(u.pathname + u.search + u.hash);
    return true;
  };
  const stale = (m) => /does not provide an export|dynamically imported module|Importing a module script failed|Failed to fetch dynamically/i.test(String(m));
  addEventListener("vite:preloadError", (e) => { if (reload()) e.preventDefault(); });
  addEventListener("error", (e) => { if (stale(e.message)) reload(); });
  addEventListener("unhandledrejection", (e) => { if (stale(e.reason && e.reason.message)) reload(); });
})();`;

function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: RECOVER }} />
        <HeadContent />
        {/* here, not in head(): it keeps one meta per name */}
        <meta name="theme-color" content="#09090b" media="(prefers-color-scheme: dark)" />
        <meta name="theme-color" content="#fafafa" media="(prefers-color-scheme: light)" />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
