import type { AccountPlan } from '../keys/apiKeyStore.js';
import type { UsageRollupRow } from '../usage/usageStore.js';
import type { Invoice } from './invoice.js';

/**
 * **The acceptance bar for ABL-307: what we metered against what we would bill,
 * demonstrably.**
 *
 * Three numbers exist for one month's traffic and they are produced by three
 * different mechanisms:
 *
 * 1. `usage_events` — one row per authenticated request, written by a buffered
 *    meter, deleted at 13 months.
 * 2. `usage_rollup` — a materialised aggregate, advanced by a watermarked job,
 *    retained for seven years. **The invoice is raised from this one.**
 * 3. The invoice — the rollup, priced.
 *
 * This module states the identity that must hold between them, evaluates it, and
 * — the part that matters — **attributes every difference to a named cause**. A
 * reconciliation that reports a delta and stops is a reconciliation nobody can
 * act on: the interesting question is never *are they different*, it is *is the
 * difference one of the three we designed in, or a fourth we did not*.
 *
 * ## The identity
 *
 * Every metered request for month M lands in exactly one place:
 *
 * ```
 * events.billable(M) = rollup.billable(M)        // aggregated, and invoiced
 *                    + rollup.lateBillable(M)    // aggregated after close, never invoiced
 *                    + unrolled.billable(M)      // metered, not yet aggregated
 * ```
 *
 * Each right-hand term is a designed behaviour with a reason recorded in
 * ABL-301, and each is reported separately rather than netted off. What is left
 * over after all three is {@link DiscrepancyKind}`.unexplained`, and that is the
 * only line in this report that means a defect.
 *
 * ## The under-count that is not in the identity, and is reported anyway
 *
 * The meter buffers and flushes on a timer, so a hard kill loses at most one
 * flush interval of one process's traffic. That is deliberate — ABL-301 rejected
 * a synchronous fsync per request — and it always errs downward.
 *
 * It is also **not observable from the store**: the lost events never reached
 * `usage_events`, so no query over the three tables can see the hole, and the
 * meter's own counters (`UsageMeterStats.dropped`, `.failedFlushes`) live in
 * process memory and die with the process that would have reported them.
 *
 * So {@link ReconciliationReport.meterLossWindow} states the bound and says
 * plainly that it is unmeasured. The alternative — omitting it because there is
 * no number — would let a report reading "0 discrepancies" be mistaken for "we
 * billed for every request served", which is a stronger claim than this system
 * can make. Making the bound visible is the requirement; closing it would mean
 * changing ABL-301's design decision, which is not this issue's to reverse.
 */

/**
 * The meter's flush interval, restated rather than imported.
 *
 * `usageMeter.DEFAULT_FLUSH_INTERVAL_MS` is the source of this number and the
 * two must agree — `reconciliation.test.ts` asserts they do, by reading the
 * meter's value there rather than here. Importing it would put `express` and the
 * whole request-path middleware into the graph of an operator tool, which is the
 * argument `usageCli.ts` makes for duplicating eight lines of argument parsing
 * rather than importing them from `keysCli.ts`. One constant with a test holding
 * it to its source is the cheaper of the two.
 */
export const METER_FLUSH_INTERVAL_MS = 1_000;

export type DiscrepancyKind =
  /** Metered, not yet aggregated. Fixed by running the rollup; the invoice is short until then. */
  | 'unrolled'
  /** Aggregated after the month closed. Never billed, by design. */
  | 'late'
  /** The raw events are gone, so the rollup cannot be corroborated at all. */
  | 'not_corroborable'
  /** The rollup and the invoice disagree. Always a defect: the invoice is the rollup, priced. */
  | 'invoice_vs_rollup'
  /** Everything above accounted for and a difference remains. **The only alarming one.** */
  | 'unexplained';

export interface Discrepancy {
  kind: DiscrepancyKind;
  accountId: string | null;
  /** Signed, in requests. Positive means the events hold more than the rollup does. */
  requests: number;
  detail: string;
  /** Whether this one should stop an invoice run. */
  blocking: boolean;
}

