// Sliding-window counters for abuse limits. Kept in the store's database (table rate_hits)
// when one is given, so a crash or restart doesn't hand out fresh allowances; in memory otherwise
// (short-lived limits like CLI logins, where a reset doesn't matter).
import { isIPv6 } from "node:net";

import type { RateHits } from "./store.ts";

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
  async take(key: string, now = Date.now()): Promise<boolean> {
    const since = now - this.windowMs;
    if (this.persist) {
      // Count + insert in one transaction under a lock on the key: concurrent requests (or servers) can't both take the last one.
      const { hits, bucket } = this.persist;
      return hits.takeRateHit(bucket, key, since, this.max, now, now + this.windowMs);
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
  const raw = ip.trim();
  const v4 = /^(\d+\.\d+\.\d+\.\d+)(?::\d+)?$/.exec(raw); // a proxy may append :port
  if (v4) return v4[1];
  const addr = raw.replace(/^\[([^\]]*)\](?::\d+)?$/, "$1").split("%")[0];
  if (!isIPv6(addr)) return raw;
  // The URL parser canonicalizes (lowercase, embedded IPv4 as hex, longest zero run as ::).
  const [head, tail] = new URL(`http://[${addr}]/`).hostname.slice(1, -1).split("::");
  const part = (s?: string) => (s ? s.split(":").map((g) => parseInt(g, 16)) : []);
  const h = part(head), t = part(tail);
  const g = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill(0), ...t];
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join("."); // IPv4-mapped: the IPv4 client
  }
  return g.slice(0, 4).map((x) => x.toString(16)).join(":") + "::/64";
}
