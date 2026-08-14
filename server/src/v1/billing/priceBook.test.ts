import { describe, it, expect } from 'vitest';
import { ACCOUNT_PLANS, type AccountPlan } from '../keys/apiKeyStore.js';
import { MONTHLY_PRICE_EUR, PLAN_LIMITS } from '../quota/planLimits.js';
import { checkAgainstPlanLimits, parsePriceBook, PRICE_BOOK_ENV, resolvePriceBook } from './priceBook.js';

/**
 * That the price book is **configuration**, and that a book which disagrees with
 * what ABL-302 is enforcing is refused rather than invoiced.
 *
 * ## Why the fixture is derived and not written down
 *
 * {@link validBook} is built *from* `quota/planLimits.ts` rather than by
 * transcribing figures. Two reasons, and both are the point of this file:
 *
 * 1. No price list is committed by ABL-307. Board Decision 1 is open, and a
 *    table of prices in a test fixture is still a table of prices in the
 *    repository — one `git grep` away from being quoted at somebody.
 * 2. Deriving it is what proves the cross-check is satisfiable by the figures
 *    the gate is *actually* enforcing today. A hand-written fixture would pass
 *    this file while disagreeing with production.
 */

type RawBook = {
  currency: string;
  effectiveFrom: string;
  plans: Record<string, { base: unknown; includedRequests: unknown; overagePerThousand: unknown }>;
};

/** A book that agrees with `planLimits.ts`, by construction. */
function validBook(): RawBook {
  return {
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
  } as RawBook;
}

function parse(mutate: (book: RawBook) => void = () => {}) {
  const book = validBook();
  mutate(book);
  return parsePriceBook(JSON.stringify(book), 'test-fixture.json');
}

describe('resolvePriceBook', () => {
  it('reports "undecided" rather than defaulting, when nothing is configured', () => {
    // The state the company is in, not an error. Every caller must handle it,
    // and none of them may invent a price.
    const resolution = resolvePriceBook({} as NodeJS.ProcessEnv);
    expect(resolution.status).toBe('undecided');
    if (resolution.status !== 'undecided') throw new Error('unreachable');
    expect(resolution.reason).toMatch(/Board Decision 1/);
    expect(resolution.reason).toMatch(/not committed to this repository/);
  });

  it('throws on a path that does not resolve rather than falling back to no prices', () => {
    // Falling back would turn a typo into a silent month of unpriced invoices.
    expect(() =>
      resolvePriceBook({ [PRICE_BOOK_ENV]: '/nope/prices.json' } as NodeJS.ProcessEnv, {
        readFile() {
          throw new Error('ENOENT');
        },
      })
    ).toThrow(/Cannot read the price book/);
  });

  it('reads a configured book through injected IO', () => {
    const resolution = resolvePriceBook(
      { [PRICE_BOOK_ENV]: '/prices.json' } as NodeJS.ProcessEnv,
      { readFile: () => JSON.stringify(validBook()) }
    );
    expect(resolution.status).toBe('configured');
  });
});

