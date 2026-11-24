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
- `npx cresslet secrets set KEY=value` — server secrets (`secrets.get("KEY")`). Needs `npx cresslet login`. Locally: `.env.cresslet`.
- `npx cresslet open` — open deployed app.

## Server rules
- Web-standard APIs only: `fetch`, `Request`, `Response`, `URL`, `crypto`, `TextEncoder`, streams. No `fs`, `process`, `child_process`.
- npm packages are bundled into `server.js`; pure-JS packages only.
- DB (SQLite; write SQLite SQL): build statements with ``db.sql`... ${value}` `` (values become parameters, never SQL text). `await db.query(q)` → rows (or just `await q`), `db.first(q)` → row|null, `db.run(q)` → `{changes, lastInsertRowid}`, `db.exec(sql)` for DDL. `db.batch([q1, q2])` runs statements in one transaction (all or none, no other request in between): use it when several writes must land together. Tables: Drizzle (below). The example table in `server/index.ts` is a placeholder: replace it with a Drizzle schema when the app needs tables.
- Files: `files.put(key, body, {contentType})`, `get(key)` → `Response|null`, `delete`, `list(prefix)`.
- Secrets: `secrets.get("KEY")` (throws if unset), `secrets.optional("KEY")`. App: `app.name`, `app.url`.
- Use bindings inside `fetch()` / `scheduled()` (or functions they call), never at module top level: they don't exist until a handler runs.
- Deploying needs `npx cresslet login`: every app belongs to an account.
- Each request has a 30s limit; memory 256MB. Keep state in `db`/`files`, not globals.

## Database tables: Drizzle
When the app needs tables of its own, use Drizzle through `cresslet/drizzle`. Don't write migration SQL by hand, and don't
add `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` to request code. Full guide: `node_modules/cresslet/README.md`
("Database schema: Drizzle").
1. `npm i drizzle-orm && npm i -D drizzle-kit`
2. `drizzle.config.ts`: `defineConfig({ dialect: "sqlite", driver: "durable-sqlite", schema: "./server/schema.ts", out: "./drizzle" })`
   (`driver: "durable-sqlite"` makes drizzle-kit write `drizzle/migrations.js`).
3. Tables in `server/schema.ts` (`sqliteTable` from `drizzle-orm/sqlite-core`). Add `drizzle/migrations.d.ts` once:
   `declare const migrations: import("cresslet/drizzle").Migrations; export default migrations;`
4. `npx drizzle-kit generate` after every schema change (and before the first deploy); commit all of `drizzle/`. Never
   edit or delete a migration that has been deployed: generate a new one.
5. Server: `const orm = drizzle(db, { schema })` (module top level is fine), and `await migrate(db, migrations)` where
   every request passes first (the top of `fetch()`, and of `scheduled()`), with `import migrations from "../drizzle/migrations"`.
- `orm.batch([...])` for writes that must land together (one transaction). `orm.transaction()` throws: use `orm.batch`.

## Verify
After deploy: `curl <url>/api/health` and `npx cresslet logs`.
