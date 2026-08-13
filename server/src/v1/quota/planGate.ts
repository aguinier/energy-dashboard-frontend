import type { RequestHandler, Response } from 'express';
import { requireApiPrincipal } from '../auth/apiKeyAuth.js';
import { PublicApiError } from '../publicErrors.js';
import { monthEndExclusive, THROTTLED_STATUS } from '../usage/usageStore.js';
import { limitsFor, monthlyCeiling, type PlanLimits } from './planLimits.js';
import {
  billingMonthOf,
  createMonthlyQuotaCounter,
  type MonthlyQuotaCounter,
  type MonthlyUsageReader,
} from './monthlyQuota.js';
import { createRateLimiter, type RateDecision, type RateLimiter } from './rateLimiter.js';
import type { AccountPlan } from '../keys/apiKeyStore.js';

/**
 * The gate: a per-minute rate limit and a per-month quota, both by plan, and a
 * 429 contract a client can act on without reading documentation.
 *
 * Mounted after the key gate and after the meter, which is the order
 * `publicApp.ts` reserved for it: a refused request must have a principal to be
 * refused *for*, and it must be counted before it is refused, because a request
 * we answered — even with a 429 — is a request that was made and is evidence for
 * abuse detection.
 *
 * ## Enforcement is 429-shaped, and that is a commitment rather than a
 *    convenience
 *
 * ABL-297 filed a requirement on this issue from a Board decision, and it draws
 * the line in a specific place. Automated throttling and automated 429s are
 * explicitly permitted — the privacy notice §8 characterises rate limiting as a
 * technical control rather than a decision about a person, which is what keeps it
 * outside GDPR Art. 22. **Suspending or terminating an account is different**:
 * AUP §6.5 commits us in writing that it is never fully automated, that a human
 * reviews and confirms it, and that the subscriber may appeal.
 *
 * So this module refuses requests and does nothing else. There is no counter that
 * trips into a disable, no threshold that flags an account, no path from
 * repeated breach to any state change at all — the next request from a caller who
 * has just been 429'd is evaluated exactly like the first. That is satisfied here
 * "by construction", which the requirement says is sufficient, and construction
 * means two checkable things rather than a promise:
 *
 * 1. The only capability this module is given over an account is
 *    {@link MonthlyUsageReader}, which reads one integer. `ApiKeyAdminStore`
 *    holds `setAccountDisabled`, and it is not reachable from here.
 * 2. `planGate.test.ts` walks this module's import graph and asserts that.
 *
 * If a future issue wants an enforcement path beyond a 429, the requirement is
 * that it stops at a queue or a flag for a human. That would be a new module with
 * a new capability and a failing graph test until somebody names it, which is the
 * point at which the commitment gets read again.
 *
 * ## What is counted against what
 *
 * - **The rate limit sees every request that reaches it**, including ones that
 *   go on to fail with a 400. `usageStore.isBillableStatus` says so from the
 *   other side: a 4xx is recorded and not billed, *"it still counts toward the
 *   rate limit, which is ABL-302's to enforce, so a broken client cannot use
 *   errors as free unlimited traffic."*
 * - **The quota counts requests this gate let through**, whatever status they
 *   end with, and never a request it refused. Refusing and then charging for the
 *   refusal is indefensible on a hard-stop plan and is literally a billed euro on
 *   a soft-overage one.
 * - **A request refused by the rate limiter never reaches the quota check**, so
 *   the two cannot both charge for the same call.
 *
 * Because every refusal from this module is a 429 and nothing else on this
 * surface produces one, "requests that consumed quota" is exactly "recorded
 * requests whose status is not 429" — which is how the durable seed in
 * `sqliteUsageStore.ts` is written, and why {@link THROTTLED_STATUS} is one
 * constant imported by both sides rather than a 429 typed twice.
 */

/**
 * The response headers this gate sets, by name.
 *
 * `RateLimit-Limit`/`-Remaining`/`-Reset` are the IETF `ratelimit-headers` draft
 * names, which is the closest thing to a convention a client library will
 * already know. The `Quota-*` names are ours: the draft models a single
 * short-window policy and has nothing that means "you have bought 50,000 of these
 * this month", and overloading `RateLimit-Remaining` with a monthly figure would
 * make an off-the-shelf client back off for a month.
 *
 * These strings are duplicated once, in `publicApp.ts`'s CORS `exposedHeaders`,
 * and the duplication is load-bearing: a header a browser cannot read is a quota
 * a browser client cannot respect. ABL-304 named the first six there in advance
 * for exactly this issue; `publicApp.test.ts` checks the two lists agree.
 */
export const RATE_LIMIT_HEADERS = {
  limit: 'RateLimit-Limit',
  remaining: 'RateLimit-Remaining',
  reset: 'RateLimit-Reset',
} as const;

