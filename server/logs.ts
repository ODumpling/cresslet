export interface LogLine {
  t: number;
  kind: "stdout" | "stderr" | "system" | "request";
  msg: string;
}

export const MAX_LINE = 16_384;

/** In-memory ring buffer of recent log lines per app, with live subscribers. */
export class Logs {
  #lines = new Map<string, LogLine[]>();
  #subs = new Map<string, Set<(l: LogLine) => void>>();

  #max: number;

  constructor(max = 1000) {
    this.#max = max;
  }

  push(appId: string, kind: LogLine["kind"], msg: string) {
    // Kept in memory (CRESSLET_LOG_LINES per app): one huge console.log mustn't cost the control plane its size.
    if (msg.length > MAX_LINE) msg = msg.slice(0, MAX_LINE) + ` … [${msg.length - MAX_LINE} more characters]`;
    const line = { t: Date.now(), kind, msg };
    let arr = this.#lines.get(appId);
    if (!arr) this.#lines.set(appId, arr = []);
    arr.push(line);
    if (arr.length > this.#max) arr.splice(0, arr.length - this.#max);
    for (const fn of this.#subs.get(appId) ?? []) fn(line);
  }

  recent(appId: string, n = 200): LogLine[] {
    return (this.#lines.get(appId) ?? []).slice(-n);
  }

  subscribe(appId: string, fn: (l: LogLine) => void): () => void {
    let set = this.#subs.get(appId);
    if (!set) this.#subs.set(appId, set = new Set());
    set.add(fn);
    return () => set!.delete(fn);
  }

  drop(appId: string) {
    this.#lines.delete(appId);
    this.#subs.delete(appId);
  }
}
