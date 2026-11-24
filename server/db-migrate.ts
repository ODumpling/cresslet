// Moves the metadata database between SQLite and Postgres (docs/database.md), and reports schema versions.
//
//   node server/db-migrate.ts status                   applied migrations of the configured database
//   node server/db-migrate.ts to-postgres [--dry-run]  <dataDir>/cresslet.db → CRESSLET_DATABASE_URL
//   node server/db-migrate.ts to-sqlite --out <dir>    CRESSLET_DATABASE_URL → <dir>/cresslet.db (to go back)
//
// The source isn't changed: SQLite is read from a snapshot (consistent even while a server runs), Postgres only
// read (after applying this release's pending migrations, as a server would). The target must be empty. Everything is copied in one transaction, then compared row for row
// (and every secret decrypted on both sides) before it commits; --dry-run rolls back after the comparison
// (the target keeps its empty tables, created as a server's first start would).
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { type Db, type Param, PostgresDb } from "./db.ts";
import { MIGRATIONS, TABLES } from "./migrations.ts";
import { type DatabaseConfig, Store } from "./store.ts";

/** Tables that keep SQLite's implicit `rowid` (lists sort by it); Postgres has it as a column. */
const ROWID_TABLES = new Set(["tokens", "deploys", "collaborators", "invites", "org_members"]);
/** Columns Postgres generates (identity): their sequences continue after the copied rows. */
const IDENTITY: Record<string, string> = { tokens: "rowid", deploys: "rowid", collaborators: "rowid", invites: "rowid", org_members: "rowid", ai_ledger: "id" };