/**
 * What `usage_events` still says about a month, recomputed from the raw rows.
 *
 * `corroborable: false` is the honest answer for a month whose events retention
 * has deleted — the rollup rows survive for seven years and the events do not,
 * which is exactly the lifecycle ABL-297 §9(2) asked for. Reporting zero
 * discrepancies for such a month would be reporting a check that did not run.
 */
export interface EventCorroboration {
  corroborable: boolean;
  /** Why not, when `corroborable` is false. */
  reason: string | null;
  requests: number;
  billableRequests: number;
  /** Of the above, those above the rollup watermark. */
  unrolledRequests: number;
  unrolledBillableRequests: number;
  /** Per account, so a discrepancy can be attributed to one customer. */
  byAccount: ReadonlyMap<string, { requests: number; billableRequests: number }>;
}

/** The gate's copy of a plan against billing's, for one account. */
export interface PlanDivergence {
  accountId: string;
  /** `accounts.plan` — what ABL-302 gated the traffic with. */
  servedAs: AccountPlan | null;
  /** The subscription history's state at month end — what the invoice priced. */
  billedAs: AccountPlan | null;
}

export interface MeterLossWindow {
  /** Milliseconds of traffic one process can lose on a hard kill. */
  boundMs: number;
  measured: false;
  note: string;
}

export interface AccountReconciliation {
  accountId: string;
  /** `usage_rollup.billable_requests`. What the invoice should have charged on. */
  rollupBillableRequests: number;
  /** What the invoice says it charged on. Must equal the above, exactly. */
  invoicedBillableRequests: number | null;
  /** From `usage_events`, when corroborable. */
  eventBillableRequests: number | null;
  lateBillableRequests: number;
  netMinor: number | null;
  blockers: number;
  ok: boolean;
}

export interface ReconciliationReport {
  yearMonth: string;
  builtAt: string;
  /** False when any blocking discrepancy was found. */
  ok: boolean;
  events: EventCorroboration;
  rollup: {
    requests: number;
    billableRequests: number;
    lateRequests: number;
    lateBillableRequests: number;
    keyMonths: number;
    openKeyMonths: number;
  };
  invoiced: {
    accounts: number;
    billableRequests: number;
    netMinor: number;
    vatMinor: number;
    grossMinor: number;
    withBlockers: number;
  };
  discrepancies: Discrepancy[];
  planDivergences: PlanDivergence[];
  meterLossWindow: MeterLossWindow;
  accounts: AccountReconciliation[];
}

export interface ReconcileInput {
  yearMonth: string;
  /** Every rollup row for the month, all accounts. */
  rollupRows: readonly UsageRollupRow[];
  events: EventCorroboration;
  invoices: readonly Invoice[];
  /** `accounts.plan` per account — the gate's copy. */
  servedPlans: ReadonlyMap<string, AccountPlan>;
  /** The subscription state at month end per account — billing's copy. */
  billedPlans: ReadonlyMap<string, AccountPlan>;
  /** Injected so the report is deterministic under test. */
  flushIntervalMs?: number;
  now: Date;
}

