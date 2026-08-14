import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { ACCOUNT_PLANS, type AccountPlan } from '../keys/apiKeyStore.js';
import { PLAN_LIMITS, OVERAGE_BILL_CAP_MULTIPLE } from '../quota/planLimits.js';
import { parseMajorToMinor, BILLING_CURRENCY } from './money.js';

/**
 * What each plan costs — **as configuration, with no prices in this repository.**
 *
 * ## Why there is no default price table here
 *
 * Board Decision 1 (tier structure and price points) is open, and the draft
 * price list is separately not publishable: it advertises two years of history
 * against the 7.5 months we hold, and a D+3 product against a 64-hour maximum
 * horizon. A price committed here would be a number nobody has approved,
 * sitting in a file that reads like the authority on what we charge, one
 * `git grep` away from being quoted to a customer.
 *
 * So this module ships the *shape* and refuses to invent the *values*. With no
 * price book configured, {@link resolvePriceBook} returns `undecided` and names
 * the decision that is missing; nothing downstream will produce an invoice, and
 * the CLI says why in the words of the open decision rather than with a stack
 * trace. When the Board rules, the numbers arrive in a JSON file at
 * `BILLING_PRICE_BOOK_PATH` and nothing in this diff changes.
 *
 * ## The cross-check, which is the reason this file imports `planLimits.ts`
 *
 * ABL-302 already enforces two numbers that are *functions of price*, and it
 * enforces them on the request path, months before an invoice is raised:
 *
 * - `PLAN_LIMITS[plan].monthlyRequests` is what a subscriber gets served before
 *   overage begins. If the price book's `includedRequests` disagrees, we either
 *   bill for requests that were inside the customer's allowance, or hand out
 *   free ones past it. Both are silent, and the second is only discovered by us.
 * - `PLAN_LIMITS.professional.overage.maxOverageRequests` — the request at which
 *   we start answering 429 — was computed by `planLimits.softOverage()` from a
 *   plan price and an overage rate. If the price book carries a different pair,
 *   then the ceiling we refuse at and the cap we bill to are derived from two
 *   different price lists, and the published promise ("overage capped at 2× plan
 *   price") is false in whichever direction the arithmetic fell.
 *
 * {@link checkAgainstPlanLimits} recomputes ABL-302's figures from the price
 * book and refuses the book if they do not match. That is what makes shipping no
 * prices *safe* rather than merely compliant: the two files must move together,
 * and a price change that updates one and forgets the other fails here instead of
 * on an invoice. It is also why this module reads `planLimits.ts` rather than
 * re-deriving a ceiling of its own — a second derivation would be a second thing
 * to get wrong.
 */

/** Where the operator's price book is read from. Unset means "the Board has not ruled". */
export const PRICE_BOOK_ENV = 'BILLING_PRICE_BOOK_PATH';

/** The open Board decision, quoted wherever the absence of prices stops something. */
export const PRICING_DECISION = 'Board Decision 1 — tier structure and price points';

export interface PlanPricing {
  plan: AccountPlan;
  /** Monthly subscription fee in minor units. `0` is a legitimate value: it is how a free tier, and how a trial, are expressed. */
  baseMinor: number;
  /**
   * Requests included in the base fee each month.
   *
   * Must equal `PLAN_LIMITS[plan].monthlyRequests`, or the gate and the invoice
   * disagree about where the customer's allowance ends. `null` only for a plan
   * whose quota is negotiated (Enterprise), where an invoice cannot be computed
   * from a table at all — see {@link PriceBook} and `invoice.ts`.
   */
  includedRequests: number | null;
  /**
   * Price of 1,000 requests past {@link includedRequests}, or `null` on a plan
   * that hard-stops instead of overaging.
   *
   * `null` here and `hard_stop` in `planLimits.ts` must agree. A price on a
   * hard-stop plan is a rate that can never be charged, which reads as an
   * intention nobody implemented; a hard stop with no price is what the plan is.
   */
  overagePerThousandMinor: number | null;
}

export interface PriceBook {
  status: 'configured';
  /** Absolute path it was read from, for the CLI to print and an invoice to record. */
  source: string;
  /**
   * The date the operator states these prices took effect. Recorded on every
   * invoice: an invoice that does not say which price list produced it cannot be
   * defended once the list has changed once.
   */
  effectiveFrom: string;
  plans: Readonly<Record<AccountPlan, PlanPricing>>;
  /**
   * `sha256` of the canonical price book. Stamped on every invoice.
   *
   * The question this answers is the one a reconciliation cannot otherwise ask:
   * *were these two invoices computed under the same prices?* Two months
   * reconciled against different fingerprints are not comparable, and a
   * fingerprint that changed between raising an invoice and reconciling it means
   * the reconciliation is checking arithmetic that was never performed.
   */
  fingerprint: string;
}

/** No price book configured. Not an error — it is the state the company is in. */
export interface UndecidedPricing {
  status: 'undecided';
  reason: string;
}

export type PriceBookResolution = PriceBook | UndecidedPricing;

export interface PriceBookIo {
  readFile(path: string): string;
}

