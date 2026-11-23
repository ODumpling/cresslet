import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Db, isUniqueViolation, openDb, SqliteDb } from "./db.ts";
import { migrate } from "./migrations.ts";
import { SecretBox } from "./secretbox.ts";
import type { Visibility } from "./config.ts";


const encodeHex = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as ArrayBuffer).toString("hex");

export interface Account {
  id: string;
  email: string;
  created_at: number;
  github_id: number | null;
  github_login: string | null;
  /** "SiteAdmin" or null. */
  role: string | null;
  /** JSON AccountSettings, or null = the server's defaults. */
  settings: string | null;
  /** Set when a site admin disabled it: no login, no tokens. */
  disabled_at: number | null;
  /** Set while it's an invite (a site admin set it up, it hasn't signed in yet). */
  invited_at: number | null;
  /** The site admin who invited it, if one did. */
  invited_by: string | null;
  /** While disabled: its real email and GitHub id (`email` is a placeholder and `github_id` null meanwhile). */
  disabled_email: string | null;
  disabled_github_id: number | null;
}

/** An account's own defaults; a key left out uses the server's (Config.pages). */
export interface AccountSettings {
  pages?: { visibility?: Visibility; retentionDays?: number | null };
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
  /** "app", or "page": uploaded static files, served from `page_deploy_id` with `visibility`. */
  kind: AppKind;
  /** Pages only. */
  visibility: Visibility | null;
  /** Pages only: days kept after the last upload or retention change (`expires_at`); null = forever. */
  retention_days: number | null;
  title: string | null;
  /**
   * A page's served deploy. Pages leave `current_deploy_id` null so a server from before pages
   * (after a rollback) serves none of them: it would ignore their visibility.
   */
  page_deploy_id: string | null;
  /** The organization it belongs to: its admins and members get access (see Store.access). */
  org_id: string | null;
  /** JSON string[]: cron expressions paused in the studio (they don't fire on schedule); null = none. */
  paused_crons: string | null;
}

export type AppKind = "app" | "page";

/** A one-time ticket (exchanged on the page's host for a session cookie), or that session. */
export interface PageSession {
  app_id: string;
  account_id: string;
  ticket: number;
  expires_at: number;
}

export interface Deploy {
  id: string;
  app_id: string;
  created_at: number;
  bytes: number;
  file_count: number;
  has_server: number;
  source: string;
  /** The commit it was built from (source control), if the client said. */
  git_sha?: string | null;
  git_branch?: string | null;
  /** `owner/name`. */
  git_repo?: string | null;
}

/** Source control providers (server/git.ts). */
export const GIT_PROVIDERS = ["github"] as const;
export type GitProvider = (typeof GIT_PROVIDERS)[number];

