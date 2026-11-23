// Versioned schema migrations for the metadata database (docs/database.md). Each runs once, in order, and
// is recorded in `schema_migrations`. Rules:
// - Never edit or renumber a migration once it has shipped: add a new one.
// - Additive only (expand/contract): a server rolled back to an older release must still run against the
//   newer schema. Add columns nullable or with a default; drop or rename only in a later release, once
//   no supported release reads the old shape.
// - Give each dialect its SQL (Postgres timestamps and counters are BIGINT, blobs BYTEA).
import { type Db, PostgresDb } from "./db.ts";

export interface Migration {
  version: number;
  name: string;
  up(db: Db): Promise<void>;
}

const cols = async (db: Db, table: string) =>
  (await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((c) => c.name);

/**
 * SQLite: brings a database from any earlier release (they upgraded themselves column by column, before
 * this table existed) to the version-1 shape. Postgres: creates that shape.
 */
async function baseline(db: Db) {
  if (db.dialect === "postgres") return db.exec(PG_BASELINE);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tokens (
      hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS apps (
      id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      deploy_key_hash TEXT NOT NULL, current_deploy_id TEXT, config TEXT NOT NULL DEFAULT '{}',
      expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS deploys (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, bytes INTEGER NOT NULL, file_count INTEGER NOT NULL,
      has_server INTEGER NOT NULL, source TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS secrets (
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, key TEXT NOT NULL,
      value TEXT NOT NULL, PRIMARY KEY (app_id, key));
  `);
  const acct = await cols(db, "accounts");
  if (!acct.includes("github_id")) {
    await db.exec("ALTER TABLE accounts ADD COLUMN github_id INTEGER; ALTER TABLE accounts ADD COLUMN github_login TEXT;");
  }
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS accounts_github_id ON accounts (github_id)");
  const app = await cols(db, "apps");
  if (!app.includes("egress")) await db.exec("ALTER TABLE apps ADD COLUMN egress TEXT");
  await db.exec(`
    CREATE TABLE IF NOT EXISTS domains (
      domain TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      token TEXT NOT NULL, verified_at INTEGER, created_at INTEGER NOT NULL, PRIMARY KEY (domain, app_id));
    CREATE UNIQUE INDEX IF NOT EXISTS domains_verified ON domains (domain) WHERE verified_at IS NOT NULL;
  `);
  if (!app.includes("uid_seq")) await db.exec("ALTER TABLE apps ADD COLUMN uid_seq INTEGER");
  if (!app.includes("deleted_at")) await db.exec("ALTER TABLE apps ADD COLUMN deleted_at INTEGER");
  if (!acct.includes("role")) await db.exec("ALTER TABLE accounts ADD COLUMN role TEXT");
  await db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
  // Named / scoped tokens. Tokens from before this keep working as full-access ("admin", all apps).
  if (!(await cols(db, "tokens")).includes("id")) {
    await db.exec(`
      ALTER TABLE tokens ADD COLUMN id TEXT;
      ALTER TABLE tokens ADD COLUMN name TEXT NOT NULL DEFAULT 'Token';
      ALTER TABLE tokens ADD COLUMN role TEXT NOT NULL DEFAULT 'admin';
      ALTER TABLE tokens ADD COLUMN apps TEXT;
      ALTER TABLE tokens ADD COLUMN last_used_at INTEGER;
      UPDATE tokens SET name = 'Token (before named tokens)';
    `);
  }
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tokens_id ON tokens (id)");
  // Collaborators (an older server ignores these tables: invited accounts just lose access).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS collaborators (
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('viewer', 'admin')), created_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, account_id));
    CREATE INDEX IF NOT EXISTS collaborators_account ON collaborators (account_id);
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      email TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('viewer', 'admin')),
      invited_by TEXT REFERENCES accounts(id) ON DELETE SET NULL, created_at INTEGER NOT NULL,
      UNIQUE (app_id, email));
    CREATE INDEX IF NOT EXISTS invites_email ON invites (email);
  `);
  // Pages (an older server sees them as apps with nothing deployed: see App.page_deploy_id).
  if (!app.includes("kind")) {
    await db.exec(`
      ALTER TABLE apps ADD COLUMN kind TEXT NOT NULL DEFAULT 'app';
      ALTER TABLE apps ADD COLUMN visibility TEXT;
      ALTER TABLE apps ADD COLUMN retention_days INTEGER;
      ALTER TABLE apps ADD COLUMN title TEXT;
      ALTER TABLE apps ADD COLUMN page_deploy_id TEXT;
    `);
  }
  if (!acct.includes("settings")) await db.exec("ALTER TABLE accounts ADD COLUMN settings TEXT");
  await db.exec(`
    CREATE TABLE IF NOT EXISTS page_sessions (
      hash TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      ticket INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS page_sessions_expiry ON page_sessions (expires_at);
    CREATE TABLE IF NOT EXISTS rate_hits (
      bucket TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, until INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS rate_hits_key ON rate_hits (bucket, key, at);
    CREATE INDEX IF NOT EXISTS rate_hits_until ON rate_hits (until);
  `);
  // The client (ipKey) that created an anonymous app, for the per-client cap. Unused since anonymous deploys were removed.
  if (!(await cols(db, "apps")).includes("anon_client")) await db.exec("ALTER TABLE apps ADD COLUMN anon_client TEXT");
  // AI credits (server/credits.ts), in millicredits. `balance`: granted credits left (can go below 0 by the last
  // request); `period_used`: this month's free allowance used (`period` = "YYYY-MM", UTC; a new month starts at 0).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ai_wallets (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      balance INTEGER NOT NULL DEFAULT 0, period TEXT, period_used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS ai_ledger (
      id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, detail TEXT);
    CREATE INDEX IF NOT EXISTS ai_ledger_account ON ai_ledger (account_id, id);
    CREATE INDEX IF NOT EXISTS ai_ledger_created ON ai_ledger (created_at);
  `);
}

// The same shape. `rowid` is SQLite's implicit insertion order, which some lists sort by; text that's sorted
// uses byte order (COLLATE "C"), as SQLite does.
const PG_BASELINE = `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY, email TEXT COLLATE "C" UNIQUE NOT NULL, created_at BIGINT NOT NULL,
    github_id BIGINT, github_login TEXT, role TEXT, settings TEXT);
  CREATE UNIQUE INDEX accounts_github_id ON accounts (github_id);
  CREATE TABLE tokens (
    hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL, id TEXT, name TEXT NOT NULL DEFAULT 'Token', role TEXT NOT NULL DEFAULT 'admin',
    apps TEXT, last_used_at BIGINT, rowid BIGINT GENERATED BY DEFAULT AS IDENTITY);
  CREATE UNIQUE INDEX tokens_id ON tokens (id);
  CREATE INDEX tokens_account ON tokens (account_id);
  CREATE TABLE apps (
    id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL,
    account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    deploy_key_hash TEXT NOT NULL, current_deploy_id TEXT, config TEXT NOT NULL DEFAULT '{}',
    expires_at BIGINT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, egress TEXT, uid_seq BIGINT,
    deleted_at BIGINT, kind TEXT NOT NULL DEFAULT 'app', visibility TEXT, retention_days BIGINT, title TEXT,
    page_deploy_id TEXT, anon_client TEXT);
  CREATE INDEX apps_account ON apps (account_id);
  CREATE TABLE deploys (
    id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL, bytes BIGINT NOT NULL, file_count BIGINT NOT NULL,
    has_server BIGINT NOT NULL, source TEXT NOT NULL, rowid BIGINT GENERATED BY DEFAULT AS IDENTITY);
  CREATE INDEX deploys_app ON deploys (app_id, created_at);
  CREATE TABLE secrets (
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, key TEXT COLLATE "C" NOT NULL,
    value BYTEA NOT NULL, PRIMARY KEY (app_id, key));
  CREATE TABLE domains (
    domain TEXT COLLATE "C" NOT NULL, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    token TEXT NOT NULL, verified_at BIGINT, created_at BIGINT NOT NULL, PRIMARY KEY (domain, app_id));
  CREATE UNIQUE INDEX domains_verified ON domains (domain) WHERE verified_at IS NOT NULL;
  CREATE INDEX domains_app ON domains (app_id);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value BIGINT NOT NULL);
  CREATE TABLE collaborators (
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('viewer', 'admin')), created_at BIGINT NOT NULL,
    rowid BIGINT GENERATED BY DEFAULT AS IDENTITY, PRIMARY KEY (app_id, account_id));
  CREATE INDEX collaborators_account ON collaborators (account_id);
  CREATE TABLE invites (
    id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    email TEXT COLLATE "C" NOT NULL, role TEXT NOT NULL CHECK (role IN ('viewer', 'admin')),
    invited_by TEXT REFERENCES accounts(id) ON DELETE SET NULL, created_at BIGINT NOT NULL,
    rowid BIGINT GENERATED BY DEFAULT AS IDENTITY, UNIQUE (app_id, email));
  CREATE INDEX invites_email ON invites (email);
  CREATE TABLE page_sessions (
    hash TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    ticket BIGINT NOT NULL, expires_at BIGINT NOT NULL);
  CREATE INDEX page_sessions_expiry ON page_sessions (expires_at);
  CREATE TABLE rate_hits (
    bucket TEXT NOT NULL, key TEXT NOT NULL, at BIGINT NOT NULL, until BIGINT NOT NULL);
  CREATE INDEX rate_hits_key ON rate_hits (bucket, key, at);
  CREATE INDEX rate_hits_until ON rate_hits (until);
  CREATE TABLE ai_wallets (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    balance BIGINT NOT NULL DEFAULT 0, period TEXT, period_used BIGINT NOT NULL DEFAULT 0);
  CREATE TABLE ai_ledger (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL, kind TEXT NOT NULL, amount BIGINT NOT NULL, detail TEXT);
  CREATE INDEX ai_ledger_account ON ai_ledger (account_id, id);
  CREATE INDEX ai_ledger_created ON ai_ledger (created_at);
