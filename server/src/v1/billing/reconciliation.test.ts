import { describe, it, expect } from 'vitest';
import { DEFAULT_FLUSH_INTERVAL_MS } from '../usage/usageMeter.js';
import type { UsageRollupRow } from '../usage/usageStore.js';
import type { Invoice } from './invoice.js';
import { NOT_FOR_ISSUE } from './invoice.js';
import {
  METER_FLUSH_INTERVAL_MS,
  reconcile,
  type EventCorroboration,
} from './reconciliation.js';
import { VAT_RATES_PROVENANCE } from './vat.js';

/**
 * Every difference between the three numbers, attributed.
 *
 * The design claim under test is not "the totals match" — they routinely will
 * not, and three of the reasons are deliberate. It is that a difference is
 * either **named** (unrolled, late, retention-pruned) or **blocking**, and that
 * nothing falls between the two. A reconciliation that netted a designed
 * under-count against an undetected defect would report zero and be worse than
 * no reconciliation at all.
 */

const YEAR_MONTH = '2026-07';
const NOW = new Date('2026-08-03T00:00:00.000Z');

let keySequence = 0;

function rollup(overrides: Partial<UsageRollupRow> = {}): UsageRollupRow {
  keySequence += 1;
  const requests = overrides.requests ?? overrides.billableRequests ?? 0;
  return {
    accountId: 'acct_a',
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

/** A real `Invoice`, minimal but structurally complete — no casts. */
function invoice(accountId: string, billableRequests: number, blockers: string[] = []): Invoice {
  return {
    mode: 'test',
    notice: NOT_FOR_ISSUE,
    accountId,
    yearMonth: YEAR_MONTH,
    currency: 'EUR',
    priceBookFingerprint: 'fixture',
    priceBookEffectiveFrom: '2026-08-01',
    lines: [],
    usage: {
      requests: billableRequests,
      billableRequests,
      includedRequests: 50_000,
      overageRequests: 0,
      billedOverageThousands: 0,
      lateRequests: 0,
      lateBillableRequests: 0,
      rowsReturned: 0,
      monthClosed: true,
      keyMonths: 1,
    },
    netMinor: 4900,
    vat: {
      kind: 'domestic',
      rateBasisPoints: 1900,
      rateCountry: 'DE',
      legend: null,
      notes: [],
      rates: VAT_RATES_PROVENANCE,
    },
    vatMinor: 931,
    grossMinor: 5831,
    blockers,
    warnings: [],
    builtAt: NOW.toISOString(),
  };
}

function events(overrides: Partial<EventCorroboration> = {}): EventCorroboration {
  return {
    corroborable: true,
    reason: null,
    requests: 0,
    billableRequests: 0,
    unrolledRequests: 0,
    unrolledBillableRequests: 0,
    byAccount: new Map(),
    ...overrides,
  };
}

function run(input: {
  rollupRows?: UsageRollupRow[];
  events?: EventCorroboration;
  invoices?: Invoice[];
  servedPlans?: Map<string, 'explorer' | 'developer' | 'professional' | 'enterprise'>;
  billedPlans?: Map<string, 'explorer' | 'developer' | 'professional' | 'enterprise'>;
}) {
  return reconcile({
    yearMonth: YEAR_MONTH,
    rollupRows: input.rollupRows ?? [],
    events: input.events ?? events(),
    invoices: input.invoices ?? [],
    servedPlans: input.servedPlans ?? new Map(),
    billedPlans: input.billedPlans ?? new Map(),
    now: NOW,
  });
}

describe('the identity holds', () => {
  it('reports no discrepancies when events, rollup and invoice agree', () => {
    const report = run({
      rollupRows: [rollup({ requests: 1000 })],
      events: events({
        requests: 1000,
        billableRequests: 1000,
        byAccount: new Map([['acct_a', { requests: 1000, billableRequests: 1000 }]]),
      }),
      invoices: [invoice('acct_a', 1000)],
    });

    expect(report.discrepancies).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.accounts[0].ok).toBe(true);
  });
});

describe('the designed differences, each named', () => {
  it('attributes un-aggregated events, and blocks because an invoice now is short', () => {
    const report = run({
      rollupRows: [rollup({ requests: 900 })],
      events: events({ requests: 1000, billableRequests: 1000, unrolledBillableRequests: 100 }),
      invoices: [invoice('acct_a', 900)],
    });

    const unrolled = report.discrepancies.find((d) => d.kind === 'unrolled');
    expect(unrolled?.requests).toBe(100);
    expect(unrolled?.blocking).toBe(true);
    expect(unrolled?.detail).toMatch(/usage:roll-up/);
    // And nothing is left over once it is accounted for.
    expect(report.discrepancies.filter((d) => d.kind === 'unexplained')).toEqual([]);
  });

  it('attributes late events, and does NOT block — never re-raise a sent invoice', () => {
    const report = run({
      rollupRows: [rollup({ requests: 900, lateRequests: 100, lateBillableRequests: 100 })],
      events: events({ requests: 1000, billableRequests: 1000 }),
      invoices: [invoice('acct_a', 900)],
    });

    const late = report.discrepancies.find((d) => d.kind === 'late');
    expect(late?.requests).toBe(100);
    expect(late?.blocking).toBe(false);
    expect(late?.detail).toMatch(/designed direction/);
    expect(report.ok).toBe(true);
  });

  it('reports a retention-pruned month as not corroborable rather than as zero difference', () => {
    // Reporting "0 discrepancies" here would be reporting a check that did not
    // run, on exactly the months a dispute is most likely to concern.
    const report = run({
      rollupRows: [rollup({ requests: 1000 })],
      events: events({ corroborable: false, reason: 'past the 13-month horizon' }),
      invoices: [invoice('acct_a', 1000)],
    });

    const pruned = report.discrepancies.find((d) => d.kind === 'not_corroborable');
    expect(pruned?.blocking).toBe(false);
    expect(pruned?.detail).toMatch(/past the 13-month horizon/);
    expect(report.ok).toBe(true);
    expect(report.accounts[0].eventBillableRequests).toBeNull();
  });
});

describe('the differences that mean a defect', () => {
  it('blocks on a residue that no designed cause explains', () => {
    // 1,000 metered; 900 billed, 0 late, 0 unrolled. The missing 100 have no
    // story, which is the one alarming line this report can print.
    const report = run({
      rollupRows: [rollup({ requests: 900 })],
      events: events({ requests: 1000, billableRequests: 1000 }),
      invoices: [invoice('acct_a', 900)],
    });

    const unexplained = report.discrepancies.find((d) => d.kind === 'unexplained');
    expect(unexplained?.requests).toBe(100);
    expect(unexplained?.blocking).toBe(true);
    expect(unexplained?.detail).toMatch(/no designed cause/);
    expect(report.ok).toBe(false);
  });

  it('blocks when an invoice charges on a different number than the rollup holds', () => {
    // These are the same number read twice inside one process.
    const report = run({
      rollupRows: [rollup({ requests: 1000 })],
      events: events({ requests: 1000, billableRequests: 1000 }),
      invoices: [invoice('acct_a', 999)],
    });

    const mismatch = report.discrepancies.find((d) => d.kind === 'invoice_vs_rollup');
    expect(mismatch?.accountId).toBe('acct_a');
    expect(mismatch?.blocking).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('blocks when an account metered traffic and got no invoice at all', () => {
    const report = run({
      rollupRows: [rollup({ requests: 1000 })],
      events: events({ requests: 1000, billableRequests: 1000 }),
      invoices: [],
    });

    expect(report.discrepancies.some((d) => d.detail.includes('has no invoice'))).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('blocks when the plan the gate served differs from the plan billing priced', () => {
    // A month can reconcile perfectly on request counts and still be billed
    // wrong: the quota enforced and the allowance charged for are two copies.
    const report = run({
      servedPlans: new Map([['acct_a', 'professional']]),
      billedPlans: new Map([['acct_a', 'developer']]),
    });

    expect(report.planDivergences).toEqual([
      { accountId: 'acct_a', servedAs: 'professional', billedAs: 'developer' },
    ]);
    expect(report.ok).toBe(false);
  });

  it('does not flag an account whose two copies agree', () => {
    const report = run({
      servedPlans: new Map([['acct_a', 'developer']]),
      billedPlans: new Map([['acct_a', 'developer']]),
    });
    expect(report.planDivergences).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe('the meter loss window', () => {
  it('is always reported, and always says it is unmeasured', () => {
    // The requirement ABL-307 states in terms: the designed under-count must be
    // visible rather than silently absorbed. "0 discrepancies" must not be read
    // as "we billed for every request we served".
    const report = run({});
    expect(report.meterLossWindow.measured).toBe(false);
    expect(report.meterLossWindow.boundMs).toBe(METER_FLUSH_INTERVAL_MS);
    expect(report.meterLossWindow.note).toMatch(/never reach usage_events/);
    expect(report.meterLossWindow.note).toMatch(/under-bill/);
  });

  it('states the same interval the meter actually flushes on', () => {
    // `reconciliation.ts` restates this constant rather than importing it, to
    // keep `express` out of an operator tool's graph. This is the line that
    // holds the copy to its source; if the meter's default changes, it fails
    // here rather than in a report that quietly quotes the old number.
    expect(METER_FLUSH_INTERVAL_MS).toBe(DEFAULT_FLUSH_INTERVAL_MS);
  });
});

describe('scoping', () => {
  it('ignores rollup rows from another month', () => {
    const report = run({
      rollupRows: [rollup({ requests: 10 }), rollup({ requests: 999, yearMonth: '2026-06' })],
      events: events({ requests: 10, billableRequests: 10 }),
      invoices: [invoice('acct_a', 10)],
    });
    expect(report.rollup.billableRequests).toBe(10);
    expect(report.ok).toBe(true);
  });

  it('sums a month across every key and reports open key-months', () => {
    const report = run({
      rollupRows: [
        rollup({ requests: 10 }),
        rollup({ requests: 20, closedAt: null }),
        rollup({ requests: 30, accountId: 'acct_b' }),
      ],
      events: events({ requests: 60, billableRequests: 60 }),
      invoices: [invoice('acct_a', 30), invoice('acct_b', 30)],
    });

    expect(report.rollup.keyMonths).toBe(3);
    expect(report.rollup.openKeyMonths).toBe(1);
    expect(report.accounts.map((a) => a.accountId)).toEqual(['acct_a', 'acct_b']);
    expect(report.ok).toBe(true);
  });
});
