import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SecretBox } from "./secretbox.ts";

const encodeHex = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as ArrayBuffer).toString("hex");

export interface Account {
  id: string;
  email: string;
  created_at: number;
  github_id: number | null;
  github_login: string | null;
}

export interface App {
  id: string;
  name: string;
  account_id: string | null;
  current_deploy_id: string | null;
  /** JSON: { routes: string[] } */
  config: string;
  /** JSON string[] of allowed outbound hosts, or null = any public host. */
  egress: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface Deploy {
  id: string;
  app_id: string;
  created_at: number;
  bytes: number;
  file_count: number;
  has_server: number;
  source: string;
}

export interface Domain {
  domain: string;
  app_id: string;
  token: string;
  verified_at: number | null;
  created_at: number;
}

export const id = (prefix: string, bytes = 10) =>
  `${prefix}_${encodeHex(crypto.getRandomValues(new Uint8Array(bytes)))}`;

export async function sha256(s: string): Promise<string> {
  return encodeHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

export class Store {
  db: DatabaseSync;
  #box: SecretBox;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "cresslet.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA secure_delete = ON;
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
    const cols = (this.db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("github_id")) {
      this.db.exec("ALTER TABLE accounts ADD COLUMN github_id INTEGER; ALTER TABLE accounts ADD COLUMN github_login TEXT;");
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS accounts_github_id ON accounts (github_id)");
    const appCols = (this.db.prepare("PRAGMA table_info(apps)").all() as { name: string }[]).map((c) => c.name);
    if (!appCols.includes("egress")) this.db.exec("ALTER TABLE apps ADD COLUMN egress TEXT");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS domains (
        domain TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        token TEXT NOT NULL, verified_at INTEGER, created_at INTEGER NOT NULL, PRIMARY KEY (domain, app_id));
      CREATE UNIQUE INDEX IF NOT EXISTS domains_verified ON domains (domain) WHERE verified_at IS NOT NULL;
    `);
    if (!appCols.includes("uid_seq")) this.db.exec("ALTER TABLE apps ADD COLUMN uid_seq INTEGER");
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    this.#box = SecretBox.load(dataDir);
    this.#sealSecrets();
  }

  /**
   * Sealed values are stored as BLOBs, plaintext ones (older versions, incl. after a rollback) as
   * TEXT, so the storage class alone tells them apart. Seals plaintext rows and re-seals rows under
   * an old key. The first run also rebuilds the file: overwritten or deleted plaintext otherwise
   * survives in free pages and the WAL.
   */
  #sealSecrets() {
    const rows = this.db.prepare("SELECT app_id, key, value FROM secrets").all() as {
      app_id: string;
      key: string;
      value: string | Uint8Array;
    }[];
    const update = this.db.prepare("UPDATE secrets SET value = ? WHERE app_id = ? AND key = ?");
    let plaintext = 0;
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        if (typeof r.value === "string") {
          update.run(this.#seal(r.app_id, r.key, r.value), r.app_id, r.key);
          plaintext++;
        } else {
          const { value, stale } = this.#box.open(r.app_id, r.key, Buffer.from(r.value).toString());
          if (stale) update.run(this.#seal(r.app_id, r.key, value), r.app_id, r.key);
        }
      }
      // Cleanup pending until the rebuild below succeeds (retried next start if the checkpoint is busy).
      if (plaintext) this.db.exec("PRAGMA user_version = 0");
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    const { user_version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (user_version < 1) {
      this.db.exec("VACUUM");
      const ck = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
      // Only mark done once the old pages are really gone (busy = a reader kept the WAL pinned).
      if (!ck.busy) this.db.exec("PRAGMA user_version = 1");
    }
  }

  #seal(appId: string, key: string, value: string): Uint8Array {
    return Buffer.from(this.#box.seal(appId, key, value));
  }

  // ---- accounts
  createAccount(email: string, github?: { id: number; login: string }): Account {
    const a: Account = {
      id: id("acct"),
      email: email.toLowerCase(),
      created_at: Date.now(),
      github_id: github?.id ?? null,
      github_login: github?.login ?? null,
    };
    this.db.prepare("INSERT INTO accounts (id, email, created_at, github_id, github_login) VALUES (?, ?, ?, ?, ?)")
      .run(a.id, a.email, a.created_at, a.github_id, a.github_login);
    return a;
  }
  accountByGithub(githubId: number): Account | undefined {
    return this.db.prepare("SELECT * FROM accounts WHERE github_id = ?").get(githubId) as Account | undefined;
  }
  linkGithub(accountId: string, github: { id: number; login: string }) {
    this.db.prepare("UPDATE accounts SET github_id = ?, github_login = ? WHERE id = ?")
      .run(github.id, github.login, accountId);
  }
  revokeTokens(accountId: string) {
    this.db.prepare("DELETE FROM tokens WHERE account_id = ?").run(accountId);
  }
  accountByEmail(email: string): Account | undefined {
    return this.db.prepare("SELECT * FROM accounts WHERE email = ?").get(email.toLowerCase()) as
      | Account
      | undefined;
  }
  async issueToken(accountId: string): Promise<string> {
    const token = id("clv_acct", 24);
    this.db.prepare("INSERT INTO tokens (hash, account_id, created_at) VALUES (?, ?, ?)")
      .run(await sha256(token), accountId, Date.now());
    return token;
  }
  async accountByToken(token: string): Promise<Account | undefined> {
    return this.db.prepare(
      "SELECT a.* FROM tokens t JOIN accounts a ON a.id = t.account_id WHERE t.hash = ?",
    ).get(await sha256(token)) as Account | undefined;
  }

  // ---- apps
  async createApp(name: string, expiresAt: number | null, accountId: string | null) {
    const deployKey = id("clv_app", 24);
    const now = Date.now();
    const app: App = {
      id: id("app"),
      name,
      account_id: accountId,
      current_deploy_id: null,
      config: "{}",
      egress: null,
      expires_at: expiresAt,
      created_at: now,
      updated_at: now,
    };
    this.db.prepare(
      `INSERT INTO apps (id, name, account_id, deploy_key_hash, config, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(app.id, name, accountId, await sha256(deployKey), "{}", expiresAt, now, now);
    return { app, deployKey };
  }
  appByName(name: string): App | undefined {
    return this.db.prepare("SELECT * FROM apps WHERE name = ?").get(name) as App | undefined;
  }
  appById(appId: string): App | undefined {
    return this.db.prepare("SELECT * FROM apps WHERE id = ?").get(appId) as App | undefined;
  }
  /** Claimed apps whose current deploy declares crons. */
  appsWithCrons(): App[] {
    return this.db.prepare(
      "SELECT * FROM apps WHERE account_id IS NOT NULL AND json_array_length(config, '$.crons') > 0",
    ).all() as unknown as App[];
  }
  /**
   * Per-app number for sandbox uids, allocated on first use from a counter that never goes back
   * (not the rowid: SQLite reuses the highest one after a delete), so a uid is never reused.
   */
  uidSeq(appId: string): number {
    const row = this.db.prepare("SELECT uid_seq FROM apps WHERE id = ?").get(appId) as { uid_seq: number | null } | undefined;
    if (!row) throw new Error(`no app ${appId}`);
    if (row.uid_seq !== null) return row.uid_seq;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const n = ((this.db.prepare("SELECT value FROM meta WHERE key = 'uid_seq'").get() as { value: number } | undefined)?.value ?? 0) + 1;
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('uid_seq', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(n);
      this.db.prepare("UPDATE apps SET uid_seq = ? WHERE id = ?").run(n, appId);
      this.db.exec("COMMIT");
      return n;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  appsByAccount(accountId: string): App[] {
    return this.db.prepare("SELECT * FROM apps WHERE account_id = ? ORDER BY updated_at DESC")
      .all(accountId) as unknown as App[];
  }
  async checkDeployKey(appId: string, key: string): Promise<boolean> {
    const row = this.db.prepare("SELECT deploy_key_hash h FROM apps WHERE id = ?").get(appId) as
      | { h: string }
      | undefined;
    return !!row && row.h === await sha256(key);
  }
  claimApp(appId: string, accountId: string) {
    this.db.prepare("UPDATE apps SET account_id = ?, expires_at = NULL, updated_at = ? WHERE id = ?")
      .run(accountId, Date.now(), appId);
  }
  setCurrentDeploy(appId: string, deployId: string, config: unknown) {
    this.db.prepare(
      "UPDATE apps SET current_deploy_id = ?, config = ?, updated_at = ? WHERE id = ?",
    ).run(deployId, JSON.stringify(config ?? {}), Date.now(), appId);
  }
  setEgress(appId: string, allow: string[] | null) {
    this.db.prepare("UPDATE apps SET egress = ?, updated_at = ? WHERE id = ?")
      .run(allow ? JSON.stringify(allow) : null, Date.now(), appId);
  }
  deleteApp(appId: string) {
    this.db.prepare("DELETE FROM apps WHERE id = ?").run(appId);
  }
  expiredApps(now = Date.now()): App[] {
    return this.db.prepare("SELECT * FROM apps WHERE expires_at IS NOT NULL AND expires_at < ?")
      .all(now) as unknown as App[];
  }

  // ---- custom domains (pending until DNS-verified; one verified owner per domain)
  domains(appId: string): Domain[] {
    return this.db.prepare("SELECT * FROM domains WHERE app_id = ? ORDER BY domain").all(appId) as unknown as Domain[];
  }
  addDomain(appId: string, domain: string): Domain {
    const d: Domain = { domain, app_id: appId, token: id("cresslet-verify", 16), verified_at: null, created_at: Date.now() };
    this.db.prepare("INSERT INTO domains (domain, app_id, token, verified_at, created_at) VALUES (?, ?, ?, NULL, ?)")
      .run(d.domain, d.app_id, d.token, d.created_at);
    return d;
  }
  /** Marks the row whose `token` was checked as verified: "gone" if it was deleted/re-added meanwhile. */
  verifyDomain(appId: string, domain: string, token: string): "ok" | "taken" | "gone" {
    try {
      const r = this.db.prepare("UPDATE domains SET verified_at = ? WHERE app_id = ? AND domain = ? AND token = ?")
        .run(Date.now(), appId, domain, token);
      return r.changes ? "ok" : "gone";
    } catch (e) {
      if (/UNIQUE/.test((e as Error).message)) return "taken";
      throw e;
    }
  }
  deleteDomain(appId: string, domain: string) {
    this.db.prepare("DELETE FROM domains WHERE app_id = ? AND domain = ?").run(appId, domain);
  }
  appByDomain(domain: string): App | undefined {
    return this.db.prepare(
      "SELECT a.* FROM domains d JOIN apps a ON a.id = d.app_id WHERE d.domain = ? AND d.verified_at IS NOT NULL",
    ).get(domain) as App | undefined;
  }

  // ---- deploys
  addDeploy(d: Deploy) {
    this.db.prepare(
      `INSERT INTO deploys (id, app_id, created_at, bytes, file_count, has_server, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(d.id, d.app_id, d.created_at, d.bytes, d.file_count, d.has_server, d.source);
  }
  deploys(appId: string, limit = 20): Deploy[] {
    return this.db.prepare("SELECT * FROM deploys WHERE app_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(appId, limit) as unknown as Deploy[];
  }
  deploy(deployId: string): Deploy | undefined {
    return this.db.prepare("SELECT * FROM deploys WHERE id = ?").get(deployId) as Deploy | undefined;
  }
  deleteDeploy(deployId: string) {
    this.db.prepare("DELETE FROM deploys WHERE id = ?").run(deployId);
  }

  // ---- secrets (AES-GCM at rest, see secretbox.ts)
  secretKeys(appId: string): string[] {
    return (this.db.prepare("SELECT key FROM secrets WHERE app_id = ? ORDER BY key").all(appId) as { key: string }[])
      .map((r) => r.key);
  }
  secrets(appId: string): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM secrets WHERE app_id = ?").all(appId) as {
      key: string;
      value: Uint8Array;
    }[];
    return Object.fromEntries(rows.map((r) => [r.key, this.#box.open(appId, r.key, Buffer.from(r.value).toString()).value]));
  }
  setSecret(appId: string, key: string, value: string) {
    this.db.prepare(
      "INSERT INTO secrets (app_id, key, value) VALUES (?, ?, ?) ON CONFLICT (app_id, key) DO UPDATE SET value = excluded.value",
    ).run(appId, key, this.#seal(appId, key, value));
  }
  deleteSecret(appId: string, key: string) {
    this.db.prepare("DELETE FROM secrets WHERE app_id = ? AND key = ?").run(appId, key);
  }
}
