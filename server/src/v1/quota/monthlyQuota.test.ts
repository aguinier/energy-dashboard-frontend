import { describe, it, expect, vi } from 'vitest';
import {
  billingMonthOf,
  createMonthlyQuotaCounter,
  RESEED_INTERVAL_MS,
  STALE_ENTRY_MS,
  type MonthlyUsageReader,
} from './monthlyQuota.js';

/**
 * The month counter: seeded from storage, counted in process, reconciled by
 * `max`.
 *
 * The reader is a stub with a settable answer and a call counter, because the two
 * properties worth testing are both about *when* storage is consulted — once per
 * entry, then once per interval — and neither is observable from the count alone.
 */
function reader(initial = 0): MonthlyUsageReader & { value: number; calls: number } {
  return {
    value: initial,
    calls: 0,
    servedRequestsInMonth() {
      this.calls += 1;
      return this.value;
    },
  };
}

const ACCOUNT = 'acct_one';
const MONTH = '2026-08';

describe('seeding', () => {
  it('starts from what storage already recorded', () => {
    // The case a restart makes routine: a customer 900 requests into their month
    // must not get a fresh 1,000 because the process bounced.
    const store = reader(900);
    const counter = createMonthlyQuotaCounter({ reader: store });

    expect(counter.used(ACCOUNT, MONTH, 0)).toBe(900);
    expect(counter.consume(ACCOUNT, MONTH, 0)).toBe(901);
  });

  it('reads storage once per account-month, not once per request', () => {
    // The reason this is a counter and not a query. A `SELECT COUNT(*)` per
    // request is a disk read on the critical path of every authenticated call —
    // the cost `usageMeter.ts` explicitly refuses to pay — and it is stale
    // anyway, because the meter buffers.
    const store = reader(10);
    const counter = createMonthlyQuotaCounter({ reader: store });

    for (let i = 0; i < 50; i += 1) counter.consume(ACCOUNT, MONTH, 1_000);
    expect(store.calls).toBe(1);
    expect(counter.used(ACCOUNT, MONTH, 1_000)).toBe(60);
  });

  it('counts a burst that has not reached storage yet', () => {
    // The failure a plain query has and this does not: storage still says zero
    // because the meter has not flushed, and the thousandth request of the burst
    // must still see 999.
    const store = reader(0);
    const counter = createMonthlyQuotaCounter({ reader: store });

    for (let i = 0; i < 999; i += 1) counter.consume(ACCOUNT, MONTH, 1_000);
    expect(store.value).toBe(0);
    expect(counter.used(ACCOUNT, MONTH, 1_000)).toBe(999);
  });

  it('keeps accounts and months apart', () => {
    const store = reader(0);
    const counter = createMonthlyQuotaCounter({ reader: store });

    counter.consume('acct_a', '2026-08', 0);
    counter.consume('acct_a', '2026-08', 0);
    counter.consume('acct_b', '2026-08', 0);
    counter.consume('acct_a', '2026-09', 0);

    expect(counter.used('acct_a', '2026-08', 0)).toBe(2);
    expect(counter.used('acct_b', '2026-08', 0)).toBe(1);
    expect(counter.used('acct_a', '2026-09', 0)).toBe(1);
  });
});

describe('reconciling with storage', () => {
  it('takes the larger of the two figures, never the newer one', () => {
    // The load-bearing line. Both quantities are lower bounds on the same total —
    // `counted` is what this process has seen, `durable` is what has been
    // written — so `max` is the better lower bound and can neither discard our
    // own unflushed requests nor count them twice.
    const store = reader(0);
    const counter = createMonthlyQuotaCounter({ reader: store });

    for (let i = 0; i < 100; i += 1) counter.consume(ACCOUNT, MONTH, 0);
    expect(counter.used(ACCOUNT, MONTH, 0)).toBe(100);

    // Storage catches up with our own 100 and adds 40 from somewhere else.
    store.value = 140;
    expect(counter.used(ACCOUNT, MONTH, RESEED_INTERVAL_MS)).toBe(140);
  });

  it('does not go backwards when storage lags behind', () => {
    // The same `max` from the other side: the meter buffers, so a re-seed
    // routinely reads a figure lower than ours. Assignment here would forget a
    // second of traffic every minute, forever.
    const store = reader(0);
    const counter = createMonthlyQuotaCounter({ reader: store });

    for (let i = 0; i < 100; i += 1) counter.consume(ACCOUNT, MONTH, 0);
    store.value = 60;

    expect(counter.used(ACCOUNT, MONTH, RESEED_INTERVAL_MS)).toBe(100);
  });

  it('re-reads storage once per interval and not more', () => {
    const store = reader(0);
    const counter = createMonthlyQuotaCounter({ reader: store });

    counter.used(ACCOUNT, MONTH, 0);
    expect(store.calls).toBe(1);

    for (let t = 1; t < RESEED_INTERVAL_MS; t += 1_000) counter.used(ACCOUNT, MONTH, t);
    expect(store.calls).toBe(1);

    counter.used(ACCOUNT, MONTH, RESEED_INTERVAL_MS);
    expect(store.calls).toBe(2);
  });
});

