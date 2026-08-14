import type { AccountPlan } from '../keys/apiKeyStore.js';
import { OVERAGE_BILL_CAP_MULTIPLE } from '../quota/planLimits.js';
import type { UsageRollupRow } from '../usage/usageStore.js';
import { BILLING_CURRENCY, floorDiv, formatMinor, roundHalfUpDiv } from './money.js';
import type { PriceBook } from './priceBook.js';
import {
  accruesCharges,
  mergeAdjacent,
  monthDurationMs,
  servesTraffic,
  type MonthSegment,
} from './subscription.js';
import {
  BASIS_POINTS_PER_UNIT,
  formatRate,
  resolveVatTreatment,
  type CustomerTaxProfile,
  type SupplierTaxProfile,
  type VatTreatment,
} from './vat.js';

/**
 * Turn a closed month of metered usage into the invoice we *would* raise.
 *
 * Pure, and the only input that is not a plain value is the price book. It reads
 * `usage_rollup` rows and never `usage_events`, which is the rule ABL-297 §9(2)
 * fixes and `usageCli.ts` already follows: the raw rows are deleted at 13 months
 * and an invoice must be defensible for seven years, so an invoice recomputed
 * from events would work perfectly for a year and then start returning zero for
 * exactly the months somebody is disputing.
 *
 * ## Nothing here issues anything
 *
 * Every document this module produces carries `mode: 'test'` and
 * {@link NOT_FOR_ISSUE}, and there is no code path that removes either. ABL-349
 * is an open pre-launch gate — no subscriber terms are published and no API key
 * is issued outside Able Energy — and this issue does not touch it. What the
 * module is for is the arithmetic: that the mapping from a metered request to a
 * billed euro is written down, tested, and reconcilable, so that when the gate
 * does open the only new thing is a payment provider.
 *
 * ## The one thing the rollup cannot tell us
 *
 * `usage_rollup` holds a month's totals per (account, key), not a distribution
 * over time. When a subscription changed plan mid-month, the overage requests
 * therefore cannot be attributed to the plan that was in effect when they were
 * served — the data to do it lives in `usage_events`, which is the table an
 * invoice may not depend on. This module does not guess: it prices the overage at
 * the **cheapest applicable rate** and records a blocker so a person decides. See
 * {@link resolveOverageRate}.
 */

/** Stamped on every document. There is no branch that omits it. */
export const NOT_FOR_ISSUE =
  'TEST MODE — DRAFT ONLY. Not a VAT invoice, not payable, and not to be sent to any party. ' +
  'ABL-349 (pre-launch gate) is open: subscriber terms are unpublished and no live payment ' +
  'provider is configured.';

export interface InvoiceLine {
  kind: 'subscription' | 'overage';
  description: string;
  /** Inclusive / exclusive ISO 8601 UTC, so a prorated line says what it covers. */
  periodFrom: string;
  periodTo: string;
  /** Months for a subscription line, thousands of requests for an overage line. */
  quantity: number;
  unit: string;
  unitPriceMinor: number;
  netMinor: number;
}

/** What the month metered, before any pricing decision touched it. */
export interface InvoiceUsage {
  /** `usage_rollup.requests`, summed over the account's keys. Not the billed figure. */
  requests: number;
  /** `usage_rollup.billable_requests`. **This is the number the invoice is raised on.** */
  billableRequests: number;
  /** Requests included in the base fee, prorated across the month's segments. */
  includedRequests: number | null;
  /** Billable requests past the allowance. */
  overageRequests: number;
  /** Of those, the ones actually charged for — whole thousands only. */
  billedOverageThousands: number;
  /**
   * Metered, arrived after the month closed, and never billed.
   *
   * Carried onto the invoice rather than left in the store, because it is the
   * one *quantified* under-count in the chain and the reconciliation report
   * needs somewhere honest to read it from.
   */
  lateRequests: number;
  lateBillableRequests: number;
  /** Rows served. Not a billing dimension; kept for reconciliation colour. */
  rowsReturned: number;
  /** Every key-month row is closed. An open month's figures can still change. */
  monthClosed: boolean;
  keyMonths: number;
}

export interface Invoice {
  mode: 'test';
  notice: string;
  accountId: string;
  yearMonth: string;
  currency: typeof BILLING_CURRENCY;
  /** Which price list produced this, and when it took effect. */
  priceBookFingerprint: string;
  priceBookEffectiveFrom: string;
  lines: InvoiceLine[];
  usage: InvoiceUsage;
  netMinor: number;
  vat: VatTreatment;
  vatMinor: number;
  grossMinor: number;
  /**
   * Conditions under which this arithmetic is not defensible. Non-empty means a
   * person decides before anything downstream treats the figure as final.
   */
  blockers: string[];
  /** True but worth reading: a bound that bound, a state that served traffic. */
  warnings: string[];
  builtAt: string;
}

