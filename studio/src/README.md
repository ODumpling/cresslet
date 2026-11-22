# The studio's UI (React, TanStack Start in SPA mode)

`routes/` are the hash routes (`#/settings` → `routes/settings.tsx`; `routeTree.gen.ts` is generated from them by
`npm run dev`, `npm run build` or `node scripts/routes.ts`, and checked by `npm run check`). Each route renders a view
from `views/`. Code that isn't UI stays in the plain modules beside `src/` (`store.ts`, `builder.ts`,
`cresslet-plugin.ts`, `start-build.ts`, …).

## What every view uses

- **`useView(view, title, nav?)`** (`lib/hooks.ts`): sets the layout's `data-view` (`"landing"` and `"workspace"`
  have no sidebar), the sidebar link marked current (`nav`, defaults to `view`) and `document.title`
  (`"<title> · Cresslet Studio"`; `""` for the bare name; `null` leaves it alone).
- **A `<main>` with an `<h1 tabIndex={-1}>`**: on in-app navigation the layout scrolls to the top and focuses the
  visible view's `h1` (screen readers hear where they are). The first page load keeps the browser's focus. A view
  that only appears once something loaded calls `viewShown()` (`lib/focus.ts`) when it mounts.
- **`useLoad(load, deps)`**: loads on mount and when `deps` change; only the latest result is shown, and nothing that
  resolves after the view is gone. `reload()` resolves `true` once the new data is in the page (it commits with
  `flushSync`), so a caller can move focus right after.
- **`api<T>(path, init)`** (`lib/api.ts`): JSON in and out, the session's token sent; throws an `ApiError`
  (`message`, `status`). A 401 for the session's token logs out and retries logged out (a 401 for a token the tab has since left is just thrown). `meta()`: `GET /v1`, once per page.
- **`useSession()`** (`lib/session.ts`): `{ token, email, accountId, siteAdmin, orgs }`. Key a view's data on `token`
  (pass it in `useLoad` deps, or `key={token}`) so another account's data never stays shown. `logIn(after?)` goes to
  GitHub and comes back to `after` (a `#/…` hash); `logOut()`.
- **`toast(content, ms?)`** (`lib/toast.tsx`): the one toast. It stays open while hovered or focused (WCAG 2.2.1),
  Escape or × closes it, and it moves off the focused control (2.4.11). Form errors go beside their form instead
  (`<FormError>`), until the user changes the form.
- **Focus after a change** (`lib/focus.ts`): when an action re-renders a list and its button is gone, call
  `refocus(target)` after the new render is in the page (after `await reload()`, or after `flushSync(...)`): it
  focuses the rebuilt twin of the last focused control (same `id` or `aria-label`), else `target`, else the heading.
- Per-item controls get unique ids (`revoke-<id>`), so `refocus` and the e2e scripts find them.
- **Leaving a view mid-action**: check `useAlive()` (or that the `useLoad` reload resolved `true`) before touching
  the page after an `await`.
- Pieces: `ui/icons.tsx` (`Icon`, `SrOnly`, `ExtLink`), `ui/bits.tsx` (`TimeAgo`, `StatusPill`, `Stat`, `UsageBar`,
  `EmptyState`, `FormError`, `Field`, `DataTable`, `Seg`), `ui/SlugField.tsx` (the address picker), `lib/format.ts`.

## Imperative parts

The workspace's editor (CodeMirror), terminal (xterm) and container (cresslet-container) stay imperative: each is
created by the component that owns it on mount and disposed of on unmount, so leaving a project (or opening another)
leaves no workers or processes behind.
