import { describe, it, expect, vi } from 'vitest';

// The module under test imports the shared database connection, which opens
// a real SQLite file at import time (same pattern as tsoForecastService.test.ts
// and renewableService.test.ts). `calculateMetrics` is a pure function and
// never touches `db`, so the default export just needs to not exist.
vi.mock('../config/database.js', () => ({ default: null }));

const { calculateMetrics, classifyCoverage, modelFilterSql } = await import('./mlForecastService.js');

const pt = (actual: number, forecast: number) => ({
  timestamp: '2026-07-27T00:00:00Z',
  forecast_value: forecast,
  actual_value: actual,
  error: actual - forecast,
  error_pct: actual > 0 ? Math.abs(actual - forecast) / actual * 100 : null,
  horizon_hours: 1,
});

describe('calculateMetrics', () => {
  it('returns null metrics when there are no paired points', () => {
    const m = calculateMetrics([]);
    expect(m).toEqual({ mae: null, mape: null, rmse: null, bias: null, dataPoints: 0, mapeSamples: 0 });
  });

  it('computes mae and rmse over every paired point', () => {
    const m = calculateMetrics([pt(100, 90), pt(100, 110)]);
    expect(m.mae).toBe(10);
    expect(m.rmse).toBe(10);
    expect(m.dataPoints).toBe(2);
  });

  it('excludes non-positive actuals from mape instead of scoring them zero', () => {
    // The 0-actual point is unmeasurable as a percentage. Counting it as 0%
    // would halve the reported mape.
    const m = calculateMetrics([pt(100, 90), pt(0, 50)]);
    expect(m.mape).toBe(10);
    expect(m.mapeSamples).toBe(1);
    expect(m.dataPoints).toBe(2);
  });

  it('returns a null mape when no point has a positive actual', () => {
    const m = calculateMetrics([pt(0, 50)]);
    expect(m.mape).toBeNull();
    expect(m.mapeSamples).toBe(0);
    expect(m.mae).toBe(50);
  });

  it('computes bias as the mean signed error (actual - forecast)', () => {
    const m = calculateMetrics([pt(100, 90), pt(100, 110)]);
    // errors are +10 and -10, so bias is 0
    expect(m.bias).toBe(0);
  });
});

describe('modelFilterSql', () => {
  it('produces no clause when no model was requested', () => {
    // Load-bearing: an empty clause is what keeps the unpinned query identical
    // to the one that ran before the `model` parameter existed.
    expect(modelFilterSql('f1', undefined)).toBe('');
    expect(modelFilterSql('f1', '')).toBe('');
  });

  it('pins the requested alias to a bound parameter, never an interpolated value', () => {
    // The model name reaches SQLite as a bound parameter; the SQL text itself
    // must never carry it.
    expect(modelFilterSql('f1', 'xgboost')).toBe('AND f1.model_name = ?');
    expect(modelFilterSql('f2', 'xgboost')).toBe('AND f2.model_name = ?');
    expect(modelFilterSql('f1', "'; DROP TABLE forecasts--")).toBe('AND f1.model_name = ?');
  });
});

describe('classifyCoverage', () => {
  it('reports served when points were actually paired', () => {
    expect(classifyCoverage(42, true)).toBe('served');
  });

  it('distinguishes a model that does not serve this country from zero error', () => {
    // catboost has no rows for FR load — measured 2026-08-05, coverage is
    // disjoint. This must read as "no coverage", never as a flawless 0%.
    expect(classifyCoverage(0, false)).toBe('no_model_coverage');
  });

  it('distinguishes no-coverage from forecast-present-but-unpaired', () => {
    // The model forecast this window, but no actual has landed against it —
    // a different fact from "this model does not serve here".
    expect(classifyCoverage(0, true)).toBe('no_paired_actuals');
  });
});
