# Cresslet app

Small web app deployed on Cresslet. Client: plain TS (bundled by esbuild). Server: one fetch handler in a sandbox with SQLite + file storage.

## Layout
- `index.html` — entry; `<script type="module" src="/src/main.ts">` is bundled.
- `src/` — client code. Import CSS/JSON/images directly.
- `public/` — copied as-is to the site root.
- `server/index.ts` — `export default { fetch(req) }`. Gets requests matching `routes` in `cresslet.json` (default `/api/*`). Everything else is static, with SPA fallback to `index.html`.
- Bindings and types come from the `cresslet` package: `import { db, files, secrets, app } from "cresslet"` (`Env`, `ScheduledEvent` types too).
- `cresslet.json` — `{ name, routes }`. `name` = subdomain (blank → assigned on first deploy).

## Commands
- `npm run dev` / `npx cresslet dev` — local dev server (http://localhost:3000), live reload, local SQLite in `.cresslet/dev/`.
- `npx cresslet build` — production build: client → `dist/`, server → `.cresslet/build/server.js`.
- `npx cresslet deploy` — build + deploy. Prints URL. First deploy creates the app and stores a deploy key in `.cresslet/app.json` (gitignored; keep it).
- `npx cresslet logs [-f]` — server logs + request log of the deployed app.
- `npx cresslet db [sql]` — inspect deployed DB (read-only).
- `npx cresslet secrets set KEY=value` — server secrets (`secrets.get("KEY")`). Needs `npx cresslet login` + `npx cresslet claim`. Locally: `.env.cresslet`.
- `npx cresslet open` — open deployed app.

## Server rules
- Web-standard APIs only: `fetch`, `Request`, `Response`, `URL`, `crypto`, `TextEncoder`, streams. No `fs`, `process`, `child_process`.
- npm packages are bundled into `server.js`; pure-JS packages only.
- DB (SQLite; write SQLite SQL): build statements with ``db.sql`... ${value}` `` (values become parameters, never SQL text). `await db.query(q)` → rows (or just `await q`), `db.first(q)` → row|null, `db.run(q)` → `{changes, lastInsertRowid}`, `db.exec(sql)` for DDL. `db.batch([q1, q2])` runs statements in one transaction (all or none, no other request in between): use it when several writes must land together. Create schema with `CREATE TABLE IF NOT EXISTS` on first request (see `server/index.ts`).
- Files: `files.put(key, body, {contentType})`, `get(key)` → `Response|null`, `delete`, `list(prefix)`.
- Secrets: `secrets.get("KEY")` (throws if unset), `secrets.optional("KEY")`. App: `app.name`, `app.url`.
- Use bindings inside `fetch()` / `scheduled()` (or functions they call), never at module top level: they don't exist until a handler runs.
- Outbound `fetch` and secrets only work on claimed apps. Unclaimed deploys expire after 72h.
- Each request has a 30s limit; memory 256MB. Keep state in `db`/`files`, not globals.

## Verify
After deploy: `curl <url>/api/health` and `npx cresslet logs`.
