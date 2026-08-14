import { describe, it, expect } from 'vitest';
import {
  addMoney,
  BILLING_CURRENCY,
  floorDiv,
  formatMinor,
  formatMoney,
  money,
  parseMajorToMinor,
  roundHalfUpDiv,
} from './money.js';

/**
 * The two rounding rules, and the one property that makes them worth having:
 * every step that decides what a customer owes rounds *down*, and only VAT
 * rounds up. If either direction were ever reversed the difference would be one
 * cent, on one invoice, and it would be found by the customer.
 */

describe('money', () => {
  it('refuses a fractional minor unit rather than rounding it away', () => {
    // The throw is the point: a non-integer here means some caller did
    // arithmetic in euro, and rounding would hide the only evidence of it.
    expect(() => money(12.5)).toThrow(/whole number of minor units/);
    expect(money(1250)).toEqual({ minor: 1250, currency: BILLING_CURRENCY });
  });

  it('adds without ever leaving the integers', () => {
    // 0.1 + 0.2 in euro is the canonical float failure; in cents it is 30.
    expect(addMoney(money(10), money(20)).minor).toBe(30);
  });
});

describe('floorDiv — what we charge', () => {
  it('rounds down, so a partial unit is never billed', () => {
    // €249 prorated over 13 of 31 days: 24900 × 13/31 = 10441.9…
    expect(floorDiv(24_900, 13, 31)).toBe(10_441);
  });

  it('is exact when the fraction is one, which is what makes a whole month cost the plan fee', () => {
    // The property the invoice depends on: a segment covering the whole month
    // prices at exactly the plan fee, with no remainder to explain to anyone.
    for (const fee of [0, 1, 4900, 24_900, 999_99]) {
      expect(floorDiv(fee, 2_678_400_000, 2_678_400_000)).toBe(fee);
    }
  });

  it('multiplies before dividing, so the intermediate is never a float', () => {
    // 7 × 1/3 is 2.33…; had this divided first it would be 7 × 0.333… and the
    // result would depend on where the precision was lost.
    expect(floorDiv(7, 1, 3)).toBe(2);
    expect(floorDiv(1_000_000_001, 1, 3)).toBe(333_333_333);
  });

  it('refuses a non-integer term and a zero denominator', () => {
    expect(() => floorDiv(100, 1.5, 3)).toThrow(/must be an integer/);
    expect(() => floorDiv(100, 1, 0)).toThrow(/denominator is zero/);
  });
});

describe('roundHalfUpDiv — VAT, the one thing allowed to round up', () => {
  it('rounds a half away from zero', () => {
    // 19% of €1.00 is 19; 19% of €0.50 is 9.5, which must become 10 and not 9.
    expect(roundHalfUpDiv(100, 1900, 10_000)).toBe(19);
    expect(roundHalfUpDiv(50, 1900, 10_000)).toBe(10);
  });

  it('handles a fractional statutory rate exactly', () => {
    // Finland is 25.5%, which is why rates are basis points and not percents.
    // 25.5% of €49.00 = €12.495 → €12.50.
    expect(roundHalfUpDiv(4900, 2550, 10_000)).toBe(1250);
  });

  it('is symmetric on negatives, so a credit note would round to the same magnitude', () => {
    expect(roundHalfUpDiv(-50, 1900, 10_000)).toBe(-10);
    expect(roundHalfUpDiv(50, 1900, 10_000)).toBe(10);
  });

  it('is zero at a zero rate, which is the reverse charge and the outside-scope case', () => {
    expect(roundHalfUpDiv(123_456, 0, 10_000)).toBe(0);
  });
});

describe('formatting', () => {
  it('renders a sub-euro amount with its leading zero', () => {
    expect(formatMinor(5)).toBe('0.05');
    expect(formatMinor(0)).toBe('0.00');
    expect(formatMinor(1234)).toBe('12.34');
    expect(formatMinor(-1234)).toBe('-12.34');
  });

  it('renders from the integer, so the printed cent is the stored one', () => {
    // 8.29 is not representable in binary floating point; via `/ 100` this
    // prints 8.290000000000001 in some engines. Via string surgery it cannot.
    expect(formatMinor(829)).toBe('8.29');
    expect(formatMoney(money(24_900))).toBe('249.00 EUR');
  });
});

describe('parseMajorToMinor — the one place a human writes an amount', () => {
  it('accepts the forms a price book is written in', () => {
    expect(parseMajorToMinor('49', 'base')).toBe(4900);
    expect(parseMajorToMinor('49.00', 'base')).toBe(4900);
    expect(parseMajorToMinor('0.10', 'overage')).toBe(10);
    expect(parseMajorToMinor('1', 'overage')).toBe(100);
    expect(parseMajorToMinor(249, 'base')).toBe(24_900);
    expect(parseMajorToMinor(0.5, 'base')).toBe(50);
  });

  it('refuses a third decimal place rather than rounding it to zero', () => {
    // A price book saying 0.001 is somebody writing a per-request price into a
    // per-thousand field. Rounded to zero it would serve every overage free.
    expect(() => parseMajorToMinor('0.001', 'overage')).toThrow(/at most two decimal places/);
  });

  it('refuses anything that is not an amount', () => {
    expect(() => parseMajorToMinor('€49', 'base')).toThrow();
    expect(() => parseMajorToMinor('', 'base')).toThrow();
    expect(() => parseMajorToMinor(Number.NaN, 'base')).toThrow(/not a finite amount/);
    expect(() => parseMajorToMinor(true, 'base')).toThrow(/number or string/);
  });
});
