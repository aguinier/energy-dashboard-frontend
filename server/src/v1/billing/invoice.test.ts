import { describe, it, expect } from 'vitest';
import { ACCOUNT_PLANS } from '../keys/apiKeyStore.js';
import { MONTHLY_PRICE_EUR, PLAN_LIMITS } from '../quota/planLimits.js';
import type { UsageRollupRow } from '../usage/usageStore.js';
import { buildInvoice, NOT_FOR_ISSUE } from './invoice.js';
import { parsePriceBook, type PriceBook } from './priceBook.js';
import { monthDurationMs, segmentsForMonth, type SubscriptionChange } from './subscription.js';
import { EU_VAT_STANDARD_RATES, UNVERIFIED_VAT_ID, type CustomerTaxProfile, type SupplierTaxProfile } from './vat.js';

/**
 * The mapping from a metered request to a billed euro.
 *
 * The invariant that carries the most weight is the dullest one:
 * `invoice.usage.billableRequests` must equal the sum of the rollup's
 * `billable_requests`, always, with no arithmetic in between. It is what
 * `reconciliation.ts` checks per account and what makes the whole chain
 * auditable — the invoice is the rollup, priced, and any difference between the
 * two is two readings of one number disagreeing inside one process.
 *
 * The price book fixture is derived from `quota/planLimits.ts` for the reason
 * `priceBook.test.ts` gives: ABL-307 commits no price list, and a derived
 * fixture is the only kind that provably agrees with what the gate enforces.
 */

const YEAR_MONTH = '2026-07';
const MONTH_MS = monthDurationMs(YEAR_MONTH);

function priceBook(): PriceBook {
  return parsePriceBook(
    JSON.stringify({
      currency: 'EUR',
      effectiveFrom: '2026-08-01',
      plans: Object.fromEntries(
        ACCOUNT_PLANS.map((plan) => {
          const limits = PLAN_LIMITS[plan];
          return [
            plan,
            {
              base: MONTHLY_PRICE_EUR[plan] ?? 0,
              includedRequests: limits.monthlyRequests,
              overagePerThousand:
                limits.overage.kind === 'soft' ? limits.overage.eurPer1000Requests : null,
            },
          ];
        })
      ),
    }),
    'derived-from-planLimits.json'
  );
}

const supplier: SupplierTaxProfile = {
  country: 'DE',
  vatId: 'DE999999999',
  ossRegistered: true,
  belowUnionThreshold: false,
};

const ACCOUNT = 'acct_test';
const NOW = new Date('2026-08-03T00:00:00.000Z');

function customer(overrides: Partial<CustomerTaxProfile> = {}): CustomerTaxProfile {
  return {
    accountId: ACCOUNT,
    country: 'DE',
    customerKind: 'consumer',
    vatId: null,
    validation: UNVERIFIED_VAT_ID,
    ...overrides,
  };
}

let keySequence = 0;

function rollup(overrides: Partial<UsageRollupRow> = {}): UsageRollupRow {
  keySequence += 1;
  const requests = overrides.requests ?? overrides.billableRequests ?? 0;
  return {
    accountId: ACCOUNT,
    keyId: `key_${keySequence}`,
    yearMonth: YEAR_MONTH,
    requests,
    billableRequests: requests,
    rowsReturned: 0,
    responseBytes: 0,
    firstEventAt: `${YEAR_MONTH}-01T00:00:01.000Z`,
    lastEventAt: `${YEAR_MONTH}-31T23:59:59.000Z`,
    closedAt: '2026-08-03T00:00:00.000Z',
    lateRequests: 0,
    lateBillableRequests: 0,
    ...overrides,
  };
}

let changeSequence = 0;

