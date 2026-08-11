import { describe, it, expect, beforeEach } from 'vitest';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import {
  captureForecastVintages,
  ensureForecastVintageArchiveTable,
} from './forecastVintageArchiveService.js';

/** Minimal DDL for the three source tables, matching their production shape. */
const SOURCE_DDL = `
  CREATE TABLE forecasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL,
    forecast_type TEXT NOT NULL,
    target_timestamp_utc TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    horizon_hours INTEGER,
    forecast_value REAL NOT NULL,
    model_name TEXT NOT NULL,
    model_version TEXT,
    renewable_type TEXT
  );

  CREATE TABLE energy_load_forecast (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL,
    target_timestamp_utc TEXT NOT NULL,
    forecast_value_mw REAL NOT NULL,
    forecast_type TEXT NOT NULL,
    forecast_run_time TIMESTAMP,
    horizon_hours INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    publication_timestamp_utc TIMESTAMP,
    forecast_min_mw REAL,
    forecast_max_mw REAL
  );

  CREATE TABLE energy_generation_forecast (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL,
    target_timestamp_utc TEXT NOT NULL,
    solar_mw REAL,
    wind_onshore_mw REAL,
    wind_offshore_mw REAL,
    total_forecast_mw REAL,
    forecast_type TEXT DEFAULT 'day_ahead',
    publication_timestamp_utc TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`;

function insertMl(
  db: DatabaseType,
  overrides: Partial<{
    country_code: string;
    forecast_type: string;
    target_timestamp_utc: string;
    generated_at: string;
    horizon_hours: number | null;
    forecast_value: number;
    model_name: string;
  }> = {}
) {
  const row = {
    country_code: 'DE',
    forecast_type: 'load',
    target_timestamp_utc: '2026-08-01T00:00:00',
    generated_at: '2026-07-31T18:00:00.000000',
    horizon_hours: 6,
    forecast_value: 1000,
    model_name: 'catboost',
    ...overrides,
  };
  db.prepare(
    `INSERT INTO forecasts
       (country_code, forecast_type, target_timestamp_utc, generated_at, horizon_hours, forecast_value, model_name)
     VALUES (@country_code, @forecast_type, @target_timestamp_utc, @generated_at, @horizon_hours, @forecast_value, @model_name)`
  ).run(row);
}

function insertTsoLoad(
  db: DatabaseType,
  overrides: Partial<{
    country_code: string;
    target_timestamp_utc: string;
    forecast_value_mw: number;
    forecast_type: string;
    publication_timestamp_utc: string | null;
  }> = {}
) {
  const row = {
    country_code: 'DE',
    target_timestamp_utc: '2026-08-01 00:00:00',
    forecast_value_mw: 950,
    forecast_type: 'day_ahead',
    publication_timestamp_utc: null as string | null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO energy_load_forecast
       (country_code, target_timestamp_utc, forecast_value_mw, forecast_type, publication_timestamp_utc)
     VALUES (@country_code, @target_timestamp_utc, @forecast_value_mw, @forecast_type, @publication_timestamp_utc)`
  ).run(row);
}

function insertTsoGeneration(
  db: DatabaseType,
  overrides: Partial<{
    country_code: string;
    target_timestamp_utc: string;
    solar_mw: number | null;
    wind_onshore_mw: number | null;
    wind_offshore_mw: number | null;
    publication_timestamp_utc: string | null;
  }> = {}
) {
  const row = {
    country_code: 'DE',
    target_timestamp_utc: '2026-08-01 00:00:00',
    solar_mw: 90 as number | null,
    wind_onshore_mw: 190 as number | null,
    wind_offshore_mw: null as number | null,
    publication_timestamp_utc: null as string | null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO energy_generation_forecast
       (country_code, target_timestamp_utc, solar_mw, wind_onshore_mw, wind_offshore_mw, publication_timestamp_utc)
     VALUES (@country_code, @target_timestamp_utc, @solar_mw, @wind_onshore_mw, @wind_offshore_mw, @publication_timestamp_utc)`
  ).run(row);
}

