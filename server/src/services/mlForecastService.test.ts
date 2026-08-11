import { beforeAll, describe, it, expect, vi } from 'vitest';
import { buildFixtureDb, WINDOW } from '../test/fixtureDb.js';

// `calculateMetrics`/`classifyCoverage`/`modelFilterSql` are pure and never
// touch `db`, but the ABL-214 join-fix tests below need a real one — the
// shared fixture, same as crossCountryMetricsService.test.ts.
const fixtureDb = buildFixtureDb();
vi.mock('../config/database.js', () => ({ default: fixtureDb }));

const { calculateMetrics, classifyCoverage, modelFilterSql, getMLForecastAccuracy } =
  await import('./mlForecastService.js');

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

describe('getMLForecastAccuracy — separator-agnostic actuals join (ABL-214)', () => {
  // Neither country is in the shared fixture's base seed, so these rows are
  // exclusively this describe block's.
  beforeAll(() => {
    fixtureDb.exec(`
      -- IT: the actual exists ONLY in 'T' form — the genuinely dropped case.
      -- Before this fix, REPLACE(f.target_timestamp_utc,'T',' ') = a.timestamp_utc
      -- normalised the forecast to space form and never matched this row.
      INSERT INTO energy_load (country_code, timestamp_utc, load_mw)
        VALUES ('IT', '2026-07-01T00:00:00', 700);
      INSERT INTO forecasts
        (country_code, forecast_type, target_timestamp_utc, generated_at, horizon_hours, forecast_value, model_name, model_version)
        VALUES ('IT', 'load', '2026-07-01T00:00:00', '2026-06-30T18:00:00.000000', 6, 650, 'catboost', 'v1');

      -- ES: a genuine ABL-211/ABL-215 conflict — BOTH forms exist for the same
      -- hour with DIFFERENT values (900 space-form, 999 'T'-form). The naive
      -- IN(...) join would match both rows and return two data points, or the
      -- wrong one; this must return exactly one, and it must be the space-form
      -- value — unchanged from what the pre-fix join already served.
      INSERT INTO energy_load (country_code, timestamp_utc, load_mw)
        VALUES ('ES', '2026-07-01 01:00:00', 900), ('ES', '2026-07-01T01:00:00', 999);
      INSERT INTO forecasts
        (country_code, forecast_type, target_timestamp_utc, generated_at, horizon_hours, forecast_value, model_name, model_version)
        VALUES ('ES', 'load', '2026-07-01T01:00:00', '2026-06-30T18:00:00.000000', 6, 850, 'catboost', 'v1');
    `);
  });

  it('rescues an actual stored only in T-form, which the old one-sided REPLACE join dropped', () => {
    const rows = getMLForecastAccuracy('IT', 'load', WINDOW.start, WINDOW.end);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actual_value: 700, forecast_value: 650, error: 50 });
  });

  it('never fans out on a conflicting T/space pair, and keeps preferring the space-form value', () => {
    const rows = getMLForecastAccuracy('ES', 'load', WINDOW.start, WINDOW.end);
    // Exactly one data point — not two. A naive `actual IN (spaceForm, tForm)`
    // join would return both ES rows for this single forecast row.
    expect(rows).toHaveLength(1);
    expect(rows[0].actual_value).toBe(900);
  });
});