`;

/**
 * Disabled accounts, who invited an account, and organizations (members; apps that belong to one).
 * An older server (after a rollback) ignores all of it: org apps fall back to their `account_id` owner (kept an
 * org admin or member: see Store.reassignOrgApps); a disabled account has no tokens, and its email and GitHub id
 * are moved aside, so the older login can't find it.
 */
async function orgs(db: Db) {
  const pg = db.dialect === "postgres";
  const big = pg ? "BIGINT" : "INTEGER";
  const text = pg ? `TEXT COLLATE "C"` : "TEXT";
  const rowid = pg ? ", rowid BIGINT GENERATED BY DEFAULT AS IDENTITY" : "";
  // Re-runnable (IF NOT EXISTS, columns checked): tests drop schema_migrations to simulate older databases.
  const addCol = async (table: string, col: string, def: string) => {
    if (pg) return db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${def}`);
    if (!(await cols(db, table)).includes(col)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  await addCol("accounts", "disabled_at", big);
  // Invited by a site admin and not signed in yet: `invited_at` is cleared when it first gets a token.
  await addCol("accounts", "invited_at", big);
  await addCol("accounts", "invited_by", "TEXT");
  // A disabled account's sign-in identity, moved out of `email` / `github_id` (see Store.setDisabled).
  await addCol("accounts", "disabled_email", "TEXT");
  await addCol("accounts", "disabled_github_id", big);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS orgs (
      id TEXT PRIMARY KEY, name ${text} UNIQUE NOT NULL, title TEXT, created_at ${big} NOT NULL,
      created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL);
    CREATE TABLE IF NOT EXISTS org_members (
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')), created_at ${big} NOT NULL${rowid},
      PRIMARY KEY (org_id, account_id));
    CREATE INDEX IF NOT EXISTS org_members_account ON org_members (account_id);
    CREATE INDEX IF NOT EXISTS accounts_disabled_github_id ON accounts (disabled_github_id);
  `);
  await addCol("apps", "org_id", "TEXT REFERENCES orgs(id) ON DELETE SET NULL");
  await db.exec("CREATE INDEX IF NOT EXISTS apps_org ON apps (org_id)");
}

/**
 * Crons paused in the studio (`apps.paused_crons`, a JSON array of expressions). An older server, after a
 * rollback, ignores it: they fire on schedule again.
 */
async function cronPauses(db: Db) {
  if (db.dialect === "postgres") return db.exec("ALTER TABLE apps ADD COLUMN IF NOT EXISTS paused_crons TEXT");
  if (!(await cols(db, "apps")).includes("paused_crons")) await db.exec("ALTER TABLE apps ADD COLUMN paused_crons TEXT");
}

/**
 * Source control (docs/architecture.md#source-control): each account's own connection to a provider (its tokens
 * sealed: see Store.upsertGitConnection), the repository an app is linked to, and the commit each deploy was built
 * from. An older server (after a rollback) ignores all of it: apps just aren't linked, deploys have no provenance.
 */
async function git(db: Db) {
  const pg = db.dialect === "postgres";
  const big = pg ? "BIGINT" : "INTEGER";
  const blob = pg ? "BYTEA" : "BLOB";
  const addCol = async (table: string, col: string, def: string) => {
    if (pg) return db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${def}`);
    if (!(await cols(db, table)).includes(col)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  await db.exec(`
    CREATE TABLE IF NOT EXISTS git_connections (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, provider TEXT NOT NULL,
      provider_uid TEXT NOT NULL, login TEXT NOT NULL, email TEXT NOT NULL, scopes TEXT,
      access_token ${blob} NOT NULL, refresh_token ${blob}, expires_at ${big},
      status TEXT NOT NULL DEFAULT 'active', gen TEXT NOT NULL, created_at ${big} NOT NULL, updated_at ${big} NOT NULL,
      PRIMARY KEY (account_id, provider));
    CREATE TABLE IF NOT EXISTS app_repos (
      app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE, provider TEXT NOT NULL,
      repo_id TEXT NOT NULL, owner TEXT NOT NULL, name TEXT NOT NULL, default_branch TEXT NOT NULL,
      subdir TEXT NOT NULL DEFAULT '', delete_branch ${big} NOT NULL DEFAULT 1,
      connected_by TEXT REFERENCES accounts(id) ON DELETE SET NULL, last_synced_sha TEXT,
      connected_at ${big} NOT NULL, updated_at ${big} NOT NULL);
  `);
  await addCol("deploys", "git_sha", "TEXT");
  await addCol("deploys", "git_branch", "TEXT");
  await addCol("deploys", "git_repo", "TEXT");
}

