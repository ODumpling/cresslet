// Sliding-window counters for abuse limits. Kept in the store's SQLite database (table rate_hits)
// when one is given, so a crash or restart doesn't hand out fresh allowances; in memory otherwise
// (short-lived limits like CLI logins, where a reset doesn't matter).

/** Where persisted hits live (Store: table rate_hits). */
export interface RateHits {
  rateHitCount(bucket: string, key: string, since: number): number;
  addRateHit(bucket: string, key: string, at: number, until: number): void;
}

export class RateLimit {
  private hits = new Map<string, number[]>();
  private max: number;
  private windowMs: number;
  private persist?: { hits: RateHits; bucket: string };
  /** `persist.bucket` names this limit's rows (unique per limit). */
  constructor(max: number, windowMs: number, persist?: { hits: RateHits; bucket: string }) {
    this.max = max;
    this.windowMs = windowMs;
    this.persist = persist;
  }

  /** Records a hit for `key` and returns true, or returns false (no hit recorded) if it's over. */
  take(key: string, now = Date.now()): boolean {
    const since = now - this.windowMs;
    if (this.persist) {
      // node:sqlite is synchronous and the control plane is one process: count + insert can't interleave.
      const { hits, bucket } = this.persist;
      if (hits.rateHitCount(bucket, key, since) >= this.max) return false;
      hits.addRateHit(bucket, key, now, now + this.windowMs);
      return true;
    }
    const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(since);
    return true;
  }

  private prune(since: number) {
    for (const [k, v] of this.hits) if (!v.some((t) => t > since)) this.hits.delete(k);
  }
}

/**
 * The key per-IP limits count by: an IPv6 address by its /64 (one subscriber usually gets a whole
 * /64, so counting single addresses would give them billions of allowances), anything else as is.
 */
export function ipKey(ip: string): string {
  const addr = ip.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  if (!addr.includes(":") || /^::ffff:\d+\.\d+\.\d+\.\d+$/.test(addr)) return addr.replace(/^::ffff:/, "");
  const [head, tail = ""] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  if (t.length && t[t.length - 1].includes(".")) t.splice(t.length - 1, 1, "0", "0"); // embedded IPv4: last 32 bits
  const groups = addr.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":") + "::/64";
}
