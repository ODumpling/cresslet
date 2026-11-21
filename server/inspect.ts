// Read-only inspection of an app's database (the db endpoints, the admin site view), run in a
// short-lived child process with a hard deadline: user SQL (a runaway recursive CTE) can't stall the
// control plane's event loop, and its reply is capped so it can't exhaust the control plane's memory.
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { HttpError } from "./deploys.ts";

export type Job =
  | { kind: "query"; sql: string; params: unknown[]; maxRows: number }
  | { kind: "tables"; limit: number }
  | { kind: "counts" };

const CHILD = new URL("./inspect-child.ts", import.meta.url);
export const INSPECT_LIMITS = {
  /** Wall clock per inspection, process start included. */
  timeoutMs: 5000,
  /** Rows a query returns at most (more → `truncated`). */
  maxRows: 1000,
  /** Serialized rows per reply at most (more → `truncated`). */
  maxBytes: 4 * 1024 * 1024,
  /** Inspections running at once, in all and per app (more → 429). */
  maxRunning: 4,
  maxPerApp: 2,
};

let running = 0;
const perApp = new Map<string, number>();

/** Runs `job` against the database at `path` (null when there's none). */
export async function inspect<T>(appId: string, path: string, job: Job): Promise<T | null> {
  if (!existsSync(path)) return null;
  const { timeoutMs, maxBytes, maxRunning, maxPerApp } = INSPECT_LIMITS;
  const mine = perApp.get(appId) ?? 0;
  if (running >= maxRunning || mine >= maxPerApp) throw new HttpError(429, "too many database queries running; try again shortly", "busy");
  running++;
  perApp.set(appId, mine + 1);
  try {
    return await new Promise<T>((resolve, reject) => {
      const child = fork(CHILD, [], {
        env: {}, // nothing of the control plane's (secrets) in a process running user SQL
        execArgv: ["--max-old-space-size=256"],
        serialization: "json",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let done = false;
      const finish = (f: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        f();
      };
      const timer = setTimeout(() => finish(() =>
        reject(new HttpError(504, `query took longer than ${timeoutMs / 1000}s and was stopped`, "query_timeout"))), timeoutMs);
      child.once("message", (m: { result?: T; error?: string }) =>
        finish(() => (m.error !== undefined ? reject(new HttpError(400, m.error, "sql_error")) : resolve(m.result as T))));
      child.on("error", (e) => finish(() => reject(new HttpError(500, `database inspection failed: ${e.message}`))));
      // "close", not "exit": a reply still in the IPC channel lands first.
      child.once("close", (code, signal) => finish(() =>
        reject(new HttpError(500, `database inspection failed (${signal ?? code})`))));
      try {
        child.send({ path, job, maxBytes });
      } catch (e) {
        finish(() => reject(new HttpError(500, `database inspection failed: ${(e as Error).message}`)));
      }
    });
  } finally {
    running--;
    const n = perApp.get(appId)! - 1;
    if (n) perApp.set(appId, n);
    else perApp.delete(appId);
  }
}
