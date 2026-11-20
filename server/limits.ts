// In-memory sliding-window counters for abuse limits (one control-plane process, so no shared store).
// Restarting the server resets them, which is fine for limits measured in hours.

export class RateLimit {
  private hits = new Map<string, number[]>();
  private max: number;
  private windowMs: number;
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** Records a hit for `key` and returns true, or returns false (no hit recorded) if it's over. */
  take(key: string, now = Date.now()): boolean {
    const since = now - this.windowMs;
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
