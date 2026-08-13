import { yearMonthOf } from '../usage/usageStore.js';

/**
 * How many requests an account has had served this billing month.
 *
 * The quota is enforced against this number, so it has to be right in a way the
 * rate-limit window does not: a minute recovers by itself, a month does not, and
 * for a Professional account the number past the quota is money.
 *
 * ## Why this is not just a query
 *
 * The obvious implementation — `SELECT COUNT(*)` on every request — is wrong
 * twice. It puts a disk read on the critical path of every authenticated call,
 * which is the cost `usageMeter.ts` explicitly refuses to pay; and it is *stale*
 * anyway, because the meter buffers for a second before writing, so a burst of a
 * thousand requests inside one flush interval would every one of them read the
 * same pre-burst count and every one of them would be admitted.
 *
 * ## What this does instead
 *
 * Seed once per (account, month) from durable storage, then count in process.
 * Within one process that is exact: the seed covers everything written before
 * this process started, and every request since has passed through here.
 *
 * ## The re-seed, and why `max` is the whole trick
 *
 * Every {@link RESEED_INTERVAL_MS} the durable figure is read again and the
 * counter takes `max(counted, durable)`. That picks up traffic this process did
 * not serve — a sibling process, a replayed batch — without ever double-counting
 * its own, because both quantities are lower bounds on the same true total:
 * `counted` is what we have seen, `durable` is what has been written, each is a
 * subset of the real number, and the larger of two lower bounds is still a lower
 * bound. So the counter is monotone, never exceeds the truth, and converges on it
 * within one interval.
 *
 * The residual is stated rather than hidden: between re-seeds, N processes each
 * enforce the quota against their own view, so a customer could briefly exceed it
 * by up to the traffic N−1 siblings serve in an interval. Today N is 1 — the
 * public surface is one process on one port — and the honest fix if that changes
 * is a shared counter, not a shorter interval.
 *
 * ## Which way this is allowed to be wrong
 *
 * Toward **serving**. A durable read that throws leaves the counter on its last
 * value and lets the request through, because the failure mode of the other
 * direction is refusing a paying customer's traffic on the strength of a broken
 * disk read. That matches the direction `usageStore.ts` errs in for the same
 * reason: the error we can absorb quietly is the one that costs us money, not the
 * one that costs the customer their service.
 */

/**
 * The durable half: what storage says this account used.
 *
 * A one-method interface rather than the whole `UsageAdminStore`, so the gate
 * holds a capability that can only *read a count*. It cannot roll up, close a
 * month, apply retention or export an account, and — the one that matters for
 * ABL-297 §6.5 — there is no shape of this type that could disable anything.
 * `planGate.test.ts` asserts that as a property of the module graph rather than
 * of this comment.
 */
export interface MonthlyUsageReader {
  /**
   * Requests **served** to this account in the given `YYYY-MM`, UTC.
   *
   * "Served" and not "recorded": a request this gate refused with a 429 is in the
   * usage log — every request is, and it must be, because a refusal is still
   * traffic and still evidence — but it never consumed quota, so counting it here
   * would make the durable figure disagree with the in-process one and would put
   * refused requests into a Professional account's billable overage. The
   * implementation excludes `THROTTLED_STATUS`; see `sqliteUsageStore.ts`.
   */
  servedRequestsInMonth(accountId: string, yearMonth: string): number;
}

/**
 * How long a counter trusts its own arithmetic before reconciling with storage.
 *
 * One minute. Long enough that the read is negligible — one indexed `COUNT` per
 * active account per minute — and short enough that a sibling process or a
 * replayed batch is reflected before it could matter at any plan's volume.
 */
export const RESEED_INTERVAL_MS = 60_000;

/**
 * How long an entry for a month nobody is using any more is kept.
 *
 * Entries are keyed by (account, month), so a long-running process would
 * otherwise accumulate one dead entry per account per month forever. Swept
 * opportunistically on a call, like the rate limiter's, and generous because the
 * cost of keeping one is two numbers and the cost of dropping one too early is a
 * re-seed.
 */
export const STALE_ENTRY_MS = 2 * RESEED_INTERVAL_MS;

