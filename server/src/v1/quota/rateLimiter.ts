/**
 * The per-minute rate limit: a sliding window, in memory, per account.
 *
 * ## Sliding window rather than a fixed one
 *
 * A fixed 60-second bucket is three lines shorter and lets a caller send `2 ×
 * limit` requests in the two seconds either side of a bucket boundary — 20
 * requests in two seconds on Explorer's 10/min. That is not a rounding error on
 * a single-threaded process reading a 9.4 GB SQLite file, and it is the exact
 * burst the limit exists to prevent.
 *
 * The cost of doing it properly is one array of timestamps per active account,
 * bounded above by the plan's own limit — at most 600 numbers for the largest
 * tier, ~5 KB. That is small enough that the approximation was never worth its
 * failure mode.
 *
 * It also makes `Retry-After` exact rather than conservative: the caller is told
 * when the oldest request leaves the window, which is precisely when a slot
 * frees, so a client that obeys the header succeeds on its first retry instead of
 * being refused again and backing off further.
 *
 * ## What "in memory" means and does not mean
 *
 * State is per process and is lost on restart, which resets every window to
 * empty. The failure direction is therefore *permissive* — a restart briefly
 * allows one extra window's worth of traffic — and that is the direction this
 * whole surface errs in: `usageStore.ts` chooses to under-count rather than
 * over-bill, and a rate limiter that wrongly refused a paying customer after a
 * deploy would be the same mistake pointed at availability.
 *
 * A second process would enforce the limit twice over, once each. The public
 * surface runs as one process (`publicIndex.ts` binds one port), so today that is
 * theoretical; the honest statement is that this limiter is per process and a
 * horizontally scaled deployment needs a shared counter, not that it is
 * distributed. {@link MonthlyQuotaCounter} carries the same caveat and closes it
 * differently, because a quota is money and a minute is not.
 */

/** The window, in milliseconds. "Per minute" from the ABL-291 brief §1.2 table. */
export const RATE_WINDOW_MS = 60_000;

/**
 * How often idle accounts are dropped from the map.
 *
 * Opportunistic, on a call, rather than on a timer. A timer here would have to be
 * created, `unref`'d and closed, and would give this module a lifecycle for the
 * sake of reclaiming a few kilobytes; sweeping on the first call after an
 * interval costs one comparison per request and needs nothing shut down.
 */
export const SWEEP_INTERVAL_MS = 5 * RATE_WINDOW_MS;

export interface RateDecision {
  /** Whether the request may proceed. When false the caller owes a 429. */
  allowed: boolean;
  /** The plan's limit, for `RateLimit-Limit`. */
  limit: number;
  /** Slots left in the current window *after* this decision, for `RateLimit-Remaining`. */
  remaining: number;
  /**
   * Whole seconds until the window frees a slot, for `RateLimit-Reset`.
   *
   * Under a sliding window this is when the oldest recorded request falls out,
   * which is the first instant a refused caller would be admitted. `0` only when
   * nothing is recorded at all.
   */
  resetSeconds: number;
}

export interface RateLimiter {
  /**
   * Ask for a slot, and take one if it is free.
   *
   * **A refused request is not recorded.** Recording it would extend the
   * penalty every time a misbehaving client retried, so a client polling at
   * 100/min against a 10/min limit would never be admitted again and
   * `Retry-After` would be a number we knew to be wrong. Refusals are still
   * visible: the usage meter records every request including the 429s, which is
   * where abuse detection reads from (ABL-297 §3.3).
   */
  admit(subject: string, limit: number, nowMs: number): RateDecision;
  /** Active subjects being tracked. For tests and for an operator counter. */
  size(): number;
}

export function createRateLimiter(): RateLimiter {
  /** Subject → admission timestamps inside the window, ascending. */
  const windows = new Map<string, number[]>();
  let lastSweepMs = Number.NEGATIVE_INFINITY;

  /**
   * Drop timestamps that have left the window.
   *
   * The array is ascending and only ever appended to at the end, so the expired
   * entries are a prefix and one `findIndex` removes them all. Mutates in place
   * rather than reassigning, because the caller holds the same array.
   */
  function evict(hits: number[], nowMs: number): void {
    const cutoff = nowMs - RATE_WINDOW_MS;
    let expired = 0;
    while (expired < hits.length && hits[expired] <= cutoff) expired += 1;
    if (expired > 0) hits.splice(0, expired);
  }

  function sweep(nowMs: number): void {
    if (nowMs - lastSweepMs < SWEEP_INTERVAL_MS) return;
    lastSweepMs = nowMs;
    for (const [subject, hits] of windows) {
      evict(hits, nowMs);
      if (hits.length === 0) windows.delete(subject);
    }
  }

  return {
    admit(subject, limit, nowMs) {
      sweep(nowMs);

      let hits = windows.get(subject);
      if (hits === undefined) {
        hits = [];
        windows.set(subject, hits);
      }
      evict(hits, nowMs);

      // A limit of zero or less would be a plan nobody can call. It is not
      // reachable from `PLAN_LIMITS` and is refused here rather than trusted,
      // because the alternative — `remaining` going negative and a `Retry-After`
      // computed off an empty array — fails in a way that reads as a bug in the
      // limiter rather than as a bad plan record.
      if (limit <= 0) {
        return { allowed: false, limit: Math.max(0, limit), remaining: 0, resetSeconds: 0 };
      }

      if (hits.length >= limit) {
        // The oldest hit decides when a slot frees. `Math.ceil` and a floor of
        // one second: telling a client to retry in zero seconds invites a retry
        // that is refused again, and a fractional `Retry-After` is not a legal
        // header value.
        const freesAt = hits[0] + RATE_WINDOW_MS;
        return {
          allowed: false,
          limit,
          remaining: 0,
          resetSeconds: Math.max(1, Math.ceil((freesAt - nowMs) / 1000)),
        };
      }

      hits.push(nowMs);
      return {
        allowed: true,
        limit,
        remaining: limit - hits.length,
        // `hits[0]` exists — this request was just pushed — so an admitted
        // caller always gets a real reset rather than a zero that would read as
        // "the window is already clear".
        resetSeconds: Math.max(1, Math.ceil((hits[0] + RATE_WINDOW_MS - nowMs) / 1000)),
      };
    },

    size: () => windows.size,
  };
}
