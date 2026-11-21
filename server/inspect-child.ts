// Child process running one read-only inspection of an app's database (see inspect.ts). A process,
// not a worker thread: terminate() can't interrupt a running SQLite statement, SIGKILL can.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { confine } from "./bindings.ts";
import type { Job } from "./inspect.ts";

process.once("message", ({ path, job, maxBytes }: { path: string; job: Job; maxBytes: number }) => {
  try {
    const db = confine(new DatabaseSync(path, { readOnly: true }));
    db.limits.length = maxBytes; // no single value bigger than the whole reply
    let bytes = 0;
    /** Rows (JSON-safe) until `max` rows or the shared byte budget runs out. */
    const take = (sql: string, params: SQLInputValue[], max: number) => {
      const rows: unknown[] = [];
      for (const row of db.prepare(sql).iterate(...params)) {
        if (rows.length >= max) return { rows, truncated: true };
        const s = JSON.stringify(row, (_k, x) =>
          typeof x === "bigint" ? Number(x) : x instanceof Uint8Array ? { $bytes: Buffer.from(x).toString("base64") } : x);
        if ((bytes += s.length) > maxBytes) return { rows, truncated: true };
        rows.push(JSON.parse(s));
      }
      return { rows, truncated: false };
    };
    const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const tables = () => (db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as { name: string; sql: string }[]);
    const count = (name: string) => Number((db.prepare(`SELECT count(*) n FROM ${quote(name)}`).get() as { n: number }).n);
    let result: unknown;
    if (job.kind === "query") result = take(job.sql, job.params as SQLInputValue[], job.maxRows);
    else if (job.kind === "counts") result = tables().map((t) => ({ name: t.name, rows: count(t.name) }));
    else {
      const out: Record<string, unknown> = {};
      for (const t of tables()) {
        const { rows, truncated } = take(`SELECT * FROM ${quote(t.name)} LIMIT ?`, [job.limit], job.limit);
        out[t.name] = { schema: t.sql, count: count(t.name), rows, ...(truncated ? { truncated } : {}) };
      }
      result = out;
    }
    db.close();
    process.send!({ result }, () => process.exit(0));
  } catch (e) {
    process.send!({ error: (e as Error).message }, () => process.exit(0));
  }
});