export const QUOTA_HEADERS = {
  limit: 'Quota-Limit-Month',
  remaining: 'Quota-Remaining-Month',
  /**
   * Requests served this month **past** the quota, i.e. the ones that will be
   * invoiced as overage.
   *
   * Set only for a plan that can overage at all, so a hard-stop customer is not
   * shown a number that will always be zero. This is the one header ABL-304 did
   * not name in advance, and it is here because a soft overage that a customer
   * cannot observe is a bill arriving without warning — the failure §1.2 rejected
   * hard stops *and* silent overages to avoid.
   */
  overage: 'Quota-Overage-Month',
} as const;

/**
 * Why a request was refused. Each is a distinct `error.code` on a 429.
 *
 * Distinguished because the three have different fixes and a customer reading
 * one wants to know which afternoon they are in for: slow down, upgrade, or ask
 * us to raise a cap. Collapsing them into `rate_limit_exceeded` would make the
 * monthly ones look transient, and a client that retries a monthly quota breach
 * with exponential backoff will do so for the rest of the month.
 */
export const THROTTLE_ERROR_CODES = {
  /** The per-minute limit. Transient by construction — `Retry-After` is seconds. */
  rate: 'rate_limit_exceeded',
  /** The monthly quota, on a plan that hard-stops. */
  quota: 'quota_exceeded',
  /** The monthly quota plus the whole soft-overage allowance. */
  overageCap: 'overage_cap_exceeded',
} as const;

export interface PlanGate {
  /** Mount after the usage meter and before the resources. */
  middleware: RequestHandler;
  /** Live counters, for an operator. Nothing on the request path reads these. */
  stats(): { rateSubjects: number; quotaEntries: number };
}

export interface PlanGateOptions {
  /**
   * Where the durable half of the monthly count comes from.
   *
   * Typed as the one-method {@link MonthlyUsageReader} rather than as the usage
   * store, which is the whole of the ABL-297 §6.5 argument in the header: the
   * gate is handed a capability that can read an integer and nothing that could
   * change an account's state.
   */
  usage: MonthlyUsageReader;
  /**
   * The tier table, injectable so a test can drive a boundary without sending
   * fifty thousand requests.
   *
   * Whole-table injection rather than a per-figure override: production has
   * exactly one table, it is `PLAN_LIMITS`, and an options bag that let a
   * deployment raise one plan's quota is the configuration surface
   * `planLimits.ts` argues against having.
   */
  limits?: (plan: AccountPlan) => PlanLimits;
  /** Wall clock, for the billing month and the month-boundary `Retry-After`. */
  now?: () => Date;
  /**
   * Monotonic milliseconds, for the rate window.
   *
   * Separate from `now` on purpose, and the split matters: a wall clock that
   * steps backwards — an NTP correction, a VM resuming — would make a sliding
   * window think its oldest entry is in the future and refuse a caller for as
   * long as the step. The month boundary genuinely needs wall time and gets it;
   * the sixty-second window does not.
   */
  monotonicMs?: () => number;
}

function setRateHeaders(res: Response, decision: RateDecision): void {
  res.setHeader(RATE_LIMIT_HEADERS.limit, decision.limit);
  res.setHeader(RATE_LIMIT_HEADERS.remaining, decision.remaining);
  res.setHeader(RATE_LIMIT_HEADERS.reset, decision.resetSeconds);
}

/**
 * State the monthly position, given a total that already includes this request
 * if it was admitted.
 *
 * A plan with no monthly quota gets **no** `Quota-*` headers rather than a
 * sentinel. `Quota-Limit-Month: unlimited` is a string in a field every client
 * will parse as a number, and `-1` is a convention nobody agreed to; an absent
 * header is the one form that cannot be misread.
 */
function setQuotaHeaders(res: Response, limits: PlanLimits, used: number): void {
  const quota = limits.monthlyRequests;
  if (quota === null) return;

  res.setHeader(QUOTA_HEADERS.limit, quota);
  res.setHeader(QUOTA_HEADERS.remaining, Math.max(0, quota - used));
  if (limits.overage.kind === 'soft') {
    res.setHeader(QUOTA_HEADERS.overage, Math.max(0, used - quota));
  }
}

/**
 * Seconds until this billing month rolls over.
 *
 * The honest `Retry-After` for a quota breach: the quota is monthly, so the next
 * instant it could succeed is the first of the next month, UTC. Large — up to
 * about 2.7 million seconds — and correct, which is better than a small number
 * that invites a client to retry into the same 429 every minute for three weeks.
 */
function secondsUntilMonthEnd(now: Date, yearMonth: string): number {
  const rollover = monthEndExclusive(yearMonth).getTime();
  return Math.max(1, Math.ceil((rollover - now.getTime()) / 1000));
}

/**
 * Messages written for a customer to read, and constants in the sense that
 * matters.
 *
 * Every interpolated value below comes from the frozen `PLAN_LIMITS` table or
 * from this module — never from the request — so this file cannot become the
 * reflected-input hole `publicErrors.ts` inverted the error contract to close.
 * `data/params.ts` interpolates `MAX_ROW_LIMIT` on the same reasoning: a number
 * we chose is not caller input, and a 429 that says *what* the limit was saves
 * the support ticket that a bare "rate limit exceeded" generates.
 */
