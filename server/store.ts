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
  /** "SiteAdmin" or null. */
  role: string | null;
}

export const SITE_ADMIN = "SiteAdmin";

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
  /** Set when a site admin deleted it: offline but restorable until purged. */
  deleted_at: number | null;
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

/** read < deploy < admin. Each role includes the ones before it. */
export const ROLES = ["read", "deploy", "admin"] as const;
export type Role = (typeof ROLES)[number];

export interface Token {
  id: string;
  account_id: string;
  name: string;
  role: Role;
  /** JSON string[] of app ids the token is limited to, or null = every app on the account. */
  apps: string | null;
  created_at: number;
  last_used_at: number | null;
}

/** An invited account's access to an app. The owner is the app's `account_id`, not a collaborator. */
export const ACCESS = ["viewer", "admin"] as const;
export type Access = (typeof ACCESS)[number];
/** The caller's access to an app: its owner, or a collaborator's role. */
export type AppAccess = "owner" | Access;

export interface Collaborator {
  app_id: string;
  account_id: string;
  role: Access;
  created_at: number;
}

/** Pending until the account with this email (from GitHub, or set by the operator) accepts it. */
export interface Invite {
  id: string;
  app_id: string;
  email: string;
  role: Access;
  invited_by: string | null;
  created_at: number;
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
    if (!appCols.includes("deleted_at")) this.db.exec("ALTER TABLE apps ADD COLUMN deleted_at INTEGER");
    if (!cols.includes("role")) this.db.exec("ALTER TABLE accounts ADD COLUMN role TEXT");
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    // Named / scoped tokens. Tokens from before this keep working as full-access ("admin", all apps).
    const tokCols = (this.db.prepare("PRAGMA table_info(tokens)").all() as { name: string }[]).map((c) => c.name);
    if (!tokCols.includes("id")) {
      this.db.exec(`
        BEGIN;
        ALTER TABLE tokens ADD COLUMN id TEXT;
        ALTER TABLE tokens ADD COLUMN name TEXT NOT NULL DEFAULT 'Token';
        ALTER TABLE tokens ADD COLUMN role TEXT NOT NULL DEFAULT 'admin';
        ALTER TABLE tokens ADD COLUMN apps TEXT;
        ALTER TABLE tokens ADD COLUMN last_used_at INTEGER;
        UPDATE tokens SET name = 'Token (before named tokens)';
        COMMIT;
      `);
    }
    // Also tokens a pre-named-tokens server inserted (after a rollback).
    this.db.exec("UPDATE tokens SET id = 'tok_' || lower(hex(randomblob(10))) WHERE id IS NULL");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tokens_id ON tokens (id)");
    // Collaborators (an older server ignores these tables: invited accounts just lose access).
    this.db.exec(`
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
      role: null,
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
  accountById(accountId: string): Account | undefined {
    return this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as Account | undefined;
  }
  setRole(accountId: string, role: string | null) {
    this.db.prepare("UPDATE accounts SET role = ? WHERE id = ?").run(role, accountId);
  }
  revokeTokens(accountId: string) {
    this.db.prepare("DELETE FROM tokens WHERE account_id = ?").run(accountId);
  }
  accountByEmail(email: string): Account | undefined {
    return this.db.prepare("SELECT * FROM accounts WHERE email = ?").get(email.toLowerCase()) as
      | Account
      | undefined;
  }
  /** Returns the secret (shown once; only its hash is stored) and the token's metadata. */
  async issueToken(
    accountId: string,
    opts: { name: string; role?: Role; apps?: string[] | null },
  ): Promise<{ token: string; info: Token }> {
    const scoped = (opts.role ?? "admin") !== "admin" || !!opts.apps;
    // Scoped tokens get their own prefix: a server from before scoped tokens (after a rollback) would
    // otherwise accept them as full-access account tokens. It ignores this prefix instead.
    const token = id(scoped ? "clv_scoped" : "clv_acct", 24);
    const info: Token = {
      id: id("tok"),
      account_id: accountId,
      name: opts.name,
      role: opts.role ?? "admin",
      apps: opts.apps ? JSON.stringify(opts.apps) : null,
      created_at: Date.now(),
      last_used_at: null,
    };
    this.db.prepare(
      "INSERT INTO tokens (hash, id, account_id, name, role, apps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(await sha256(token), info.id, accountId, info.name, info.role, info.apps, info.created_at);
    return { token, info };
  }
  /** Looks up a token and records its use (at most once a minute, to spare writes). */
  async useToken(token: string): Promise<{ account: Account; token: Token } | undefined> {
    const hash = await sha256(token);
    const t = this.db.prepare(
      "SELECT id, account_id, name, role, apps, created_at, last_used_at FROM tokens WHERE hash = ?",
    ).get(hash) as Token | undefined;
    if (!t) return undefined;
    const account = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(t.account_id) as Account | undefined;
    if (!account) return undefined;
    const now = Date.now();
    if (!t.last_used_at || now - t.last_used_at > 60_000) {
      this.db.prepare("UPDATE tokens SET last_used_at = ? WHERE hash = ?").run(now, hash);
      t.last_used_at = now;
    }
    return { account, token: t };
  }
  tokens(accountId: string): Token[] {
    return this.db.prepare(
      "SELECT id, account_id, name, role, apps, created_at, last_used_at FROM tokens WHERE account_id = ? ORDER BY created_at, rowid",
    ).all(accountId) as unknown as Token[];
  }
  /** False if there's no such token on this account. */
  revokeToken(accountId: string, tokenId: string): boolean {
    return this.db.prepare("DELETE FROM tokens WHERE account_id = ? AND id = ?").run(accountId, tokenId).changes > 0;
  }

  // ---- apps
  /** `check` runs right before the insert, with no await in between (quota checks can't race). */
  async createApp(name: string, expiresAt: number | null, accountId: string | null, check?: () => void) {
    const deployKey = id("clv_app", 24);
    const keyHash = await sha256(deployKey);
    check?.();
    const now = Date.now();
    const app: App = {
      id: id("app"),
      name,
      account_id: accountId,
      current_deploy_id: null,
      config: "{}",
      egress: null,
      expires_at: expiresAt,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };
    this.db.prepare(
      `INSERT INTO apps (id, name, account_id, deploy_key_hash, config, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(app.id, name, accountId, keyHash, "{}", expiresAt, now, now);
    return { app, deployKey };
  }
  /** Live apps only; `includeDeleted` also finds ones a site admin deleted (their name stays taken until purged). */
  appByName(name: string, includeDeleted = false): App | undefined {
    return this.db.prepare(`SELECT * FROM apps WHERE name = ?${includeDeleted ? "" : " AND deleted_at IS NULL"}`)
      .get(name) as App | undefined;
  }
  appById(appId: string, includeDeleted = false): App | undefined {
    return this.db.prepare(`SELECT * FROM apps WHERE id = ?${includeDeleted ? "" : " AND deleted_at IS NULL"}`)
      .get(appId) as App | undefined;
  }
  /** Every app, deleted ones included (site admin view). */
  allApps(): App[] {
    return this.db.prepare("SELECT * FROM apps ORDER BY updated_at DESC").all() as unknown as App[];
  }
  setDeleted(appId: string, deletedAt: number | null) {
    this.db.prepare("UPDATE apps SET deleted_at = ? WHERE id = ?").run(deletedAt, appId);
  }
  /** Deleted by a site admin before `before`: due to be purged. */
  deletedBefore(before: number): App[] {
    return this.db.prepare("SELECT * FROM apps WHERE deleted_at IS NOT NULL AND deleted_at < ?")
      .all(before) as unknown as App[];
  }
  /** Claimed apps whose current deploy declares crons. */
  appsWithCrons(): App[] {
    return this.db.prepare(
      "SELECT * FROM apps WHERE account_id IS NOT NULL AND deleted_at IS NULL AND json_array_length(config, '$.crons') > 0",
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
    return this.db.prepare("SELECT * FROM apps WHERE account_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC")
      .all(accountId) as unknown as App[];
  }
  /** Live apps the account owns or collaborates on, with its access to each. */
  appsFor(accountId: string): (App & { access: AppAccess })[] {
    return this.db.prepare(
      `SELECT a.*, CASE WHEN a.account_id = ?1 THEN 'owner' ELSE c.role END access
       FROM apps a LEFT JOIN collaborators c ON c.app_id = a.id AND c.account_id = ?1
       WHERE a.deleted_at IS NULL AND (a.account_id = ?1 OR c.account_id IS NOT NULL)
       ORDER BY a.updated_at DESC`,
    ).all(accountId) as unknown as (App & { access: AppAccess })[];
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
  /** Live unclaimed apps (anonymous deploys) on the instance. */
  anonAppCount(): number {
    return (this.db.prepare("SELECT count(*) n FROM apps WHERE account_id IS NULL AND deleted_at IS NULL").get() as { n: number }).n;
  }
  expiredApps(now = Date.now()): App[] {
    return this.db.prepare("SELECT * FROM apps WHERE expires_at IS NOT NULL AND expires_at < ? AND deleted_at IS NULL")
      .all(now) as unknown as App[];
  }

  // ---- collaborators and invites
  /** The account's access to the app, or undefined if it has none. */
  access(a: App, accountId: string): AppAccess | undefined {
    if (a.account_id === accountId) return "owner";
    const row = this.db.prepare("SELECT role FROM collaborators WHERE app_id = ? AND account_id = ?")
      .get(a.id, accountId) as { role: Access } | undefined;
    return row?.role;
  }
  collaborators(appId: string): (Collaborator & { email: string; github_login: string | null })[] {
    return this.db.prepare(
      `SELECT c.*, ac.email, ac.github_login FROM collaborators c JOIN accounts ac ON ac.id = c.account_id
       WHERE c.app_id = ? ORDER BY c.created_at, c.rowid`,
    ).all(appId) as unknown as (Collaborator & { email: string; github_login: string | null })[];
  }
  /** False if the account isn't a collaborator on the app. */
  setCollaboratorRole(appId: string, accountId: string, role: Access): boolean {
    return this.db.prepare("UPDATE collaborators SET role = ? WHERE app_id = ? AND account_id = ?")
      .run(role, appId, accountId).changes > 0;
  }
  removeCollaborator(appId: string, accountId: string): boolean {
    return this.db.prepare("DELETE FROM collaborators WHERE app_id = ? AND account_id = ?").run(appId, accountId).changes > 0;
  }
  invites(appId: string): Invite[] {
    return this.db.prepare("SELECT * FROM invites WHERE app_id = ? ORDER BY created_at, rowid").all(appId) as unknown as Invite[];
  }
  /**
   * Creates the invite, or updates the inviter of a pending one for the same email. A new role makes it a new
   * invite (new id): an invitee accepting the old one, as shown to them, gets 404 instead of the other role.
   */
  invite(appId: string, email: string, role: Access, invitedBy: string): { invite: Invite; created: boolean } {
    email = email.toLowerCase();
    const existing = this.db.prepare("SELECT * FROM invites WHERE app_id = ? AND email = ?").get(appId, email) as Invite | undefined;
    if (existing) {
      const inviteId = existing.role === role ? existing.id : id("inv");
      this.db.prepare("UPDATE invites SET id = ?, role = ?, invited_by = ? WHERE id = ?").run(inviteId, role, invitedBy, existing.id);
      return { invite: { ...existing, id: inviteId, role, invited_by: invitedBy }, created: false };
    }
    const inv: Invite = { id: id("inv"), app_id: appId, email, role, invited_by: invitedBy, created_at: Date.now() };
    this.db.prepare("INSERT INTO invites (id, app_id, email, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(inv.id, inv.app_id, inv.email, inv.role, inv.invited_by, inv.created_at);
    return { invite: inv, created: true };
  }
  /** Deletes a pending invite on the app; false if there was none. */
  cancelInvite(appId: string, inviteId: string): boolean {
    return this.db.prepare("DELETE FROM invites WHERE app_id = ? AND id = ?").run(appId, inviteId).changes > 0;
  }
  /** Pending invites for this email on live apps. */
  invitesFor(email: string): (Invite & { app_name: string })[] {
    return this.db.prepare(
      `SELECT i.*, a.name app_name FROM invites i JOIN apps a ON a.id = i.app_id
       WHERE i.email = ? AND a.deleted_at IS NULL ORDER BY i.created_at, i.rowid`,
    ).all(email.toLowerCase()) as unknown as (Invite & { app_name: string })[];
  }
  inviteFor(email: string, inviteId: string): Invite | undefined {
    return this.db.prepare("SELECT * FROM invites WHERE id = ? AND email = ?").get(inviteId, email.toLowerCase()) as
      | Invite
      | undefined;
  }
  /** The invite becomes a collaborator (unless the account owns the app) and is deleted, in one transaction. */
  acceptInvite(inv: Invite, accountId: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("DELETE FROM invites WHERE id = ?").run(inv.id).changes) {
        this.db.prepare(
          `INSERT INTO collaborators (app_id, account_id, role, created_at)
           SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM apps WHERE id = ? AND account_id = ?)
           ON CONFLICT (app_id, account_id) DO UPDATE SET role = excluded.role`,
        ).run(inv.app_id, accountId, inv.role, Date.now(), inv.app_id, accountId);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  declineInvite(inviteId: string) {
    this.db.prepare("DELETE FROM invites WHERE id = ?").run(inviteId);
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
      "SELECT a.* FROM domains d JOIN apps a ON a.id = d.app_id WHERE d.domain = ? AND d.verified_at IS NOT NULL AND a.deleted_at IS NULL",
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
