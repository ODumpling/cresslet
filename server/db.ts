// The control plane's metadata database (Store, server/store.ts): SQLite in the data dir by default, or
// Postgres when CRESSLET_DATABASE_URL is set. Both speak the same small async interface; SQL uses `?`
// placeholders and the subset of SQL both understand (Store branches on `dialect` for the rest).
// Apps' own databases (env.db, server/bindings.ts) are always SQLite: they're part of the app API.
import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import pg from "pg";

export type Param = string | number | bigint | null | Uint8Array;
export type Dialect = "sqlite" | "postgres";

export interface Db {
  readonly dialect: Dialect;
  all<T = Record<string, unknown>>(sql: string, ...params: Param[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, ...params: Param[]): Promise<T | undefined>;
  run(sql: string, ...params: Param[]): Promise<{ changes: number }>;
  /** Several statements, no parameters. */
  exec(sql: string): Promise<void>;
  /**
   * Runs `fn` in a transaction. Every query made inside it (anywhere in its async call tree) joins it;
   * a nested `tx` joins the outer one. Commits when `fn` resolves, rolls back when it throws.
   * Keep `fn` to database work: SQLite holds every other query until it ends.
   */
  tx<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Inside `tx`: waits for, then holds until commit, a lock no other transaction taking the same key can
   * hold (read-modify-write and check-then-insert). SQLite needs none (one transaction at a time).
   */
  lock(key: string): Promise<void>;
  close(): Promise<void>;
}

/** A UNIQUE / PRIMARY KEY violation, in either dialect. */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err?.code === "23505" || /UNIQUE constraint failed/.test(err?.message ?? "");
}

export class SqliteDb implements Db {
  readonly dialect = "sqlite";
  readonly raw: DatabaseSync;
  #tx = new AsyncLocalStorage<{ open: boolean }>();
  /** Settles when the open transaction ends; queries outside it wait (one connection). */
  #gate: Promise<void> | null = null;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
  }

  /**
   * Someone else's transaction is open. Callers wait with `while (this.#blocked()) await this.#gate` and then
   * run their statement with no await in between: the check and the statement can't be split by a BEGIN.
   */
  #blocked() {
    return this.#gate !== null && !this.#tx.getStore()?.open;
  }
  async all<T>(sql: string, ...params: Param[]): Promise<T[]> {
    while (this.#blocked()) await this.#gate;
    return this.raw.prepare(sql).all(...(params as SQLInputValue[])) as T[];
  }
  async get<T>(sql: string, ...params: Param[]): Promise<T | undefined> {
    while (this.#blocked()) await this.#gate;
    return this.raw.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined;
  }
  async run(sql: string, ...params: Param[]) {
    while (this.#blocked()) await this.#gate;
    return { changes: Number(this.raw.prepare(sql).run(...(params as SQLInputValue[])).changes) };
  }
  async exec(sql: string) {
    while (this.#blocked()) await this.#gate;
    this.raw.exec(sql);
  }
  async tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#tx.getStore()?.open) return fn();
    while (this.#gate) await this.#gate;
    let release!: () => void;
    this.#gate = new Promise((r) => (release = r));
    const ctx = { open: true };
    try {
      this.raw.exec("BEGIN IMMEDIATE");
      try {
        const r = await this.#tx.run(ctx, fn);
        this.raw.exec("COMMIT");
        return r;
      } catch (e) {
        this.raw.exec("ROLLBACK");
        throw e;
      }
    } finally {
      ctx.open = false; // work `fn` left running queues behind later transactions instead of joining a closed one
      this.#gate = null;
      release();
    }
  }
  async lock(_key: string) {
    if (!this.#tx.getStore()?.open) throw new Error("lock() outside a transaction");
  }
  async close() {
    while (this.#blocked()) await this.#gate;
    this.raw.close();
  }
}

/** `?` placeholders to `$1`, `$2`, … (outside quoted strings and identifiers). */
export function numberParams(sql: string): string {
  let n = 0, out = "", quote: string | null = null;
  for (const ch of sql) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "?") {
      out += `$${++n}`;
      continue;
    }
    out += ch;
  }
  return out;
}

const PG_TYPES = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    // Timestamps (ms) and counts are BIGINT; sums are NUMERIC. All fit a double, as they do in SQLite.
    if (oid === 20 || oid === 1700) return (v: string) => Number(v);
    return pg.types.getTypeParser(oid, format as "text");
  },
};

type PgClient = pg.Pool | pg.PoolClient;

export class PostgresDb implements Db {
  readonly dialect = "postgres";
  readonly pool: pg.Pool;
  #tx = new AsyncLocalStorage<{ client: pg.PoolClient; open: boolean }>();

  /** `schema`: where Cresslet's tables live (created if missing). */
  readonly schema: string;

  constructor(url: string, schema = "public") {
    this.schema = schema;
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`invalid database schema name: ${schema}`);
    // A database that doesn't answer fails the request (or startup) instead of hanging it.
    this.pool = new pg.Pool({ connectionString: url, types: PG_TYPES, options: `-c search_path=${schema}`, connectionTimeoutMillis: 10_000 });
    this.pool.on("error", (e) => console.error("cresslet: postgres connection error:", e.message));
  }

  #client(): PgClient {
    const t = this.#tx.getStore();
    return t?.open ? t.client : this.pool;
  }
  async #query(sql: string, params: Param[]) {
    return this.#client().query(numberParams(sql), params.map((p) => (typeof p === "bigint" ? String(p) : p)));
  }
  async all<T>(sql: string, ...params: Param[]): Promise<T[]> {
    return (await this.#query(sql, params)).rows as T[];
  }
  async get<T>(sql: string, ...params: Param[]): Promise<T | undefined> {
    return (await this.#query(sql, params)).rows[0] as T | undefined;
  }
  async run(sql: string, ...params: Param[]) {
    return { changes: (await this.#query(sql, params)).rowCount ?? 0 };
  }
  async exec(sql: string) {
    await this.#client().query(sql);
  }
  async tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#tx.getStore()?.open) return fn();
    const client = await this.pool.connect();
    const ctx = { client, open: true };
    let broken: unknown;
    try {
      await client.query("BEGIN");
      try {
        const r = await this.#tx.run(ctx, fn);
        await client.query("COMMIT");
        return r;
      } catch (e) {
        await client.query("ROLLBACK").catch((re) => (broken = re));
        throw e;
      }
    } finally {
      ctx.open = false;
      client.release(broken as Error | undefined);
    }
  }
  async lock(key: string) {
    const t = this.#tx.getStore();
    if (!t?.open) throw new Error("lock() outside a transaction");
    await t.client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
  }
  async close() {
    await this.pool.end();
  }
}

/** Postgres when `url` is set, else SQLite at `sqlitePath`. */
export function openDb(o: { url: string | null; schema?: string; sqlitePath: string }): Db {
  return o.url ? new PostgresDb(o.url, o.schema) : new SqliteDb(o.sqlitePath);
}