export interface BuildInvoiceInput {
  accountId: string;
  /** `YYYY-MM`, UTC. */
  yearMonth: string;
  /** Every `usage_rollup` row for this account and month, across all its keys. */
  rollupRows: readonly UsageRollupRow[];
  /** From `segmentsForMonth`; merged here, so an unmerged list is fine. */
  segments: readonly MonthSegment[];
  priceBook: PriceBook;
  supplier: SupplierTaxProfile;
  customer: CustomerTaxProfile;
  now: Date;
}

export function buildInvoice({
  accountId,
  yearMonth,
  rollupRows,
  segments,
  priceBook,
  supplier,
  customer,
  now,
}: BuildInvoiceInput): Invoice {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const rows = rollupRows.filter((row) => row.accountId === accountId && row.yearMonth === yearMonth);
  const monthMs = monthDurationMs(yearMonth);
  const charging = mergeAdjacent(segments);

  /*
   * 1. What the month metered.
   */
  const requests = sum(rows, (row) => row.requests);
  const billableRequests = sum(rows, (row) => row.billableRequests);
  const lateRequests = sum(rows, (row) => row.lateRequests);
  const lateBillableRequests = sum(rows, (row) => row.lateBillableRequests);
  const rowsReturned = sum(rows, (row) => row.rowsReturned);
  const monthClosed = rows.length > 0 && rows.every((row) => row.closedAt !== null);

  if (rows.length === 0) {
    warnings.push(
      `No usage_rollup rows for ${accountId} in ${yearMonth}. That is a zero-usage month or a ` +
        'rollup that has not run — usage:stats says which, and the two are not the same fact.'
    );
  } else if (!monthClosed) {
    blockers.push(
      `${yearMonth} is not closed, so these figures can still change. Close it with ` +
        '`npm run usage -- usage:close-months` before treating this as final.'
    );
  }

  if (lateBillableRequests > 0) {
    warnings.push(
      `${lateBillableRequests} billable requests arrived for ${yearMonth} after it closed and ` +
        'are not on this invoice. That is the designed direction (ABL-301: never re-raise an ' +
        'invoice a customer has received), and it is an under-count of exactly that size.'
    );
  }

  /*
   * 2. Subscription lines, one per stretch of the month with an unchanged plan
   *    and status, prorated by exact duration.
   */
  const lines: InvoiceLine[] = [];
  let includedRequests: number | null = 0;
  const chargingPlans = new Set<AccountPlan>();

  for (const segment of charging) {
    if (segment.plan === null || segment.status === null) {
      if (segmentHadTraffic(rows, segment)) {
        blockers.push(
          `Traffic was metered between ${segment.fromIso} and ${segment.toIso}, when ${accountId} ` +
            'had no subscription at all. Nothing is charged for it. Either the subscription ' +
            'history is missing a change, or a key was live for an account that was never ' +
            'subscribed.'
        );
      }
      continue;
    }

    if (!accruesCharges(segment.status)) {
      if (!servesTraffic(segment.status) && segmentHadTraffic(rows, segment)) {
        blockers.push(
          `Traffic was metered between ${segment.fromIso} and ${segment.toIso}, when ` +
            `${accountId} was ${segment.status}. Nothing is charged for it — we do not bill for ` +
            'service we had said was stopped — but the gate served an account billing believes ' +
            'was off. Reconcile the key state.'
        );
      }
      continue;
    }

    chargingPlans.add(segment.plan);
    const pricing = priceBook.plans[segment.plan];

    // Prorated by exact elapsed milliseconds, not by whole days. A month is not
    // 30 days, a change does not land at midnight, and the segments' durations
    // sum to exactly the month (asserted in `subscription.test.ts`) — so a whole
    // month on one plan prices at exactly the plan fee, with no remainder to
    // explain.
    const netMinor = floorDiv(pricing.baseMinor, segment.durationMs, monthMs);
    const wholeMonth = segment.durationMs === monthMs;

    lines.push({
      kind: 'subscription',
      description: wholeMonth
        ? `${titleCase(segment.plan)} plan — ${yearMonth}`
        : `${titleCase(segment.plan)} plan — ${yearMonth}, ${describeFraction(segment.durationMs, monthMs)}`,
      periodFrom: segment.fromIso,
      periodTo: segment.toIso,
      quantity: 1,
      unit: wholeMonth ? 'month' : 'part month',
      unitPriceMinor: pricing.baseMinor,
      netMinor,
    });

    // The allowance prorates the same way and by the same rule, so that "what
    // you paid for" and "what you may use" cannot come apart. `null` is
    // Enterprise, whose quota is negotiated rather than tabulated — one such
    // segment makes the month's allowance unknowable rather than partial.
    if (pricing.includedRequests === null) {
      includedRequests = null;
    } else if (includedRequests !== null) {
      includedRequests += floorDiv(pricing.includedRequests, segment.durationMs, monthMs);
    }
  }

  if (includedRequests === null) {
    blockers.push(
      `${accountId} was on a plan with a negotiated quota during ${yearMonth}, so the included ` +
        'allowance is not in the price book and the overage cannot be computed from a table. ' +
        'That invoice is written by hand against the contract.'
    );
  }

  /*
   * 3. Overage.
   */
  const baseNetMinor = sum(lines, (line) => line.netMinor);
  const overageRequests =
    includedRequests === null ? 0 : Math.max(0, billableRequests - includedRequests);

  let billedOverageThousands = 0;

  if (overageRequests > 0) {
    const rate = resolveOverageRate(chargingPlans, priceBook, blockers, warnings, accountId);

    if (rate === null) {
      // Every plan in effect hard-stops at quota, so this traffic should never
      // have been served. Charging for it would bill a customer for the failure
      // of a control we told them about; the finding is the point.
      blockers.push(
        `${overageRequests.toLocaleString('en-GB')} billable requests were served past the ` +
          `allowance of ${(includedRequests ?? 0).toLocaleString('en-GB')} on a plan that ` +
          'hard-stops at quota. They are NOT charged. This is a quota-gate leak, not a billing ' +
          'question: ABL-302 should have answered 429. Investigate before the next month closes.'
      );
    } else {
      // Whole thousands only. `planLimits.softOverage()` sizes the serve ceiling
      // with the same floor and for the same stated reason — a partial thousand
      // is not billable — so the ceiling and the charge round the same way.
      billedOverageThousands = Math.floor(overageRequests / 1000);

      const uncappedMinor = billedOverageThousands * rate.perThousandMinor;

      // The published cap: overage is capped at (multiple − 1) × the plan fee for
      // the month. Against the *prorated* fee, because a customer who was on the
      // plan for half the month bought half a month's headroom.
      const capMinor = baseNetMinor * (OVERAGE_BILL_CAP_MULTIPLE - 1);
      const netMinor = Math.min(uncappedMinor, capMinor);

      if (netMinor < uncappedMinor) {
        warnings.push(
          `Overage was capped at ${formatMinor(capMinor)} ${BILLING_CURRENCY} ` +
            `(${OVERAGE_BILL_CAP_MULTIPLE}× the plan fee for the month); the metered overage ` +
            `priced at ${formatMinor(uncappedMinor)}. The cap binding means more requests were ` +
            'served than the ABL-302 ceiling allows — the ceiling is derived from this same cap, ' +
            'so in a correct month it is unreachable. Check the gate.'
        );
      }

      if (netMinor > 0 || billedOverageThousands > 0) {
        lines.push({
          kind: 'overage',
          description:
            `${rate.plan} overage — ${overageRequests.toLocaleString('en-GB')} requests past ` +
            `${(includedRequests ?? 0).toLocaleString('en-GB')} included, charged as ` +
            `${billedOverageThousands.toLocaleString('en-GB')} whole thousands`,
          periodFrom: charging[0]?.fromIso ?? '',
          periodTo: charging[charging.length - 1]?.toIso ?? '',
          quantity: billedOverageThousands,
          unit: '1,000 requests',
          unitPriceMinor: rate.perThousandMinor,
          netMinor,
        });
      }
    }
  }

  /*
   * 4. VAT and totals.
   */
  const netMinor = sum(lines, (line) => line.netMinor);
  const vat = resolveVatTreatment(supplier, customer);
  const vatMinor = roundHalfUpDiv(netMinor, vat.rateBasisPoints, BASIS_POINTS_PER_UNIT);

  if (vat.kind === 'oss_destination' && !supplier.ossRegistered) {
    blockers.push(
      `VAT at ${formatRate(vat.rateBasisPoints)} is due in ${vat.rateCountry}, and the supplier ` +
        'is not registered for the One Stop Shop. There is no return to declare it on.'
    );
  }
  if (!vat.rates.verified) {
    warnings.push(
      `VAT rates are the unverified reference table of ${vat.rates.asOf}. No invoice may be ` +
        'issued on them until counsel has signed the table off (ABL-349).'
    );
  }

  return {
    mode: 'test',
    notice: NOT_FOR_ISSUE,
    accountId,
    yearMonth,
    currency: BILLING_CURRENCY,
    priceBookFingerprint: priceBook.fingerprint,
    priceBookEffectiveFrom: priceBook.effectiveFrom,
    lines,
    usage: {
      requests,
      billableRequests,
      includedRequests,
      overageRequests,
      billedOverageThousands,
      lateRequests,
      lateBillableRequests,
      rowsReturned,
      monthClosed,
      keyMonths: rows.length,
    },
    netMinor,
    vat,
    vatMinor,
    grossMinor: netMinor + vatMinor,
    blockers,
    warnings,
    builtAt: now.toISOString(),
  };
}

