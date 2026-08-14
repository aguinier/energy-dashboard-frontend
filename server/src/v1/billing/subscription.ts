import type { AccountPlan } from '../keys/apiKeyStore.js';
import { monthEndExclusive } from '../usage/usageStore.js';

/**
 * What plan an account was on, and in what state, at every instant of a billing
 * month.
 *
 * Types and pure functions only — nothing here reaches a database driver, so
 * `invoice.ts` and `reconciliation.ts` can name these without pulling
 * `better-sqlite3` into their graphs, exactly as `usageStore.ts` stands to
 * `sqliteUsageStore.ts`.
 *
 * ## Why the model is a history and not a column
 *
 * The obvious shape is `accounts.plan`, which already exists (ABL-300) and is
 * what the request path reads. It answers "what may this key do *now*", which is
 * the only question a gate has. It cannot answer the question an invoice asks —
 * *what was this account entitled to on the 14th?* — because an upgrade
 * overwrites it, and an invoice raised after an upgrade would charge the whole of
 * the previous month at the new plan's price and allowance.
 *
 * So subscription state is an **append-only sequence of changes**, each with the
 * instant it took effect, and the state at any time is the latest change at or
 * before it. That makes an upgrade a row rather than an `UPDATE`, makes a
 * back-dated correction expressible without destroying what was billed, and makes
 * {@link segmentsForMonth} a pure function of recorded facts.
 *
 * `accounts.plan` remains the gate's copy and is not replaced here. The two are
 * expected to agree about *now*, and `reconciliation.ts` checks that they do —
 * an account the gate is serving as `professional` while billing believes it is
 * `developer` is a divergence that shows up as either an unbillable overage or a
 * quota the customer paid for and cannot use.
 *
 * ## Trials
 *
 * There is deliberately no `trialing` status. A trial is an ordinary
 * subscription on a plan whose price book entry has a `base` of `0`, which
 * needs no new concept, no new branch in the invoice arithmetic, and no second
 * definition of what a trial includes. A status that suppressed a fee would put
 * a commercial rule in a state machine, where the price book cannot see it.
 */

/**
 * The states a subscription can be in.
 *
 * Four, and each one answers a different pair of questions — *does traffic get
 * served?* and *does a charge accrue?* — which is why {@link servesTraffic} and
 * {@link accruesCharges} are separate predicates rather than one `isActive`.
 */
