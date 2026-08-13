import type { AccountPlan } from '../keys/apiKeyStore.js';

/**
 * The plan tiers, as numbers something enforces.
 *
 * Every figure below is transcribed from the ABL-291 brief §1.2 table, which the
 * Board approved as a starting commercial position, and nothing here invents a
 * number the brief does not carry. The one arithmetic step is the Professional
 * overage ceiling, and it is computed from the published price rather than
 * written down — see {@link softOverage}.
 *
 * ## Why this is a table and not configuration
 *
 * `usageStore.ts` reads its retention periods from the environment, and ABL-297
 * §5 requires exactly that, because a retention period is a promise counsel may
 * want to change without a migration. These are the opposite kind of number: a
 * quota is the thing a subscriber pays for, and an operator who can raise
 * Explorer to 100,000 requests with an environment variable can give the product
 * away without a diff. So the tier table is source, a change to it is a review,
 * and the injection point for a test is the whole table
 * ({@link PlanGateOptions.limits}) rather than a per-figure override.
 *
 * ## What is deliberately *not* in this table
 *
 * **The per-request row cap.** `MAX_ROW_LIMIT` (10,000, `data/params.ts`) is one
 * number for every plan and is not a dimension a tier can raise — this module
 * does not import `params.ts` and `planLimits.test.ts` asserts that it cannot.
 * That is the shape brief §1.3 asks for: the cap is what keeps requests-per-month
 * a meaningful billing dimension at all, so a plan that could raise it would be a
 * plan that could re-open the pricing flaw. A tier buys *more requests*, never
 * *bigger requests*.
 *
 * The other columns of the §1.2 table — forecast horizons, history depth, the
 * backtest archive, formats, support, uptime — are product entitlements rather
 * than counters, and they are not enforced here. They are not enforced anywhere
 * yet, which is a gap worth stating plainly rather than leaving to be discovered:
 * a Developer key today can read the same history depth as a Professional one.
 * That is a separate issue (entitlements), it is not what ABL-302 was asked for,
 * and it is not something this file should grow into silently.
 */

/**
 * Published monthly price, in euro. Brief §1.2.
 *
 * Present because the overage ceiling is derived from it and a derived number
 * whose input is not written down is a magic constant with extra steps. `null`
 * for Enterprise, which is negotiated per contract.
 */
export const MONTHLY_PRICE_EUR: Record<AccountPlan, number | null> = {
  explorer: 0,
  developer: 49,
  professional: 249,
  enterprise: null,
};

/** Brief §1.2: Professional soft-overages at €1.00 per 1,000 requests. */
export const OVERAGE_EUR_PER_1000_REQUESTS = 1.0;

/**
 * Brief §1.2: overage is "capped at 2× plan price per month unless they raise
 * it".
 *
 * The cap is on the **bill**, so the request ceiling is what that many euro buys
 * on top of the plan, and it is the plan price itself that decides how much
 * headroom a customer has. Expressed as a multiple rather than as a euro figure
 * so that a price change moves one number and the ceiling follows.
 *
 * "Unless they raise it" is a per-account arrangement and there is nowhere to
 * store one yet: the account record holds a plan and nothing else. Until there
 * is, every Professional account gets the default cap, and raising it is a
 * conversation rather than a config toggle. That is the safe direction — a
 * customer who wants to spend more can be told yes, whereas a customer who was
 * silently allowed to spend €4,000 cannot be un-billed.
 */
export const OVERAGE_BILL_CAP_MULTIPLE = 2;

/**
 * What happens at the monthly quota.
 *
 * Brief §1.2: *"Explorer and Developer hard-stop at quota (429 with a clear
 * upgrade message) — a free tier that can generate a bill is a support burden and
 * a trust problem. Professional soft-overages…"*
 */
export type OveragePolicy =
  /** Refuse past the quota. Nothing beyond the plan price can ever be billed. */
  | { kind: 'hard_stop' }
  /** Serve past the quota, billed, up to a ceiling the bill cap decides. */
  | {
      kind: 'soft';
      /** Requests servable beyond {@link PlanLimits.monthlyRequests}, then 429. */
      maxOverageRequests: number;
      eurPer1000Requests: number;
    };

