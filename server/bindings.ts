// Host side of the app `env` bindings (db, files). Runs in the control plane; each sandbox reaches
// its own instance over a per-app unix socket (see runtime/worker.js for the client side).
// Same shape is implemented by cresslet-cli (local dev) and the studio (in-browser preview).
// Keep in sync with docs/app-format.md.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";

const num = (v: number | bigint) => (typeof v === "bigint" ? Number(v) : v);

export function createDb(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return {
    query(sql: string, ...params: SQLInputValue[]) {
      return db.prepare(sql).all(...params);
    },
    first(sql: string, ...params: SQLInputValue[]) {
      return db.prepare(sql).get(...params) ?? null;
    },
    run(sql: string, ...params: SQLInputValue[]) {
      const r = db.prepare(sql).run(...params);
      return { changes: num(r.changes), lastInsertRowid: num(r.lastInsertRowid) };
    },
    exec(sql: string) {
      db.exec(sql);
      return null;
    },
    close: () => db.close(),
  };
}

export function safeKey(key: string): string {
  const k = normalize(key).replace(/^\/+/, "");
  if (!k || k.startsWith("..") || k.includes("\0") || k.length > 512) {
    throw new Error(`invalid file key: ${key}`);
  }
  return k;
}

export function createFiles(dir: string) {
  const root = resolve(dir, "blobs");
  mkdirSync(root, { recursive: true });
  const meta = new DatabaseSync(join(dir, "index.sqlite"));
  meta.exec(`PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS files (
    key TEXT PRIMARY KEY, size INTEGER NOT NULL, content_type TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
  const blob = (k: string) => {
    const p = resolve(root, k);
    if (!p.startsWith(root + sep)) throw new Error(`invalid file key: ${k}`);
    return p;
  };
  return {
    async put(key: string, bytes: Uint8Array, contentType: string) {
      const k = safeKey(key);
      await mkdir(dirname(blob(k)), { recursive: true });
      await writeFile(blob(k), bytes);
      meta.prepare(
        `INSERT INTO files (key, size, content_type, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET size = excluded.size, content_type = excluded.content_type, updated_at = excluded.updated_at`,
      ).run(k, bytes.byteLength, contentType || "application/octet-stream", Date.now());
    },
    async get(key: string): Promise<Response | null> {
      const k = safeKey(key);
      const row = meta.prepare("SELECT * FROM files WHERE key = ?").get(k) as
        | { size: number; content_type: string }
        | undefined;
      if (!row) return null;
      const data = await readFile(blob(k));
      return new Response(data, {
        headers: { "content-type": row.content_type, "content-length": String(row.size) },
      });
    },
    async delete(key: string) {
      const k = safeKey(key);
      meta.prepare("DELETE FROM files WHERE key = ?").run(k);
      await rm(blob(k), { force: true });
    },
    list(prefix = "") {
      const rows = meta.prepare(
        "SELECT key, size, content_type, updated_at FROM files WHERE key LIKE ? ESCAPE '\\' ORDER BY key LIMIT 1000",
      ).all(prefix.replace(/[\\%_]/g, (c) => "\\" + c) + "%") as {
        key: string;
        size: number;
        content_type: string;
        updated_at: number;
      }[];
      return rows.map((r) => ({
        key: r.key,
        size: r.size,
        contentType: r.content_type,
        updatedAt: r.updated_at,
      }));
    },
    close: () => meta.close(),
  };
}

// SQL values cross the binding as JSON; bigints and blobs are tagged (mirrors runtime/worker.js).
const reviver = (_k: string, v: unknown) => {
  if (v && typeof v === "object") {
    const o = v as { $bytes?: unknown; $bigint?: unknown };
    if (typeof o.$bytes === "string") return new Uint8Array(Buffer.from(o.$bytes, "base64"));
    if (typeof o.$bigint === "string") return BigInt(o.$bigint);
  }
  return v;
};
const replacer = (_k: string, v: unknown) =>
  typeof v === "bigint"
    ? Number(v)
    : v instanceof Uint8Array
    ? { $bytes: Buffer.from(v).toString("base64") }
    : v;

/** One app's bindings, served as a fetch handler for its sandbox. */
export function createBindings(
  dataDir: string,
  { secrets = {}, maxFileBytes = 25 * 1024 * 1024 }: { secrets?: Record<string, string>; maxFileBytes?: number } = {},
) {
  const db = createDb(join(dataDir, "db.sqlite"));
  const files = createFiles(join(dataDir, "files"));
  const text = (s: string, status: number) => new Response(s, { status });

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/secrets") return Response.json(secrets);
      if (req.method === "POST" && url.pathname.startsWith("/db/")) {
        const op = url.pathname.slice(4);
        const { sql, params = [] } = JSON.parse(await req.text(), reviver) as {
          sql: string;
          params?: SQLInputValue[];
        };
        if (typeof sql !== "string") return text("sql required", 400);
        let result: unknown;
        if (op === "query") result = db.query(sql, ...params);
        else if (op === "first") result = db.first(sql, ...params);
        else if (op === "run") result = db.run(sql, ...params);
        else if (op === "exec") result = db.exec(sql);
        else return text("unknown op", 404);
        return new Response(JSON.stringify(result, replacer), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/files/list") return Response.json(files.list(url.searchParams.get("prefix") ?? ""));
      if (url.pathname === "/files") {
        const key = url.searchParams.get("key") ?? "";
        if (req.method === "GET") return (await files.get(key)) ?? text("not found", 404);
        if (req.method === "PUT") {
          const bytes = await readCapped(req, maxFileBytes);
          if (!bytes) return text(`file exceeds ${maxFileBytes} bytes`, 413);
          await files.put(key, bytes, req.headers.get("content-type") ?? "");
          return new Response(null, { status: 204 });
        }
        if (req.method === "DELETE") {
          await files.delete(key);
          return new Response(null, { status: 204 });
        }
      }
      return text("not found", 404);
    } catch (e) {
      return text((e as Error).message, 400);
    }
  }

  return {
    fetch,
    close() {
      db.close();
      files.close();
    },
  };
}

async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const c of req.body ?? []) {
    n += c.byteLength;
    if (n > max) return null;
    chunks.push(c);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
