# Metadata database

Cresslet's own data (accounts, tokens, apps, deploys, secrets, domains, collaborators, page sessions, rate limits, AI credits) lives in one database, behind `Store` ([`server/store.ts`](../server/store.ts)):

| | When | Where |
|---|---|---|
| SQLite (default) | `CRESSLET_DATABASE_URL` unset | `<data dir>/cresslet.db` |
| Postgres (15 to 17 tested) | `CRESSLET_DATABASE_URL=postgres://user:pass@host:5432/db` | tables in `CRESSLET_DATABASE_SCHEMA` (default `public`), created on first start |

Apps' own databases (`env.db`) stay SQLite files in the data dir either way: their SQL dialect is part of the app API ([app format](app-format.md)). Deploys, app files and `secrets.key` stay in the data dir too, so a server on Postgres still needs its volume, and every server sharing one Postgres database needs the same secrets key (`CRESSLET_SECRETS_KEY`, or the same `secrets.key`).

Every `Store` method is async. [`server/db.ts`](../server/db.ts) gives both databases one small interface (`all`, `get`, `run`, `exec`, `tx`, `lock`): SQL is written once with `?` placeholders in the SQL both understand, and `Store` branches on `db.dialect` for the few queries that differ (JSON functions, `MAX`/`GREATEST`). Writes that read first (rate limits, quota checks before creating an app, AI wallets, sandbox uid numbers, invites) run in a transaction holding a lock on their key (`Store.serialized`): Postgres takes a transaction-scoped advisory lock, so they don't race across servers sharing the database either; SQLite runs one transaction at a time.

## Schema migrations

[`server/migrations.ts`](../server/migrations.ts) lists every migration, numbered. On start the server applies the ones the database hasn't had, in order, all in one transaction (all or none), and records each in `schema_migrations` (`version`, `name`, `applied_at`). On Postgres it holds an advisory lock while doing so: servers starting together apply each migration once.

- Version 1 (`baseline`) is the schema as of this release. On Postgres it creates the tables. On SQLite it upgrades a database from any earlier release in place (they added columns as they went, before migrations were recorded), so existing `cresslet.db` files carry on.
- Version 2 (`orgs`) adds disabled and invited accounts (`accounts.disabled_at`, `disabled_email`, `disabled_github_id`, `invited_at`, `invited_by`), organizations (`orgs`, `org_members`) and `apps.org_id`. A release from before it, after a rollback, ignores them: org apps go back to their `account_id` holder (kept an org admin or member), and disabled accounts stay locked out (no tokens; email and GitHub id moved aside).
- To change the schema, append a migration with the next number and give each dialect its SQL:

  ```ts
  {
    version: 2,
    name: "apps.description",
    up: (db) => db.exec("ALTER TABLE apps ADD COLUMN description TEXT"),
  },
  ```

  Postgres types: `BIGINT` for timestamps (ms) and counters, `BYTEA` for blobs, `COLLATE "C"` on text that's sorted (byte order, as in SQLite). Add the table to `TABLES` (foreign-key order) if it's new, so copies include it.
- Rules: never edit, renumber or remove a migration that has shipped. Expand, then contract: a migration only adds (tables, nullable columns or ones with a default, indexes), so the previous release still runs against the new schema after a rollback. Drop or rename only in a later release, once no release you'd roll back to reads the old shape.
- A database with migrations the server doesn't know (a newer release ran against it, then was rolled back) still starts, with a warning naming them.
- `node server/db-migrate.ts status` lists what's applied to the configured database.
- `tests/database_test.ts` covers the runner on both databases (order, all or nothing, a newer database, concurrent starts); `npm run test:pg` runs every test against Postgres.

## Moving to Postgres

[`server/db-migrate.ts`](../server/db-migrate.ts) copies the metadata between the two. It reads `CRESSLET_DATA_DIR`, `CRESSLET_DATABASE_URL` and `CRESSLET_DATABASE_SCHEMA` like the server, and it's in the image: with [Compose](self-hosting.md#production), `docker compose exec cresslet node server/db-migrate.ts …` while the server runs, `docker compose run --rm cresslet node server/db-migrate.ts …` while it's stopped (add `-e CRESSLET_DATABASE_URL=…` until it's in the server's environment).

- The source isn't changed: SQLite is read from a snapshot (consistent while the server runs), with this release's pending migrations applied to the snapshot.
- The target must be empty. Everything is copied in one transaction; before committing, each table's rows are compared (count and a digest of every row) and every app's secrets are decrypted on both sides and compared. Any difference rolls it all back.
- `--dry-run` does all of that, then rolls back: no rows are written, and generated ids start where they did (the target keeps the empty tables, created as a server's first start would).

Cutover:

1. Back up the data volume ([Backups](self-hosting.md#backups)).
2. Create the database and a user for it: `CREATE USER cresslet PASSWORD '…'; CREATE DATABASE cresslet OWNER cresslet;`. A user that doesn't own the database needs `USAGE` and `CREATE` on the schema (`CRESSLET_DATABASE_SCHEMA`), which must then exist.
3. Rehearse while the server runs: `CRESSLET_DATABASE_URL=… node server/db-migrate.ts to-postgres --dry-run`. It prints each table's row count and digest, and `dry run: verified, rolled back`.
4. Stop the server (writes after the copy's snapshot aren't copied), then copy for real: `CRESSLET_DATABASE_URL=… node server/db-migrate.ts to-postgres` (`copied and verified: committed`).
5. Set `CRESSLET_DATABASE_URL` (and `CRESSLET_DATABASE_SCHEMA` if not `public`) in the server's environment and start it. `cresslet.db` stays in the volume, untouched, until you remove it.

Rolling back:

- Before the server on Postgres took writes: unset `CRESSLET_DATABASE_URL` and start it; it uses `cresslet.db` as it was.
- After: stop it, `node server/db-migrate.ts to-sqlite --out /data/from-postgres` (same checks), move `/data/cresslet.db` aside, move `/data/from-postgres/cresslet.db` in, unset `CRESSLET_DATABASE_URL`, start.

Backups on Postgres: [`deploy/backup.sh`](../deploy/backup.sh) still snapshots the volume (deploys, app databases and files; it says the metadata isn't in it); back up the database with `pg_dump` (or the provider's backups) at the same time. Both need the same `secrets.key`.