describe('when storage cannot be read', () => {
  it('serves rather than refuses, and says so once per interval', () => {
    // The direction this whole surface errs in. Refusing a paying customer's
    // traffic on the strength of a failed disk read is the mistake that costs
    // *them* their service; letting it through costs us margin we can absorb.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store: MonthlyUsageReader = {
      servedRequestsInMonth() {
        throw new Error('database is locked');
      },
    };
    const counter = createMonthlyQuotaCounter({ reader: store });

    expect(counter.used(ACCOUNT, MONTH, 0)).toBe(0);
    expect(counter.consume(ACCOUNT, MONTH, 0)).toBe(1);
    expect(logged).toHaveBeenCalledTimes(1);

    logged.mockRestore();
  });

  it('keeps its own count when a later read throws', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    let failing = false;
    const store: MonthlyUsageReader = {
      servedRequestsInMonth() {
        if (failing) throw new Error('database is locked');
        return 0;
      },
    };
    const counter = createMonthlyQuotaCounter({ reader: store });

    for (let i = 0; i < 20; i += 1) counter.consume(ACCOUNT, MONTH, 0);
    failing = true;

    expect(counter.used(ACCOUNT, MONTH, RESEED_INTERVAL_MS)).toBe(20);
    // And the failed read still resets the clock, so a store that is down does
    // not make every subsequent request retry it.
    expect(counter.used(ACCOUNT, MONTH, RESEED_INTERVAL_MS + 1)).toBe(20);

    logged.mockRestore();
  });

  it('ignores a nonsense figure rather than trusting it', () => {
    const store: MonthlyUsageReader = { servedRequestsInMonth: () => Number.NaN };
    const counter = createMonthlyQuotaCounter({ reader: store });

    // `NaN` compares false against every limit, so a counter that adopted it
    // would admit everything for the rest of the month.
    expect(counter.used(ACCOUNT, MONTH, 0)).toBe(0);
  });
});

describe('the map does not grow without bound', () => {
  it('drops entries for months nobody is using', () => {
    const store = reader(0);
    const counter = createMonthlyQuotaCounter({ reader: store });

    counter.consume('acct_a', '2026-07', 0);
    counter.consume('acct_b', '2026-07', 0);
    expect(counter.size()).toBe(2);

    counter.consume('acct_a', '2026-08', STALE_ENTRY_MS + 1);
    expect(counter.size()).toBe(1);
  });
});

describe('which month a request belongs to', () => {
  it('is the UTC calendar month, at both boundaries', () => {
    // UTC for every customer in every timezone, because the billing month is
    // UTC: `usage_rollup.year_month` is `substr(received_at, 1, 7)` and a
    // boundary that moved per customer would make two invoices for the same
    // traffic disagree.
    expect(billingMonthOf(new Date('2026-08-01T00:00:00.000Z'))).toBe('2026-08');
    expect(billingMonthOf(new Date('2026-08-31T23:59:59.999Z'))).toBe('2026-08');
    expect(billingMonthOf(new Date('2026-09-01T00:00:00.000Z'))).toBe('2026-09');
  });

  it('gives a fresh quota when the month rolls over', () => {
    const store = reader(0);
    const counter = createMonthlyQuotaCounter({ reader: store });

    for (let i = 0; i < 1_000; i += 1) counter.consume(ACCOUNT, '2026-08', 0);
    expect(counter.used(ACCOUNT, '2026-08', 0)).toBe(1_000);
    expect(counter.used(ACCOUNT, '2026-09', 0)).toBe(0);
  });
});