const realIo: PriceBookIo = { readFile: (p) => fs.readFileSync(p, 'utf8') };

/**
 * Read the price book, or say which decision is missing.
 *
 * A malformed or inconsistent book **throws**; an absent one does not. The
 * difference is deliberate: "the Board has not ruled" is a state we are
 * legitimately in and every caller must handle, whereas "there is a price book
 * and it disagrees with what the API is enforcing" is a misconfiguration that
 * must stop the operator rather than produce an invoice with a footnote.
 */
export function resolvePriceBook(
  env: NodeJS.ProcessEnv = process.env,
  io: PriceBookIo = realIo
): PriceBookResolution {
  const configured = (env[PRICE_BOOK_ENV] ?? '').trim();
  if (configured === '') {
    return {
      status: 'undecided',
      reason:
        `${PRICE_BOOK_ENV} is not set, so no plan has a price. This is expected while ` +
        `${PRICING_DECISION} is open: prices are not committed to this repository. ` +
        'Usage metering, subscription state and reconciliation all work without one; ' +
        'only the amounts on an invoice need it.',
    };
  }

  let raw: string;
  try {
    raw = io.readFile(configured);
  } catch (err) {
    throw new Error(
      `Cannot read the price book at ${configured}: ${(err as Error).message}. ` +
        `Unset ${PRICE_BOOK_ENV} to run without prices; a path that does not resolve is a ` +
        'typo, and falling back to no prices would hide it.'
    );
  }

  return parsePriceBook(raw, configured);
}

interface RawPlanPricing {
  base?: unknown;
  includedRequests?: unknown;
  overagePerThousand?: unknown;
}

/**
 * Parse and validate a price book, then check it against what ABL-302 enforces.
 *
 * Exported for the test and for the CLI's `billing:price-book --file`, which
 * exists so an operator can validate a candidate book *before* pointing the
 * environment at it.
 */
export function parsePriceBook(raw: string, source: string): PriceBook {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Price book at ${source} is not valid JSON: ${(err as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Price book at ${source} must be a JSON object.`);
  }
  const doc = parsed as Record<string, unknown>;

  const currency = doc.currency;
  if (currency !== BILLING_CURRENCY) {
    throw new Error(
      `Price book at ${source} declares currency ${JSON.stringify(currency)}; this module ` +
        `handles ${BILLING_CURRENCY} only. See money.ts for why that is a constant.`
    );
  }

  const effectiveFrom = doc.effectiveFrom;
  if (typeof effectiveFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    throw new Error(
      `Price book at ${source} needs "effectiveFrom" as YYYY-MM-DD. An invoice records which ` +
        'price list produced it, and a list with no date cannot be cited later.'
    );
  }

  const plansDoc = doc.plans;
  if (typeof plansDoc !== 'object' || plansDoc === null) {
    throw new Error(`Price book at ${source} needs a "plans" object.`);
  }

  const plans = {} as Record<AccountPlan, PlanPricing>;
  for (const plan of ACCOUNT_PLANS) {
    const entry = (plansDoc as Record<string, unknown>)[plan];
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(
        `Price book at ${source} has no entry for plan "${plan}". Every plan in ACCOUNT_PLANS ` +
          'needs one: a missing plan is an account that authenticates, meters and cannot be ' +
          'invoiced, which is discovered at month end.'
      );
    }
    plans[plan] = readPlanPricing(plan, entry as RawPlanPricing, source);
  }

  const problems = checkAgainstPlanLimits(plans);
  if (problems.length > 0) {
    throw new Error(
      `Price book at ${source} disagrees with what /v1 is enforcing (quota/planLimits.ts):\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\n\nThese two must move together. The limits file decides what is served and the ' +
        'price book decides what is charged; when they are derived from different prices, the ' +
        'ceiling we refuse at is not the cap we bill to.'
    );
  }

  return {
    status: 'configured',
    source,
    effectiveFrom,
    plans: Object.freeze(plans),
    fingerprint: fingerprintOf(plans, effectiveFrom),
  };
}

function readPlanPricing(plan: AccountPlan, entry: RawPlanPricing, source: string): PlanPricing {
  const where = `Price book at ${source}, plan "${plan}"`;

  if (entry.base === undefined || entry.base === null) {
    throw new Error(
      `${where}: "base" is required. A free tier is written as 0, not as an omission — an ` +
        'absent price and a zero price are different facts, and only one of them is a decision.'
    );
  }
  const baseMinor = parseMajorToMinor(entry.base, `${where}: "base"`);
  if (baseMinor < 0) throw new Error(`${where}: "base" cannot be negative.`);

  const included = entry.includedRequests ?? null;
  if (included !== null && (!Number.isInteger(included) || (included as number) < 0)) {
    throw new Error(
      `${where}: "includedRequests" must be a whole number of requests, or null for a plan ` +
        'whose quota is negotiated rather than tabulated.'
    );
  }

  const overageRaw = entry.overagePerThousand ?? null;
  const overagePerThousandMinor =
    overageRaw === null ? null : parseMajorToMinor(overageRaw, `${where}: "overagePerThousand"`);
  if (overagePerThousandMinor !== null && overagePerThousandMinor < 0) {
    throw new Error(`${where}: "overagePerThousand" cannot be negative.`);
  }

  return {
    plan,
    baseMinor,
    includedRequests: included as number | null,
    overagePerThousandMinor,
  };
}