export function reconcile({
  yearMonth,
  rollupRows,
  events,
  invoices,
  servedPlans,
  billedPlans,
  flushIntervalMs = METER_FLUSH_INTERVAL_MS,
  now,
}: ReconcileInput): ReconciliationReport {
  const rows = rollupRows.filter((row) => row.yearMonth === yearMonth);
  const discrepancies: Discrepancy[] = [];

  const rollup = {
    requests: sum(rows, (row) => row.requests),
    billableRequests: sum(rows, (row) => row.billableRequests),
    lateRequests: sum(rows, (row) => row.lateRequests),
    lateBillableRequests: sum(rows, (row) => row.lateBillableRequests),
    keyMonths: rows.length,
    openKeyMonths: rows.filter((row) => row.closedAt === null).length,
  };

  /*
   * 1. Events against the rollup, with every designed cause named before
   *    anything is called unexplained.
   */
  if (!events.corroborable) {
    discrepancies.push({
      kind: 'not_corroborable',
      accountId: null,
      requests: 0,
      detail:
        events.reason ??
        `The raw request records for ${yearMonth} are no longer held, so usage_rollup cannot be ` +
          'checked against them. The rollup rows are the seven-year record and stand on their ' +
          'own; this check simply did not run.',
      // Not blocking. A month past the events retention horizon is the designed
      // state, and refusing to invoice it would mean an invoice becomes
      // unraisable thirteen months after the traffic — the opposite of what the
      // rollup exists for.
      blocking: false,
    });
  } else {
    if (events.unrolledBillableRequests > 0) {
      discrepancies.push({
        kind: 'unrolled',
        accountId: null,
        requests: events.unrolledBillableRequests,
        detail:
          `${events.unrolledBillableRequests} billable requests for ${yearMonth} are metered but ` +
          'not aggregated, so they are missing from every figure below. Run ' +
          '`npm run usage -- usage:roll-up` and reconcile again.',
        // Blocking: this is temporary and fixable, and an invoice raised now is
        // short by exactly this much.
        blocking: true,
      });
    }

    if (rollup.lateBillableRequests > 0) {
      discrepancies.push({
        kind: 'late',
        accountId: null,
        requests: rollup.lateBillableRequests,
        detail:
          `${rollup.lateBillableRequests} billable requests arrived after ${yearMonth} closed. ` +
          'They are counted, never invoiced, and this is the designed direction: ABL-301 ' +
          'refuses to raise an invoice a customer has already received. An under-count of ' +
          'exactly this size.',
        blocking: false,
      });
    }

    // The identity. Everything designed is on the right; what is left is not.
    const accounted =
      rollup.billableRequests + rollup.lateBillableRequests + events.unrolledBillableRequests;
    const unexplained = events.billableRequests - accounted;

    if (unexplained !== 0) {
      discrepancies.push({
        kind: 'unexplained',
        accountId: null,
        requests: unexplained,
        detail:
          `usage_events holds ${events.billableRequests} billable requests for ${yearMonth}; ` +
          `usage_rollup accounts for ${accounted} (${rollup.billableRequests} billed, ` +
          `${rollup.lateBillableRequests} late, ${events.unrolledBillableRequests} unrolled). ` +
          `${Math.abs(unexplained)} ${unexplained > 0 ? 'are missing from' : 'are extra in'} the ` +
          'aggregate with no designed cause. This is a defect in the rollup, not a rounding ' +
          'question — do not invoice this month until it is explained.',
        blocking: true,
      });
    }
  }

  /*
   * 2. Invoice against rollup, per account. This one admits no tolerance: the
   *    invoice *is* the rollup, priced, so any difference is arithmetic that
   *    went wrong between two numbers in the same process.
   */
  const rollupByAccount = groupSum(rows);
  const accounts: AccountReconciliation[] = [];
  const invoiceByAccount = new Map(invoices.map((invoice) => [invoice.accountId, invoice]));

  for (const accountId of new Set([...rollupByAccount.keys(), ...invoiceByAccount.keys()])) {
    const rollupTotals = rollupByAccount.get(accountId) ?? {
      requests: 0,
      billableRequests: 0,
      lateBillableRequests: 0,
    };
    const invoice = invoiceByAccount.get(accountId) ?? null;
    const invoiced = invoice === null ? null : invoice.usage.billableRequests;

    if (invoice !== null && invoiced !== rollupTotals.billableRequests) {
      discrepancies.push({
        kind: 'invoice_vs_rollup',
        accountId,
        requests: (invoiced ?? 0) - rollupTotals.billableRequests,
        detail:
          `Invoice for ${accountId} charges on ${invoiced} billable requests; usage_rollup holds ` +
          `${rollupTotals.billableRequests}. These are the same number read twice and must never ` +
          'differ.',
        blocking: true,
      });
    }

    if (invoice === null && rollupTotals.billableRequests > 0) {
      discrepancies.push({
        kind: 'invoice_vs_rollup',
        accountId,
        requests: -rollupTotals.billableRequests,
        detail:
          `${accountId} metered ${rollupTotals.billableRequests} billable requests in ` +
          `${yearMonth} and has no invoice. Either it has no subscription recorded, or the ` +
          'invoice run skipped it.',
        blocking: true,
      });
    }

    const eventTotals = events.corroborable ? events.byAccount.get(accountId) ?? null : null;

    accounts.push({
      accountId,
      rollupBillableRequests: rollupTotals.billableRequests,
      invoicedBillableRequests: invoiced,
      eventBillableRequests: eventTotals?.billableRequests ?? null,
      lateBillableRequests: rollupTotals.lateBillableRequests,
      netMinor: invoice?.netMinor ?? null,
      blockers: invoice?.blockers.length ?? 0,
      ok:
        invoice !== null &&
        invoiced === rollupTotals.billableRequests &&
        invoice.blockers.length === 0,
    });
  }

  accounts.sort((a, b) => a.accountId.localeCompare(b.accountId));

  /*
   * 3. The two copies of a plan. Not part of the request identity, and the
   *    reason a month can reconcile perfectly and still be billed wrong.
   */
  const planDivergences: PlanDivergence[] = [];
  for (const accountId of new Set([...servedPlans.keys(), ...billedPlans.keys()])) {
    const servedAs = servedPlans.get(accountId) ?? null;
    const billedAs = billedPlans.get(accountId) ?? null;
    if (servedAs === billedAs) continue;

    planDivergences.push({ accountId, servedAs, billedAs });
    discrepancies.push({
      kind: 'unexplained',
      accountId,
      requests: 0,
      detail:
        `${accountId} is gated as ${servedAs ?? 'no plan'} (accounts.plan, what ABL-302 served ` +
        `the traffic with) and billed as ${billedAs ?? 'no plan'} (the subscription history). ` +
        'The quota enforced and the allowance charged for are from different plans.',
      blocking: true,
    });
  }

  const invoiced = {
    accounts: invoices.length,
    billableRequests: sum(invoices, (invoice) => invoice.usage.billableRequests),
    netMinor: sum(invoices, (invoice) => invoice.netMinor),
    vatMinor: sum(invoices, (invoice) => invoice.vatMinor),
    grossMinor: sum(invoices, (invoice) => invoice.grossMinor),
    withBlockers: invoices.filter((invoice) => invoice.blockers.length > 0).length,
  };

  return {
    yearMonth,
    builtAt: now.toISOString(),
    ok: discrepancies.every((d) => !d.blocking),
    events,
    rollup,
    invoiced,
    discrepancies,
    planDivergences,
    meterLossWindow: {
      boundMs: flushIntervalMs,
      measured: false,
      note:
        `The meter buffers and flushes every ${flushIntervalMs}ms, so an unclean shutdown loses ` +
        'at most that much of one process\'s traffic (ABL-301: a synchronous fsync per request ' +
        'was rejected). Those requests never reach usage_events, so no figure above can see ' +
        'them and this reconciliation cannot bound the loss for any particular month. It is ' +
        'always downward — we under-bill — and it is stated here rather than absorbed, because ' +
        '"0 discrepancies" must not be read as "we billed for every request we served".',
    },
    accounts,
  };
}

function groupSum(
  rows: readonly UsageRollupRow[]
): Map<string, { requests: number; billableRequests: number; lateBillableRequests: number }> {
  const byAccount = new Map<
    string,
    { requests: number; billableRequests: number; lateBillableRequests: number }
  >();

  for (const row of rows) {
    const entry = byAccount.get(row.accountId) ?? {
      requests: 0,
      billableRequests: 0,
      lateBillableRequests: 0,
    };
    entry.requests += row.requests;
    entry.billableRequests += row.billableRequests;
    entry.lateBillableRequests += row.lateBillableRequests;
    byAccount.set(row.accountId, entry);
  }

  return byAccount;
}

function sum<T>(items: readonly T[], of: (item: T) => number): number {
  return items.reduce((total, item) => total + of(item), 0);
}