export const SUBSCRIPTION_STATUSES = ['active', 'past_due', 'paused', 'canceled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * Whether traffic is expected while in this state.
 *
 * `past_due` serves. That is not leniency, it is ABL-297 §6.5: *suspension is
 * never fully automated.* An unpaid invoice is a conversation, and a subscriber
 * whose integration stops at midnight because a card expired learns about it
 * from their own outage. Suspension is `paused`, and something with a person
 * behind it sets that.
 *
 * Traffic recorded against a state that returns `false` here is not billed — we
 * do not charge for service we had said was off — and is reported by
 * `reconciliation.ts`, because it means the gate served an account that billing
 * believes is stopped.
 */
export function servesTraffic(status: SubscriptionStatus): boolean {
  return status === 'active' || status === 'past_due';
}

/**
 * Whether a base fee and a request allowance accrue while in this state.
 *
 * Identical to {@link servesTraffic} today, and kept separate anyway: the two
 * answer different questions and the first plausible change to either — a paid
 * pause that keeps a customer's keys alive, a grace period that serves without
 * charging — moves one and not the other. Collapsing them now would mean
 * discovering at that point which of the call sites meant which.
 */
export function accruesCharges(status: SubscriptionStatus): boolean {
  return servesTraffic(status);
}

/**
 * One recorded transition. Append-only: nothing updates or deletes one of these.
 *
 * `effectiveAt` is when the change *applies*, `recordedAt` is when we learned of
 * it, and they are different fields because they are different facts. A
 * downgrade agreed on the 20th and effective on the 1st of the next month has an
 * `effectiveAt` in the future; a correction entered after an invoice was raised
 * has an `effectiveAt` in the past, and that is precisely the case a billing
 * dispute turns on.
 */
export interface SubscriptionChange {
  id: string;
  accountId: string;
  /** ISO 8601 UTC. */
  effectiveAt: string;
  plan: AccountPlan;
  status: SubscriptionStatus;
  /** Free text a human wrote: "upgrade agreed on call", "card expired". */
  reason: string | null;
  recordedAt: string;
}

/** A subscription's state at one instant, as derived from its history. */
export interface SubscriptionState {
  plan: AccountPlan;
  status: SubscriptionStatus;
  /** The change that put it in this state. */
  since: string;
}

/**
 * A stretch of a billing month during which plan and status did not change.
 *
 * `plan: null` is a real and important case: the account had no subscription at
 * all for this stretch — before its first change, or an interval a back-dated
 * correction opened up. Nothing is charged for it, and traffic in it is a
 * finding rather than a free month.
 */
export interface MonthSegment {
  /** Inclusive, ISO 8601 UTC. */
  fromIso: string;
  /** Exclusive, ISO 8601 UTC. */
  toIso: string;
  /** Milliseconds. The proration weight; see `invoice.ts`. */
  durationMs: number;
  plan: AccountPlan | null;
  status: SubscriptionStatus | null;
}

/** The first instant of a `YYYY-MM`, in the same text form the meter writes. */
export function monthStartIso(yearMonth: string): string {
  return new Date(`${yearMonth}-01T00:00:00.000Z`).toISOString();
}

/** Milliseconds in a `YYYY-MM`. The proration denominator, and never 30 or 30.44. */
export function monthDurationMs(yearMonth: string): number {
  return monthEndExclusive(yearMonth).getTime() - Date.parse(monthStartIso(yearMonth));
}

/**
 * The state at an instant: the latest change at or before it, or `null`.
 *
 * Ordering is by `effectiveAt` and then by `recordedAt`, so two changes made
 * effective at the same instant resolve to the one entered later — which is what
 * a correction is. Ordering by `effectiveAt` alone would leave the result
 * dependent on the order rows came back in.
 */
export function stateAt(
  changes: readonly SubscriptionChange[],
  instantIso: string
): SubscriptionState | null {
  const at = Date.parse(instantIso);
  let winner: SubscriptionChange | null = null;

  for (const change of changes) {
    if (Date.parse(change.effectiveAt) > at) continue;
    if (winner === null || isLater(change, winner)) winner = change;
  }

  return winner === null
    ? null
    : { plan: winner.plan, status: winner.status, since: winner.effectiveAt };
}

function isLater(a: SubscriptionChange, b: SubscriptionChange): boolean {
  const byEffective = Date.parse(a.effectiveAt) - Date.parse(b.effectiveAt);
  if (byEffective !== 0) return byEffective > 0;
  const byRecorded = Date.parse(a.recordedAt) - Date.parse(b.recordedAt);
  if (byRecorded !== 0) return byRecorded > 0;
  // Last resort, so the result never depends on row order out of SQLite.
  return a.id > b.id;
}

/**
 * Cut a billing month into the stretches during which nothing changed.
 *
 * The segments are contiguous, non-overlapping, and their durations sum to
 * exactly {@link monthDurationMs} — a property `subscription.test.ts` asserts
 * directly, because it is what makes prorating by `durationMs / monthMs` add up
 * to the whole fee rather than to *about* the whole fee.
 *
 * Changes effective before the month collapse into the opening state; changes
 * effective after it are ignored. A change effective exactly at the month
 * boundary belongs to the month it opens, which is the ordinary half-open
 * convention and the same one `usage_events` is bucketed with.
 */
export function segmentsForMonth(
  changes: readonly SubscriptionChange[],
  yearMonth: string
): MonthSegment[] {
  const startIso = monthStartIso(yearMonth);
  const endIso = monthEndExclusive(yearMonth).toISOString();
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);

  // Every distinct instant inside the month at which something changed, plus the
  // month's own bounds. A `Set` because two changes can share an instant — a
  // plan change and a status change entered together — and that is one boundary,
  // not two zero-length segments.
  const boundaries = new Set<number>([startMs, endMs]);
  for (const change of changes) {
    const at = Date.parse(change.effectiveAt);
    if (at > startMs && at < endMs) boundaries.add(at);
  }

  const ordered = [...boundaries].sort((a, b) => a - b);
  const segments: MonthSegment[] = [];

  for (let i = 0; i < ordered.length - 1; i += 1) {
    const fromMs = ordered[i];
    const toMs = ordered[i + 1];
    const fromIso = new Date(fromMs).toISOString();
    const state = stateAt(changes, fromIso);

    segments.push({
      fromIso,
      toIso: new Date(toMs).toISOString(),
      durationMs: toMs - fromMs,
      plan: state?.plan ?? null,
      status: state?.status ?? null,
    });
  }

  return segments;
}

/**
 * Merge neighbouring segments that describe the same state.
 *
 * {@link segmentsForMonth} cuts at every recorded instant, so a change that
 * "changes" nothing — a status re-asserted, a correction that restates the same
 * plan — produces two adjacent identical segments. They would price identically
 * either way, but each rounds its own prorated fee down, so two segments where
 * one belongs can cost the customer a cent that the arithmetic never intended
 * to charge and cannot explain. Merging first makes the fee depend on the state
 * history rather than on how many times it was written down.
 */
export function mergeAdjacent(segments: readonly MonthSegment[]): MonthSegment[] {
  const merged: MonthSegment[] = [];

  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && previous.plan === segment.plan && previous.status === segment.status) {
      previous.toIso = segment.toIso;
      previous.durationMs += segment.durationMs;
      continue;
    }
    merged.push({ ...segment });
  }

  return merged;
}

/**
 * The current record, as the store holds it.
 *
 * Derived from the history rather than maintained beside it — `sqliteBillingStore`
 * recomputes it on every write — so there is no state that can drift from the
 * changes it is a summary of. The provider references are the only fields that
 * are not derivable, and they are test-mode identifiers; see `provider.ts`.
 */
export interface SubscriptionRecord {
  accountId: string;
  plan: AccountPlan;
  status: SubscriptionStatus;
  /** `effectiveAt` of the change that produced the current state. */
  since: string;
  /** Test-mode provider handles, or `null` before anything was synced. */
  providerCustomerRef: string | null;
  providerSubscriptionRef: string | null;
  createdAt: string;
  updatedAt: string;
}
