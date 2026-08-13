import { describe, expect, it } from 'vitest';
import { wape } from './wape.js';

// This file imports no DB-touching module, so it runs without a database, a
// fixture or a mock. The cases below moved here from
// `crossCountryMetricsService.test.ts` when ABL-388 extracted the function;
// that file had to build a fixture database before it could import a pure
// arithmetic helper.

describe('wape', () => {
  it('is zero for a perfect forecast', () => {
    expect(wape([{ actual: 50, forecast: 50 }, { actual: 20, forecast: 20 }])).toBe(0);
  });

  it('does not explode on a near-zero actual', () => {
    const value = wape([{ actual: 0.01, forecast: 5 }, { actual: 100, forecast: 100 }]);
    expect(value).toBeLessThan(20);
  });

  it('does not let negative actuals cancel error', () => {
    expect(wape([{ actual: -50, forecast: 0 }, { actual: 50, forecast: 0 }])).toBe(100);
  });

  it('returns null when the summed magnitude is zero', () => {
    expect(wape([{ actual: 0, forecast: 3 }])).toBeNull();
  });

  it('returns null for an empty series', () => {
    expect(wape([])).toBeNull();
  });

  // ABL-388: the property the generation accuracy endpoint needed.
  it('is not dominated by a single dawn point the way MAPE is', () => {
    // One near-zero actual badly missed, beside a day of good forecasts.
    const pairs = [
      { actual: 0.4, forecast: 40 },
      ...Array.from({ length: 10 }, () => ({ actual: 1000, forecast: 1050 })),
    ];

    // What the per-point mean does with it: the dawn point alone contributes
    // 9,900%, so the mean lands near 900% and reads as a broken forecast.
    const perPointMean =
      pairs.reduce((sum, p) => sum + (100 * Math.abs(p.actual - p.forecast)) / p.actual, 0) /
      pairs.length;
    expect(perPointMean).toBeGreaterThan(900);

    // Weighted by magnitude, that same point is worth about as much as it is.
    expect(wape(pairs)).toBeLessThan(10);
  });

  it('skips non-finite pairs rather than poisoning both sums to NaN', () => {
    const value = wape([
      { actual: Number.NaN, forecast: 10 },
      { actual: 100, forecast: 90 },
    ]);
    expect(value).toBe(10);
  });

  it('is null rather than 0 when every actual is a measured zero', () => {
    // Solar overnight: the forecast was wrong, but there is no magnitude to
    // express the error as a fraction of. Never a flawless 0%.
    expect(wape([{ actual: 0, forecast: 12 }, { actual: 0, forecast: 8 }])).toBeNull();
  });

  it('rounds to two decimals', () => {
    expect(wape([{ actual: 3, forecast: 4 }])).toBe(33.33);
  });
});