/** Source control webhooks: the default branch's head GitHub last reported (an older server ignores it). */
async function gitUpstream(db: Db) {
  if (db.dialect === "postgres") return db.exec("ALTER TABLE app_repos ADD COLUMN IF NOT EXISTS upstream_sha TEXT");
  if (!(await cols(db, "app_repos")).includes("upstream_sha")) await db.exec("ALTER TABLE app_repos ADD COLUMN upstream_sha TEXT");
}

/**
 * Stacked changes (docs/architecture.md#stacked-changes): each AI builder turn that changed files, as a change of
 * its app's stack (its branch, the commit it holds, the one it was cut from). An older server ignores the table.
 */
async function stacks(db: Db) {
  const big = db.dialect === "postgres" ? "BIGINT" : "INTEGER";
  await db.exec(`
    CREATE TABLE IF NOT EXISTS stack_changes (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      stack_id TEXT NOT NULL, stack_name TEXT NOT NULL, position INTEGER NOT NULL,
      branch TEXT NOT NULL, sha TEXT NOT NULL, base_sha TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'open', landed_sha TEXT, pr_number INTEGER,
      author TEXT, created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      created_at ${big} NOT NULL, updated_at ${big} NOT NULL,
      UNIQUE (stack_id, position));
    CREATE INDEX IF NOT EXISTS stack_changes_app ON stack_changes (app_id, state);
  `);
}

