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
  getLastSeen,
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

/** Seed one 24-point D+2 run, mirroring the real Chronos job's shape. */
function seedRun(
  db: DatabaseType,
  country: string,
  generatedAt: string,
  modelVersion: string,
  targetDay: string,
  baseHorizon: number,
  baseValue: number
) {
  const ins = db.prepare(
    `INSERT INTO forecasts
       (country_code, forecast_type, target_timestamp_utc, generated_at,
        horizon_hours, forecast_value, model_name, model_version)
     VALUES (?, 'net_position', ?, ?, ?, ?, 'chronos-2-V010', ?)`
  );
  for (let h = 0; h < 24; h++) {
    const hh = String(h).padStart(2, '0');
    ins.run(
      country,
      `${targetDay} ${hh}:00:00`,
      generatedAt,
      baseHorizon + h,
      baseValue + h,
      modelVersion
    );
  }
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

  it('picks the freshest run for a timestamp two vintages both cover', () => {
    seedForecast(db, '2026-07-26 06:00:43.125465', -100);
    seedForecast(db, '2026-07-26 07:06:28.960696', -57.2);

    const { points, meta } = getNetPositionForecast('BE', db);
    expect(points).toHaveLength(1);
    expect(points[0].p50).toBe(-57.2);
    expect(points[0].generated_at).toBe('2026-07-26T07:06:28.960696');
    expect(points[0].horizon_hours).toBe(40);
    expect(meta.vintages).toEqual([
      {
        generated_at: '2026-07-26T07:06:28.960696',
        model_version: '20260726_070628',
        horizon_hours_min: 40,
        horizon_hours_max: 40,
        target_count: 1,
        first_target: '2026-07-28T00:00:00',
        last_target: '2026-07-28T00:00:00',
      },
    ]);
  });

  it('degrades to a median-only forecast when forecast_quantiles is absent', () => {
    seedForecast(db, '2026-07-26 07:06:28.960696', -57.2);

    const { points, meta } = getNetPositionForecast('BE', db);
    expect(meta.has_band).toBe(false);
    expect(points[0]).toEqual({
      timestamp: '2026-07-28T00:00:00',
      p50: -57.2,
      p10: null,
      p90: null,
      generated_at: '2026-07-26T07:06:28.960696',
      horizon_hours: 40,
    });
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
      generated_at: '2026-07-26T07:06:28.960696',
      horizon_hours: 40,
    });
  });

  it('reports the bidding zone and empty vintages when nothing is forecast', () => {
    const { points, meta } = getNetPositionForecast('GR', db);
    expect(points).toEqual([]);
    expect(meta).toEqual({
      bidding_zone: 'GR',
      model_name: null,
      vintages: [],
      has_band: false,
    });
  });

  describe('multiple vintages covering different targets', () => {
    beforeEach(() => {
      db.exec(QUANTILES_SCHEMA);
      // Mirrors the reported bug: a D+2 run from 26 Jul covers 28 Jul, and
      // the next day's run covers 29 Jul. Both must appear - the 26 Jul run
      // is not superseded, because it targets different timestamps.
      seedRun(db, 'FR', '2026-07-26 07:06:28.960696', '20260726_070628', '2026-07-28', 40, 100);
      seedRun(db, 'FR', '2026-07-27 06:00:35.035825', '20260727_060035', '2026-07-29', 41, 200);
    });

    it('returns points from every vintage, not just the newest', () => {
      const { points } = getNetPositionForecast('FR', db);
      expect(points).toHaveLength(48);
      const day28 = points.filter((p) => p.timestamp.startsWith('2026-07-28'));
      const day29 = points.filter((p) => p.timestamp.startsWith('2026-07-29'));
      expect(day28).toHaveLength(24);
      expect(day29).toHaveLength(24);
      expect(day28.every((p) => p.generated_at === '2026-07-26T07:06:28.960696')).toBe(true);
      expect(day29.every((p) => p.generated_at === '2026-07-27T06:00:35.035825')).toBe(true);
    });

    it('lists both vintages in meta, newest first, with their own target coverage', () => {
      const { meta } = getNetPositionForecast('FR', db);
      expect(meta.vintages).toEqual([
        {
          generated_at: '2026-07-27T06:00:35.035825',
          model_version: '20260727_060035',
          horizon_hours_min: 41,
          horizon_hours_max: 64,
          target_count: 24,
          first_target: '2026-07-29T00:00:00',
          last_target: '2026-07-29T23:00:00',
        },
        {
          generated_at: '2026-07-26T07:06:28.960696',
          model_version: '20260726_070628',
          horizon_hours_min: 40,
          horizon_hours_max: 63,
          target_count: 24,
          first_target: '2026-07-28T00:00:00',
          last_target: '2026-07-28T23:00:00',
        },
      ]);
    });

    it('never pairs a p50 from one vintage with a band from another', () => {
      const insq = db.prepare(
        `INSERT INTO forecast_quantiles
           (country_code, forecast_type, target_timestamp_utc, generated_at,
            quantile, forecast_value, model_name)
         VALUES ('FR','net_position',?,?,?,?,'chronos-2-V010')`
      );
      // Band only exists for the 26 Jul vintage's first target.
      insq.run('2026-07-28 00:00:00', '2026-07-26 07:06:28.960696', 0.1, -50);
      insq.run('2026-07-28 00:00:00', '2026-07-26 07:06:28.960696', 0.9, 300);
      // A stale band under the SAME target timestamp but the OLD vintage that
      // lost - must never leak onto the winning row.
      insq.run('2026-07-29 00:00:00', '2026-07-26 07:06:28.960696', 0.1, -9999);
      insq.run('2026-07-29 00:00:00', '2026-07-26 07:06:28.960696', 0.9, 9999);

      const { points } = getNetPositionForecast('FR', db);
      const jul28 = points.find((p) => p.timestamp === '2026-07-28T00:00:00')!;
      expect(jul28.p10).toBe(-50);
      expect(jul28.p90).toBe(300);

      // 29 Jul is won by the 27 Jul vintage, which has no quantile rows here -
      // it must stay null, not inherit the 26 Jul vintage's stray band.
      const jul29 = points.find((p) => p.timestamp === '2026-07-29T00:00:00')!;
      expect(jul29.p10).toBeNull();
      expect(jul29.p90).toBeNull();
    });
  });

  describe('a single-vintage country renders exactly as before', () => {
    it('produces one vintage entry with points matching the one run', () => {
      seedRun(db, 'BE', '2026-07-27 06:00:00.000000', '20260727_060000', '2026-07-29', 41, 10);

      const { points, meta } = getNetPositionForecast('BE', db);
      expect(points).toHaveLength(24);
      expect(meta.vintages).toHaveLength(1);
      expect(meta.vintages[0].target_count).toBe(24);
      expect(points.every((p) => p.generated_at === '2026-07-27T06:00:00.000000')).toBe(true);
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

describe('getLastSeen', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    const ins = db.prepare(
      'INSERT INTO net_position (country_code, timestamp_utc, net_position_mw) VALUES (?, ?, ?)'
    );
    // GR went silent in March; no recent query window will contain this.
    ins.run('GR', '2026-03-14 22:00:00', 120.0);
    ins.run('BE', '2026-07-26 06:00:00', -980.0);
  });

  it('reports the last published hour even when it predates every window', () => {
    expect(getLastSeen('GR', db)).toBe('2026-03-14T22:00:00');
  });

  it('is null for a zone that never published', () => {
    expect(getLastSeen('MT', db)).toBeNull();
  });

  it('rides the DE_LU mapping like the other reads', () => {
    expect(getLastSeen('LU', db)).toBe(getLastSeen('DE', db));
  });

  it('surfaces on the combined payload so the UI can name the date', () => {
    const out = getNetPosition('GR', '2026-07-20 00:00:00', '2026-07-27 00:00:00', db);
    expect(out.actual).toEqual([]);
    expect(out.meta.last_seen).toBe('2026-03-14T22:00:00');
  });
});

describe('net position model pinning', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
  });

  function seedModel(model: string, generatedAt: string, value: number) {
    db.prepare(
      `INSERT INTO forecasts
         (country_code, forecast_type, target_timestamp_utc, generated_at,
          horizon_hours, forecast_value, model_name, model_version)
       VALUES ('BE','net_position','2026-07-28 00:00:00',?,40,?,?,'v')`
    ).run(generatedAt, value, model);
  }

  it('ignores an unregistered model even when it is the newest run', () => {
    // V011 lost to V010 on 2026-07-25 (+11.7% pooled MAE). Running it must not
    // put it on the dashboard just by being more recent.
    seedModel('chronos-2-V010', '2026-07-26 07:00:00', -57.2);
    seedModel('chronos-2-V011', '2026-07-26 09:00:00', 999.9);

    const { points, meta } = getNetPositionForecast('BE', db);
    expect(meta.model_name).toBe('chronos-2-V010');
    expect(points[0].p50).toBe(-57.2);
  });

  it('still takes the newest vintage of the registered model', () => {
    seedModel('chronos-2-V010', '2026-07-26 06:00:00', -100);
    seedModel('chronos-2-V010', '2026-07-26 07:00:00', -57.2);

    const { points } = getNetPositionForecast('BE', db);
    expect(points).toHaveLength(1);
    expect(points[0].p50).toBe(-57.2);
  });
});
