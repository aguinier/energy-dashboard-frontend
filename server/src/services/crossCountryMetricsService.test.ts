import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildFixtureDb, WINDOW } from '../test/fixtureDb.js';
import { rangeArgs, timestampRange } from '../utils/timestamp.js';

const fixtureDb = buildFixtureDb();
vi.mock('../config/database.js', () => ({ default: fixtureDb }));
vi.mock('./readQueryWorker.js', () => ({ runReadQueryInWorker: vi.fn() }));

const { crossCountryMetricsSql, VALID_FORECAST_TYPES, wape, getCrossCountryMetrics } =
  await import('./crossCountryMetricsService.js');

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
});

describe('cross-country metrics query plan', () => {
  it('materializes latest forecast vintages in one forecast-table pass', () => {
    fixtureDb.exec(`
      CREATE INDEX idx_forecasts_lookup
        ON forecasts(country_code, forecast_type, target_timestamp_utc);
      CREATE INDEX idx_load_country_time
        ON energy_load(country_code, timestamp_utc);
      CREATE INDEX idx_price_country_time
        ON energy_price(country_code, timestamp_utc);
      CREATE INDEX idx_renewable_country_time
        ON energy_renewable(country_code, timestamp_utc);
    `);

    const detail = fixtureDb
      .prepare(`EXPLAIN QUERY PLAN ${crossCountryMetricsSql(VALID_FORECAST_TYPES)}`)
      .all(...rangeArgs(timestampRange(WINDOW.start, WINDOW.end)))
      .map((row) => (row as { detail: string }).detail);

    const forecastPasses = detail.filter((line) => /^(?:SCAN|SEARCH) forecasts USING (?:COVERING )?INDEX/.test(line));
    expect(forecastPasses, detail.join('\n')).toHaveLength(1);
    expect(detail.some((line) => line.includes('CORRELATED SCALAR SUBQUERY'))).toBe(false);
    expect(detail).toContain('MATERIALIZE latest_keys');
    expect(detail).toContain('MATERIALIZE latest_forecasts');
  });
});

describe('skill vs seasonal-naive (ABL-186)', () => {
  // AT load is not part of the shared fixture's D-7 window (2026-06-24) — seeded
  // once here, in a single beforeAll, so every `it` below reads one consistent
  // dataset rather than risking duplicate rows from re-seeding per test. AT's
  // WINDOW actual is 600/620/640/660 against an xgboost forecast of
  // 540/560/580/600 (error 60 flat, WAPE 9.52 — see crossCountryComparison.test.ts).
  //
  // Hour 0's D-7 reading is seeded as an impossible-zero placeholder (the same
  // shape ABL-35/ABL-50 guard against on the actuals side) and must drop out of
  // the baseline intersection rather than join as `load_mw: 0`. Hours 1-3 are a
  // real D-7 baseline, 10 MW off the actual at every hour.
  beforeAll(() => {
    fixtureDb.exec(`
      INSERT INTO energy_load (country_code, timestamp_utc, load_mw) VALUES
        ('AT', '2026-06-24 00:00:00', 0),
        ('AT', '2026-06-24 01:00:00', 610),
        ('AT', '2026-06-24 02:00:00', 630),
        ('AT', '2026-06-24 03:00:00', 650);
    `);
  });

  it('drops an impossible-zero D-7 reading from the intersection rather than joining it as a real baseline', () => {
    const result = getCrossCountryMetrics('load', WINDOW.start, WINDOW.end);
    expect(result.AT.wape).toBe(9.52);
    // Only 3 of the 4 hours have a usable D-7 baseline.
    expect(result.AT.skillVsSeasonalNaive.n).toBe(3);
    expect(result.AT.skillVsSeasonalNaive.n).toBeLessThanOrEqual(result.AT.dataPoints);
  });

  it('scores skill on that intersection, and renders a loss as a negative number', () => {
    const result = getCrossCountryMetrics('load', WINDOW.start, WINDOW.end);
    // Over hours 1-3: actual 620/640/660 (sum 1920), model error 60 flat (sum
    // 180, WAPE 9.375), D-7 baseline error 10 flat (sum 30, WAPE 1.5625).
    // skill = 100*(1 - 9.375/1.5625) = -500 — a forecast six times worse than
    // "the same hour last week", not a small or neutral number.
    expect(result.AT.skillVsSeasonalNaive).toEqual({ n: 3, skillPct: -500, baselineWape: 1.56 });
  });

  it('is insufficient data, not a misleading zero, when no D-7 actual exists', () => {
    // DE has WAPE-measurable rows in WINDOW but nothing seven days earlier
    // anywhere in the fixture.
    const result = getCrossCountryMetrics('load', WINDOW.start, WINDOW.end);
    expect(result.DE.wape).not.toBeNull();
    expect(result.DE.skillVsSeasonalNaive).toEqual({ n: 0, skillPct: null, baselineWape: null });
  });
});