interface OverageRate {
  plan: string;
  perThousandMinor: number;
}

/**
 * Which rate the month's overage is charged at.
 *
 * One charging plan is the ordinary case and is unambiguous. More than one is
 * the case the rollup cannot resolve: it holds a month's totals, not a
 * distribution over time, so there is no way to say which of the overage
 * requests were served while which plan was in effect. Attributing them to the
 * plan in effect at month end would be a guess that happens to favour whichever
 * direction the customer moved.
 *
 * So the cheapest rate is used and a blocker is recorded. Cheapest because it is
 * the direction every other rounding decision in this module takes, and a
 * blocker because a guess that is only *probably* right does not belong on an
 * invoice unread. Resolving it properly means attributing requests to segments,
 * which needs `usage_events` — the table an invoice may not depend on — or a
 * rollup keyed by subscription segment, which is a schema change and a separate
 * issue.
 *
 * Returns `null` when no plan in effect can overage at all.
 */
function resolveOverageRate(
  plans: ReadonlySet<AccountPlan>,
  priceBook: PriceBook,
  blockers: string[],
  warnings: string[],
  accountId: string
): OverageRate | null {
  const rates = [...plans]
    .map((plan) => ({ plan, perThousandMinor: priceBook.plans[plan].overagePerThousandMinor }))
    .filter((entry): entry is { plan: AccountPlan; perThousandMinor: number } =>
      entry.perThousandMinor !== null
    );

  if (rates.length === 0) return null;

  const cheapest = rates.reduce((best, entry) =>
    entry.perThousandMinor < best.perThousandMinor ? entry : best
  );

  if (plans.size > 1) {
    blockers.push(
      `${accountId} changed plan during the month (${[...plans].join(' → ')}) and has overage. ` +
        'usage_rollup holds monthly totals, not a distribution over time, so the overage ' +
        `requests cannot be attributed to a plan. Charged at the cheapest rate in effect ` +
        `(${cheapest.plan}, ${formatMinor(cheapest.perThousandMinor)} ${BILLING_CURRENCY} per ` +
        '1,000). Confirm or price by hand.'
    );
  } else if (rates.length < plans.size) {
    warnings.push(
      `Some plans in effect for ${accountId} hard-stop at quota and priced no overage; the ` +
        `${cheapest.plan} rate was used for all of it.`
    );
  }

  return cheapest;
}

/**
 * Whether any metered traffic falls inside a segment.
 *
 * Approximate on purpose, and the approximation is stated because it decides
 * whether a blocker fires. `usage_rollup` records only the first and last event
 * of a key-month, so this asks whether that window *overlaps* the segment — it
 * cannot tell whether a specific request landed inside one. It over-reports:
 * a key with one event on the 2nd and one on the 30th looks like traffic in
 * every segment between. That direction is right for a control whose output is
 * "a person should look at this".
 */
function segmentHadTraffic(rows: readonly UsageRollupRow[], segment: MonthSegment): boolean {
  return rows.some(
    (row) =>
      row.requests > 0 && row.firstEventAt < segment.toIso && row.lastEventAt >= segment.fromIso
  );
}

function sum<T>(items: readonly T[], of: (item: T) => number): number {
  return items.reduce((total, item) => total + of(item), 0);
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** `13 days 6 hours of 31 days`, for a prorated line a human has to check. */
function describeFraction(durationMs: number, monthMs: number): string {
  const days = durationMs / 86_400_000;
  const monthDays = monthMs / 86_400_000;
  const rendered = Number.isInteger(days) ? String(days) : days.toFixed(2);
  return `${rendered} of ${monthDays} days`;
}
