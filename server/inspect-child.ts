// Child process running one read-only inspection of an app's database (see inspect.ts). A process,
// not a worker thread: terminate() can't interrupt a running SQLite statement, SIGKILL can.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { confine } from "./bindings.ts";
import type { Job } from "./inspect.ts";

process.once("message", ({ path, job, maxBytes }: { path: string; job: Job; maxBytes: number }) => {
  try {
    const db = confine(new DatabaseSync(path, { readOnly: true }));
    // A query builds no value bigger than the whole reply (stored ones, which the listing reads, are
    // bounded by the app's database cap). `limits` is Node ≥ 24.15; before, only the deadline bounds it.
    if (job.kind === "query" && db.limits) db.limits.length = maxBytes;
    // The reply's own framing (`{"rows":[],"truncated":true}` and the like) is reserved up front.
    let bytes = 64;
    /** Counts `n` bytes against the reply's budget; false (and nothing counted) if they don't fit. */
    const charge = (n: number) => bytes + n <= maxBytes && ((bytes += n), true);
    /**
     * A value's size in the reply (JSON, UTF-8, escapes included), worked out before building it: a
     * stored blob's base64 may not even fit in a string.
     */
    const size = (x: unknown) =>
      x instanceof Uint8Array ? Math.ceil(x.length / 3) * 4 + 13 : typeof x === "string" ? str(x) : 24;
    // Raw bytes first: escaping only adds, and a value too big for the reply isn't stringified at all.
    const str = (x: string) => {
      const raw = Buffer.byteLength(x) + 2;
      return raw > maxBytes ? raw : Buffer.byteLength(JSON.stringify(x));
    };
    /** Rows (JSON-safe) until `max` rows or the shared byte budget runs out. */
    const take = (sql: string, params: SQLInputValue[], max: number) => {
      const rows: unknown[] = [];
      for (const row of db.prepare(sql).iterate(...params) as Iterable<Record<string, unknown>>) {
        if (rows.length >= max) return { rows, truncated: true };
        let len = 3; // {},
        for (const [k, v] of Object.entries(row)) len += size(k) + 2 + size(v); // "k":v,
        if (!charge(len)) return { rows, truncated: true };
        rows.push(JSON.parse(JSON.stringify(row, (_k, x) =>
          typeof x === "bigint" ? Number(x) : x instanceof Uint8Array ? { $bytes: Buffer.from(x).toString("base64") } : x)));
      }
      return { rows, truncated: false };
    };
    const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const tables = () => db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).iterate() as Iterable<{ name: string; sql: string }>;
    const count = (name: string) => Number((db.prepare(`SELECT count(*) n FROM ${quote(name)}`).get() as { n: number }).n);
    let result: unknown;
    if (job.kind === "query") result = take(job.sql, job.params as SQLInputValue[], job.maxRows);
    else if (job.kind === "counts") {
      const list: { name: string; rows: number }[] = [];
      let truncated = false;
      for (const t of tables()) {
        if (!charge(size(t.name) + 40)) { // {"name":…,"rows":N},
          truncated = true;
          break;
        }
        list.push({ name: t.name, rows: count(t.name) });
      }
      result = { tables: list, truncated };
    } else {
      const out: Record<string, unknown> = {};
      let truncated = false;
      for (const t of tables()) {
        // Names and schemas count too: a database of many tables mustn't make an unbounded reply.
        if (!charge(size(t.name) + size(t.sql) + 64)) { // "name":{"schema":…,"count":N,"rows":[],"truncated":true},
          truncated = true;
          break;
        }
        const r = take(`SELECT * FROM ${quote(t.name)} LIMIT ?`, [job.limit], job.limit);
        out[t.name] = { schema: t.sql, count: count(t.name), rows: r.rows, ...(r.truncated ? { truncated: true } : {}) };
      }
      result = { tables: out, truncated };
    }
    db.close();
    process.send!({ result }, () => process.exit(0));
  } catch (e) {
    process.send!({ error: (e as Error).message }, () => process.exit(0));
  }
});
