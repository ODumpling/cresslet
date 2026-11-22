// Cron triggers: `"crons": ["*/5 * * * *"]` in cresslet.json runs the server's `scheduled(event, env, ctx)`
// export on that schedule (UTC, minute resolution). Claimed apps only.
import type { Store } from "./store.ts";

const FIELDS: [min: number, max: number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const NAMES: Record<number, string[]> = {
  3: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
  4: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
};
export const MAX_CRONS = 5;
const MINUTE = 60_000;

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

export function cronMatches(cron: Cron, d: Date): boolean {
  const [min, hour, , mon] = cron.fields;
  return min.has(d.getUTCMinutes()) && hour.has(d.getUTCHours()) && mon.has(d.getUTCMonth() + 1) && dayMatches(cron, d);
}

function dayMatches({ fields: [, , dom, , dow], domStar, dowStar }: Cron, d: Date): boolean {
  const domOk = dom.has(d.getUTCDate()), dowOk = dow.has(d.getUTCDay());
  // Both restricted: either may match; otherwise both must.
  return domStar || dowStar ? domOk && dowOk : domOk || dowOk;
}

/**
 * The next `n` minutes (ms, UTC) after `from` the cron fires at, within `horizonMs` (an expression like
 * `0 0 30 2 *` never fires: fewer or none). 400 years: the Gregorian calendar repeats, so a date and weekday
 * that can ever meet do within it. Skips whole months, days and hours that can't match (a few thousand steps).
 */
export function nextRuns(cron: Cron, from: number, n: number, horizonMs = 400 * 366 * 86_400_000): number[] {
  const [min, hour, , mon] = cron.fields;
  const out: number[] = [];
  const end = from + horizonMs;
  for (let t = Math.floor(from / MINUTE) * MINUTE + MINUTE; out.length < n && t <= end;) {
    const d = new Date(t);
    const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate(), h = d.getUTCHours();
    if (!mon.has(m + 1)) t = Date.UTC(y, m + 1, 1);
    else if (!dayMatches(cron, d)) t = Date.UTC(y, m, day + 1);
    else if (!hour.has(h)) t = Date.UTC(y, m, day, h + 1);
    else {
      if (min.has(d.getUTCMinutes())) out.push(t);
      t += MINUTE;
    }
  }
  return out;
}

/** One finished run: `at` the minute it was due (or when it was asked for), `status` 0 if it couldn't reach the app. */
export interface CronRun {
  cron: string;
  at: number;
  startedAt: number;
  ms: number;
  status: number;
  /** Started with Run now, not the schedule. */
  manual: boolean;
}

/**
 * Recent runs per app, newest first, and each cron's last one (kept also once its run left the recent ones), in
 * memory on the node that runs them (a restart starts over: see `since`).
 */
export class CronRuns {
  static readonly KEEP = 50;
  /** Crons whose last run is kept (most recently run first): an app has at most MAX_CRONS at a time. */
  static readonly KEEP_LAST = 2 * MAX_CRONS;
  #apps = new Map<string, { runs: CronRun[]; last: Map<string, CronRun> }>();
  readonly since = Date.now();

  record(appId: string, run: CronRun) {
    let a = this.#apps.get(appId);
    if (!a) this.#apps.set(appId, a = { runs: [], last: new Map() });
    a.runs.unshift(run);
    if (a.runs.length > CronRuns.KEEP) a.runs.length = CronRuns.KEEP;
    a.last.delete(run.cron); // to the end: the most recent
    a.last.set(run.cron, run);
    for (const k of a.last.keys()) {
      if (a.last.size <= CronRuns.KEEP_LAST) break;
      a.last.delete(k);
    }
  }
  list(appId: string): readonly CronRun[] {
    return this.#apps.get(appId)?.runs ?? [];
  }
  last(appId: string, cron: string): CronRun | undefined {
    return this.#apps.get(appId)?.last.get(cron);
  }
  drop(appId: string) {
    this.#apps.delete(appId);
  }
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

/** Minutes missed during an event-loop stall that still fire late (bounded). */
const CATCH_UP = 5;

/** Performs one invocation (see host.ts); `manual`: Run now, which also runs a paused cron. */
export type RunCron = (appId: string, cron: string, at: Date, manual?: boolean) => Promise<void>;

/** The expressions of an app's crons paused in the studio (`apps.paused_crons`). */
export const pausedCrons = (app: { paused_crons?: string | null }): Set<string> =>
  new Set(app.paused_crons ? JSON.parse(app.paused_crons) as string[] : []);

/**
 * Fires due crons once per minute. Runs of one app go one at a time (they share the sandbox's
 * connection, so each gets its own full request timeout), and a cron still running or queued is not
 * started again. Paused crons are skipped (and checked again at dispatch, in `run`).
 */
export class Scheduler {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #store: Pick<Store, "appsWithCrons">;
  #run: RunCron;
  #last: number;
  #queues = new Map<string, Promise<void>>();
  /** `<appId> <cron>`: queued or running. */
  #running = new Set<string>();
  /** The cron each app is running right now (one at a time). */
  #active = new Map<string, string>();

  constructor(store: Pick<Store, "appsWithCrons">, run: RunCron, now = Date.now()) {
    this.#store = store;
    this.#run = async (appId, cron, at, manual) => {
      this.#active.set(appId, cron);
      try {
        await run(appId, cron, at, manual);
      } finally {
        this.#active.delete(appId);
      }
    };
    this.#last = Math.floor(now / MINUTE) * MINUTE;
  }

  /** What an app's crons are doing on this node: `running` (now) or `queued` (waiting behind another run). */
  state(appId: string, cron: string): "running" | "queued" | null {
    return this.#active.get(appId) === cron ? "running" : this.#running.has(`${appId} ${cron}`) ? "queued" : null;
  }

  /**
   * Run now: queues one run of the cron behind the app's others, also when it's paused. False if that
   * cron is already running or queued.
   */
  runNow(appId: string, cron: string, at = new Date()): boolean {
    const key = `${appId} ${cron}`;
    if (this.#running.has(key)) return false;
    this.#running.add(key);
    const job = (this.#queues.get(appId) ?? Promise.resolve())
      .then(() => this.#run(appId, cron, at, true)).catch(() => {})
      .finally(() => this.#running.delete(key));
    this.#queues.set(appId, job);
    void job.then(() => this.#queues.get(appId) === job && this.#queues.delete(appId));
    return true;
  }

  start() {
    const arm = () => {
      this.#timer = setTimeout(() => {
        const due = this.due(Date.now());
        if (due.length) void this.tick(due.map((m) => new Date(m))).catch((e) => console.error("cresslet: cron tick failed:", e));
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
    for (const app of await this.#store.appsWithCrons()) {
      // One app's runs go in minute order (then cron order), as they would without a stall.
      const due: { m: Date; c: string }[] = [];
      const paused = pausedCrons(app);
      for (const c of (JSON.parse(app.config) as { crons?: string[] }).crons ?? []) {
        if (paused.has(c)) continue;
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
