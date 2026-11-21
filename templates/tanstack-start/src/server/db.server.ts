// Schema migrations for the app's SQLite database (`db` from "cresslet"). Append to MIGRATIONS; never edit one that
// has shipped. Each runs in one db.batch (all or nothing) with its version row, so concurrent first requests are safe.
import { db } from "cresslet";

const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE todos (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX todos_user ON todos (user_id, created_at)`,
  ],
];

let ready: Promise<void> | null = null;

/** Brings the schema up to date (once per sandbox). Call before queries: `await migrate()`. */
export function migrate(): Promise<void> {
  ready ??= run().catch((e) => {
    ready = null; // try again on the next request
    throw e;
  });
  return ready;
}

async function version(): Promise<number> {
  await db.exec("CREATE TABLE IF NOT EXISTS _schema (version INTEGER PRIMARY KEY)");
  const row = await db.first(db.sql<{ v: number | null }>`SELECT max(version) AS v FROM _schema`);
  return row?.v ?? 0;
}

async function run() {
  let current = await version();
  for (let v = current + 1; v <= MIGRATIONS.length; v++) {
    try {
      await db.batch([...MIGRATIONS[v - 1], db.sql`INSERT INTO _schema (version) VALUES (${v})`]);
    } catch (e) {
      // another request ran it first
      if ((await version()) < v) throw e;
    }
    current = v;
  }
}