export interface MonthlyQuotaCounter {
  /**
   * What this account has used this month, reconciling with storage if the
   * entry is due. Does not consume anything.
   */
  used(accountId: string, yearMonth: string, nowMs: number): number;
  /** Record one request that passed the gate, returning the new total. */
  consume(accountId: string, yearMonth: string, nowMs: number): number;
  /** Tracked (account, month) entries. For tests and for an operator counter. */
  size(): number;
}

interface Entry {
  count: number;
  seededAtMs: number;
  touchedAtMs: number;
}

export interface MonthlyQuotaCounterOptions {
  reader: MonthlyUsageReader;
  reseedIntervalMs?: number;
}

/**
 * One entry per account per billing month.
 *
 * Joined on a character that cannot occur in either half — an account id is
 * `acct_` and hex, a month is `YYYY-MM` — so no pair of inputs can produce the
 * same key as a different pair. A NUL would be the textbook separator here and is
 * deliberately not used: a source file containing a raw NUL byte is one git
 * treats as binary, and it stops producing a reviewable diff of it.
 */
function entryKey(accountId: string, yearMonth: string): string {
  return `${accountId}#${yearMonth}`;
}

export function createMonthlyQuotaCounter({
  reader,
  reseedIntervalMs = RESEED_INTERVAL_MS,
}: MonthlyQuotaCounterOptions): MonthlyQuotaCounter {
  const entries = new Map<string, Entry>();
  let lastSweepMs = Number.NEGATIVE_INFINITY;

  /**
   * Read the durable count, or `null` if storage could not answer.
   *
   * The throw is swallowed rather than propagated, and logged rather than
   * silent. Propagating would turn a transient SQLite lock into a 500 on a
   * request that was inside its quota; swallowing quietly would let a store that
   * has been failing for a month look exactly like a store that agrees with us.
   */
  function readDurable(accountId: string, yearMonth: string): number | null {
    try {
      const count = reader.servedRequestsInMonth(accountId, yearMonth);
      return Number.isFinite(count) && count >= 0 ? count : null;
    } catch (err) {
      console.error('Monthly quota: durable usage read failed, serving on the local count:', err);
      return null;
    }
  }

  function sweep(nowMs: number): void {
    if (nowMs - lastSweepMs < STALE_ENTRY_MS) return;
    lastSweepMs = nowMs;
    for (const [key, entry] of entries) {
      if (nowMs - entry.touchedAtMs >= STALE_ENTRY_MS) entries.delete(key);
    }
  }

  function resolve(accountId: string, yearMonth: string, nowMs: number): Entry {
    sweep(nowMs);

    const key = entryKey(accountId, yearMonth);
    const existing = entries.get(key);

    if (existing === undefined) {
      // First sight of this account this month in this process. `?? 0` on a
      // failed read is the permissive direction on purpose: a store that cannot
      // be read must not lock out a customer who has used nothing.
      const entry: Entry = {
        count: readDurable(accountId, yearMonth) ?? 0,
        seededAtMs: nowMs,
        touchedAtMs: nowMs,
      };
      entries.set(key, entry);
      return entry;
    }

    existing.touchedAtMs = nowMs;
    if (nowMs - existing.seededAtMs >= reseedIntervalMs) {
      const durable = readDurable(accountId, yearMonth);
      // `max`, never assignment. See the header: both figures are lower bounds
      // on the same total, so the larger is the better lower bound and taking it
      // can neither lose our own uncommitted requests nor double-count them.
      if (durable !== null) existing.count = Math.max(existing.count, durable);
      // The clock is reset even when the read failed, so a store that is down
      // does not make every subsequent request retry it.
      existing.seededAtMs = nowMs;
    }
    return existing;
  }

  return {
    used: (accountId, yearMonth, nowMs) => resolve(accountId, yearMonth, nowMs).count,

    consume(accountId, yearMonth, nowMs) {
      const entry = resolve(accountId, yearMonth, nowMs);
      entry.count += 1;
      return entry.count;
    },

    size: () => entries.size,
  };
}

/**
 * The billing month an instant falls in, UTC.
 *
 * Re-exported from `usageStore.ts` rather than reimplemented, so the month the
 * quota resets on and the month the invoice is raised for are the same string
 * produced by the same function. Two implementations of "which month is it"
 * would disagree for one hour a year in some timezone and the disagreement would
 * surface as a customer whose quota reset a day after their bill did.
 */
export function billingMonthOf(now: Date): string {
  return yearMonthOf(now.toISOString());
}
