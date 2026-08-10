import { describe, expect, it, vi } from 'vitest';
import { buildFixtureDb, WINDOW } from '../test/fixtureDb.js';
import { rangeArgs, timestampRange } from '../utils/timestamp.js';

const fixtureDb = buildFixtureDb();
vi.mock('../config/database.js', () => ({ default: fixtureDb }));
vi.mock('./readQueryWorker.js', () => ({ runReadQueryInWorker: vi.fn() }));

const { crossCountryMetricsSql, VALID_FORECAST_TYPES, wape } = await import('./crossCountryMetricsService.js');

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