async function columns(db: Db, table: string): Promise<string[]> {
  const cols = db instanceof PostgresDb
    ? (await db.all<{ name: string }>(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
      db.schema, table,
    )).map((c) => c.name)
    : (await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((c) => c.name);
  if (db.dialect === "sqlite" && ROWID_TABLES.has(table)) cols.push("rowid");
  return cols;
}

const norm = (v: unknown) =>
  v === null || v === undefined ? "N" : v instanceof Uint8Array ? "b" + Buffer.from(v).toString("hex")
  : typeof v === "number" || typeof v === "bigint" ? "n" + String(v) : "s" + String(v);

/** Row count and a digest of the rows (order-independent) over `cols`. */
async function digest(db: Db, table: string, cols: string[]) {
  const rows = await db.all<Record<string, unknown>>(`SELECT ${cols.join(", ")} FROM ${table}`);
  const lines = rows.map((r) => JSON.stringify(cols.map((c) => norm(r[c])))).sort();
  const h = createHash("sha256");
  for (const l of lines) h.update(l).update("\n");
  return { rows: rows.length, sha256: h.digest("hex") };
}

export interface TableReport {
  table: string;
  rows: number;
  sha256: string;
}

export interface CopyReport {
  tables: TableReport[];
  secrets: number;
  committed: boolean;
}

/**
 * Copies every row from `from` into the empty `to` (both opened by Store.open, so both are at the current
 * schema) in one transaction, and checks the copy before committing: per table, row counts and digests
 * match, and every app's secrets decrypt to the same values. Throws (rolled back) on any difference.
 */
export async function copyStore(from: Store, to: Store, opts: { dryRun?: boolean } = {}): Promise<CopyReport> {
  const versions = async (s: Store) => (await s.db.all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version")).map((r) => r.version);
  const [fv, tv] = [await versions(from), await versions(to)];
  if (JSON.stringify(fv) !== JSON.stringify(tv)) throw new Error(`schema versions differ: source ${fv.join(",")}, target ${tv.join(",")}`);
  const known = MIGRATIONS.map((m) => m.version);
  if (fv.some((v) => !known.includes(v))) throw new Error("the source has migrations this release doesn't know: use the release that wrote it");

  for (const t of TABLES) {
    const { n } = (await to.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${t}`))!;
    if (n) throw new Error(`target table ${t} isn't empty (${n} rows): copy into an empty database`);
  }

  const rollback = new Error("dry run");
  let report: CopyReport | undefined;
  try {
    await to.db.tx(async () => {
      const tables: TableReport[] = [];
      for (const t of TABLES) {
        const target = await columns(to.db, t);
        const cols = (await columns(from.db, t)).filter((c) => target.includes(c));
        const rows = await from.db.all<Record<string, unknown>>(`SELECT ${cols.join(", ")} FROM ${t}`);
        // Batches under both databases' parameter limits.
        const per = Math.max(1, Math.floor(30_000 / cols.length));
        for (let i = 0; i < rows.length; i += per) {
          const batch = rows.slice(i, i + per);
          const values = batch.map(() => `(${cols.map(() => "?").join(", ")})`).join(", ");
          await to.db.run(`INSERT INTO ${t} (${cols.join(", ")}) VALUES ${values}`, ...batch.flatMap((r) => cols.map((c) => r[c] as Param)));
        }
        if (to.db instanceof PostgresDb && IDENTITY[t]) {
          // Generated ids continue after the copied ones. RESTART (unlike setval) rolls back with the copy.
          const c = IDENTITY[t];
          const { next } = (await to.db.get<{ next: number }>(`SELECT COALESCE(MAX(${c}), 0) + 1 AS next FROM ${t}`))!;
          await to.db.exec(`ALTER TABLE ${t} ALTER COLUMN ${c} RESTART WITH ${Math.max(1, next)}`);
        }
        const a = await digest(from.db, t, cols), b = await digest(to.db, t, cols);
        if (a.rows !== b.rows || a.sha256 !== b.sha256) {
          throw new Error(`${t}: copy differs (source ${a.rows} rows ${a.sha256.slice(0, 12)}, target ${b.rows} rows ${b.sha256.slice(0, 12)})`);
        }
        tables.push({ table: t, ...a });
      }
      let secrets = 0;
      for (const { id } of await from.db.all<{ id: string }>("SELECT id FROM apps")) {
        const [a, b] = [await from.secrets(id), await to.secrets(id)];
        if (JSON.stringify(Object.entries(a).sort()) !== JSON.stringify(Object.entries(b).sort())) throw new Error(`secrets of ${id} differ after the copy`);
        secrets += Object.keys(a).length;
      }
      // An environment's own (sealed to the environment): what its sandbox sees, production's and its overrides.
      for (const env of await from.db.all<{ id: string; app_id: string }>("SELECT id, app_id FROM environments")) {
        const [a, b] = [await from.envSecrets(env), await to.envSecrets(env)];
        if (JSON.stringify(Object.entries(a).sort()) !== JSON.stringify(Object.entries(b).sort())) throw new Error(`secrets of environment ${env.id} differ after the copy`);
        secrets += (await from.envSecretKeys(env.id)).length;
      }
      report = { tables, secrets, committed: !opts.dryRun };
      if (opts.dryRun) throw rollback;
    });
  } catch (e) {
    if (e !== rollback) throw e;
  }
  return report!;
}

/** A consistent copy of `<dataDir>/cresslet.db` (and its key) in a temp dir: the source is only read. */
async function snapshot(dataDir: string): Promise<string> {
  const src = join(dataDir, "cresslet.db");
  if (!existsSync(src)) throw new Error(`no SQLite database at ${src}`);
  const dir = mkdtempSync(join(tmpdir(), "cresslet-snapshot-"));
  const db = new DatabaseSync(src, { readOnly: true });
  try {
    await backup(db, join(dir, "cresslet.db"));
  } finally {
    db.close();
  }
  if (existsSync(join(dataDir, "secrets.key"))) copyFileSync(join(dataDir, "secrets.key"), join(dir, "secrets.key"));
  return dir;
}

/** SQLite at `<dataDir>/cresslet.db` → the Postgres database `database`. */
export async function sqliteToPostgres(dataDir: string, database: DatabaseConfig, opts: { dryRun?: boolean } = {}) {
  if (!database.url) throw new Error("set CRESSLET_DATABASE_URL to the Postgres database to copy into");
  const snap = await snapshot(dataDir);
  try {
    const from = await Store.open(snap);
    try {
      const to = await Store.open(snap, database); // same secrets key
      try {
        return await copyStore(from, to, opts);
      } finally {
        await to.close();
      }
    } finally {
      await from.close();
    }
  } finally {
    rmSync(snap, { recursive: true, force: true });
  }
}

/**
 * The Postgres database `database` → a new SQLite database at `<outDir>/cresslet.db`, with a copy of the data
 * dir's secrets key (a dry run writes to a temp dir instead, removed after).
 */
export async function postgresToSqlite(dataDir: string, database: DatabaseConfig, outDir: string, opts: { dryRun?: boolean } = {}) {
  if (!database.url) throw new Error("set CRESSLET_DATABASE_URL to the Postgres database to copy from");
  if (existsSync(join(outDir, "cresslet.db"))) throw new Error(`${join(outDir, "cresslet.db")} exists: pick an empty directory`);
  const dir = opts.dryRun ? mkdtempSync(join(tmpdir(), "cresslet-dry-")) : outDir;
  try {
    const from = await Store.open(dataDir, database);
    try {
      mkdirSync(dir, { recursive: true });
      if (!existsSync(join(dir, "secrets.key")) && existsSync(join(dataDir, "secrets.key"))) {
        copyFileSync(join(dataDir, "secrets.key"), join(dir, "secrets.key"));
      }
      const to = await Store.open(dir);
      try {
        return await copyStore(from, to, opts);
      } finally {
        await to.close();
      }
    } finally {
      await from.close();
    }
  } finally {
    if (opts.dryRun) rmSync(dir, { recursive: true, force: true });
  }
}

function print(r: CopyReport) {
  for (const t of r.tables) console.log(`  ${t.table.padEnd(14)} ${String(t.rows).padStart(8)} rows  sha256 ${t.sha256.slice(0, 16)}  ok`);
  console.log(`  secrets decrypted and compared: ${r.secrets}`);
  console.log(r.committed ? "copied and verified: committed" : "dry run: verified, rolled back (no rows written)");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const cfg = loadConfig();
  const dryRun = args.includes("--dry-run");
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
  try {
    if (cmd === "status") {
      const store = await Store.open(cfg.dataDir, cfg.database);
      try {
        console.log(`database: ${cfg.database.url ? `postgres (schema ${cfg.database.schema})` : join(cfg.dataDir, "cresslet.db")}`);
        for (const m of await store.db.all<{ version: number; name: string; applied_at: number }>("SELECT * FROM schema_migrations ORDER BY version")) {
          console.log(`  ${String(m.version).padStart(4)} ${m.name.padEnd(24)} ${new Date(m.applied_at).toISOString()}`);
        }
        console.log(`this release knows up to version ${MIGRATIONS.at(-1)!.version}`);
      } finally {
        await store.close();
      }
    } else if (cmd === "to-postgres") {
      console.log(`${join(cfg.dataDir, "cresslet.db")} → postgres (schema ${cfg.database.schema})`);
      print(await sqliteToPostgres(cfg.dataDir, cfg.database, { dryRun }));
    } else if (cmd === "to-sqlite" && out) {
      console.log(`postgres (schema ${cfg.database.schema}) → ${join(out, "cresslet.db")}`);
      print(await postgresToSqlite(cfg.dataDir, cfg.database, out, { dryRun }));
    } else {
      console.error("usage: node server/db-migrate.ts status | to-postgres [--dry-run] | to-sqlite --out <dir> [--dry-run]");
      process.exit(2);
    }
  } catch (e) {
    console.error(`cresslet db-migrate: ${(e as Error).message}`);
    process.exit(1);
  }
}