describe('parsePriceBook', () => {
  it('accepts a book derived from the figures /v1 is enforcing today', () => {
    // If this ever fails, `planLimits.ts` and this module have come apart and
    // the cross-check below is unsatisfiable — which is a louder problem than a
    // failing test in a billing directory.
    const book = parse();
    expect(book.status).toBe('configured');
    expect(book.plans.developer.includedRequests).toBe(PLAN_LIMITS.developer.monthlyRequests);
    expect(book.plans.professional.overagePerThousandMinor).toBe(100);
    expect(book.plans.enterprise.includedRequests).toBeNull();
  });

  it('fingerprints the prices, stably across formatting and key order', () => {
    // The question a reconciliation cannot otherwise ask: were these two
    // invoices computed under the same prices?
    const compact = parsePriceBook(JSON.stringify(validBook()), 'a.json');
    const pretty = parsePriceBook(JSON.stringify(validBook(), null, 4), 'b.json');
    expect(compact.fingerprint).toBe(pretty.fingerprint);

    const changed = parse((book) => {
      book.plans.developer.base = 59;
      // Keep the book internally consistent so it reaches the fingerprint.
      book.effectiveFrom = '2026-09-01';
    });
    expect(changed.fingerprint).not.toBe(compact.fingerprint);
  });

  it('requires a date, because an invoice cites which price list produced it', () => {
    expect(() => parse((book) => void (book.effectiveFrom = 'August'))).toThrow(/YYYY-MM-DD/);
  });

  it('requires an entry for every plan', () => {
    expect(() => parse((book) => void delete book.plans.enterprise)).toThrow(
      /no entry for plan "enterprise"/
    );
  });

  it('requires a free tier to be written as 0, not omitted', () => {
    // An absent price and a zero price are different facts, and only one of
    // them is a decision.
    expect(() => parse((book) => void (book.plans.explorer.base = null))).toThrow(
      /"base" is required/
    );
  });

  it('refuses a currency it does not handle', () => {
    expect(() => parse((book) => void (book.currency = 'USD'))).toThrow(/handles EUR only/);
  });
});

describe('checkAgainstPlanLimits — the reason this module reads quota/planLimits.ts', () => {
  it('passes for the current committed figures', () => {
    expect(checkAgainstPlanLimits(parse().plans)).toEqual([]);
  });

  it('catches an allowance that disagrees with the quota the gate serves', () => {
    // The most consequential mismatch, and the most boring-looking: the gate
    // serves 50,000 free and the invoice charges from 40,000.
    expect(() => parse((book) => void (book.plans.developer.includedRequests = 40_000))).toThrow(
      /includedRequests is 40,000 but PLAN_LIMITS.developer.monthlyRequests is 50,000/
    );
  });

  it('catches a price pair that sizes a different overage ceiling than the gate refuses at', () => {
    // `planLimits.softOverage()` derived `maxOverageRequests` from a base price
    // and a rate. Halve the base in the price book and the ceiling we refuse at
    // is no longer the cap we bill to, so "capped at 2× plan price" is false.
    expect(() => parse((book) => void (book.plans.professional.base = 124.5))).toThrow(
      /buy 124500 requests of overage at the published 2× cap, but PLAN_LIMITS.professional refuses at 249000/
    );
  });

  it('catches an overage rate that would be quoted on a line the ceiling was not sized with', () => {
    // Two price pairs can floor to the same ceiling and still differ; the
    // per-thousand figure is what appears on the invoice line.
    const problems = checkAgainstPlanLimits({
      ...parse().plans,
      professional: {
        plan: 'professional' as AccountPlan,
        baseMinor: 24_900,
        includedRequests: PLAN_LIMITS.professional.monthlyRequests,
        // Same ceiling by construction (floor(24900 × 1 / 100 × 1000) is
        // unchanged only if the rate is 100), so this must be caught by the
        // rate comparison rather than by the ceiling one.
        overagePerThousandMinor: 101,
      },
    });

    expect(problems.join('\n')).toMatch(/overagePerThousand is 101 minor units/);
  });

  it('catches a price on a plan that hard-stops, and a missing price on one that does not', () => {
    expect(() => parse((book) => void (book.plans.developer.overagePerThousand = 1))).toThrow(
      /has an overage price, but PLAN_LIMITS.developer hard-stops at quota/
    );
    expect(() => parse((book) => void (book.plans.professional.overagePerThousand = null))).toThrow(
      /served and never billed/
    );
  });

  it('reports every problem at once rather than one per run', () => {
    const problems = checkAgainstPlanLimits({
      ...parse().plans,
      explorer: { plan: 'explorer', baseMinor: 0, includedRequests: 5, overagePerThousandMinor: 7 },
    });
    expect(problems.length).toBeGreaterThan(1);
  });
});