function rateLimitError(limits: PlanLimits, retryAfterSeconds: number): PublicApiError {
  return new PublicApiError(
    THROTTLED_STATUS,
    THROTTLE_ERROR_CODES.rate,
    `This key's plan allows ${limits.requestsPerMinute} requests per minute and that ` +
      `window is full. Retry in ${retryAfterSeconds} second(s), or spread requests more ` +
      'evenly. See the RateLimit-Remaining and RateLimit-Reset headers on every response.'
  );
}

function quotaError(limits: PlanLimits): PublicApiError {
  const quota = limits.monthlyRequests as number;

  if (limits.overage.kind === 'soft') {
    const ceiling = monthlyCeiling(limits) as number;
    return new PublicApiError(
      THROTTLED_STATUS,
      THROTTLE_ERROR_CODES.overageCap,
      `This account has used its ${quota.toLocaleString('en-GB')} requests for the month ` +
        `plus the full overage allowance of ${(ceiling - quota).toLocaleString('en-GB')} ` +
        'additional requests, which is the point at which overage charges reach their ' +
        'monthly cap. Service resumes when the month rolls over; contact us to raise the ' +
        'cap before then.'
    );
  }

  return new PublicApiError(
    THROTTLED_STATUS,
    THROTTLE_ERROR_CODES.quota,
    `This account has used its ${quota.toLocaleString('en-GB')} requests for the month. ` +
      'This plan stops at its quota rather than billing for overage, so service resumes ' +
      'when the month rolls over. A larger plan raises the quota immediately.'
  );
}

/**
 * Build the gate.
 *
 * A factory over injected collaborators, exactly like `requireApiKey` and
 * `createUsageMeter`, so `publicApp.ts` names the *shape* of an enforcement layer
 * and `publicIndex.ts` decides what backs it. That is what keeps `better-sqlite3`
 * out of the composed app's import graph even though the quota is ultimately a
 * count of rows in a SQLite file.
 */
export function createPlanGate({
  usage,
  limits = limitsFor,
  now = () => new Date(),
  monotonicMs = () => performance.now(),
}: PlanGateOptions): PlanGate {
  const rateLimiter: RateLimiter = createRateLimiter();
  const quota: MonthlyQuotaCounter = createMonthlyQuotaCounter({ reader: usage });

  const middleware: RequestHandler = function enforcePlanLimits(_req, res, next) {
    // Synchronously, and before anything else, for the reason `usageMeter.ts`
    // gives: this throws when the gate is mounted ahead of `requireApiKey`, and
    // a throw here is a 500 Express can handle rather than an uncaught exception
    // from inside an event handler.
    const principal = requireApiPrincipal(res);
    const plan = limits(principal.plan);

    // The **account**, not the key, is the subject of both limits — and this one
    // line is the whole of that decision, so it is worth stating where it is
    // made. A plan is sold to an account; `MAX_LIVE_KEYS_PER_ACCOUNT` is 5, so a
    // per-key limit would deliver five times the quota and five times the burst
    // that was actually bought. Per-key figures are not lost: `usage_rollup` is
    // keyed (account, key, month) and the invoice and any key-sharing
    // investigation read from there.
    const subject = principal.accountId;

    const rate = rateLimiter.admit(subject, plan.requestsPerMinute, monotonicMs());
    setRateHeaders(res, rate);

    const at = now();
    const yearMonth = billingMonthOf(at);

    if (!rate.allowed) {
      // The monthly position is reported even on a rate-limit refusal. It costs
      // a cached lookup and it is the difference between a client that knows to
      // slow down and one that cannot tell a busy minute from an exhausted
      // month.
      setQuotaHeaders(res, plan, quota.used(subject, yearMonth, monotonicMs()));
      res.setHeader('Retry-After', rate.resetSeconds);
      return next(rateLimitError(plan, rate.resetSeconds));
    }

    const ceiling = monthlyCeiling(plan);
    if (ceiling !== null) {
      const used = quota.used(subject, yearMonth, monotonicMs());
      if (used >= ceiling) {
        setQuotaHeaders(res, plan, used);
        res.setHeader('Retry-After', secondsUntilMonthEnd(at, yearMonth));
        return next(quotaError(plan));
      }
    }

    // Consumed only now, once the request is certain to be served. Everything
    // above this line either let it through or ended it with a 429, so the
    // number this increments is "requests we served", which is what the durable
    // seed counts and what a Professional account's overage is billed on.
    setQuotaHeaders(res, plan, quota.consume(subject, yearMonth, monotonicMs()));
    next();
  };

  return {
    middleware,
    stats: () => ({ rateSubjects: rateLimiter.size(), quotaEntries: quota.size() }),
  };
}
