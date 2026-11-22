// Files the studio serves as they are at stable URLs from its root (studio/vite.config.ts `staticFiles`), not
// bundled: the page fetches them (the SDK source, the Start compiler service) or hands them to the container (the
// preview server worker). The page's bundled modules live under /assets/, so `import.meta.url` there won't do.

/** `path` (relative, e.g. "server-worker.js") at the studio's root in the page; under Node (tests), beside this file. */
export const staticUrl = (path: string) =>
  new URL(path, globalThis.location?.origin ? `${globalThis.location.origin}/` : import.meta.url);