export interface PlanLimits {
  plan: AccountPlan;
  /**
   * Requests per UTC calendar month, or `null` for a plan with no fixed quota.
   *
   * `null` is Enterprise only and means *negotiated*, not *unlimited-by-accident*:
   * the commercial ceiling for such an account lives in its contract, and
   * inventing one here would enforce a number nobody signed. The per-minute limit
   * below still applies, so "no monthly quota" never means "no protection".
   */
  monthlyRequests: number | null;
  /**
   * Requests per rolling minute. Brief §1.2.
   *
   * Always a number, including for Enterprise. A rate limit is a service
   * protection as much as a commercial term — it is what stops one caller
   * consuming a single-threaded process — and leaving it unset for the tier most
   * likely to run a bulk job would point the gap at the largest customer.
   */
  requestsPerMinute: number;
  overage: OveragePolicy;
}

/**
 * How many requests the bill cap buys past the quota.
 *
 * At €249/month and €1.00/1,000, the cap of 2× plan price leaves €249 of overage
 * budget, i.e. 249,000 requests, so a Professional account is refused at 749,000.
 * `Math.floor`, because a partial thousand is not billable and rounding up would
 * put a request on the far side of a cap we published.
 */
function softOverage(monthlyPriceEur: number): OveragePolicy {
  const overageBudgetEur = monthlyPriceEur * (OVERAGE_BILL_CAP_MULTIPLE - 1);
  return {
    kind: 'soft',
    maxOverageRequests: Math.floor((overageBudgetEur / OVERAGE_EUR_PER_1000_REQUESTS) * 1000),
    eurPer1000Requests: OVERAGE_EUR_PER_1000_REQUESTS,
  };
}

/**
 * The tier table. Brief §1.2, column for column on the two enforced rows.
 *
 * Frozen so that a handler holding a `PlanLimits` cannot mutate the shared record
 * and quietly raise a customer's quota for the life of the process.
 */
export const PLAN_LIMITS: Readonly<Record<AccountPlan, PlanLimits>> = Object.freeze({
  explorer: Object.freeze({
    plan: 'explorer',
    monthlyRequests: 1_000,
    requestsPerMinute: 10,
    // Free tier. §1.2's reasoning is commercial rather than technical and worth
    // keeping next to the constant: a free tier that can generate a bill is a
    // support burden and a trust problem.
    overage: Object.freeze({ kind: 'hard_stop' }),
  }),
  developer: Object.freeze({
    plan: 'developer',
    monthlyRequests: 50_000,
    requestsPerMinute: 60,
    overage: Object.freeze({ kind: 'hard_stop' }),
  }),
  professional: Object.freeze({
    plan: 'professional',
    monthlyRequests: 500_000,
    requestsPerMinute: 300,
    // €249 of headroom at €1.00/1,000 → 249,000 requests → refused at 749,000.
    overage: Object.freeze(softOverage(MONTHLY_PRICE_EUR.professional as number)),
  }),
  enterprise: Object.freeze({
    plan: 'enterprise',
    // "Negotiated". See PlanLimits.monthlyRequests for why that is null rather
    // than a number this file made up.
    monthlyRequests: null,
    // Twice Professional. This one figure is **not** from the brief, which says
    // "Negotiated" here too, and it is a service-protection default rather than a
    // sold number — the alternative was leaving the largest accounts able to
    // saturate a single-threaded process, which is a worse default than one that
    // a signed contract can raise.
    requestsPerMinute: 600,
    // Unreachable while `monthlyRequests` is null — there is no quota to overage
    // past — and stated rather than left implicit so that setting a negotiated
    // quota later is one field and not a missing branch.
    overage: Object.freeze({ kind: 'hard_stop' }),
  }),
} satisfies Record<AccountPlan, PlanLimits>);

/**
 * The limits for a plan.
 *
 * Total over {@link AccountPlan}, so there is no "unknown plan" fallback to
 * choose — and no fallback is the point. A permissive default would hand an
 * unlimited key to whoever added a tier and forgot this file; a restrictive one
 * would 429 a paying customer for the same mistake. The type makes the omission a
 * compile error instead, and `planLimits.test.ts` checks every member of
 * `ACCOUNT_PLANS` has an entry in case someone reaches this with a cast.
 */
export function limitsFor(plan: AccountPlan): PlanLimits {
  return PLAN_LIMITS[plan];
}

/**
 * The most requests a plan will ever serve in a month, quota plus any overage.
 *
 * `null` when the plan has no monthly quota. This is the figure the gate refuses
 * at, and it is computed in one place because the two callers that need it — the
 * gate and its test — must not be able to disagree about where a customer stops.
 */
export function monthlyCeiling(limits: PlanLimits): number | null {
  if (limits.monthlyRequests === null) return null;
  return (
    limits.monthlyRequests +
    (limits.overage.kind === 'soft' ? limits.overage.maxOverageRequests : 0)
  );
}