/**
 * Recompute ABL-302's enforced figures from these prices and report every
 * disagreement.
 *
 * Returns a list rather than throwing on the first, so an operator fixing a
 * price book sees all of it at once instead of one line per run.
 *
 * Exported because `priceBook.test.ts` asserts each branch, and because the CLI
 * prints the same list when validating a candidate file.
 */
export function checkAgainstPlanLimits(
  plans: Readonly<Record<AccountPlan, PlanPricing>>
): string[] {
  const problems: string[] = [];

  for (const plan of ACCOUNT_PLANS) {
    const pricing = plans[plan];
    const limits = PLAN_LIMITS[plan];

    // The allowance. This one matters on every plan and every month: it is the
    // boundary between "included" and "billed", and the gate has already served
    // traffic against its own copy of it.
    if (pricing.includedRequests !== limits.monthlyRequests) {
      problems.push(
        `${plan}: includedRequests is ${describeCount(pricing.includedRequests)} but ` +
          `PLAN_LIMITS.${plan}.monthlyRequests is ${describeCount(limits.monthlyRequests)}. ` +
          'The gate serves against the second and the invoice would charge against the first.'
      );
    }

    // A rate on a plan that cannot overage, or none on a plan that can.
    const hasRate = pricing.overagePerThousandMinor !== null;
    const canOverage = limits.overage.kind === 'soft';
    if (hasRate && !canOverage) {
      problems.push(
        `${plan}: has an overage price, but PLAN_LIMITS.${plan} hard-stops at quota, so no ` +
          'overage request is ever served and the rate can never be charged. Set it to null, ' +
          'or change the plan to soft-overage in planLimits.ts.'
      );
    }
    if (!hasRate && canOverage) {
      problems.push(
        `${plan}: PLAN_LIMITS.${plan} serves up to ` +
          `${limits.overage.kind === 'soft' ? limits.overage.maxOverageRequests : 0} requests ` +
          'past quota, but the price book gives no overage price, so those requests would be ' +
          'served and never billed.'
      );
    }

    // The derived ceiling. Only reachable on a soft-overage plan, and it is the
    // figure that ties the two files together: `softOverage()` computed
    // `maxOverageRequests` from a base price and a rate, and this recomputes it
    // from the configured pair.
    if (canOverage && hasRate && limits.overage.kind === 'soft') {
      const budgetMinor = pricing.baseMinor * (OVERAGE_BILL_CAP_MULTIPLE - 1);
      const expected = Math.floor(
        (budgetMinor / (pricing.overagePerThousandMinor as number)) * 1000
      );
      if (expected !== limits.overage.maxOverageRequests) {
        problems.push(
          `${plan}: the configured base and overage price buy ${expected} requests of overage ` +
            `at the published ${OVERAGE_BILL_CAP_MULTIPLE}× cap, but PLAN_LIMITS.${plan} ` +
            `refuses at ${limits.overage.maxOverageRequests}. planLimits.softOverage() derived ` +
            'that number from a different price pair; update it in the same change.'
        );
      }

      // `planLimits.ts` publishes the rate it derived the ceiling from. A price
      // book that agrees on the ceiling but not on the rate is arithmetically
      // possible (two pairs can round to the same floor) and is still wrong: the
      // per-thousand figure is what appears on the invoice line.
      const limitsRateMinor = Math.round(limits.overage.eurPer1000Requests * 100);
      if (limitsRateMinor !== pricing.overagePerThousandMinor) {
        problems.push(
          `${plan}: overagePerThousand is ${pricing.overagePerThousandMinor} minor units but ` +
            `PLAN_LIMITS.${plan}.overage.eurPer1000Requests is ${limits.overage.eurPer1000Requests}. ` +
            'The invoice line would quote a rate the gate did not size the ceiling with.'
        );
      }
    }
  }

  return problems;
}

function describeCount(value: number | null): string {
  return value === null ? 'null (negotiated)' : value.toLocaleString('en-GB');
}

/**
 * A stable hash of the prices, independent of key order and formatting.
 *
 * Built from a canonical rendering rather than from the file's bytes, so
 * reformatting the JSON or reordering its keys does not change the fingerprint
 * and make two identically-priced months look incomparable.
 */
function fingerprintOf(
  plans: Readonly<Record<AccountPlan, PlanPricing>>,
  effectiveFrom: string
): string {
  const canonical = ACCOUNT_PLANS.map((plan) => {
    const p = plans[plan];
    return `${plan}:${p.baseMinor}:${p.includedRequests ?? 'null'}:${p.overagePerThousandMinor ?? 'null'}`;
  }).join('|');

  return createHash('sha256')
    .update(`${BILLING_CURRENCY}|${effectiveFrom}|${canonical}`)
    .digest('hex')
    .slice(0, 16);
}
