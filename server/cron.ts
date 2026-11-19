// Cron triggers: `"crons": ["*/5 * * * *"]` in cresslet.json runs the server's `scheduled(event, env, ctx)`
// export on that schedule (UTC, minute resolution). Claimed apps only.
import type { Store } from "./store.ts";

const FIELDS: [min: number, max: number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const NAMES: Record<number, string[]> = {
  3: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
  4: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
};
export const MAX_CRONS = 5;

export interface Cron {
  fields: Set<number>[];
  /** Day-of-month / day-of-week field started with `*` (Vixie cron: then the day fields are ANDed). */
  domStar: boolean;
  dowStar: boolean;
}

/** Standard 5-field expression: lists, ranges, steps, `*`, JAN-DEC / SUN-SAT names, dow 7 = Sunday. */
export function parseCron(expr: string): Cron {
  const parts = expr.trim().toLowerCase().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields: ${expr}`);
  const fields = parts.map((part, i) => {
    const [lo, hi] = FIELDS[i];
    const names = NAMES[i];
    const num = (t: string) => {
      const n = names?.indexOf(t) ?? -1;
      return n >= 0 ? n + (i === 3 ? 1 : 0) : /^\d+$/.test(t) ? Number(t) : NaN;
    };
    const out = new Set<number>();
    for (const item of part.split(",")) {
      const m = /^(\*|([a-z0-9]+)(?:-([a-z0-9]+))?)(?:\/(\d+))?$/.exec(item);
      if (!m) throw new Error(`invalid cron field "${part}" in: ${expr}`);
      const a = m[1] === "*" ? lo : num(m[2]);
      const b = m[1] === "*" ? (i === 4 ? 6 : hi) : m[3] !== undefined ? num(m[3]) : m[4] ? hi : a;
      const step = m[4] ? Number(m[4]) : 1;
      if (!(a >= lo && b <= hi && a <= b && step >= 1)) throw new Error(`cron field out of range "${part}" in: ${expr}`);
      for (let v = a; v <= b; v += step) out.add(i === 4 && v === 7 ? 0 : v);
    }
    return out;
  });
  return { fields, domStar: parts[2].startsWith("*"), dowStar: parts[4].startsWith("*") };
}

export function cronMatches({ fields, domStar, dowStar }: Cron, d: Date): boolean {
  const [min, hour, dom, mon, dow] = fields;
  if (!min.has(d.getUTCMinutes()) || !hour.has(d.getUTCHours()) || !mon.has(d.getUTCMonth() + 1)) return false;
  const domOk = dom.has(d.getUTCDate()), dowOk = dow.has(d.getUTCDay());
  // Both restricted: either may match; otherwise both must.
  return domStar || dowStar ? domOk && dowOk : domOk || dowOk;
}

export function normalizeCrons(crons: unknown): string[] {
  if (crons === undefined) return [];
  if (!Array.isArray(crons) || crons.length > MAX_CRONS) throw new Error(`crons must be an array of at most ${MAX_CRONS}`);
  const out = crons.map((c) => {
    if (typeof c !== "string" || c.length > 1000) throw new Error(`invalid cron: ${String(c)}`);
    parseCron(c);
    return c.trim().replace(/\s+/g, " ");
  });
  return [...new Set(out)];
}

const MINUTE = 60_000;
/** Minutes missed during an event-loop stall that still fire late (bounded). */
const CATCH_UP = 5;

/**
 * Fires due crons once per minute. Runs of one app go one at a time (they share the sandbox's
 * connection, so each gets its own full request timeout), and a cron still running is not started
 * again. `run` performs one invocation (see host.ts).
 */
export class Scheduler {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #store: Store;
  #run: (appId: string, cron: string, at: Date) => Promise<void>;
  #last: number;
  #queues = new Map<string, Promise<void>>();
  #running = new Set<string>();

  constructor(store: Store, run: (appId: string, cron: string, at: Date) => Promise<void>, now = Date.now()) {
    this.#store = store;
    this.#run = run;
    this.#last = Math.floor(now / MINUTE) * MINUTE;
  }

  start() {
    const arm = () => {
      this.#timer = setTimeout(() => {
        const due = this.due(Date.now());
        if (due.length) void this.tick(due.map((m) => new Date(m)));
        arm();
      }, MINUTE - (Date.now() % MINUTE) + 50);
      this.#timer.unref?.();
    };
    arm();
  }

  /**
   * Minute boundaries to fire at wall-clock `now`: each one passed since the last call exactly once,
   * also when the callback ran late (stall, bounded catch-up) or the clock stepped back (nothing
   * until it passes the last fired minute again).
   */
  due(now: number): number[] {
    const cur = Math.floor(now / MINUTE) * MINUTE;
    const out = [];
    for (let m = Math.max(this.#last + MINUTE, cur - (CATCH_UP - 1) * MINUTE); m <= cur; m += MINUTE) out.push(m);
    this.#last = Math.max(this.#last, cur);
    return out;
  }

  /**
   * Queues every cron due at the given minute(s) (several after a stall, run in order). A cron still
   * running from an earlier tick isn't queued again. Resolves when they have all finished.
   */
  async tick(at: Date | Date[]) {
    const minutes = Array.isArray(at) ? at : [at];
    const jobs: Promise<void>[] = [];
    for (const app of this.#store.appsWithCrons()) {
      // One app's runs go in minute order (then cron order), as they would without a stall.
      const due: { m: Date; c: string }[] = [];
      for (const c of (JSON.parse(app.config) as { crons?: string[] }).crons ?? []) {
        let cron;
        try {
          cron = parseCron(c);
        } catch {
          continue;
        }
        const key = `${app.id} ${c}`;
        const hits = minutes.filter((m) => cronMatches(cron, m));
        if (!hits.length || this.#running.has(key)) continue;
        this.#running.add(key);
        for (const m of hits) due.push({ m, c });
      }
      if (!due.length) continue;
      due.sort((a, b) => a.m.getTime() - b.m.getTime());
      // Each cron counts as running until its own last queued run ends (not the whole batch's).
      const last = new Map(due.map((d, i) => [d.c, i]));
      let chain = this.#queues.get(app.id) ?? Promise.resolve();
      due.forEach(({ m, c }, i) => {
        chain = chain.then(() => this.#run(app.id, c, m)).catch(() => {});
        if (last.get(c) === i) chain = chain.finally(() => this.#running.delete(`${app.id} ${c}`));
      });
      const job = chain;
      this.#queues.set(app.id, job);
      void job.then(() => this.#queues.get(app.id) === job && this.#queues.delete(app.id));
      jobs.push(job);
    }
    await Promise.all(jobs);
  }

  stop() {
    clearTimeout(this.#timer);
  }
}
