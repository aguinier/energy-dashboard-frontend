import { describe, it, expect } from 'vitest';
import { calculateAccuracy, NO_METRICS, type AccuracyPoint } from './accuracyMetrics.js';

/**
 * The arithmetic, without a database.
 *
 * Pure on purpose: "does an unmeasurable window return nulls rather than zeros"
 * is the assertion this endpoint most needs, and it should not require seeding
 * SQLite to make. ABL-293 §2a is emphatic that a country whose actuals summed to
 * zero over a window must not render as a flawless 0% error, and `0` is the best
 * possible score — so every one of these cases is a case where the *tidy* answer
 * is the wrong one.
 */

const point = (forecast: number, actual: number): AccuracyPoint => ({ forecast, actual });

describe('an unmeasurable window is null, never zero', () => {
  it('returns nulls for an empty sample', () => {
    expect(calculateAccuracy([])).toEqual(NO_METRICS);
  });

  it('does not report a flawless forecast when nothing was measured', () => {
    // The sentence this whole endpoint turns on, as an assertion. Every one of
    // these being `0` instead would be a perfect score for a window in which
    // nothing happened.
    const metrics = calculateAccuracy([]);
    for (const field of ['mape', 'wape', 'smape', 'mae', 'rmse'] as const) {
      expect(metrics[field]).toBeNull();
      expect(metrics[field]).not.toBe(0);
    }
    expect(metrics.sample_size).toBe(0);
  });

  it('returns a null WAPE when the actuals sum to zero, with the sample intact', () => {
    // Solar overnight, or a zone reporting nothing. The points are real and
    // `mae`/`rmse` are measurable over them; the *percentage* is not, because
    // there is no magnitude to weight against.
    const metrics = calculateAccuracy([point(5, 0), point(3, 0)]);

    expect(metrics.wape).toBeNull();
    expect(metrics.mape).toBeNull(); // no positive actual either
    expect(metrics.sample_size).toBe(2);
    expect(metrics.mae).toBe(4);
  });
});

describe('mape covers only the points where a percentage means something', () => {
  it('skips non-positive actuals and says how many it used', () => {
    // A percentage error is undefined at zero, and dividing by a *signed* actual
    // lets a negative day-ahead price cancel error instead of accumulating it
    // (ABL-19). Both are excluded — and the count is published, because a MAPE
    // computed over a third of the sample is otherwise indistinguishable from
    // one computed over all of it.
    const metrics = calculateAccuracy([
      point(90, 100), // 10%
      point(80, 100), // 20%
      point(5, 0), // skipped: undefined at zero
      point(-10, -20), // skipped: negative actual
    ]);

    expect(metrics.mape).toBe(15);
    expect(metrics.mape_samples).toBe(2);
    expect(metrics.sample_size).toBe(4);
  });

  it('is null when no point had a positive actual, even with points in hand', () => {
    const metrics = calculateAccuracy([point(1, 0), point(2, -5)]);

    expect(metrics.mape).toBeNull();
    expect(metrics.mape_samples).toBe(0);
    expect(metrics.sample_size).toBe(2);
  });

  it('is the measure a near-zero actual can run away with — which is why wape ships beside it', () => {
    // ABL-388's shape, reproduced small: one dawn point at 0.4 MW against a
    // 40 MW forecast contributes 9,900% and swamps a hundred well-forecast
    // hours. Both numbers are arithmetically right; publishing only the first
    // would sell an artifact of the denominator as a quality figure.
    const points = [...Array(99)].map(() => point(100, 100));
    points.push(point(40, 0.4));

    const metrics = calculateAccuracy(points);

    expect(metrics.mape).toBeGreaterThan(90);
    expect(metrics.wape).toBeLessThan(1);
  });
});

describe('smape is the 0-100 form, and says so', () => {
  it('cannot exceed 100 even when the forecast is wildly wrong', () => {
    // The property that distinguishes this from the halved-denominator form,
    // which is bounded at 200. A subscriber reconciling our number against their
    // own implementation will otherwise find it exactly half theirs.
    const metrics = calculateAccuracy([point(1_000_000, 1)]);

    expect(metrics.smape).toBeLessThanOrEqual(100);
    expect(metrics.smape).toBeGreaterThan(99);
  });

  it('is 0 for a perfect forecast and 100 for a sign flip', () => {
    expect(calculateAccuracy([point(50, 50)]).smape).toBe(0);
    expect(calculateAccuracy([point(-50, 50)]).smape).toBe(100);
  });

  it('skips a pair where both sides are exactly zero rather than scoring it perfect', () => {
    // `0/0` is undefined, and a midnight solar hour forecast at zero is not
    // evidence of skill. Counting it as a perfect 0 would let a night's worth of
    // trivially-right hours drown a day's worth of real error.
    const metrics = calculateAccuracy([point(0, 0), point(150, 100)]);

    expect(metrics.smape_samples).toBe(1);
    expect(metrics.sample_size).toBe(2);
    expect(metrics.smape).toBe(20); // 50 / (150 + 100)
  });

  it('uses absolute values, so a negative price cannot cancel its own denominator', () => {
    const metrics = calculateAccuracy([point(-40, -60)]);

    expect(metrics.smape).toBe(20); // 20 / (60 + 40), not 20 / (-60 + -40)
  });
});

describe('mae and rmse are in the unit of the target', () => {
  it('computes both over every paired point', () => {
    // Errors of 10 and 30: MAE 20, RMSE sqrt((100 + 900) / 2) = 22.36. RMSE
    // above MAE is the signature of an uneven error distribution, which is the
    // reason both ship.
    const metrics = calculateAccuracy([point(90, 100), point(70, 100)]);

    expect(metrics.mae).toBe(20);
    expect(metrics.rmse).toBe(22.36);
  });

  it('is unaffected by the mape exclusions — its sample is every paired point', () => {
    const metrics = calculateAccuracy([point(10, 0), point(90, 100)]);

    expect(metrics.sample_size).toBe(2);
    expect(metrics.mae).toBe(10); // (10 + 10) / 2
    expect(metrics.mape_samples).toBe(1);
  });
});

describe('wape is the shared definition, not a local one', () => {
  it('weights by magnitude — 100 * sum|error| / sum|actual|', () => {
    const metrics = calculateAccuracy([point(90, 100), point(60, 100)]);

    expect(metrics.wape).toBe(25); // (10 + 40) / 200
  });

  it('does not let a negative actual cancel the denominator', () => {
    // ABL-19: plain MAPE divided by the signed actual, so negative day-ahead
    // prices cancelled error instead of accumulating it. `|actual|` is what
    // stops that, and it is `services/wape.ts`'s property, exercised here
    // because this endpoint is the third caller to depend on it.
    const metrics = calculateAccuracy([point(10, 50), point(10, -50)]);

    expect(metrics.wape).toBe(100); // (40 + 60) / (50 + 50)
  });
});
