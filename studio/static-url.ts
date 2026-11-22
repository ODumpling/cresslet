// Files the studio serves as they are at stable URLs from its root (studio/vite.config.ts `staticFiles`), not
// bundled: the page fetches them (the SDK source, the Start compiler service) or hands them to the container (the
// preview server worker). The page's bundled modules live under /assets/, so `import.meta.url` there won't do.

/** The build's id for those files (vite.config.ts `define`); not defined under Node (tests). */
declare const __STUDIO_STATIC__: string | undefined;

/**
 * `path` (relative, e.g. "server-worker.js") at the studio's root in the page, with `?v=<build>` so a CDN that keeps
 * "no-cache" files for hours (as it can) can't pair this build's page with an older one's file; under Node (tests),
 * beside this file.
 */
export function staticUrl(path: string) {
  if (!globalThis.location?.origin) return new URL(path, import.meta.url);
  const u = new URL(path, `${globalThis.location.origin}/`);
  if (typeof __STUDIO_STATIC__ === "string") u.searchParams.set("v", __STUDIO_STATIC__);
  return u;
}