function change(overrides: Partial<SubscriptionChange> = {}): SubscriptionChange {
  changeSequence += 1;
  return {
    id: `sub_chg_${changeSequence}`,
    accountId: ACCOUNT,
    effectiveAt: '2026-01-01T00:00:00.000Z',
    plan: 'developer',
    status: 'active',
    reason: null,
    recordedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function build(options: {
  rows?: UsageRollupRow[];
  changes?: SubscriptionChange[];
  customer?: CustomerTaxProfile;
  supplier?: SupplierTaxProfile;
}) {
  const changes = options.changes ?? [change()];
  return buildInvoice({
    accountId: ACCOUNT,
    yearMonth: YEAR_MONTH,
    rollupRows: options.rows ?? [],
    segments: segmentsForMonth(changes, YEAR_MONTH),
    priceBook: priceBook(),
    supplier: options.supplier ?? supplier,
    customer: options.customer ?? customer(),
    now: NOW,
  });
}

describe('the stamp', () => {
  it('is on every document, and no input removes it', () => {
    for (const rows of [[], [rollup({ requests: 10 })]]) {
      const invoice = build({ rows });
      expect(invoice.mode).toBe('test');
      expect(invoice.notice).toBe(NOT_FOR_ISSUE);
    }
  });

  it('records which price list produced it', () => {
    // An invoice that does not say which prices it used cannot be defended once
    // the price list has changed once.
    const invoice = build({ rows: [rollup({ requests: 10 })] });
    expect(invoice.priceBookFingerprint).toBe(priceBook().fingerprint);
    expect(invoice.priceBookEffectiveFrom).toBe('2026-08-01');
  });
});

describe('the reconciliation invariant', () => {
  it('charges on exactly the rollup billable sum, across every key', () => {
    const invoice = build({
      rows: [
        rollup({ requests: 100, billableRequests: 90 }),
        rollup({ requests: 250, billableRequests: 200 }),
      ],
    });

    expect(invoice.usage.billableRequests).toBe(290);
    expect(invoice.usage.requests).toBe(350);
    expect(invoice.usage.keyMonths).toBe(2);
  });

  it('ignores rows belonging to another account or another month', () => {
    const invoice = build({
      rows: [
        rollup({ requests: 10 }),
        rollup({ requests: 999, accountId: 'acct_other' }),
        rollup({ requests: 999, yearMonth: '2026-06' }),
      ],
    });
    expect(invoice.usage.billableRequests).toBe(10);
  });
});

describe('the subscription line', () => {
  it('is exactly the plan fee for a whole month on one plan', () => {
    // The property `floorDiv`'s exactness at a fraction of one buys: no
    // remainder, no cent to explain, whatever the month's length.
    const invoice = build({ rows: [rollup({ requests: 10 })] });

    expect(invoice.lines).toHaveLength(1);
    expect(invoice.lines[0].netMinor).toBe(MONTHLY_PRICE_EUR.developer! * 100);
    expect(invoice.lines[0].unit).toBe('month');
    expect(invoice.netMinor).toBe(4900);
  });

  it('prorates by exact elapsed time when the plan changes mid-month', () => {
    const upgradeAt = '2026-07-16T00:00:00.000Z';
    const invoice = build({
      rows: [rollup({ requests: 10 })],
      changes: [
        change({ plan: 'developer' }),
        change({ plan: 'professional', effectiveAt: upgradeAt }),
      ],
    });

    const firstMs = Date.parse(upgradeAt) - Date.parse('2026-07-01T00:00:00.000Z');
    const secondMs = MONTH_MS - firstMs;

    expect(invoice.lines).toHaveLength(2);
    expect(invoice.lines[0].netMinor).toBe(Math.floor((4900 * firstMs) / MONTH_MS));
    expect(invoice.lines[1].netMinor).toBe(Math.floor((24_900 * secondMs) / MONTH_MS));
    // Each rounds down, so the customer is never charged more than the sum of
    // the exact fractions.
    expect(invoice.netMinor).toBeLessThanOrEqual(
      (4900 * firstMs) / MONTH_MS + (24_900 * secondMs) / MONTH_MS
    );
  });

  it('charges nothing for a stretch with no subscription', () => {
    const invoice = build({
      rows: [],
      changes: [change({ effectiveAt: '2026-07-16T00:00:00.000Z' })],
    });

    expect(invoice.lines).toHaveLength(1);
    expect(invoice.lines[0].periodFrom).toBe('2026-07-16T00:00:00.000Z');
  });

  it('charges nothing while paused or canceled', () => {
    const invoice = build({
      rows: [],
      changes: [
        change({ plan: 'developer' }),
        change({ plan: 'developer', status: 'paused', effectiveAt: '2026-07-16T00:00:00.000Z' }),
      ],
    });

    expect(invoice.lines).toHaveLength(1);
    expect(invoice.lines[0].netMinor).toBeLessThan(4900);
  });

  it('still charges while past_due, because past_due still serves', () => {
    const invoice = build({
      rows: [rollup({ requests: 10 })],
      changes: [change({ status: 'past_due' })],
    });
    expect(invoice.netMinor).toBe(4900);
  });
});

describe('the allowance', () => {
  it('is the whole plan quota for a whole month', () => {
    const invoice = build({ rows: [rollup({ requests: 10 })] });
    expect(invoice.usage.includedRequests).toBe(PLAN_LIMITS.developer.monthlyRequests);
  });

  it('prorates by the same rule as the fee, so the two cannot come apart', () => {
    const upgradeAt = '2026-07-16T00:00:00.000Z';
    const firstMs = Date.parse(upgradeAt) - Date.parse('2026-07-01T00:00:00.000Z');
    const secondMs = MONTH_MS - firstMs;

    const invoice = build({
      rows: [rollup({ requests: 10 })],
      changes: [
        change({ plan: 'developer' }),
        change({ plan: 'professional', effectiveAt: upgradeAt }),
      ],
    });

    expect(invoice.usage.includedRequests).toBe(
      Math.floor((50_000 * firstMs) / MONTH_MS) + Math.floor((500_000 * secondMs) / MONTH_MS)
    );
  });

  it('is unknowable on a negotiated plan, and blocks rather than guessing', () => {
    const invoice = build({
      rows: [rollup({ requests: 10 })],
      changes: [change({ plan: 'enterprise' })],
    });

    expect(invoice.usage.includedRequests).toBeNull();
    expect(invoice.blockers.join('\n')).toMatch(/negotiated quota/);
  });
});

describe('overage', () => {
  it('is charged in whole thousands, rounding down', () => {
    // 1,999 requests past the allowance is one billable thousand, not two, and
    // `planLimits.softOverage()` sizes the serve ceiling with the same floor.
    const invoice = build({
      rows: [rollup({ requests: 501_999 })],
      changes: [change({ plan: 'professional' })],
    });

    expect(invoice.usage.overageRequests).toBe(1_999);
    expect(invoice.usage.billedOverageThousands).toBe(1);

    const overageLine = invoice.lines.find((line) => line.kind === 'overage');
    expect(overageLine?.netMinor).toBe(100);
    expect(invoice.netMinor).toBe(24_900 + 100);
  });

  it('is absent when usage is inside the allowance', () => {
    const invoice = build({
      rows: [rollup({ requests: 500_000 })],
      changes: [change({ plan: 'professional' })],
    });
    expect(invoice.lines.filter((line) => line.kind === 'overage')).toHaveLength(0);
    expect(invoice.usage.overageRequests).toBe(0);
  });

  it('is capped at the published multiple of the plan fee, and says the cap bound', () => {
    // The cap binding is itself a finding: the ABL-302 ceiling is derived from
    // this same cap, so in a correct month it is unreachable.
    const invoice = build({
      rows: [rollup({ requests: 800_000 })],
      changes: [change({ plan: 'professional' })],
    });

    expect(invoice.usage.overageRequests).toBe(300_000);
    const overageLine = invoice.lines.find((line) => line.kind === 'overage');
    expect(overageLine?.netMinor).toBe(24_900);
    expect(invoice.warnings.join('\n')).toMatch(/Overage was capped/);
    expect(invoice.warnings.join('\n')).toMatch(/Check the gate/);
  });

  it('caps against the PRORATED fee, because half a month buys half the headroom', () => {
    const invoice = build({
      rows: [rollup({ requests: 800_000 })],
      changes: [
        change({ plan: 'professional', effectiveAt: '2026-07-16T00:00:00.000Z' }),
      ],
    });

    const baseLine = invoice.lines.find((line) => line.kind === 'subscription');
    const overageLine = invoice.lines.find((line) => line.kind === 'overage');
    expect(overageLine?.netMinor).toBe(baseLine?.netMinor);
  });

  it('charges NOTHING past a hard stop, and reports the gate leak', () => {
    // A quota gate that let traffic through is not a billing question. Charging
    // for it would bill a customer for the failure of a control we published.
    const invoice = build({ rows: [rollup({ requests: 60_000 })] });

    expect(invoice.usage.overageRequests).toBe(10_000);
    expect(invoice.usage.billedOverageThousands).toBe(0);
    expect(invoice.lines.filter((line) => line.kind === 'overage')).toHaveLength(0);
    expect(invoice.netMinor).toBe(4900);
    expect(invoice.blockers.join('\n')).toMatch(/quota-gate leak/);
    expect(invoice.blockers.join('\n')).toMatch(/ABL-302 should have answered 429/);
  });

  it('blocks when a plan change makes attribution impossible, and takes the cheapest rate', () => {
    // usage_rollup holds monthly totals, not a distribution over time, so there
    // is no honest way to say which overage requests were served on which plan.
    // The guess would favour whichever direction the customer moved, so it is
    // refused: cheapest rate, and a person decides.
    const invoice = build({
      rows: [rollup({ requests: 400_000 })],
      changes: [
        change({ plan: 'developer' }),
        change({ plan: 'professional', effectiveAt: '2026-07-16T00:00:00.000Z' }),
      ],
    });

    expect(invoice.usage.overageRequests).toBeGreaterThan(0);
    expect(invoice.blockers.join('\n')).toMatch(/changed plan during the month/);
    expect(invoice.blockers.join('\n')).toMatch(/developer → professional/);
    expect(invoice.blockers.join('\n')).toMatch(/Charged at the cheapest rate in effect/);
  });

  it('is not charged at all when every plan in effect hard-stops', () => {
    // Two hard-stop plans, so there is no rate to fall back to and the leak is
    // the whole finding.
    const invoice = build({
      rows: [rollup({ requests: 60_000 })],
      changes: [
        change({ plan: 'explorer' }),
        change({ plan: 'developer', effectiveAt: '2026-07-16T00:00:00.000Z' }),
      ],
    });

    expect(invoice.lines.filter((line) => line.kind === 'overage')).toHaveLength(0);
    expect(invoice.blockers.join('\n')).toMatch(/quota-gate leak/);
  });

  it('blocks a negotiated plan rather than pricing it from a table', () => {
    const invoice = build({
      rows: [rollup({ requests: 600_000 })],
      changes: [
        change({ plan: 'professional' }),
        change({ plan: 'enterprise', effectiveAt: '2026-07-20T00:00:00.000Z' }),
      ],
    });

    expect(invoice.blockers.join('\n')).toMatch(/negotiated quota/);
  });
});

describe('what the month cannot promise', () => {
  it('blocks on an open month, because the figures can still change', () => {
    const invoice = build({ rows: [rollup({ requests: 10, closedAt: null })] });
    expect(invoice.usage.monthClosed).toBe(false);
    expect(invoice.blockers.join('\n')).toMatch(/is not closed/);
  });

  it('reports late requests as an under-count of exactly that size', () => {
    const invoice = build({
      rows: [rollup({ requests: 100, lateRequests: 12, lateBillableRequests: 9 })],
    });

    expect(invoice.usage.lateBillableRequests).toBe(9);
    expect(invoice.usage.billableRequests).toBe(100);
    expect(invoice.warnings.join('\n')).toMatch(/9 billable requests arrived .* after it closed/);
  });

  it('blocks when traffic was metered with no subscription at all', () => {
    const invoice = build({
      rows: [rollup({ requests: 500, firstEventAt: '2026-07-02T00:00:00.000Z' })],
      changes: [change({ effectiveAt: '2026-07-20T00:00:00.000Z' })],
    });

    expect(invoice.blockers.join('\n')).toMatch(/had no subscription at all/);
  });

  it('blocks when traffic was metered while the subscription was stopped', () => {
    const invoice = build({
      rows: [rollup({ requests: 500 })],
      changes: [
        change({ plan: 'developer' }),
        change({ plan: 'developer', status: 'paused', effectiveAt: '2026-07-10T00:00:00.000Z' }),
      ],
    });

    expect(invoice.blockers.join('\n')).toMatch(/was paused/);
    expect(invoice.blockers.join('\n')).toMatch(/gate served an account billing believes was off/);
  });

  it('warns that no month can be invoiced on unverified VAT rates', () => {
    expect(build({ rows: [rollup({ requests: 10 })] }).warnings.join('\n')).toMatch(
      /unverified reference table/
    );
  });
});

describe('VAT on the totals', () => {
  it('applies the domestic rate to the net', () => {
    const invoice = build({ rows: [rollup({ requests: 10 })] });
    expect(invoice.vat.kind).toBe('domestic');
    expect(invoice.vatMinor).toBe(931); // 19% of €49.00
    expect(invoice.grossMinor).toBe(4900 + 931);
  });

  it('zero-rates a validated cross-border business and carries the legend', () => {
    const invoice = build({
      rows: [rollup({ requests: 10 })],
      customer: customer({
        country: 'FR',
        customerKind: 'business',
        vatId: 'FR12345678901',
        validation: {
          status: 'validated',
          checkedAt: '2026-07-01T00:00:00.000Z',
          source: 'vies',
          reference: 'X1',
        },
      }),
    });

    expect(invoice.vat.kind).toBe('reverse_charge');
    expect(invoice.vatMinor).toBe(0);
    expect(invoice.grossMinor).toBe(invoice.netMinor);
    expect(invoice.vat.legend).toContain('Article 196');
  });

  it('charges destination VAT to an unvalidated business, which is every account today', () => {
    const invoice = build({
      rows: [rollup({ requests: 10 })],
      customer: customer({ country: 'FR', customerKind: 'business', vatId: 'FR12345678901' }),
    });

    expect(invoice.vat.kind).toBe('oss_destination');
    expect(invoice.vatMinor).toBe(980); // 20% of €49.00
    expect(invoice.vat.rateBasisPoints).toBe(EU_VAT_STANDARD_RATES.FR);
  });

  it('blocks a destination supply the supplier cannot declare', () => {
    const invoice = build({
      rows: [rollup({ requests: 10 })],
      supplier: { ...supplier, ossRegistered: false },
      customer: customer({ country: 'FR' }),
    });

    expect(invoice.blockers.join('\n')).toMatch(/not registered for the One Stop Shop/);
  });
});