/** One change of an app's stack (server/stack.ts): a builder turn's commit, on a branch of its own. */
export interface StackChange {
  id: string;
  app_id: string;
  stack_id: string;
  /** The stack's name: its branches are `feat/<name>/<position>-<slug>`. */
  stack_name: string;
  /** 1 = the bottom (cut from the default branch). */
  position: number;
  branch: string;
  /** The commit the branch is recorded at (GitHub is the authority: see readStacks). */
  sha: string;
  /** The commit it was cut from: the change below's, or the default branch's for the bottom one. */
  base_sha: string;
  title: string;
  prompt: string;
  /** `outside`: its branch was pushed to on GitHub and the user carried on from it as a branch of its own (no
   * longer a change of a stack); `dropped`: set aside, its branch deleted. */
  state: "open" | "landed" | "set_aside" | "outside" | "dropped";
  /** The default branch's commit that took it in (landed). */
  landed_sha: string | null;
  pr_number: number | null;
  /** The stack it was moved out of (set aside for good, dropped, carried on from: migration 8). */
  origin_stack_id?: string | null;
  /**
   * At a sync commit (a squash landed below it, squash-only repositories): the commit it was made from, its files the
   * same. The change above, cut before, holds that one (migration 9).
   */
  synced_from?: string | null;
  /** The provider login it was committed as. */
  author: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/** An account's own connection to a provider: Cresslet acts as this user there. Tokens are plaintext here, sealed at rest. */
export interface GitConnection {
  account_id: string;
  provider: GitProvider;
  /** The provider's user id. */
  provider_uid: string;
  login: string;
  /** Commit author email: the verified primary email, or the provider's noreply address. */
  email: string;
  scopes: string | null;
  access_token: string;
  refresh_token: string | null;
  /** When `access_token` expires (null: it doesn't). */
  expires_at: number | null;
  /** "active", or "expired": refreshing failed (revoked), the user has to connect again. */
  status: "active" | "expired";
  /** Which tokens these are: new on every connect and refresh, so a refresh or expiry meant for older ones doesn't apply. */
  gen: string;
  created_at: number;
  updated_at: number;
}

/** The repository an app is linked to. */
export interface AppRepo {
  app_id: string;
  provider: GitProvider;
  repo_id: string;
  owner: string;
  name: string;
  default_branch: string;
  /** Directory in the repository holding the app ("" = the root). */
  subdir: string;
  /** Delete a branch once it's merged into the default branch (1/0). */
  delete_branch: number;
  connected_by: string | null;
  last_synced_sha: string | null;
  /** The default branch's head a webhook last reported (migration 5; undefined before it). */
  upstream_sha?: string | null;
  /** Submit the stack (its pull requests) after each change (1/0; migration 7). */
  stack_auto_submit?: number;
  connected_at: number;
  updated_at: number;
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

/** Organization roles: admins manage members and own the org's apps; members get admin access to them. */
export const ORG_ROLES = ["admin", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export interface Org {
  id: string;
  name: string;
  title: string | null;
  created_at: number;
  created_by: string | null;
}

/** An invited account's access to an app. The owner is the app's `account_id`, not a collaborator. */
export const ACCESS = ["viewer", "admin"] as const;
export type Access = (typeof ACCESS)[number];
/** The caller's access to an app: its owner, or a collaborator's role. */
export type AppAccess = "owner" | Access;

const ACCESS_RANK: AppAccess[] = ["viewer", "admin", "owner"];
/** The higher of two access levels. */
export const maxAccess = (x?: AppAccess, y?: AppAccess): AppAccess | undefined =>
  !x ? y : !y ? x : ACCESS_RANK.indexOf(x) >= ACCESS_RANK.indexOf(y) ? x : y;

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

/** One AI credits ledger row (server/credits.ts): `amount` in millicredits, negative for usage. */
export interface AiLedgerRow {
  created_at: number;
  kind: string;
  amount: number;
  detail: string | null;
}

export interface AiAccountRow {
  id: string;
  email: string;
  github_login: string | null;
  balance: number;
  period_used: number;
  /** Millicredits used since the query's `since`, and how many requests. */
  used: number;
  requests: number;
  last_used_at: number | null;
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

export interface DatabaseConfig {
  /** Postgres connection string (CRESSLET_DATABASE_URL), or null: SQLite at <dataDir>/cresslet.db. */
  url: string | null;
  /** Postgres schema for Cresslet's tables (CRESSLET_DATABASE_SCHEMA). */
  schema: string;
}

/** What rate limits persist through (limits.ts RateLimit). */
export interface RateHits {
  /** Records a hit unless `key` already has `max` since `since`; true if recorded. Atomic. */
  takeRateHit(bucket: string, key: string, since: number, max: number, at: number, until: number): Promise<boolean>;
}

export class Store implements RateHits {
  readonly db: Db;
  #box: SecretBox;

  private constructor(db: Db, box: SecretBox) {
    this.db = db;
    this.#box = box;
  }

  /** Opens the metadata database (Postgres if `database.url`), applying pending migrations. */
  static async open(dataDir: string, database: DatabaseConfig = { url: null, schema: "public" }): Promise<Store> {
    mkdirSync(dataDir, { recursive: true });
    const db = openDb({ url: database.url, schema: database.schema, sqlitePath: join(dataDir, "cresslet.db") });
    try {
      if (db instanceof SqliteDb) {
        // Not settable inside a transaction.
        db.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
      }
      const { unknown } = await migrate(db);
      if (unknown.length) {
        console.warn(`cresslet: the database has migrations this server doesn't know (${
          unknown.map((m) => `${m.version} ${m.name}`).join(", ")
        }): a newer release ran against it. Running anyway (migrations only add).`);
      }
      if (db instanceof SqliteDb) {
        // Tokens a pre-named-tokens server inserted (after a rollback).
        await db.exec("UPDATE tokens SET id = 'tok_' || lower(hex(randomblob(10))) WHERE id IS NULL");
      }
      const store = new Store(db, SecretBox.load(dataDir));
      await store.#sealSecrets();
      return store;
    } catch (e) {
      await db.close().catch(() => {});
      throw e;
    }
  }

  async close() {
    await this.db.close();
  }

  /**
   * SQLite: sealed values are stored as BLOBs, plaintext ones (older versions, incl. after a rollback) as
   * TEXT, so the storage class alone tells them apart. Seals plaintext rows and re-seals rows under
   * an old key. The first run also rebuilds the file: overwritten or deleted plaintext otherwise
   * survives in free pages and the WAL. Postgres only ever holds sealed values (BYTEA).
   */
  async #sealSecrets() {
    let plaintext = 0;
    await this.db.tx(async () => {
      const rows = await this.db.all<{ app_id: string; key: string; value: string | Uint8Array }>(
        "SELECT app_id, key, value FROM secrets",
      );
      const update = (r: { app_id: string; key: string }, value: string) =>
        this.db.run("UPDATE secrets SET value = ? WHERE app_id = ? AND key = ?", this.#seal(r.app_id, r.key, value), r.app_id, r.key);
      for (const r of rows) {
        if (typeof r.value === "string") {
          await update(r, r.value);
          plaintext++;
        } else {
          const { value, stale } = this.#box.open(r.app_id, r.key, Buffer.from(r.value).toString());
          if (stale) await update(r, value);
        }
      }
      // Source control tokens: only re-sealed under the primary key (they're never stored plaintext).
      const conns = await this.db.all<{ account_id: string; provider: string; access_token: Uint8Array; refresh_token: Uint8Array | null }>(
        "SELECT account_id, provider, access_token, refresh_token FROM git_connections",
      );
      for (const r of conns) {
        const scope = gitScope(r.account_id);
        const a = this.#box.open(scope, gitKey(r.provider, "access"), Buffer.from(r.access_token).toString());
        const f = r.refresh_token ? this.#box.open(scope, gitKey(r.provider, "refresh"), Buffer.from(r.refresh_token).toString()) : null;
        if (a.stale || f?.stale) {
          await this.db.run(
            "UPDATE git_connections SET access_token = ?, refresh_token = ? WHERE account_id = ? AND provider = ?",
            this.#seal(scope, gitKey(r.provider, "access"), a.value),
            f ? this.#seal(scope, gitKey(r.provider, "refresh"), f.value) : null,
            r.account_id, r.provider,
          );
        }
      }
      // Cleanup pending until the rebuild below succeeds (retried next start if the checkpoint is busy).
      if (plaintext && this.db.dialect === "sqlite") await this.db.exec("PRAGMA user_version = 0");
    });
    if (!(this.db instanceof SqliteDb)) return;
    const raw = this.db.raw;
    const { user_version } = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    if (user_version < 1) {
      raw.exec("VACUUM");
      const ck = raw.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
      // Only mark done once the old pages are really gone (busy = a reader kept the WAL pinned).
      if (!ck.busy) raw.exec("PRAGMA user_version = 1");
    }
  }

  #seal(appId: string, key: string, value: string): Uint8Array {
    return Buffer.from(this.#box.seal(appId, key, value));
  }

  /** Runs `fn` in a transaction holding `lock` (see Db.lock): check-then-write without races. */
  serialized<T>(lock: string, fn: () => Promise<T>): Promise<T> {
    return this.db.tx(async () => {
      await this.db.lock(lock);
      return fn();
    });
  }

  // ---- accounts
  /** `invite`: a site admin invites it (it signs in with GitHub later, by email); `by`: their account. */
  async createAccount(email: string, github?: { id: number; login: string }, invite?: { by: string | null }): Promise<Account> {
    const a: Account = {
      id: id("acct"),
      email: email.toLowerCase(),
      created_at: Date.now(),
      github_id: github?.id ?? null,
      github_login: github?.login ?? null,
      role: null,
      settings: null,
      disabled_at: null,
      invited_at: invite ? Date.now() : null,
      invited_by: invite?.by ?? null,
      disabled_email: null,
      disabled_github_id: null,
    };
    await this.db.run(
      "INSERT INTO accounts (id, email, created_at, github_id, github_login, invited_at, invited_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      a.id, a.email, a.created_at, a.github_id, a.github_login, a.invited_at, a.invited_by,
    );
    return a;
  }
  /** Every account, oldest first, with when one of its tokens was last used, and how many live apps it owns. */
  allAccounts(): Promise<(Account & { last_used_at: number | null; tokens: number; apps: number })[]> {
    return this.db.all(
      `SELECT ac.*, (SELECT MAX(last_used_at) FROM tokens t WHERE t.account_id = ac.id) AS last_used_at,
         (SELECT count(*) FROM tokens t WHERE t.account_id = ac.id) AS tokens,
         (SELECT count(*) FROM apps a WHERE a.account_id = ac.id AND a.org_id IS NULL AND a.deleted_at IS NULL) AS apps
       FROM accounts ac ORDER BY ac.created_at, ac.id`,
    );
  }
  /**
   * Disables an account: deletes its tokens and private-page sessions, and moves its email and GitHub id aside
   * (`disabled_email`, `disabled_github_id`; `email` becomes a placeholder), so no login finds it, not even a
   * server from before disabling existed (after a rollback). Under the account's lock, which token issuing takes
   * too: nothing issued meanwhile survives. Its org apps go to another org admin (reassignOrgApps).
   */
  disableAccount(accountId: string): Promise<boolean> {
    return this.serialized(accountLock(accountId), async () => {
      // Each organization's lock (in a fixed order), as member changes take, before this account's row is
      // locked by the update: two disables handing apps to each other wait here rather than deadlock.
      const orgs = (await this.orgsFor(accountId)).map((o) => o.id).sort();
      for (const o of orgs) await this.db.lock(orgLock(o));
      const r = await this.db.run(
        `UPDATE accounts SET disabled_at = ?, disabled_email = email, disabled_github_id = github_id,
           email = 'disabled+' || id || '@invalid', github_id = NULL
         WHERE id = ? AND disabled_at IS NULL`,
        Date.now(), accountId,
      );
      await this.db.run("DELETE FROM tokens WHERE account_id = ?", accountId);
      await this.db.run("DELETE FROM page_sessions WHERE account_id = ?", accountId);
      for (const o of orgs) await this.reassignOrgApps(o, accountId);
      return r.changes > 0;
    });
  }
  /**
   * Re-enables it, putting its email and GitHub id back: "taken" if another account has either now (that
   * account has to change or go first).
   */
  enableAccount(accountId: string): Promise<"ok" | "taken"> {
    return this.serialized(accountLock(accountId), async () => {
      const a = await this.accountById(accountId);
      if (!a?.disabled_at) return "ok";
      const email = a.disabled_email ?? a.email;
      const other = await this.db.get<{ id: string }>(
        "SELECT id FROM accounts WHERE id <> ? AND (email = ? OR (CAST(? AS BIGINT) IS NOT NULL AND github_id = ?))",
        accountId, email, a.disabled_github_id, a.disabled_github_id,
      );
      if (other) return "taken";
      try {
        await this.db.run(
          `UPDATE accounts SET disabled_at = NULL, email = ?, github_id = ?, disabled_email = NULL, disabled_github_id = NULL
           WHERE id = ?`,
          email, a.disabled_github_id, accountId,
        );
      } catch (e) {
        if (isUniqueViolation(e)) return "taken"; // taken meanwhile (a signup doesn't take this lock)
        throw e;
      }
      return "ok";
    });
  }
  /** A disabled account that signed in with this GitHub id, or has this email. */
  disabledAccount(match: { githubId?: number; emails?: string[] }): Promise<Account | undefined> {
    const emails = (match.emails ?? []).map((e) => e.toLowerCase());
    return this.db.get<Account>(
      `SELECT * FROM accounts WHERE disabled_at IS NOT NULL AND (disabled_github_id = ?${
        emails.length ? ` OR disabled_email IN (${emails.map(() => "?").join(", ")})` : ""
      }) LIMIT 1`,
      match.githubId ?? -1, ...emails,
    );
  }
  /**
   * Deletes an account that's still an invite (never signed in) and owns nothing: "not_invited" if it isn't (any
   * more), "last_admin" if it's the only enabled admin of an organization (which would be left with none).
   */
  deleteInvitedAccount(accountId: string): Promise<"ok" | "not_invited" | "last_admin"> {
    return this.serialized(accountLock(accountId), async () => {
      const orgs = (await this.orgsFor(accountId)).sort((x, y) => (x.id < y.id ? -1 : 1));
      for (const o of orgs) await this.db.lock(orgLock(o.id));
      // Roles as they are now, under the locks.
      for (const o of orgs) if (await this.orgRole(o.id, accountId) === "admin" && await this.orgAdminCount(o.id) <= 1) return "last_admin";
      return (await this.db.run(
        `DELETE FROM accounts WHERE id = ? AND invited_at IS NOT NULL AND github_id IS NULL AND disabled_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM tokens WHERE account_id = accounts.id)
           AND NOT EXISTS (SELECT 1 FROM apps WHERE account_id = accounts.id)`,
        accountId,
      )).changes ? "ok" : "not_invited";
    });
  }
  accountByGithub(githubId: number): Promise<Account | undefined> {
    return this.db.get<Account>("SELECT * FROM accounts WHERE github_id = ?", githubId);
  }
  /** Not on a disabled account (disabled meanwhile: its GitHub id stays aside, see disableAccount). */
  async linkGithub(accountId: string, github: { id: number; login: string }) {
    await this.db.run("UPDATE accounts SET github_id = ?, github_login = ? WHERE id = ? AND disabled_at IS NULL", github.id, github.login, accountId);
  }
  accountById(accountId: string): Promise<Account | undefined> {
    return this.db.get<Account>("SELECT * FROM accounts WHERE id = ?", accountId);
  }
  settings(a: Account): AccountSettings {
    return a.settings ? JSON.parse(a.settings) : {};
  }
  async setSettings(accountId: string, settings: AccountSettings) {
    await this.db.run("UPDATE accounts SET settings = ? WHERE id = ?", JSON.stringify(settings), accountId);
  }
  async setRole(accountId: string, role: string | null) {
    await this.db.run("UPDATE accounts SET role = ? WHERE id = ?", role, accountId);
  }
  async revokeTokens(accountId: string) {
    await this.db.run("DELETE FROM tokens WHERE account_id = ?", accountId);
  }
  accountByEmail(email: string): Promise<Account | undefined> {
    return this.db.get<Account>("SELECT * FROM accounts WHERE email = ?", email.toLowerCase());
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
    const hash = await sha256(token);
    await this.serialized(accountLock(accountId), async () => {
      // Disabled meanwhile (a login in flight): no token. The insert refuses it in the same statement.
      const r = await this.db.run(
        `INSERT INTO tokens (hash, id, account_id, name, role, apps, created_at)
         SELECT ?, ?, id, ?, ?, ?, ? FROM accounts WHERE id = ? AND disabled_at IS NULL`,
        hash, info.id, info.name, info.role, info.apps, info.created_at, accountId,
      );
      if (!r.changes) throw new AccountDisabledError();
      await this.db.run("UPDATE accounts SET invited_at = NULL WHERE id = ? AND invited_at IS NOT NULL", accountId);
    });
    return { token, info };
  }
  /** Looks up a token and records its use (at most once a minute, to spare writes). */
  async useToken(token: string): Promise<{ account: Account; token: Token } | undefined> {
    const hash = await sha256(token);
    const t = await this.db.get<Token>(
      "SELECT id, account_id, name, role, apps, created_at, last_used_at FROM tokens WHERE hash = ?", hash,
    );
    if (!t) return undefined;
    const account = await this.db.get<Account>("SELECT * FROM accounts WHERE id = ?", t.account_id);
    if (!account || account.disabled_at) return undefined;
    const now = Date.now();
    if (!t.last_used_at || now - t.last_used_at > 60_000) {
      await this.db.run("UPDATE tokens SET last_used_at = ? WHERE hash = ?", now, hash);
      t.last_used_at = now;
    }
    return { account, token: t };
  }
  tokens(accountId: string): Promise<Token[]> {
    return this.db.all<Token>(
      "SELECT id, account_id, name, role, apps, created_at, last_used_at FROM tokens WHERE account_id = ? ORDER BY created_at, rowid",
      accountId,
    );
  }
  /** False if there's no such token on this account. */
  async revokeToken(accountId: string, tokenId: string): Promise<boolean> {
    return (await this.db.run("DELETE FROM tokens WHERE account_id = ? AND id = ?", accountId, tokenId)).changes > 0;
  }

  // ---- apps
  /**
   * `check` runs right before the insert, in its transaction, while holding the app-creation lock: quota
   * checks can't race (also across servers sharing a Postgres database). It throws to refuse.
   * Every new app has an owner: apps without one are only those from before anonymous deploys were removed.
   */
  async createApp(name: string, accountId: string, check?: () => Promise<void>) {
    const deployKey = id("clv_app", 24);
    const keyHash = await sha256(deployKey);
    return this.serialized("cresslet:create-app", async () => {
      await check?.();
      const now = Date.now();
      const app: App = {
        id: id("app"),
        name,
        account_id: accountId,
        current_deploy_id: null,
        config: "{}",
        egress: null,
        expires_at: null,
        deleted_at: null,
        created_at: now,
        updated_at: now,
        kind: "app",
        visibility: null,
        retention_days: null,
        title: null,
        page_deploy_id: null,
        org_id: null,
        paused_crons: null,
      };
      await this.db.run(
        `INSERT INTO apps (id, name, account_id, deploy_key_hash, config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        app.id, name, accountId, keyHash, "{}", now, now,
      );
      return { app, deployKey };
    });
  }
  /** A page has no usable deploy key (only accounts change it). `check` as in createApp. */
  async createPage(
    name: string,
    accountId: string,
    p: { title: string | null; visibility: Visibility; retentionDays: number | null },
    check?: () => Promise<void>,
  ): Promise<App> {
    const keyHash = await sha256(id("clv_none", 24)); // never handed out
    return this.serialized("cresslet:create-app", async () => {
      await check?.();
      const now = Date.now();
      const app: App = {
        id: id("app"),
        name,
        account_id: accountId,
        current_deploy_id: null,
        config: "{}",
        egress: null,
        expires_at: p.retentionDays === null ? null : now + p.retentionDays * 86_400_000,
        deleted_at: null,
        created_at: now,
        updated_at: now,
        kind: "page",
        visibility: p.visibility,
        retention_days: p.retentionDays,
        title: p.title,
        page_deploy_id: null,
        org_id: null,
        paused_crons: null,
      };
      await this.db.run(
        `INSERT INTO apps (id, name, account_id, deploy_key_hash, config, expires_at, created_at, updated_at,
           kind, visibility, retention_days, title)
         VALUES (?, ?, ?, ?, '{}', ?, ?, ?, 'page', ?, ?, ?)`,
        app.id, name, accountId, keyHash, app.expires_at, now, now, app.visibility, app.retention_days, app.title,
      );
      return app;
    });
  }
  async setPageDeploy(appId: string, deployId: string) {
    await this.db.run("UPDATE apps SET page_deploy_id = ?, updated_at = ? WHERE id = ?", deployId, Date.now(), appId);
  }
  /** Changes a page's settings; a new `retention_days` restarts its clock (`expires_at` from now). */
  async setPage(appId: string, p: { title?: string | null; visibility?: Visibility; retention_days?: number | null }) {
    const now = Date.now();
    await this.db.tx(async () => {
      if (p.title !== undefined) await this.db.run("UPDATE apps SET title = ? WHERE id = ?", p.title, appId);
      if (p.visibility !== undefined) await this.db.run("UPDATE apps SET visibility = ? WHERE id = ?", p.visibility, appId);
      if (p.retention_days !== undefined) {
        await this.db.run("UPDATE apps SET retention_days = ?, expires_at = ? WHERE id = ?",
          p.retention_days, p.retention_days === null ? null : now + p.retention_days * 86_400_000, appId);
      }
      await this.db.run("UPDATE apps SET updated_at = ? WHERE id = ?", now, appId);
    });
  }
  /** Live apps only; `includeDeleted` also finds ones a site admin deleted (their name stays taken until purged). */
  appByName(name: string, includeDeleted = false): Promise<App | undefined> {
    return this.db.get<App>(`SELECT * FROM apps WHERE name = ?${includeDeleted ? "" : " AND deleted_at IS NULL"}`, name);
  }
  appById(appId: string, includeDeleted = false): Promise<App | undefined> {
    return this.db.get<App>(`SELECT * FROM apps WHERE id = ?${includeDeleted ? "" : " AND deleted_at IS NULL"}`, appId);
  }
  /** Every app, deleted ones included (site admin view). */
  allApps(): Promise<App[]> {
    return this.db.all<App>("SELECT * FROM apps ORDER BY updated_at DESC");
  }
  async setDeleted(appId: string, deletedAt: number | null) {
    await this.db.run("UPDATE apps SET deleted_at = ? WHERE id = ?", deletedAt, appId);
  }
  /** Deleted by a site admin before `before`: due to be purged. */
  deletedBefore(before: number): Promise<App[]> {
    return this.db.all<App>("SELECT * FROM apps WHERE deleted_at IS NOT NULL AND deleted_at < ?", before);
  }
  /** Claimed apps whose current deploy declares crons. */
  appsWithCrons(): Promise<App[]> {
    const crons = this.db.dialect === "postgres"
      ? "json_typeof(config::json -> 'crons') = 'array' AND json_array_length(config::json -> 'crons') > 0"
      : "json_array_length(config, '$.crons') > 0";
    return this.db.all<App>(`SELECT * FROM apps WHERE account_id IS NOT NULL AND deleted_at IS NULL AND ${crons}`);
  }
  /**
   * Per-app number for sandbox uids, allocated on first use from a counter that never goes back
   * (not the rowid: SQLite reuses the highest one after a delete), so a uid is never reused.
   */
  async uidSeq(appId: string): Promise<number> {
    const get = () => this.db.get<{ uid_seq: number | null }>("SELECT uid_seq FROM apps WHERE id = ?", appId);
    const row = await get();
    if (!row) throw new Error(`no app ${appId}`);
    if (row.uid_seq !== null) return row.uid_seq;
    return this.serialized("cresslet:uid-seq", async () => {
      const again = await get(); // another caller may have allocated it meanwhile
      if (!again) throw new Error(`no app ${appId}`);
      if (again.uid_seq !== null) return again.uid_seq;
      const n = ((await this.db.get<{ value: number }>("SELECT value FROM meta WHERE key = 'uid_seq'"))?.value ?? 0) + 1;
      await this.db.run("INSERT INTO meta (key, value) VALUES ('uid_seq', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", n);
      await this.db.run("UPDATE apps SET uid_seq = ? WHERE id = ?", n, appId);
      return n;
    });
  }
  /** Live personal apps (or pages) of the account: not ones in an organization. For quotas. */
  appsByAccount(accountId: string, kind: AppKind = "app"): Promise<App[]> {
    return this.db.all<App>(
      "SELECT * FROM apps WHERE account_id = ? AND kind = ? AND org_id IS NULL AND deleted_at IS NULL ORDER BY updated_at DESC",
      accountId, kind,
    );
  }
  /** Live apps (or pages) the account owns, collaborates on or reaches through an organization, with its access to each. */
  async appsFor(accountId: string, kind: AppKind = "app"): Promise<(App & { access: AppAccess })[]> {
    const rows = await this.db.all<App & { collab: Access | null; org_role: OrgRole | null }>(
      `SELECT a.*, c.role AS collab, m.role AS org_role
       FROM apps a LEFT JOIN collaborators c ON c.app_id = a.id AND c.account_id = ?
       LEFT JOIN org_members m ON m.org_id = a.org_id AND m.account_id = ?
       WHERE a.deleted_at IS NULL AND a.kind = ?
         AND ((a.org_id IS NULL AND a.account_id = ?) OR c.account_id IS NOT NULL OR m.account_id IS NOT NULL)
       ORDER BY a.updated_at DESC`,
      accountId, accountId, kind, accountId,
    );
    return rows.map(({ collab, org_role, ...a }) => {
      const own: AppAccess | undefined = !a.org_id && a.account_id === accountId ? "owner"
        : org_role === "admin" ? "owner" : org_role === "member" ? "admin" : undefined;
      return { ...a, access: maxAccess(own, collab ?? undefined)! };
    });
  }
  async checkDeployKey(appId: string, key: string): Promise<boolean> {
    const row = await this.db.get<{ h: string }>("SELECT deploy_key_hash AS h FROM apps WHERE id = ?", appId);
    return !!row && row.h === await sha256(key);
  }
  /** Paused crons the new config doesn't have are forgotten (one brought back later isn't paused). */
  async setCurrentDeploy(appId: string, deployId: string, config: unknown) {
    const crons = (config as { crons?: string[] } | null)?.crons ?? [];
    await this.serialized(cronsLock(appId), async () => {
      const row = await this.db.get<{ paused_crons: string | null }>("SELECT paused_crons FROM apps WHERE id = ?", appId);
      const paused = row?.paused_crons ? (JSON.parse(row.paused_crons) as string[]).filter((c) => crons.includes(c)) : [];
      await this.db.run("UPDATE apps SET current_deploy_id = ?, config = ?, paused_crons = ?, updated_at = ? WHERE id = ?",
        deployId, JSON.stringify(config ?? {}), paused.length ? JSON.stringify(paused) : null, Date.now(), appId);
    });
  }
  async setPausedCrons(appId: string, crons: string[]) {
    await this.db.run("UPDATE apps SET paused_crons = ?, updated_at = ? WHERE id = ?", crons.length ? JSON.stringify(crons) : null, Date.now(), appId);
  }
  async setEgress(appId: string, allow: string[] | null) {
    await this.db.run("UPDATE apps SET egress = ?, updated_at = ? WHERE id = ?", allow ? JSON.stringify(allow) : null, Date.now(), appId);
  }
  async deleteApp(appId: string) {
    await this.db.run("DELETE FROM apps WHERE id = ?", appId);
  }
  // ---- rate-limit hits (limits.ts RateLimit)
  takeRateHit(bucket: string, key: string, since: number, max: number, at: number, until: number): Promise<boolean> {
    return this.serialized(`cresslet:rate:${bucket}:${key}`, async () => {
      const { n } = (await this.db.get<{ n: number }>(
        "SELECT count(*) AS n FROM rate_hits WHERE bucket = ? AND key = ? AND at > ?", bucket, key, since,
      ))!;
      if (n >= max) return false;
      await this.db.run("INSERT INTO rate_hits (bucket, key, at, until) VALUES (?, ?, ?, ?)", bucket, key, at, until);
      return true;
    });
  }
  /** Drops rate-limit hits that have left their window. */
  async pruneRateHits(now = Date.now()) {
    await this.db.run("DELETE FROM rate_hits WHERE until <= ?", now);
  }
  expiredApps(now = Date.now()): Promise<App[]> {
    return this.db.all<App>("SELECT * FROM apps WHERE expires_at IS NOT NULL AND expires_at < ? AND deleted_at IS NULL", now);
  }

  // ---- private page sessions (see host.ts)
  /** A one-time ticket for `accountId` to open the page, good for `ttlMs`. */
  async pageTicket(appId: string, accountId: string, ttlMs: number): Promise<string> {
    const t = id("pvt", 24);
    await this.db.run("INSERT INTO page_sessions (hash, app_id, account_id, ticket, expires_at) VALUES (?, ?, ?, 1, ?)",
      await sha256(t), appId, accountId, Date.now() + ttlMs);
    return t;
  }
  /** Spends a ticket for this page: a session token good for `ttlMs`, or undefined. */
  async redeemPageTicket(appId: string, ticket: string, ttlMs: number): Promise<{ token: string; account_id: string } | undefined> {
    const hash = await sha256(ticket);
    const row = await this.db.get<PageSession>("DELETE FROM page_sessions WHERE hash = ? AND ticket = 1 RETURNING *", hash);
    if (!row || row.app_id !== appId || row.expires_at < Date.now()) return undefined;
    const token = id("pvs", 24);
    await this.db.run("INSERT INTO page_sessions (hash, app_id, account_id, ticket, expires_at) VALUES (?, ?, ?, 0, ?)",
      await sha256(token), appId, row.account_id, Date.now() + ttlMs);
    return { token, account_id: row.account_id };
  }
  /** The account a live session for this page belongs to. */
  async pageSession(appId: string, token: string): Promise<string | undefined> {
    const row = await this.db.get<PageSession>("SELECT * FROM page_sessions WHERE hash = ? AND ticket = 0", await sha256(token));
    return row && row.app_id === appId && row.expires_at > Date.now() ? row.account_id : undefined;
  }
  async prunePageSessions(now = Date.now()) {
    await this.db.run("DELETE FROM page_sessions WHERE expires_at < ?", now);
  }

  // ---- collaborators and invites
  /**
   * The account's access to the app, or undefined if it has none (always for a disabled account). An app in an
   * organization belongs to the organization: its admins are owners, its members admins (`account_id` alone
   * doesn't count, so a removed member loses the apps they created there); a collaborator role can add to that.
   */
  async access(a: App, accountId: string): Promise<AppAccess | undefined> {
    const row = await this.db.get<{ disabled: number; collab: Access | null; org: OrgRole | null }>(
      `SELECT ac.disabled_at IS NOT NULL AS disabled,
         (SELECT role FROM collaborators WHERE app_id = ? AND account_id = ac.id) AS collab,
         (SELECT role FROM org_members WHERE org_id = ? AND account_id = ac.id) AS org
       FROM accounts ac WHERE ac.id = ?`,
      a.id, a.org_id, accountId,
    );
    if (!row || row.disabled) return undefined;
    if (!a.org_id && a.account_id === accountId) return "owner";
    const fromOrg: AppAccess | undefined = row.org === "admin" ? "owner" : row.org === "member" ? "admin" : undefined;
    return maxAccess(fromOrg, row.collab ?? undefined);
  }
  collaborators(appId: string): Promise<(Collaborator & { email: string; github_login: string | null })[]> {
    return this.db.all<Collaborator & { email: string; github_login: string | null }>(
      `SELECT c.app_id, c.account_id, c.role, c.created_at, COALESCE(ac.disabled_email, ac.email) AS email, ac.github_login
       FROM collaborators c JOIN accounts ac ON ac.id = c.account_id
       WHERE c.app_id = ? ORDER BY c.created_at, c.rowid`,
      appId,
    );
  }
  /** False if the account isn't a collaborator on the app. */
  async setCollaboratorRole(appId: string, accountId: string, role: Access): Promise<boolean> {
    return (await this.db.run("UPDATE collaborators SET role = ? WHERE app_id = ? AND account_id = ?", role, appId, accountId)).changes > 0;
  }
  async removeCollaborator(appId: string, accountId: string): Promise<boolean> {
    return (await this.db.run("DELETE FROM collaborators WHERE app_id = ? AND account_id = ?", appId, accountId)).changes > 0;
  }
  invites(appId: string): Promise<Invite[]> {
    return this.db.all<Invite>(`SELECT ${INVITE} FROM invites WHERE app_id = ? ORDER BY created_at, rowid`, appId);
  }
  /**
   * Creates the invite, or updates the inviter of a pending one for the same email. A new role makes it a new
   * invite (new id): an invitee accepting the old one, as shown to them, gets 404 instead of the other role.
   */
  invite(appId: string, email: string, role: Access, invitedBy: string): Promise<{ invite: Invite; created: boolean }> {
    email = email.toLowerCase();
    return this.serialized(inviteLock(appId), async () => {
      const existing = await this.db.get<Invite>(`SELECT ${INVITE} FROM invites WHERE app_id = ? AND email = ?`, appId, email);
      if (existing) {
        const inviteId = existing.role === role ? existing.id : id("inv");
        // Cancelled or declined meanwhile (those don't take the lock): a new invite then, below.
        if ((await this.db.run("UPDATE invites SET id = ?, role = ?, invited_by = ? WHERE id = ?", inviteId, role, invitedBy, existing.id)).changes) {
          return { invite: { ...existing, id: inviteId, role, invited_by: invitedBy }, created: false };
        }
      }
      const inv: Invite = { id: id("inv"), app_id: appId, email, role, invited_by: invitedBy, created_at: Date.now() };
      await this.db.run("INSERT INTO invites (id, app_id, email, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        inv.id, inv.app_id, inv.email, inv.role, inv.invited_by, inv.created_at);
      return { invite: inv, created: true };
    });
  }
  /** Deletes a pending invite on the app; false if there was none. */
  async cancelInvite(appId: string, inviteId: string): Promise<boolean> {
    return (await this.db.run("DELETE FROM invites WHERE app_id = ? AND id = ?", appId, inviteId)).changes > 0;
  }
  /** Pending invites for this email on live apps. */
  invitesFor(email: string): Promise<(Invite & { app_name: string })[]> {
    return this.db.all<Invite & { app_name: string }>(
      `SELECT i.id, i.app_id, i.email, i.role, i.invited_by, i.created_at, a.name AS app_name
       FROM invites i JOIN apps a ON a.id = i.app_id
       WHERE i.email = ? AND a.deleted_at IS NULL ORDER BY i.created_at, i.rowid`,
      email.toLowerCase(),
    );
  }
  inviteFor(email: string, inviteId: string): Promise<Invite | undefined> {
    return this.db.get<Invite>(`SELECT ${INVITE} FROM invites WHERE id = ? AND email = ?`, inviteId, email.toLowerCase());
  }
  /**
   * The invite becomes a collaborator (unless the account owns the app) and is deleted, in one transaction
   * under the app's invite lock. False if it was already gone (accepted, cancelled, or resent as a new one).
   */
  acceptInvite(inv: Invite, accountId: string): Promise<boolean> {
    return this.serialized(inviteLock(inv.app_id), async () => {
      if (!(await this.db.run("DELETE FROM invites WHERE id = ?", inv.id)).changes) return false;
      await this.db.run(
        `INSERT INTO collaborators (app_id, account_id, role, created_at)
         SELECT CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS BIGINT)
         WHERE NOT EXISTS (SELECT 1 FROM apps WHERE id = ? AND account_id = ? AND org_id IS NULL)
         ON CONFLICT (app_id, account_id) DO UPDATE SET role = excluded.role`,
        inv.app_id, accountId, inv.role, Date.now(), inv.app_id, accountId,
      );
      return true;
    });
  }
  async declineInvite(inviteId: string) {
    await this.db.run("DELETE FROM invites WHERE id = ?", inviteId);
  }

  // ---- organizations (created by site admins; see docs/api.md#organizations)
  async createOrg(name: string, title: string | null, createdBy: string | null): Promise<Org> {
    const o: Org = { id: id("org"), name, title, created_at: Date.now(), created_by: createdBy };
    await this.db.run("INSERT INTO orgs (id, name, title, created_at, created_by) VALUES (?, ?, ?, ?, ?)",
      o.id, o.name, o.title, o.created_at, o.created_by);
    return o;
  }
  orgByName(name: string): Promise<Org | undefined> {
    return this.db.get<Org>("SELECT * FROM orgs WHERE name = ?", name);
  }
  orgById(orgId: string): Promise<Org | undefined> {
    return this.db.get<Org>("SELECT * FROM orgs WHERE id = ?", orgId);
  }
  /** Every organization, with how many members and live apps (site admin view). */
  allOrgs(): Promise<(Org & { members: number; apps: number })[]> {
    return this.db.all(
      `SELECT o.*, (SELECT count(*) FROM org_members m WHERE m.org_id = o.id) AS members,
         (SELECT count(*) FROM apps a WHERE a.org_id = o.id AND a.deleted_at IS NULL) AS apps
       FROM orgs o ORDER BY o.name`,
    );
  }
  /** The organizations an account belongs to, with its role in each. */
  orgsFor(accountId: string): Promise<(Org & { role: OrgRole })[]> {
    return this.db.all(
      `SELECT o.*, m.role FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.account_id = ? ORDER BY o.name`, accountId,
    );
  }
  async setOrgTitle(orgId: string, title: string | null) {
    await this.db.run("UPDATE orgs SET title = ? WHERE id = ?", title, orgId);
  }
  /** Deletes it; its apps stay, back with their `account_id` owners (ON DELETE SET NULL). */
  async deleteOrg(orgId: string) {
    await this.db.run("DELETE FROM orgs WHERE id = ?", orgId);
  }
  orgRole(orgId: string, accountId: string): Promise<OrgRole | undefined> {
    return this.db.get<{ role: OrgRole }>("SELECT role FROM org_members WHERE org_id = ? AND account_id = ?", orgId, accountId)
      .then((r) => r?.role);
  }
  orgMembers(orgId: string): Promise<{ account_id: string; role: OrgRole; created_at: number; email: string; github_login: string | null; disabled_at: number | null }[]> {
    return this.db.all(
      `SELECT m.account_id, m.role, m.created_at, COALESCE(ac.disabled_email, ac.email) AS email, ac.github_login, ac.disabled_at
       FROM org_members m JOIN accounts ac ON ac.id = m.account_id WHERE m.org_id = ? ORDER BY m.created_at, m.rowid`,
      orgId,
    );
  }
  /** Adds the account or changes its role. */
  async setOrgMember(orgId: string, accountId: string, role: OrgRole) {
    await this.db.run(
      `INSERT INTO org_members (org_id, account_id, role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (org_id, account_id) DO UPDATE SET role = excluded.role`,
      orgId, accountId, role, Date.now(),
    );
  }
  async removeOrgMember(orgId: string, accountId: string): Promise<boolean> {
    return (await this.db.run("DELETE FROM org_members WHERE org_id = ? AND account_id = ?", orgId, accountId)).changes > 0;
  }
  /** Enabled admins of the organization. */
  async orgAdminCount(orgId: string): Promise<number> {
    return (await this.db.get<{ n: number }>(
      `SELECT count(*) AS n FROM org_members m JOIN accounts ac ON ac.id = m.account_id
       WHERE m.org_id = ? AND m.role = 'admin' AND ac.disabled_at IS NULL`, orgId,
    ))!.n;
  }
  /**
   * Gives the organization's apps held by `fromAccount` (their `account_id`, which a server from before
   * organizations treats as the owner) to another enabled org admin, else an enabled member: run when that account
   * leaves or is removed, or is disabled. (Removing the last admin is refused; a disabled holder with nobody to
   * hand to keeps them, locked out even on an older server.)
   */
  async reassignOrgApps(orgId: string, fromAccount: string) {
    const to = await this.db.get<{ account_id: string }>(
      `SELECT m.account_id FROM org_members m JOIN accounts ac ON ac.id = m.account_id
       WHERE m.org_id = ? AND ac.disabled_at IS NULL AND m.account_id <> ?
       ORDER BY CASE WHEN m.role = 'admin' THEN 0 ELSE 1 END, m.created_at, m.account_id LIMIT 1`,
      orgId, fromAccount,
    );
    if (to) await this.db.run("UPDATE apps SET account_id = ? WHERE org_id = ? AND account_id = ?", to.account_id, orgId, fromAccount);
  }
  /** Apps and artifacts in the organization (deleted ones included) whose `account_id` is this account. */
  async orgAppsHeldBy(orgId: string, accountId: string): Promise<number> {
    return (await this.db.get<{ n: number }>("SELECT count(*) AS n FROM apps WHERE org_id = ? AND account_id = ?", orgId, accountId))!.n;
  }
  /** Apps and artifacts in the organization, deleted ones included. */
  async orgAppCount(orgId: string): Promise<number> {
    return (await this.db.get<{ n: number }>("SELECT count(*) AS n FROM apps WHERE org_id = ?", orgId))!.n;
  }
  /** Live apps and artifacts in the organization. */
  orgApps(orgId: string): Promise<App[]> {
    return this.db.all<App>("SELECT * FROM apps WHERE org_id = ? AND deleted_at IS NULL ORDER BY kind, name", orgId);
  }
  /** Moves an app into an organization, or out of one (`orgId` null) to `accountId` as its owner. */
  async setAppOrg(appId: string, orgId: string | null, accountId: string) {
    await this.db.run("UPDATE apps SET org_id = ?, account_id = ?, updated_at = ? WHERE id = ?", orgId, accountId, Date.now(), appId);
  }

  // ---- custom domains (pending until DNS-verified; one verified owner per domain)
  domains(appId: string): Promise<Domain[]> {
    return this.db.all<Domain>("SELECT * FROM domains WHERE app_id = ? ORDER BY domain", appId);
  }
  async addDomain(appId: string, domain: string): Promise<Domain> {
    const d: Domain = { domain, app_id: appId, token: id("cresslet-verify", 16), verified_at: null, created_at: Date.now() };
    await this.db.run("INSERT INTO domains (domain, app_id, token, verified_at, created_at) VALUES (?, ?, ?, NULL, ?)",
      d.domain, d.app_id, d.token, d.created_at);
    return d;
  }
  /** Marks the row whose `token` was checked as verified: "gone" if it was deleted/re-added meanwhile. */
  async verifyDomain(appId: string, domain: string, token: string): Promise<"ok" | "taken" | "gone"> {
    try {
      const r = await this.db.run("UPDATE domains SET verified_at = ? WHERE app_id = ? AND domain = ? AND token = ?",
        Date.now(), appId, domain, token);
      return r.changes ? "ok" : "gone";
    } catch (e) {
      if (isUniqueViolation(e)) return "taken";
      throw e;
    }
  }
  async deleteDomain(appId: string, domain: string) {
    await this.db.run("DELETE FROM domains WHERE app_id = ? AND domain = ?", appId, domain);
  }
  appByDomain(domain: string): Promise<App | undefined> {
    return this.db.get<App>(
      "SELECT a.* FROM domains d JOIN apps a ON a.id = d.app_id WHERE d.domain = ? AND d.verified_at IS NOT NULL AND a.deleted_at IS NULL",
      domain,
    );
  }

  // ---- deploys
  async addDeploy(d: Deploy) {
    await this.db.run(
      `INSERT INTO deploys (id, app_id, created_at, bytes, file_count, has_server, source, git_sha, git_branch, git_repo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      d.id, d.app_id, d.created_at, d.bytes, d.file_count, d.has_server, d.source,
      d.git_sha ?? null, d.git_branch ?? null, d.git_repo ?? null,
    );
  }
  deploys(appId: string, limit = 20): Promise<Deploy[]> {
    return this.db.all<Deploy>(`SELECT ${DEPLOY} FROM deploys WHERE app_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`, appId, limit);
  }
  /** A page's versions (pages only: an app's rollback breaks this order), newest upload first, which is the order a page served them (the clock can step back). */
  pageVersions(appId: string): Promise<Deploy[]> {
    return this.db.all<Deploy>(`SELECT ${DEPLOY} FROM deploys WHERE app_id = ? ORDER BY rowid DESC`, appId);
  }
  deploy(deployId: string): Promise<Deploy | undefined> {
    return this.db.get<Deploy>(`SELECT ${DEPLOY} FROM deploys WHERE id = ?`, deployId);
  }
  /** Pages with deploys other than the one each serves. */
  async pagesWithOldVersions(): Promise<string[]> {
    return (await this.db.all<{ app_id: string }>(`SELECT DISTINCT d.app_id FROM deploys d JOIN apps a ON a.id = d.app_id
      WHERE a.kind = 'page' AND a.page_deploy_id IS NOT NULL AND d.id <> a.page_deploy_id`)).map((r) => r.app_id);
  }
  async deleteDeploy(deployId: string) {
    await this.db.run("DELETE FROM deploys WHERE id = ?", deployId);
  }

  // ---- secrets (AES-GCM at rest, see secretbox.ts)
  async secretKeys(appId: string): Promise<string[]> {
    return (await this.db.all<{ key: string }>("SELECT key FROM secrets WHERE app_id = ? ORDER BY key", appId)).map((r) => r.key);
  }
  async secrets(appId: string): Promise<Record<string, string>> {
    const rows = await this.db.all<{ key: string; value: Uint8Array }>("SELECT key, value FROM secrets WHERE app_id = ?", appId);
    return Object.fromEntries(rows.map((r) => [r.key, this.#box.open(appId, r.key, Buffer.from(r.value).toString()).value]));
  }
  async setSecret(appId: string, key: string, value: string) {
    await this.db.run(
      "INSERT INTO secrets (app_id, key, value) VALUES (?, ?, ?) ON CONFLICT (app_id, key) DO UPDATE SET value = excluded.value",
      appId, key, this.#seal(appId, key, value),
    );
  }
  async deleteSecret(appId: string, key: string) {
    await this.db.run("DELETE FROM secrets WHERE app_id = ? AND key = ?", appId, key);
  }

  // ---- source control (server/git.ts). Tokens are sealed bound to the account and which token it is, so a
  // ciphertext moved to another account's row (or swapped access ↔ refresh) doesn't decrypt.
  async getGitConnection(accountId: string, provider: GitProvider): Promise<GitConnection | undefined> {
    const r = await this.db.get<Omit<GitConnection, "access_token" | "refresh_token"> & { access_token: Uint8Array; refresh_token: Uint8Array | null }>(
      "SELECT * FROM git_connections WHERE account_id = ? AND provider = ?", accountId, provider,
    );
    if (!r) return undefined;
    const scope = gitScope(accountId);
    return {
      ...r,
      access_token: this.#box.open(scope, gitKey(provider, "access"), Buffer.from(r.access_token).toString()).value,
      refresh_token: r.refresh_token ? this.#box.open(scope, gitKey(provider, "refresh"), Buffer.from(r.refresh_token).toString()).value : null,
    };
  }
  /** A new connection (the OAuth callback), replacing the account's earlier one for the provider. */
  async upsertGitConnection(c: Omit<GitConnection, "created_at" | "updated_at" | "status" | "gen">) {
    const scope = gitScope(c.account_id), now = Date.now();
    const access = this.#seal(scope, gitKey(c.provider, "access"), c.access_token);
    const refresh = c.refresh_token ? this.#seal(scope, gitKey(c.provider, "refresh"), c.refresh_token) : null;
    await this.db.run(
      `INSERT INTO git_connections (account_id, provider, provider_uid, login, email, scopes, access_token, refresh_token,
         expires_at, status, gen, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
       ON CONFLICT (account_id, provider) DO UPDATE SET provider_uid = excluded.provider_uid, login = excluded.login,
         email = excluded.email, scopes = excluded.scopes, access_token = excluded.access_token,
         refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, status = 'active', gen = excluded.gen,
         updated_at = excluded.updated_at`,
      c.account_id, c.provider, c.provider_uid, c.login, c.email, c.scopes, access, refresh, c.expires_at, id("cg", 12), now, now,
    );
  }
  /**
   * New tokens from a refresh, only onto the tokens they were refreshed from (`was`: their `gen`): a connection
   * disconnected or replaced meanwhile isn't brought back or overwritten. False if it changed. Active again even if a
   * stale 401 (another server's, with the old token GitHub revoked as it refreshed) marked these tokens expired.
   */
  async refreshGitConnection(
    accountId: string, provider: GitProvider, was: string,
    t: Pick<GitConnection, "access_token" | "refresh_token" | "expires_at" | "scopes">,
  ): Promise<boolean> {
    const scope = gitScope(accountId);
    return (await this.db.run(
      `UPDATE git_connections SET access_token = ?, refresh_token = ?, expires_at = ?, scopes = ?, gen = ?, status = 'active', updated_at = ?
       WHERE account_id = ? AND provider = ? AND gen = ?`,
      this.#seal(scope, gitKey(provider, "access"), t.access_token),
      t.refresh_token ? this.#seal(scope, gitKey(provider, "refresh"), t.refresh_token) : null,
      t.expires_at, t.scopes, id("cg", 12), Date.now(), accountId, provider, was,
    )).changes > 0;
  }
  /**
   * Refreshing failed (revoked or invalid): kept, so the studio can say who to reconnect as. `was`: only if they're
   * still the tokens that failed (`gen`: not ones refreshed or reconnected meanwhile).
   */
  async expireGitConnection(accountId: string, provider: GitProvider, was: string) {
    await this.db.run(
      "UPDATE git_connections SET status = 'expired', updated_at = ? WHERE account_id = ? AND provider = ? AND gen = ?",
      Date.now(), accountId, provider, was,
    );
  }
  async deleteGitConnection(accountId: string, provider: GitProvider): Promise<boolean> {
    return (await this.db.run("DELETE FROM git_connections WHERE account_id = ? AND provider = ?", accountId, provider)).changes > 0;
  }
  getAppRepo(appId: string): Promise<AppRepo | undefined> {
    return this.db.get<AppRepo>("SELECT * FROM app_repos WHERE app_id = ?", appId);
  }
  async setAppRepo(r: Omit<AppRepo, "connected_at" | "updated_at">) {
    const now = Date.now();
    await this.db.run("DELETE FROM stack_changes WHERE app_id = ?", r.app_id); // a new link: no stacks yet
    await this.db.run(
      `INSERT INTO app_repos (app_id, provider, repo_id, owner, name, default_branch, subdir, delete_branch, connected_by,
         last_synced_sha, connected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (app_id) DO UPDATE SET provider = excluded.provider, repo_id = excluded.repo_id, owner = excluded.owner,
         name = excluded.name, default_branch = excluded.default_branch, subdir = excluded.subdir,
         delete_branch = excluded.delete_branch, connected_by = excluded.connected_by,
         last_synced_sha = excluded.last_synced_sha, upstream_sha = NULL, connected_at = excluded.connected_at, updated_at = excluded.updated_at`,
      r.app_id, r.provider, r.repo_id, r.owner, r.name, r.default_branch, r.subdir, r.delete_branch, r.connected_by,
      r.last_synced_sha, now, now,
    );
  }
  /** A push to a repository's `branch` (webhook): noted on the apps linked to it with that default branch. */
  async noteUpstreamPush(repoId: string, branch: string, sha: string): Promise<number> {
    return (await this.db.run(
      "UPDATE app_repos SET upstream_sha = ?, updated_at = ? WHERE provider = 'github' AND repo_id = ? AND default_branch = ?",
      sha, Date.now(), repoId, branch,
    )).changes;
  }
  async deleteAppRepo(appId: string): Promise<boolean> {
    // Its stacks were that repository's branches.
    await this.db.run("DELETE FROM stack_changes WHERE app_id = ?", appId);
    return (await this.db.run("DELETE FROM app_repos WHERE app_id = ?", appId)).changes > 0;
  }

  // ---- stacked changes (server/stack.ts)
  /** The app's open changes, by stack (oldest stack first), bottom first. */
  openStackChanges(appId: string): Promise<StackChange[]> {
    return this.db.all<StackChange>(
      "SELECT * FROM stack_changes WHERE app_id = ? AND state = 'open' ORDER BY created_at, stack_id, position", appId,
    );
  }
  async addStackChange(c: Omit<StackChange, "state" | "landed_sha" | "pr_number" | "created_at" | "updated_at">): Promise<StackChange> {
    const now = Date.now();
    await this.db.run(
      `INSERT INTO stack_changes (id, app_id, stack_id, stack_name, position, branch, sha, base_sha, title, prompt, author,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.id, c.app_id, c.stack_id, c.stack_name, c.position, c.branch, c.sha, c.base_sha, c.title, c.prompt, c.author,
      c.created_by, now, now,
    );
    return { ...c, state: "open", landed_sha: null, pr_number: null, created_at: now, updated_at: now };
  }
  /** The open or set-aside change on `branch` (one read: its state with it). */
  stackChangeByBranch(appId: string, branch: string): Promise<StackChange | undefined> {
    return this.db.get<StackChange>(
      "SELECT * FROM stack_changes WHERE app_id = ? AND branch = ? AND state IN ('open', 'set_aside') ORDER BY created_at DESC LIMIT 1", appId, branch,
    );
  }
  /** The app's changes in `state`, oldest first. */
  stackChangesInState(appId: string, state: StackChange["state"]): Promise<StackChange[]> {
    return this.db.all<StackChange>("SELECT * FROM stack_changes WHERE app_id = ? AND state = ? ORDER BY created_at, stack_id, position", appId, state);
  }
  /** A change's commit, taken as it is on GitHub (pulled in after a push from outside). */
  /** `syncedFrom`: a sync commit's (else it's cleared: any other commit has files of its own). */
  async setStackChangeSha(id: string, sha: string, base?: string, syncedFrom?: string) {
    if (base) await this.db.run("UPDATE stack_changes SET sha = ?, base_sha = ?, synced_from = ?, updated_at = ? WHERE id = ?", sha, base, syncedFrom ?? null, Date.now(), id);
    else await this.db.run("UPDATE stack_changes SET sha = ?, synced_from = NULL, updated_at = ? WHERE id = ?", sha, Date.now(), id);
  }
  /**
   * Folds `upper` into `lower` (the change below it): the lower one leaves the stack (`dropped`, its position free),
   * the upper one takes its place (position, base, title, both prompts), and the ones above move down one.
   */
  async foldStackChange(lower: StackChange, upper: StackChange, out: string, prompt: string) {
    await this.db.tx(async () => {
      const now = Date.now();
      await this.db.run(
        "UPDATE stack_changes SET state = 'dropped', origin_stack_id = COALESCE(origin_stack_id, stack_id), stack_id = ?, updated_at = ? WHERE id = ?",
        out, now, lower.id,
      );
      await this.db.run(
        "UPDATE stack_changes SET position = ?, base_sha = ?, title = ?, prompt = ?, updated_at = ? WHERE id = ?",
        lower.position, lower.base_sha, lower.title, prompt, now, upper.id,
      );
      // Those above (set aside too: they come back above it), one at a time, lowest first: a position is never held twice.
      const above = await this.db.all<{ id: string; position: number }>(
        "SELECT id, position FROM stack_changes WHERE stack_id = ? AND state IN ('open', 'set_aside') AND position > ? ORDER BY position", upper.stack_id, upper.position,
      );
      for (const x of above) await this.db.run("UPDATE stack_changes SET position = ?, updated_at = ? WHERE id = ?", x.position - 1, now, x.id);
    });
  }
  /** A change's pull request. */
  async setStackChangePull(id: string, number: number | null) {
    await this.db.run("UPDATE stack_changes SET pr_number = ?, updated_at = ? WHERE id = ?", number, Date.now(), id);
  }
  async setStackAutoSubmit(appId: string, on: boolean) {
    await this.db.run("UPDATE app_repos SET stack_auto_submit = ?, updated_at = ? WHERE app_id = ?", on ? 1 : 0, Date.now(), appId);
  }
  /** The app's changes set aside (gone back from), by stack, bottom first. */
  setAsideStackChanges(appId: string): Promise<StackChange[]> {
    return this.db.all<StackChange>("SELECT * FROM stack_changes WHERE app_id = ? AND state = 'set_aside' ORDER BY stack_id, position", appId);
  }
  /** Gone back to the change at `position`: the open ones above it are set aside. */
  async setAsideAbove(appId: string, stackId: string, position: number): Promise<number> {
    return (await this.db.run(
      "UPDATE stack_changes SET state = 'set_aside', updated_at = ? WHERE app_id = ? AND stack_id = ? AND state = 'open' AND position > ?",
      Date.now(), appId, stackId, position,
    )).changes;
  }
  /** A stack's changes set aside (these ones), back on it. */
  async restoreSetAside(appId: string, stackId: string, ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    return (await this.db.run(
      `UPDATE stack_changes SET state = 'open', updated_at = ? WHERE app_id = ? AND stack_id = ? AND state = 'set_aside' AND id IN (${ids.map(() => "?").join(", ")})`,
      Date.now(), appId, stackId, ...ids,
    )).changes;
  }
  /** A new change was built where they were: a stack's changes set aside leave it (for good; their branches stay). */
  async detachSetAside(appId: string, stackId: string, to: string, above = 0): Promise<number> {
    return (await this.db.run(
      `UPDATE stack_changes SET origin_stack_id = COALESCE(origin_stack_id, stack_id), stack_id = ?, updated_at = ?
       WHERE app_id = ? AND stack_id = ? AND state = 'set_aside' AND position > ?`,
      to, Date.now(), appId, stackId, above,
    )).changes;
  }
  /** Changes moved out of their stack, to `to` (their positions stay theirs), in `state`. */
  async moveStackChanges(appId: string, ids: string[], to: string, state: StackChange["state"]): Promise<number> {
    if (!ids.length) return 0;
    return (await this.db.run(
      `UPDATE stack_changes SET origin_stack_id = COALESCE(origin_stack_id, stack_id), stack_id = ?, state = ?, updated_at = ?
       WHERE app_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
      to, state, Date.now(), appId, ...ids,
    )).changes;
  }
  /** A commit onto the top change's branch from its recorded commit (a hand edit pushed, a merge resolved): it follows. */
  async followStackTop(appId: string, branch: string, from: string, to: string): Promise<boolean> {
    return (await this.db.run(
      `UPDATE stack_changes SET sha = ?, synced_from = NULL, updated_at = ? WHERE app_id = ? AND branch = ? AND sha = ? AND state = 'open'
         AND position = (SELECT MAX(s.position) FROM stack_changes s WHERE s.stack_id = stack_changes.stack_id AND s.state = 'open')`,
      to, Date.now(), appId, branch, from,
    )).changes > 0;
  }
  /** A stack's open changes up to `position`, landed in the default branch at `sha`. */
  async landStack(appId: string, stackId: string, position: number, sha: string): Promise<number> {
    return (await this.db.run(
      "UPDATE stack_changes SET state = 'landed', landed_sha = ?, updated_at = ? WHERE app_id = ? AND stack_id = ? AND state = 'open' AND position <= ?",
      sha, Date.now(), appId, stackId, position,
    )).changes;
  }
  /**
   * The last commit Cresslet wrote or read, and what the provider says about the repository now (renamed,
   * transferred, a new default branch). Only onto the link `was` (one relinked meanwhile is left alone).
   */
  async updateAppRepoSync(was: AppRepo, p: { sha?: string | null; owner?: string; name?: string; defaultBranch?: string; upstream?: string }) {
    await this.db.run(
      `UPDATE app_repos SET last_synced_sha = COALESCE(?, last_synced_sha), owner = COALESCE(?, owner), name = COALESCE(?, name),
         default_branch = COALESCE(?, default_branch), updated_at = ?
       WHERE app_id = ? AND repo_id = ? AND connected_at = ?`,
      p.sha ?? null, p.owner ?? null, p.name ?? null, p.defaultBranch ?? null, Date.now(), was.app_id, was.repo_id, was.connected_at,
    );
    // Cresslet moved the default branch itself: that's where it is now (a webhook's older report doesn't count).
    if (p.upstream) {
      await this.db.run("UPDATE app_repos SET upstream_sha = ? WHERE app_id = ? AND repo_id = ? AND connected_at = ?", p.upstream, was.app_id, was.repo_id, was.connected_at);
    }
  }

  // ---- AI credits (millicredits; server/credits.ts)
  /** Granted credits left and this month's free allowance used (0 in a month with no use yet). */
  async aiWallet(accountId: string, period: string): Promise<{ balance: number; periodUsed: number }> {
    const w = await this.db.get<{ balance: number; period: string | null; period_used: number }>(
      "SELECT balance, period, period_used FROM ai_wallets WHERE account_id = ?", accountId,
    );
    return { balance: w?.balance ?? 0, periodUsed: w && w.period === period ? w.period_used : 0 };
  }

  /**
   * Charges `amount` for one request: from this month's free `allowance` first, the rest from the balance (which
   * may go below 0). One ledger row. Returns the wallet after.
   */
  chargeAi(accountId: string, period: string, allowance: number, amount: number, detail: unknown) {
    return this.serialized(`cresslet:ai-wallet:${accountId}`, async () => {
      const w = await this.aiWallet(accountId, period);
      const free = Math.max(0, Math.min(amount, allowance - w.periodUsed));
      const after = { balance: w.balance - (amount - free), periodUsed: w.periodUsed + free };
      await this.#putWallet(accountId, period, after);
      await this.db.run("INSERT INTO ai_ledger (account_id, created_at, kind, amount, detail) VALUES (?, ?, 'usage', ?, ?)",
        accountId, Date.now(), -amount, JSON.stringify({ ...(detail as object), free }));
      return after;
    });
  }

  /** Adds `amount` (negative: takes it back) to the balance. One ledger row. Returns the new balance. */
  grantAi(accountId: string, amount: number, detail: { note?: string | null; by: string }): Promise<number> {
    return this.serialized(`cresslet:ai-wallet:${accountId}`, async () => {
      await this.db.run("INSERT INTO ai_wallets (account_id, balance) VALUES (?, 0) ON CONFLICT (account_id) DO NOTHING", accountId);
      await this.db.run("UPDATE ai_wallets SET balance = balance + ? WHERE account_id = ?", amount, accountId);
      await this.db.run("INSERT INTO ai_ledger (account_id, created_at, kind, amount, detail) VALUES (?, ?, 'grant', ?, ?)",
        accountId, Date.now(), amount, JSON.stringify(detail));
      return (await this.db.get<{ balance: number }>("SELECT balance FROM ai_wallets WHERE account_id = ?", accountId))!.balance;
    });
  }

  /** The account's ledger rows up to row `upTo` (all: null), newest first: `limit` of them after skipping `offset`. */
  aiLedger(accountId: string, limit = 50, offset = 0, upTo: number | null = null): Promise<AiLedgerRow[]> {
    return this.db.all<AiLedgerRow>(
      "SELECT created_at, kind, amount, detail FROM ai_ledger WHERE account_id = ? AND id <= ? ORDER BY id DESC LIMIT ? OFFSET ?",
      accountId, upTo ?? Number.MAX_SAFE_INTEGER, limit, offset,
    );
  }

  /** The account's newest ledger row (0: none yet), and how many rows it has up to `upTo` (all: null). */
  async aiLedgerCount(accountId: string, upTo: number | null = null): Promise<{ last: number; count: number }> {
    const r = (await this.db.get<{ last: number | null; n: number }>(
      "SELECT MAX(id) AS last, COUNT(*) AS n FROM ai_ledger WHERE account_id = ? AND id <= ?", accountId, upTo ?? Number.MAX_SAFE_INTEGER,
    ))!;
    return { last: Number(r.last ?? 0), count: Number(r.n) };
  }

  /**
   * Site admin view: every account with a wallet (or just `accountId`'s), its wallet and its usage since `since` (ms), most used first.
   * `period_used` is 0 when the wallet's period isn't `period` (a new month).
   */
  aiAccounts(period: string, since: number, accountId: string | null = null): Promise<AiAccountRow[]> {
    return this.db.all<AiAccountRow>(
      `SELECT a.id, a.email, a.github_login, w.balance,
         CASE WHEN w.period = ? THEN w.period_used ELSE 0 END AS period_used,
         COALESCE(u.used, 0) AS used, COALESCE(u.requests, 0) AS requests,
         (SELECT MAX(created_at) FROM ai_ledger l WHERE l.account_id = w.account_id AND l.kind = 'usage') AS last_used_at
       FROM ai_wallets w JOIN accounts a ON a.id = w.account_id
       LEFT JOIN (SELECT account_id, -SUM(amount) AS used, COUNT(*) AS requests FROM ai_ledger
         WHERE kind = 'usage' AND created_at >= ? GROUP BY account_id) u ON u.account_id = w.account_id
       WHERE CAST(? AS TEXT) IS NULL OR w.account_id = ?
       ORDER BY used DESC, last_used_at DESC NULLS LAST, a.email`,
      period, since, accountId, accountId,
    );
  }

  /** Usage since `since` (ms) per model, most used first. Amounts are millicredits used (positive). */
  aiModels(since: number): Promise<{ model: string | null; used: number; requests: number; free: number; usd: number; input: number; output: number }[]> {
    const f = this.db.dialect === "postgres"
      ? (k: string) => `COALESCE((detail::jsonb ->> '${k}')::numeric, 0)`
      : (k: string) => `COALESCE(json_extract(detail, '$.${k}'), 0)`;
    const model = this.db.dialect === "postgres" ? "detail::jsonb ->> 'model'" : "json_extract(detail, '$.model')";
    return this.db.all(
      `SELECT ${model} AS model, -SUM(amount) AS used, COUNT(*) AS requests,
         SUM(${f("free")}) AS free, SUM(${f("usd")}) AS usd,
         SUM(${f("input")} + ${f("cacheRead")} + ${f("cacheWrite")}) AS input,
         SUM(${f("output")}) AS output
       FROM ai_ledger WHERE kind = 'usage' AND created_at >= ? GROUP BY model ORDER BY used DESC`,
      since,
    );
  }

  /** Usage since `since` (ms) per UTC day (`day`: days since the epoch), oldest first. */
  aiDays(since: number): Promise<{ day: number; used: number; requests: number }[]> {
    return this.db.all(
      `SELECT created_at / 86400000 AS day, -SUM(amount) AS used, COUNT(*) AS requests
       FROM ai_ledger WHERE kind = 'usage' AND created_at >= ? GROUP BY day ORDER BY day`,
      since,
    );
  }

  /** Credits granted (net of take-backs) since `since` (ms), and how many grants. */
  async aiGranted(since: number): Promise<{ amount: number; grants: number }> {
    const r = (await this.db.get<{ amount: number; grants: number }>(
      "SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS grants FROM ai_ledger WHERE kind = 'grant' AND created_at >= ?", since,
    ))!;
    return { amount: r.amount, grants: r.grants };
  }

  /** Granted credits left across every wallet (overdrawn ones count as 0), and the overdrawn total. */
  async aiOutstanding(): Promise<{ balance: number; overdrawn: number }> {
    const [max, min] = this.db.dialect === "postgres" ? ["GREATEST", "LEAST"] : ["MAX", "MIN"];
    const r = (await this.db.get<{ balance: number; overdrawn: number }>(
      `SELECT COALESCE(SUM(${max}(balance, 0)), 0) AS balance, COALESCE(-SUM(${min}(balance, 0)), 0) AS overdrawn FROM ai_wallets`,
    ))!;
    return { balance: r.balance, overdrawn: r.overdrawn };
  }

  /** The latest ledger rows across every account, newest first, with the account. */
  aiLedgerAll(limit = 100): Promise<(AiLedgerRow & { account_id: string; email: string; github_login: string | null })[]> {
    return this.db.all(
      `SELECT l.account_id, l.created_at, l.kind, l.amount, l.detail, a.email, a.github_login
       FROM ai_ledger l JOIN accounts a ON a.id = l.account_id ORDER BY l.id DESC LIMIT ?`,
      limit,
    );
  }

  async #putWallet(accountId: string, period: string, w: { balance: number; periodUsed: number }) {
    await this.db.run(`INSERT INTO ai_wallets (account_id, balance, period, period_used) VALUES (?, ?, ?, ?)
      ON CONFLICT (account_id) DO UPDATE SET balance = excluded.balance, period = excluded.period, period_used = excluded.period_used`,
      accountId, w.balance, period, w.periodUsed);
  }
}

/** Held while an account's tokens are issued, and while it's disabled. */
export const accountLock = (accountId: string) => `cresslet:account:${accountId}`;
/** Changing an app's paused crons (pause, resume, and a deploy forgetting the ones it dropped). */
export const cronsLock = (appId: string) => `cresslet:crons:${appId}`;
/** Held while an organization's members change (the last admin can't leave). */
export const orgLock = (orgId: string) => `cresslet:org:${orgId}`;

/** issueToken for a disabled (or deleted) account. */
export class AccountDisabledError extends Error {
  constructor() {
    super("account disabled");
  }
}

/** Held while an app's invites are checked and written (api.ts checks its cap under it too). */
export const inviteLock = (appId: string) => `cresslet:invite:${appId}`;

/** Explicit columns where Postgres has a `rowid` column (SQLite's is implicit): rows look the same in both. */
const DEPLOY = "id, app_id, created_at, bytes, file_count, has_server, source, git_sha, git_branch, git_repo";
/** SecretBox binding for an account's source control tokens (app secrets use the app id: `app_…`). */
const gitScope = (accountId: string) => `acct:${accountId}`;
const gitKey = (provider: string, which: "access" | "refresh") => `git:${provider}:${which}`;
const INVITE = "id, app_id, email, role, invited_by, created_at";
