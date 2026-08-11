import { describe, expect, it } from 'vitest';
import { computeSkillVsSeasonalNaive } from './skillScore.js';

describe('computeSkillVsSeasonalNaive', () => {
  it('is positive when the model beats the D-7 baseline', () => {
    // actual 1000/1100/1200/1300, forecast 900/1000/1100/1200 (error 100 flat),
    // D-7 baseline flat at 700 (error 300/400/500/600).
    const result = computeSkillVsSeasonalNaive({
      n: 4,
      actualAbsSum: 4600,
      modelErrAbsSum: 400,
      baselineErrAbsSum: 1800,
    });
    // model WAPE = 100*400/4600 = 8.6957%, baseline WAPE = 100*1800/4600 = 39.1304%
    // skill = 100*(1 - 8.6957/39.1304) = 77.78
    expect(result).toEqual({ n: 4, skillPct: 77.78, baselineWape: 39.13 });
  });

  it('is negative — and reads as a failure, not a neutral number — when the model loses to D-7', () => {
    // actual 600/620/640/660, forecast 540/560/580/600 (error 60 flat),
    // D-7 baseline actual-50 (error 50 flat).
    const result = computeSkillVsSeasonalNaive({
      n: 4,
      actualAbsSum: 2520,
      modelErrAbsSum: 240,
      baselineErrAbsSum: 200,
    });
    // model WAPE = 9.5238%, baseline WAPE = 7.9365%, skill = 100*(1-1.2) = -20
    expect(result).toEqual({ n: 4, skillPct: -20, baselineWape: 7.94 });
    expect(result.skillPct).toBeLessThan(0);
  });

  it('is insufficient data — not a misleading 0 — when no row has a D-7 baseline', () => {
    const result = computeSkillVsSeasonalNaive({
      n: 0, actualAbsSum: 0, modelErrAbsSum: 0, baselineErrAbsSum: 0,
    });
    expect(result).toEqual({ n: 0, skillPct: null, baselineWape: null });
  });

  it('is null, not 0, when the intersection actuals sum to zero', () => {
    // Every actual in the baseline-available subset happens to be a measured
    // zero (e.g. solar overnight) — same "NULL is not 0" rule as plain WAPE.
    const result = computeSkillVsSeasonalNaive({
      n: 3, actualAbsSum: 0, modelErrAbsSum: 15, baselineErrAbsSum: 9,
    });
    expect(result).toEqual({ n: 3, skillPct: null, baselineWape: null });
  });

  it('is null when the baseline itself is a perfect predictor (would divide by zero)', () => {
    const result = computeSkillVsSeasonalNaive({
      n: 2, actualAbsSum: 100, modelErrAbsSum: 10, baselineErrAbsSum: 0,
    });
    expect(result.skillPct).toBeNull();
    expect(result.baselineWape).toBe(0);
  });
});
