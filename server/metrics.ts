// In-memory request metrics per app, in 5-minute buckets over the last 24 hours (for the app dashboard).
// Not persisted: a restart starts them over (the dashboard says since when they run).

export const BUCKET_MS = 5 * 60_000;
export const WINDOW_MS = 24 * 3600_000;
const BUCKETS = WINDOW_MS / BUCKET_MS;

interface Bucket {
  /** Bucket number (start / BUCKET_MS). */
  n: number;
  requests: number;
  /** Responses by class: 2xx, 3xx, 4xx, 5xx. */
  s2: number;
  s3: number;
  s4: number;
  s5: number;
  /** Requests the app's server handled (static files aren't timed), and their total and slowest time. */
  timed: number;
  ms: number;
  maxMs: number;
}

export interface MetricsView {
  since: string;
  bucketMs: number;
  totals: { requests: number; errors: number; clientErrors: number; avgMs: number | null; maxMs: number | null };
  series: { t: string; requests: number; errors: number; avgMs: number | null }[];
}

export class Metrics {
  #apps = new Map<string, Bucket[]>();
  #since = Date.now();

  /** One response: its status, and (for server routes) how long the app took. */
  record(appId: string, status: number, ms?: number, now = Date.now()) {
    const n = Math.floor(now / BUCKET_MS);
    let list = this.#apps.get(appId);
    if (!list) this.#apps.set(appId, list = []);
    let b = list.at(-1);
    if (!b || b.n !== n) {
      list.push(b = { n, requests: 0, s2: 0, s3: 0, s4: 0, s5: 0, timed: 0, ms: 0, maxMs: 0 });
      while (list.length && list[0].n <= n - BUCKETS) list.shift();
    }
    b.requests++;
    const cls = Math.floor(status / 100);
    if (cls === 2) b.s2++;
    else if (cls === 3) b.s3++;
    else if (cls === 4) b.s4++;
    else if (cls === 5) b.s5++;
    if (ms !== undefined) {
      b.timed++;
      b.ms += ms;
      b.maxMs = Math.max(b.maxMs, ms);
    }
  }

  /** The last 24 hours, one entry per bucket (oldest first), and totals over them. */
  view(appId: string, now = Date.now()): MetricsView {
    const last = Math.floor(now / BUCKET_MS), first = last - BUCKETS + 1;
    const by = new Map((this.#apps.get(appId) ?? []).filter((b) => b.n >= first).map((b) => [b.n, b]));
    let requests = 0, errors = 0, clientErrors = 0, timed = 0, ms = 0, maxMs = 0;
    const series = Array.from({ length: BUCKETS }, (_, i) => {
      const n = first + i, b = by.get(n);
      if (b) {
        requests += b.requests;
        errors += b.s5;
        clientErrors += b.s4;
        timed += b.timed;
        ms += b.ms;
        maxMs = Math.max(maxMs, b.maxMs);
      }
      return {
        t: new Date(n * BUCKET_MS).toISOString(),
        requests: b?.requests ?? 0,
        errors: b?.s5 ?? 0,
        avgMs: b?.timed ? Math.round(b.ms / b.timed) : null,
      };
    });
    return {
      since: new Date(this.#since).toISOString(),
      bucketMs: BUCKET_MS,
      totals: { requests, errors, clientErrors, avgMs: timed ? Math.round(ms / timed) : null, maxMs: timed ? Math.round(maxMs) : null },
      series,
    };
  }

  drop(appId: string) {
    this.#apps.delete(appId);
  }
}