/** Stacked changes: an app's stacks open pull requests after each change (0/1; an older server ignores it). */
async function stackAutoSubmit(db: Db) {
  if (db.dialect === "postgres") return db.exec("ALTER TABLE app_repos ADD COLUMN IF NOT EXISTS stack_auto_submit BIGINT NOT NULL DEFAULT 0");
  if (!(await cols(db, "app_repos")).includes("stack_auto_submit")) await db.exec("ALTER TABLE app_repos ADD COLUMN stack_auto_submit INTEGER NOT NULL DEFAULT 0");
}

/** Stacked changes moved out of their stack (set aside for good, dropped, carried on from) keep which one it was. */
async function stackOrigin(db: Db) {
  if (db.dialect === "postgres") return db.exec("ALTER TABLE stack_changes ADD COLUMN IF NOT EXISTS origin_stack_id TEXT");
  if (!(await cols(db, "stack_changes")).includes("origin_stack_id")) await db.exec("ALTER TABLE stack_changes ADD COLUMN origin_stack_id TEXT");
}

/** A stack change's sync commit (squash-only landing) keeps the commit it was made from. */
async function stackSyncedFrom(db: Db) {
  if (db.dialect === "postgres") return db.exec("ALTER TABLE stack_changes ADD COLUMN IF NOT EXISTS synced_from TEXT");
  if (!(await cols(db, "stack_changes")).includes("synced_from")) await db.exec("ALTER TABLE stack_changes ADD COLUMN synced_from TEXT");
}