function archiveRows(db: DatabaseType) {
  return db
    .prepare(
      `SELECT source, forecast_type, country_code, target_timestamp_utc, model_name,
              run_timestamp_utc, horizon_hours, forecast_value, first_seen_at
       FROM forecast_vintage_archive
       ORDER BY id`
    )
    .all();
}

describe('captureForecastVintages', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SOURCE_DDL);
  });

  it('creates forecast_vintage_archive when the database has never had it', () => {
    const before = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='forecast_vintage_archive'")
      .get();
    expect(before).toBeUndefined();

    captureForecastVintages(db, '2026-08-01T00:00:00.000Z');

    const after = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='forecast_vintage_archive'")
      .get();
    expect(after).toBeDefined();
  });

  it('ensureForecastVintageArchiveTable is safe to call twice', () => {
    ensureForecastVintageArchiveTable(db);
    expect(() => ensureForecastVintageArchiveTable(db)).not.toThrow();
  });

  it('captures a row from each of the three source tables', () => {
    insertMl(db);
    insertTsoLoad(db);
    insertTsoGeneration(db, { wind_offshore_mw: 40 });

    const result = captureForecastVintages(db, '2026-08-01T00:00:00.000Z');

    // ml: 1 row. tso load: 1 row. tso generation: solar + wind_onshore + wind_offshore = 3 rows.
    expect(result).toEqual({
      ml: 1,
      tsoLoad: 1,
      tsoSolar: 1,
      tsoWindOnshore: 1,
      tsoWindOffshore: 1,
      total: 5,
    });
    expect(archiveRows(db)).toHaveLength(5);
  });

  it('does not archive a null generation metric (unreported, not zero)', () => {
    insertTsoGeneration(db, { wind_offshore_mw: null });

    const result = captureForecastVintages(db, '2026-08-01T00:00:00.000Z');

    expect(result.tsoWindOffshore).toBe(0);
    expect(archiveRows(db).some((r: any) => r.forecast_type === 'wind_offshore')).toBe(false);
  });

  it('is idempotent: running the same refresh twice adds no rows and mutates none', () => {
    insertMl(db);
    insertTsoLoad(db);
    insertTsoGeneration(db);

    const first = captureForecastVintages(db, '2026-08-01T00:00:00.000Z');
    const before = archiveRows(db);

    // Nothing in the source tables changed — a second capture pass (e.g. the
    // next scheduled run finding an unchanged upstream) must be a pure no-op.
    const second = captureForecastVintages(db, '2026-08-01T01:00:00.000Z');
    const after = archiveRows(db);

    expect(second.total).toBe(0);
    expect(after).toHaveLength(before.length);
    // Every row, including first_seen_at, is byte-for-byte the same — the
    // second call must not have touched (not just "not added to") the archive.
    expect(after).toEqual(before);
    expect(first.total).toBeGreaterThan(0);
  });

  it('a changed ML value under the same natural key lands as a new vintage, not an update', () => {
    insertMl(db, { generated_at: '2026-07-31T18:00:00.000000', forecast_value: 1000 });
    captureForecastVintages(db, '2026-08-01T00:00:00.000Z');

    // Simulate the destructive replace-on-refresh this archive exists to
    // survive: the same natural key (country/type/target/model/generated_at)
    // reappears with a different value, exactly like
    // ingestNetPositionForecast's delete-then-reinsert would produce for a
    // corrected re-run under the same generated_at.
    db.prepare('DELETE FROM forecasts').run();
    insertMl(db, { generated_at: '2026-07-31T18:00:00.000000', forecast_value: 1075 });
    captureForecastVintages(db, '2026-08-01T06:00:00.000Z');

    const rows = archiveRows(db) as Array<{ forecast_value: number; run_timestamp_utc: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.forecast_value).sort((a, b) => a - b)).toEqual([1000, 1075]);
    // Both vintages share the same natural key (run_timestamp_utc unchanged) —
    // it is genuinely the value alone that distinguishes them.
    expect(rows[0].run_timestamp_utc).toBe(rows[1].run_timestamp_utc);
  });

  it('a changed TSO value under the same target/type also lands as a new vintage', () => {
    // TSO has no run/issue-time column at all in the fixture case — falls
    // back to created_at, which a fresh row always gets from SQLite's
    // CURRENT_TIMESTAMP default, so the two captures are naturally
    // distinguished even though publication_timestamp_utc stays NULL both times.
    insertTsoLoad(db, { forecast_value_mw: 950, publication_timestamp_utc: null });
    captureForecastVintages(db, '2026-08-01T00:00:00.000Z');

    db.prepare('DELETE FROM energy_load_forecast').run();
    insertTsoLoad(db, { forecast_value_mw: 975, publication_timestamp_utc: null });
    captureForecastVintages(db, '2026-08-01T06:00:00.000Z');

    const rows = archiveRows(db) as Array<{ forecast_value: number }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.forecast_value).sort((a, b) => a - b)).toEqual([950, 975]);
  });

  it('records first_seen_at in UTC as the capture-time clock, independent of the source row', () => {
    insertMl(db);
    captureForecastVintages(db, '2026-08-01T12:34:56.000Z');

    const row = db.prepare('SELECT first_seen_at FROM forecast_vintage_archive').get() as {
      first_seen_at: string;
    };
    expect(row.first_seen_at).toBe('2026-08-01T12:34:56.000Z');
  });

  it('prefixes the TSO model name so it never collides with an ml model_name', () => {
    insertTsoLoad(db, { forecast_type: 'week_ahead' });
    captureForecastVintages(db, '2026-08-01T00:00:00.000Z');

    const row = db.prepare('SELECT model_name FROM forecast_vintage_archive').get() as {
      model_name: string;
    };
    expect(row.model_name).toBe('tso-week_ahead');
  });

  it('falls back to created_at for the TSO run timestamp when publication_timestamp_utc is null', () => {
    insertTsoLoad(db, { publication_timestamp_utc: null });
    captureForecastVintages(db, '2026-08-01T00:00:00.000Z');

    const row = db.prepare('SELECT run_timestamp_utc FROM forecast_vintage_archive').get() as {
      run_timestamp_utc: string;
    };
    expect(row.run_timestamp_utc).not.toBeNull();
    expect(row.run_timestamp_utc).not.toBe('');
  });

  it('prefers publication_timestamp_utc over created_at when both are present', () => {
    insertTsoLoad(db, { publication_timestamp_utc: '2026-07-31 12:00:00' });
    captureForecastVintages(db, '2026-08-01T00:00:00.000Z');

    const row = db.prepare('SELECT run_timestamp_utc FROM forecast_vintage_archive').get() as {
      run_timestamp_utc: string;
    };
    expect(row.run_timestamp_utc).toBe('2026-07-31 12:00:00');
  });

  it('covers a country carrying multiple ML forecast types independently', () => {
    for (const forecast_type of [
      'load', 'price', 'renewable', 'solar', 'wind_onshore',
      'wind_offshore', 'biomass', 'hydro_total', 'net_position',
    ]) {
      insertMl(db, { forecast_type, forecast_value: 42 });
    }

    const result = captureForecastVintages(db, '2026-08-01T00:00:00.000Z');

    expect(result.ml).toBe(9);
    const types = (archiveRows(db) as Array<{ forecast_type: string }>)
      .map((r) => r.forecast_type)
      .sort();
    expect(types).toEqual([
      'biomass', 'hydro_total', 'load', 'net_position', 'price',
      'renewable', 'solar', 'wind_offshore', 'wind_onshore',
    ]);
  });

  it('never mutates or deletes an existing archive row, even across many capture calls', () => {
    insertMl(db, { forecast_value: 1 });
    captureForecastVintages(db, '2026-08-01T00:00:00.000Z');
    const original = archiveRows(db)[0];

    for (let i = 0; i < 3; i++) {
      captureForecastVintages(db, `2026-08-0${2 + i}T00:00:00.000Z`);
    }

    expect(archiveRows(db)).toEqual([original]);
  });
});
