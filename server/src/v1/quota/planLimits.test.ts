import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  MONTHLY_PRICE_EUR,
  OVERAGE_BILL_CAP_MULTIPLE,
  OVERAGE_EUR_PER_1000_REQUESTS,
  PLAN_LIMITS,
  limitsFor,
  monthlyCeiling,
} from './planLimits.js';
import { ACCOUNT_PLANS, type AccountPlan } from '../keys/apiKeyStore.js';
import { MAX_ROW_LIMIT, parseLimit } from '../data/params.js';
import { walkModuleGraph } from '../importGraph.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '../..');

/**
 * The tier table against the document it was transcribed from.
 *
 * This file is unusual for a unit test: it asserts constants against constants,
 * which normally proves only that somebody typed the same number twice. It earns
 * its place because the numbers came from **outside engineering** — the ABL-291
 * brief §1.2, approved by the Board as a commercial position — and the failure
 * mode it guards is not a bug, it is a quiet edit. A one-character change to
 * Explorer's quota is invisible in review, has no test that would fail, and gives
 * the product away.
 *
 * So the table below is the brief, retyped from the source document rather than
 * from `planLimits.ts`, and a diff here means somebody changed a published price
 * or a published quota. That is a conversation, not a merge.
 */
const BRIEF_SECTION_1_2 = [
  { plan: 'explorer', priceEur: 0, requestsPerMonth: 1_000, ratePerMinute: 10 },
  { plan: 'developer', priceEur: 49, requestsPerMonth: 50_000, ratePerMinute: 60 },
  { plan: 'professional', priceEur: 249, requestsPerMonth: 500_000, ratePerMinute: 300 },
] as const satisfies ReadonlyArray<{
  plan: AccountPlan;
  priceEur: number;
  requestsPerMonth: number;
  ratePerMinute: number;
}>;

describe('the tier table is the ABL-291 brief §1.2 table', () => {
  it.each(BRIEF_SECTION_1_2)(
    '$plan: €$priceEur, $requestsPerMonth requests/month, $ratePerMinute/min',
    ({ plan, priceEur, requestsPerMonth, ratePerMinute }) => {
      expect(MONTHLY_PRICE_EUR[plan]).toBe(priceEur);
      expect(PLAN_LIMITS[plan].monthlyRequests).toBe(requestsPerMonth);
      expect(PLAN_LIMITS[plan].requestsPerMinute).toBe(ratePerMinute);
    }
  );

  it('prices Enterprise per contract rather than in this file', () => {
    // "Negotiated" in both cells of the brief. A number here would be a price
    // nobody quoted and a quota nobody signed.
    expect(MONTHLY_PRICE_EUR.enterprise).toBeNull();
    expect(PLAN_LIMITS.enterprise.monthlyRequests).toBeNull();
  });

  it('still rate-limits Enterprise, because that one is not a commercial term', () => {
    // The exception to the line above, and the reason is availability rather
    // than commerce: the process is single-threaded and reads a 9.4 GB SQLite
    // file, so an unlimited per-minute rate on the tier most likely to run a bulk
    // job would point the only real capacity risk at the largest customer.
    expect(PLAN_LIMITS.enterprise.requestsPerMinute).toBeGreaterThan(
      PLAN_LIMITS.professional.requestsPerMinute
    );
  });

  it('covers every plan a key can carry', () => {
    // `limitsFor` is total over `AccountPlan` and the compiler enforces that —
    // until somebody reaches it with a cast, or adds a plan to `ACCOUNT_PLANS`
    // and a migration writes the string into the database before this file
    // catches up. A missing entry would be `undefined` and every read off it
    // `NaN`, which compares false against every limit and admits everything.
    for (const plan of ACCOUNT_PLANS) {
      expect(limitsFor(plan)).toBeDefined();
      expect(limitsFor(plan).plan).toBe(plan);
    }
  });
});

