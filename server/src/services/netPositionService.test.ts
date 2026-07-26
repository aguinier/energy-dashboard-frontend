import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database, { type Database as DatabaseType } from 'better-sqlite3';

// The module under test imports the shared connection, which opens a real
// SQLite file at import time. Tests always pass their own handle, so the
// default just needs to not exist.
vi.mock('../config/database.js', () => ({ default: null }));

const {
  getNetPosition,
  getNetPositionActuals,
  getNetPositionForecast,
  resolveBiddingZone,
} = await import('./netPositionService.js');

const SCHEMA = `
  CREATE TABLE net_position (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL,
    timestamp_utc TEXT NOT NULL,
    net_position_mw REAL,
    data_quality TEXT
  );
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
  );
`;

const QUANTILES_SCHEMA = `
  CREATE TABLE forecast_quantiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL,
    forecast_type TEXT NOT NULL,
    target_timestamp_utc TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    quantile REAL NOT NULL,
    forecast_value REAL NOT NULL,
    model_name TEXT NOT NULL
  );
`;

function seedActuals(db: DatabaseType) {
  const ins = db.prepare(
    'INSERT INTO net_position (country_code, timestamp_utc, net_position_mw) VALUES (?, ?, ?)'
  );
  ins.run('BE', '2026-07-26 00:00:00', -1200.5);
  ins.run('BE', '2026-07-26 01:00:00', -980.0);
  ins.run('BE', '2026-07-27 00:00:00', 340.0);
  ins.run('DE', '2026-07-26 00:00:00', 5176.05);
  ins.run('FR', '2026-07-26 00:00:00', 800.0);
}

function seedForecast(db: DatabaseType, generatedAt: string, value: number) {
  db.prepare(
    `INSERT INTO forecasts
       (country_code, forecast_type, target_timestamp_utc, generated_at,
        horizon_hours, forecast_value, model_name, model_version)
     VALUES ('BE','net_position','2026-07-28 00:00:00',?,40,?,'chronos-2-V010','20260726_070628')`
  ).run(generatedAt, value);
}

describe('resolveBiddingZone', () => {
  it('maps DE and LU to the Core CCR zone DE_LU', () => {
    expect(resolveBiddingZone('DE')).toBe('DE_LU');
    expect(resolveBiddingZone('LU')).toBe('DE_LU');
  });

  it('leaves other countries alone', () => {
    expect(resolveBiddingZone('BE')).toBe('BE');
    expect(resolveBiddingZone('fr')).toBe('FR');
  });

  it('does not apply the price-zone mapping', () => {
    // Prices map IT -> IT_NORD; that would be wrong for a national net position.
    expect(resolveBiddingZone('IT')).toBe('IT');
  });
});

describe('getNetPositionActuals', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    seedActuals(db);
  });

  it('returns points in range as ISO timestamps', () => {
    const rows = getNetPositionActuals('BE', '2026-07-26 00:00:00', '2026-07-26 23:00:00', db);
    expect(rows).toEqual([
      { timestamp: '2026-07-26T00:00:00', net_position_mw: -1200.5 },
      { timestamp: '2026-07-26T01:00:00', net_position_mw: -980 },
    ]);
  });

  it('reads LU from the DE_LU series stored under DE', () => {
    const lu = getNetPositionActuals('LU', '2026-07-26 00:00:00', '2026-07-26 23:00:00', db);
    expect(lu).toEqual([{ timestamp: '2026-07-26T00:00:00', net_position_mw: 5176.05 }]);
  });

  it('returns an empty array for a country with no data', () => {
    expect(
      getNetPositionActuals('GR', '2026-07-26 00:00:00', '2026-07-26 23:00:00', db)
    ).toEqual([]);
  });
});

describe('getNetPositionForecast', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
  });

  it('returns the newest vintage when several runs exist', () => {
    seedForecast(db, '2026-07-26 06:00:43.125465', -100);
    seedForecast(db, '2026-07-26 07:06:28.960696', -57.2);

    const { points, meta } = getNetPositionForecast('BE', db);
    expect(points).toHaveLength(1);
    expect(points[0].p50).toBe(-57.2);
    expect(meta.generated_at).toBe('2026-07-26T07:06:28.960696');
  });

  it('degrades to a median-only forecast when forecast_quantiles is absent', () => {
    seedForecast(db, '2026-07-26 07:06:28.960696', -57.2);

    const { points, meta } = getNetPositionForecast('BE', db);
    expect(meta.has_band).toBe(false);
    expect(points[0]).toEqual({ timestamp: '2026-07-28T00:00:00', p50: -57.2, p10: null, p90: null });
  });

  it('attaches the p10/p90 band when quantiles are present', () => {
    db.exec(QUANTILES_SCHEMA);
    seedForecast(db, '2026-07-26 07:06:28.960696', -57.2);
    const insq = db.prepare(
      `INSERT INTO forecast_quantiles
         (country_code, forecast_type, target_timestamp_utc, generated_at,
          quantile, forecast_value, model_name)
       VALUES ('BE','net_position','2026-07-28 00:00:00','2026-07-26 07:06:28.960696',?,?,'chronos-2-V010')`
    );
    insq.run(0.1, -166.5);
    insq.run(0.5, -57.2);
    insq.run(0.9, 56.1);

    const { points, meta } = getNetPositionForecast('BE', db);
    expect(meta.has_band).toBe(true);
    expect(points[0]).toEqual({
      timestamp: '2026-07-28T00:00:00',
      p50: -57.2,
      p10: -166.5,
      p90: 56.1,
    });
  });

  it('reports the bidding zone and null model metadata when nothing is forecast', () => {
    const { points, meta } = getNetPositionForecast('GR', db);
    expect(points).toEqual([]);
    expect(meta).toEqual({
      bidding_zone: 'GR',
      model_name: null,
      model_version: null,
      generated_at: null,
      has_band: false,
    });
  });
});

describe('getNetPosition', () => {
  it('combines actuals and forecast in one payload', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    seedActuals(db);
    seedForecast(db, '2026-07-26 07:06:28.960696', -57.2);

    const out = getNetPosition('BE', '2026-07-26 00:00:00', '2026-07-27 23:00:00', db);
    expect(out.actual).toHaveLength(3);
    expect(out.forecast).toHaveLength(1);
    expect(out.meta.bidding_zone).toBe('BE');
  });
});