/** Every migration, oldest first. Append only. */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: "baseline", up: baseline },
  { version: 2, name: "orgs", up: orgs },
  { version: 3, name: "cron_pauses", up: cronPauses },
  { version: 4, name: "git", up: git },
  { version: 5, name: "git_upstream", up: gitUpstream },
  { version: 6, name: "stacks", up: stacks },
  { version: 7, name: "stack_auto_submit", up: stackAutoSubmit },
  { version: 8, name: "stack_origin", up: stackOrigin },
  { version: 9, name: "stack_synced_from", up: stackSyncedFrom },
];

/** Tables in foreign-key order (parents first), for copying between databases. */
export const TABLES = [
  "accounts", "orgs", "apps", "tokens", "deploys", "secrets", "domains", "meta", "collaborators", "invites",
  "page_sessions", "rate_hits", "ai_wallets", "ai_ledger", "org_members", "git_connections", "app_repos",
  "stack_changes",
] as const;

export interface MigrateResult {
  /** Versions this call applied. */
  applied: number[];
  /** Versions in the database this server doesn't know (a newer release ran here; ours was rolled back). */
  unknown: { version: number; name: string }[];
}

/**
 * Applies the pending migrations, all in one transaction (all or none), under a lock so servers starting
 * together against one Postgres database don't both run them.
 */
export async function migrate(db: Db, migrations: Migration[] = MIGRATIONS): Promise<MigrateResult> {
  const versions = migrations.map((m) => m.version);
  if (versions.some((v, i) => !Number.isInteger(v) || v < 1 || (i > 0 && v <= versions[i - 1]))) {
    throw new Error("migration versions must be whole numbers in increasing order");
  }
  return db.tx(async () => {
    await db.lock("cresslet:migrate");
    // Only when missing: CREATE SCHEMA needs the CREATE privilege on the database, even with IF NOT EXISTS.
    if (db instanceof PostgresDb && !(await db.get("SELECT 1 FROM pg_namespace WHERE nspname = ?", db.schema))) {
      await db.exec(`CREATE SCHEMA "${db.schema}"`);
    }
    await db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${
        db.dialect === "postgres" ? "BIGINT" : "INTEGER"
      } NOT NULL)`,
    );
    const done = (await db.all<{ version: number; name: string }>("SELECT version, name FROM schema_migrations ORDER BY version"))
      .map((r) => ({ version: r.version, name: r.name }));
    const have = new Set(done.map((r) => r.version));
    const applied: number[] = [];
    for (const m of migrations) {
      if (have.has(m.version)) continue;
      await m.up(db);
      await db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", m.version, m.name, Date.now());
      applied.push(m.version);
    }
    const known = new Set(versions);
    return { applied, unknown: done.filter((r) => !known.has(r.version)) };
  });
}
