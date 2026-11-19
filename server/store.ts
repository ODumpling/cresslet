import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { encodeHex } from "@std/encoding/hex";

export interface Account {
  id: string;
  email: string;
  created_at: number;
}

export interface App {
  id: string;
  name: string;
  account_id: string | null;
  current_deploy_id: string | null;
  /** JSON: { routes: string[] } */
  config: string;
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

export const id = (prefix: string, bytes = 10) =>
  `${prefix}_${encodeHex(crypto.getRandomValues(new Uint8Array(bytes)))}`;

export async function sha256(s: string): Promise<string> {
  return encodeHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

export class Store {
  db: DatabaseSync;

  constructor(dataDir: string) {
    Deno.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "cresslet.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
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
  }

  // ---- accounts
  createAccount(email: string): Account {
    const a = { id: id("acct"), email: email.toLowerCase(), created_at: Date.now() };
    this.db.prepare("INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)")
      .run(a.id, a.email, a.created_at);
    return a;
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
  deleteApp(appId: string) {
    this.db.prepare("DELETE FROM apps WHERE id = ?").run(appId);
  }
  expiredApps(now = Date.now()): App[] {
    return this.db.prepare("SELECT * FROM apps WHERE expires_at IS NOT NULL AND expires_at < ?")
      .all(now) as unknown as App[];
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

  // ---- secrets (plaintext at rest in v1; see docs/roadmap)
  secrets(appId: string): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM secrets WHERE app_id = ?").all(appId) as {
      key: string;
      value: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
  setSecret(appId: string, key: string, value: string) {
    this.db.prepare(
      "INSERT INTO secrets (app_id, key, value) VALUES (?, ?, ?) ON CONFLICT (app_id, key) DO UPDATE SET value = excluded.value",
    ).run(appId, key, value);
  }
  deleteSecret(appId: string, key: string) {
    this.db.prepare("DELETE FROM secrets WHERE app_id = ? AND key = ?").run(appId, key);
  }
}
