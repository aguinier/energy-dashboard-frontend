import { describe, it, expect, beforeEach } from 'vitest';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import {
  ingestNetPositionForecast,
  ensureForecastQuantilesTable,
} from './netPositionIngestService.js';
import type { NetPositionForecastIngestPayload } from '../types/index.js';

/** The canonical `forecasts` table as it exists on prod (superset of sidecar). */
const FORECASTS_DDL = `
  CREATE TABLE forecasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL,
    forecast_type TEXT NOT NULL,
    target_timestamp_utc TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    horizon_hours INTEGER,
    forecast_value REAL NOT NULL,
    model_name TEXT,
    model_version TEXT,
    renewable_type TEXT
  )
`;

function payload(
  overrides: Partial<NetPositionForecastIngestPayload> = {}
): NetPositionForecastIngestPayload {
  return {
    model: { name: 'chronos-2-V010', version: '20260726_070628' },
    generated_at: '2026-07-26 07:06:28.960696',
    rows: [
      {
        country_code: 'BE',
        target_timestamp_utc: '2026-07-28 00:00:00',
        horizon_hours: 40,
        forecast_value: -57.2,
        quantiles: { '0.1': -166.5, '0.5': -57.2, '0.9': 56.1 },
      },
      {
        country_code: 'BE',
        target_timestamp_utc: '2026-07-28 01:00:00',
        horizon_hours: 41,
        forecast_value: -61.0,
        quantiles: { '0.1': -170.0, '0.5': -61.0, '0.9': 48.0 },
      },
    ],
    ...overrides,
  };
}

describe('ingestNetPositionForecast', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(FORECASTS_DDL);
  });

  it('creates forecast_quantiles when the database has never had it', () => {
    const before = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='forecast_quantiles'")
      .get();
    expect(before).toBeUndefined();

    ingestNetPositionForecast(db, payload());

    const after = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='forecast_quantiles'")
      .get();
    expect(after).toBeDefined();
  });

  it('inserts points and their quantiles', () => {
    const result = ingestNetPositionForecast(db, payload());

    expect(result).toEqual({ points: 2, quantiles: 6, replaced: false });
    expect(
      (db.prepare('SELECT COUNT(*) n FROM forecasts').get() as { n: number }).n
    ).toBe(2);
    expect(
      (db.prepare('SELECT COUNT(*) n FROM forecast_quantiles').get() as { n: number }).n
    ).toBe(6);
  });

  it('is idempotent: re-posting the same run does not duplicate rows', () => {
    ingestNetPositionForecast(db, payload());
    const second = ingestNetPositionForecast(db, payload());

    expect(second.replaced).toBe(true);
    expect(
      (db.prepare('SELECT COUNT(*) n FROM forecasts').get() as { n: number }).n
    ).toBe(2);
    expect(
      (db.prepare('SELECT COUNT(*) n FROM forecast_quantiles').get() as { n: number }).n
    ).toBe(6);
  });

  it('keeps separate runs as distinct vintages', () => {
    ingestNetPositionForecast(db, payload());
    ingestNetPositionForecast(
      db,
      payload({ generated_at: '2026-07-26 08:00:00.000000' })
    );

    expect(
      (db.prepare('SELECT COUNT(*) n FROM forecasts').get() as { n: number }).n
    ).toBe(4);
    expect(
      (db.prepare('SELECT COUNT(DISTINCT generated_at) n FROM forecasts').get() as { n: number }).n
    ).toBe(2);
  });

  it('replacing one country leaves another country untouched', () => {
    ingestNetPositionForecast(db, payload());
    ingestNetPositionForecast(
      db,
      payload({
        rows: [
          {
            country_code: 'FR',
            target_timestamp_utc: '2026-07-28 00:00:00',
            horizon_hours: 40,
            forecast_value: 237.3,
          },
        ],
      })
    );
    // Re-post BE only; FR must survive.
    ingestNetPositionForecast(db, payload());

    const byCountry = db
      .prepare('SELECT country_code, COUNT(*) n FROM forecasts GROUP BY country_code')
      .all() as Array<{ country_code: string; n: number }>;
    expect(byCountry).toEqual([
      { country_code: 'BE', n: 2 },
      { country_code: 'FR', n: 1 },
    ]);
  });

  it('tolerates rows without a quantile band', () => {
    const result = ingestNetPositionForecast(
      db,
      payload({
        rows: [
          {
            country_code: 'SK',
            target_timestamp_utc: '2026-07-28 00:00:00',
            horizon_hours: 40,
            forecast_value: 92.8,
          },
        ],
      })
    );
    expect(result.points).toBe(1);
    expect(result.quantiles).toBe(0);
  });

  it('uppercases country codes so casing cannot split a series', () => {
    ingestNetPositionForecast(
      db,
      payload({
        rows: [
          {
            country_code: 'be',
            target_timestamp_utc: '2026-07-28 00:00:00',
            horizon_hours: 40,
            forecast_value: -57.2,
          },
        ],
      })
    );
    const row = db.prepare('SELECT country_code FROM forecasts').get() as {
      country_code: string;
    };
    expect(row.country_code).toBe('BE');
  });

  it('ensureForecastQuantilesTable is safe to call twice', () => {
    ensureForecastQuantilesTable(db);
    expect(() => ensureForecastQuantilesTable(db)).not.toThrow();
  });
});
