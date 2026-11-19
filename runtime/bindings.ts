// Env bindings handed to app code. Same shape is implemented by cresslet-cli (local dev)
// and the studio (in-browser preview). Keep in sync with docs/app-format.md.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dirname, join, normalize } from "node:path";

export interface RunConfig {
  appId: string;
  appName: string;
  appUrl: string;
  deployId: string;
  serverPath: string;
  dataDir: string;
  sock: string;
  secrets: Record<string, string>;
}

const num = (v: number | bigint) => (typeof v === "bigint" ? Number(v) : v);

export function createDb(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return {
    query<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): Promise<T[]> {
      return Promise.resolve(db.prepare(sql).all(...params) as T[]);
    },
    first<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): Promise<T | null> {
      return Promise.resolve((db.prepare(sql).get(...params) as T) ?? null);
    },
    run(sql: string, ...params: SQLInputValue[]) {
      const r = db.prepare(sql).run(...params);
      return Promise.resolve({ changes: num(r.changes), lastInsertRowid: num(r.lastInsertRowid) });
    },
    exec(sql: string): Promise<void> {
      db.exec(sql);
      return Promise.resolve();
    },
    close: () => db.close(),
  };
}

type Body = string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;

export function safeKey(key: string): string {
  const k = normalize(key).replace(/^\/+/, "");
  if (!k || k.startsWith("..") || k.includes("\0") || k.length > 512) {
    throw new Error(`invalid file key: ${key}`);
  }
  return k;
}

export function createFiles(dir: string) {
  Deno.mkdirSync(join(dir, "blobs"), { recursive: true });
  const meta = new DatabaseSync(join(dir, "index.sqlite"));
  meta.exec(`PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS files (
    key TEXT PRIMARY KEY, size INTEGER NOT NULL, content_type TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
  const blob = (k: string) => join(dir, "blobs", k);
  return {
    async put(key: string, body: Body, opts: { contentType?: string } = {}) {
      const k = safeKey(key);
      const bytes = new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
      await Deno.mkdir(dirname(blob(k)), { recursive: true });
      await Deno.writeFile(blob(k), bytes);
      const type = opts.contentType ?? (body instanceof Blob && body.type) ??
        "application/octet-stream";
      meta.prepare(
        `INSERT INTO files (key, size, content_type, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET size = excluded.size, content_type = excluded.content_type, updated_at = excluded.updated_at`,
      ).run(k, bytes.byteLength, type || "application/octet-stream", Date.now());
    },
    async get(key: string): Promise<Response | null> {
      const k = safeKey(key);
      const row = meta.prepare("SELECT * FROM files WHERE key = ?").get(k) as
        | { size: number; content_type: string }
        | undefined;
      if (!row) return null;
      const data = await Deno.readFile(blob(k));
      return new Response(data, {
        headers: { "content-type": row.content_type, "content-length": String(row.size) },
      });
    },
    async delete(key: string) {
      const k = safeKey(key);
      meta.prepare("DELETE FROM files WHERE key = ?").run(k);
      await Deno.remove(blob(k)).catch(() => {});
    },
    list(prefix = ""): Promise<{ key: string; size: number; contentType: string; updatedAt: number }[]> {
      const rows = meta.prepare(
        "SELECT key, size, content_type, updated_at FROM files WHERE key LIKE ? ESCAPE '\\' ORDER BY key LIMIT 1000",
      ).all(prefix.replace(/[\\%_]/g, (c) => "\\" + c) + "%") as {
        key: string;
        size: number;
        content_type: string;
        updated_at: number;
      }[];
      return Promise.resolve(
        rows.map((r) => ({
          key: r.key,
          size: r.size,
          contentType: r.content_type,
          updatedAt: r.updated_at,
        })),
      );
    },
  };
}

export function createEnv(cfg: RunConfig) {
  return {
    db: createDb(join(cfg.dataDir, "db.sqlite")),
    files: createFiles(join(cfg.dataDir, "files")),
    secrets: Object.freeze({ ...cfg.secrets }),
    app: Object.freeze({ id: cfg.appId, name: cfg.appName, url: cfg.appUrl, deployId: cfg.deployId }),
  };
}