describe('hard stop and soft overage, per brief §1.2', () => {
  it('hard-stops the two plans the brief hard-stops', () => {
    // "Explorer and Developer hard-stop at quota (429 with a clear upgrade
    // message) — a free tier that can generate a bill is a support burden and a
    // trust problem."
    expect(PLAN_LIMITS.explorer.overage.kind).toBe('hard_stop');
    expect(PLAN_LIMITS.developer.overage.kind).toBe('hard_stop');
  });

  it('lets a hard-stop plan serve exactly its quota and not one request more', () => {
    expect(monthlyCeiling(PLAN_LIMITS.explorer)).toBe(1_000);
    expect(monthlyCeiling(PLAN_LIMITS.developer)).toBe(50_000);
  });

  it('derives the Professional overage ceiling from the published price', () => {
    // €249/month, 2× bill cap, €1.00/1,000 → €249 of headroom → 249,000
    // requests → refused at 749,000. Asserted as the arithmetic rather than as
    // the answer, so that changing the price changes this test's expectation
    // too and a stale number cannot survive by being retyped.
    const price = MONTHLY_PRICE_EUR.professional as number;
    const expected = Math.floor(
      ((price * (OVERAGE_BILL_CAP_MULTIPLE - 1)) / OVERAGE_EUR_PER_1000_REQUESTS) * 1000
    );

    expect(PLAN_LIMITS.professional.overage).toMatchObject({
      kind: 'soft',
      maxOverageRequests: expected,
      eurPer1000Requests: OVERAGE_EUR_PER_1000_REQUESTS,
    });
    expect(expected).toBe(249_000);
    expect(monthlyCeiling(PLAN_LIMITS.professional)).toBe(749_000);
  });

  it('caps the worst-case Professional bill at twice the plan price', () => {
    // The property the brief actually promises. A customer reading "capped at 2×
    // plan price" and receiving a bill for 2.001× would be right to complain,
    // and the arithmetic that produces that is a `Math.ceil` away.
    const plan = PLAN_LIMITS.professional;
    if (plan.overage.kind !== 'soft') throw new Error('professional must soft-overage');

    const price = MONTHLY_PRICE_EUR.professional as number;
    const worstCaseBill =
      price + (plan.overage.maxOverageRequests / 1000) * plan.overage.eurPer1000Requests;

    expect(worstCaseBill).toBeLessThanOrEqual(price * OVERAGE_BILL_CAP_MULTIPLE);
  });

  it('has no monthly ceiling for a plan with no monthly quota', () => {
    expect(monthlyCeiling(PLAN_LIMITS.enterprise)).toBeNull();
  });
});

describe('a plan buys more requests, never bigger ones', () => {
  it('holds the row cap at 10,000 whatever the caller asks for', () => {
    // Brief §1.3's figure, and ABL-303 landed it. Re-asserted from this file
    // because the cap is what makes requests-per-month mean anything: without
    // it, one Explorer request can return the entire history and the whole tier
    // table above prices nothing.
    expect(MAX_ROW_LIMIT).toBe(10_000);
    expect(parseLimit('9999999')).toBe(MAX_ROW_LIMIT);
    expect(parseLimit(undefined)).toBe(MAX_ROW_LIMIT);
  });

  it('gives no plan a row-cap dimension to raise', () => {
    // The structural half, and the one that survives someone adding a field in a
    // hurry. `parseLimit` takes no plan and could not read one if it wanted to:
    // the plan table does not import the parameter module, so there is no
    // expression anywhere that resolves a row cap from a tier.
    const graph = walkModuleGraph(path.join(HERE, 'planLimits.ts'), SRC_ROOT);
    expect(graph.modules).toEqual(['v1/quota/planLimits.ts']);

    for (const plan of ACCOUNT_PLANS) {
      expect(Object.keys(limitsFor(plan)).sort()).toEqual([
        'monthlyRequests',
        'overage',
        'plan',
        'requestsPerMinute',
      ]);
    }
  });

  it('is frozen, so a handler cannot raise a customer’s quota for the process', () => {
    // `Object.freeze` on a shared record is not paranoia here: the gate hands
    // `PlanLimits` to code that formats an error message, and a mutation would
    // persist for every later request from every account on that plan.
    expect(Object.isFrozen(PLAN_LIMITS)).toBe(true);
    expect(Object.isFrozen(PLAN_LIMITS.explorer)).toBe(true);
    expect(() => {
      (PLAN_LIMITS.explorer as { monthlyRequests: number | null }).monthlyRequests = 1_000_000;
    }).toThrow();
    expect(PLAN_LIMITS.explorer.monthlyRequests).toBe(1_000);
  });
});

describe('the table is not configuration', () => {
  it('reads no environment variable', () => {
    // `usageStore.ts` reads its retention periods from the environment because
    // ABL-297 §5 requires it. A quota is the opposite kind of number: an operator
    // who can raise Explorer to 100,000 requests with an env var can give the
    // product away without a diff. Checked as text because the claim is about
    // what the module *can* do, and a runtime check would only prove that this
    // particular process had nothing set.
    const source = fs.readFileSync(path.join(HERE, 'planLimits.ts'), 'utf8');
    expect(source).not.toContain('process.env');
  });
});
