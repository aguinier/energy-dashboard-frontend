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

/** Window wide enough to cover every timestamp the fixtures below use. */
const WIDE_START = '2000-01-01 00:00:00';
const WIDE_END = '2100-01-01 00:00:00';

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

/** Add `days` (may be negative) to a 'YYYY-MM-DD' date, returning 'YYYY-MM-DD'. */
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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

    const { points, meta } = getNetPositionForecast('BE', WIDE_START, WIDE_END, db);
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

    const { points, meta } = getNetPositionForecast('BE', WIDE_START, WIDE_END, db);
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

    const { points, meta } = getNetPositionForecast('BE', WIDE_START, WIDE_END, db);
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
    const { points, meta } = getNetPositionForecast('GR', WIDE_START, WIDE_END, db);
    expect(points).toEqual([]);
    expect(meta).toEqual({
      bidding_zone: 'GR',
      model_name: null,
      vintages: [],
      has_band: false,
      forecast_coverage: 'no_forecast',
      degenerate_forecast: null,
    });
  });

  describe('a series that has collapsed to zero', () => {
    // ABL-25. GR's real chronos-2-V010 net-position rows, measured on the
    // replica 2026-08-06: 168 values between 2.3e-11 and 4.6e-7 MW, not one
    // exactly 0.0. Drawn, they are a flat line at 0 MW that reads as a
    // confident forecast; withheld, the client can say why.
    const GR_P50 = [4.582052497426048e-7, -1.7743546720794257e-7, 2.3065367324437425e-11];

    function seedDegenerate() {
      const ins = db.prepare(
        `INSERT INTO forecasts
           (country_code, forecast_type, target_timestamp_utc, generated_at,
            horizon_hours, forecast_value, model_name, model_version)
         VALUES ('GR','net_position',?,'2026-07-26 07:00:00',40,?,'chronos-2-V010','V010')`
      );
      GR_P50.forEach((v, i) => ins.run(`2026-07-28 0${i}:00:00`, v));
    }

    it('withholds the points and says why, rather than returning them', () => {
      seedDegenerate();

      const { points, meta } = getNetPositionForecast('GR', WIDE_START, WIDE_END, db);
      expect(points).toEqual([]);
      expect(meta.forecast_coverage).toBe('degenerate_zero');
      expect(meta.degenerate_forecast).toEqual({
        points: 3,
        max_abs_mw: 4.582052497426048e-7,
      });
    });

    it('empties the vintages that would otherwise caption an empty chart', () => {
      seedDegenerate();

      // `vintages` is documented as the runs present in `forecast`; the client
      // renders "N runs on screen" from it. A populated list beside zero
      // points would just relocate the false claim into the subtitle.
      const { meta } = getNetPositionForecast('GR', WIDE_START, WIDE_END, db);
      expect(meta.vintages).toEqual([]);
      expect(meta.has_band).toBe(false);
      // The model that produced the unusable rows is still named — unlike the
      // no-rows case above, something really did run here.
      expect(meta.model_name).toBe('chronos-2-V010');
    });

    it('leaves a genuine series that crosses zero completely alone', () => {
      // The rule is on the series maximum, never on individual points: a real
      // net position passes through ~0 on its way from importing to exporting,
      // and genuine rows go as low as 0.0094 MW (ES, measured).
      const ins = db.prepare(
        `INSERT INTO forecasts
           (country_code, forecast_type, target_timestamp_utc, generated_at,
            horizon_hours, forecast_value, model_name, model_version)
         VALUES ('BE','net_position',?,'2026-07-26 07:00:00',40,?,'chronos-2-V010','V010')`
      );
      [-900, 0.0093994140625, 880].forEach((v, i) => ins.run(`2026-07-28 0${i}:00:00`, v));

      const { points, meta } = getNetPositionForecast('BE', WIDE_START, WIDE_END, db);
      expect(points).toHaveLength(3);
      expect(meta.forecast_coverage).toBe('served');
      expect(meta.degenerate_forecast).toBeNull();
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
      const { points } = getNetPositionForecast('FR', WIDE_START, WIDE_END, db);
      expect(points).toHaveLength(48);
      const day28 = points.filter((p) => p.timestamp.startsWith('2026-07-28'));
      const day29 = points.filter((p) => p.timestamp.startsWith('2026-07-29'));
      expect(day28).toHaveLength(24);
      expect(day29).toHaveLength(24);
      expect(day28.every((p) => p.generated_at === '2026-07-26T07:06:28.960696')).toBe(true);
      expect(day29.every((p) => p.generated_at === '2026-07-27T06:00:35.035825')).toBe(true);
    });

    it('lists both vintages in meta, newest first, with their own target coverage', () => {
      const { meta } = getNetPositionForecast('FR', WIDE_START, WIDE_END, db);
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

      const { points } = getNetPositionForecast('FR', WIDE_START, WIDE_END, db);
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

      const { points, meta } = getNetPositionForecast('BE', WIDE_START, WIDE_END, db);
      expect(points).toHaveLength(24);
      expect(meta.vintages).toHaveLength(1);
      expect(meta.vintages[0].target_count).toBe(24);
      expect(points.every((p) => p.generated_at === '2026-07-27T06:00:00.000000')).toBe(true);
    });
  });

  describe('bounding by the requested window', () => {
    // Mirrors the daily D+2 job's real steady state: every run targets a
    // distinct calendar day, so nothing ever supersedes an older run.
    // Without a time bound, 58 days of runs leaves 58 permanent "winners"
    // and 58*24 = 1392 points, growing forever as the job keeps running.
    const RUN_COUNT = 58;
    const FIRST_GENERATED_DAY = '2026-06-01'; // -> first target 2026-06-03

    function seedDailyRuns() {
      for (let i = 0; i < RUN_COUNT; i++) {
        const generatedDay = addDays(FIRST_GENERATED_DAY, i);
        const targetDay = addDays(generatedDay, 2);
        seedRun(db, 'FR', `${generatedDay} 06:00:00.000000`, generatedDay, targetDay, 40, 100);
      }
    }

    it('does not accumulate every vintage ever written - only those inside the window', () => {
      seedDailyRuns();

      // A realistic query window: the client extends `end` to now+3d but
      // does not extend `start` back through the whole deployment's
      // history (see client/src/hooks/useNetPositionData.ts). Using the
      // day after the last seeded run as "now", with a 10-day lookback,
      // mirrors that shape.
      const now = addDays(FIRST_GENERATED_DAY, RUN_COUNT - 1);
      const start = `${addDays(now, -10)} 00:00:00`;
      const end = `${addDays(now, 3)} 00:00:00`;

      const { points, meta } = getNetPositionForecast('FR', start, end, db);

      // Bounded, not "everything the deployment has ever produced": only
      // the 13 target days that fall inside [start, end] come back, out of
      // the 58 that exist on disk.
      expect(points.length).toBeLessThan(58 * 24);
      expect(meta.vintages.length).toBeLessThan(58);
      expect(points).toHaveLength(13 * 24);
      expect(meta.vintages).toHaveLength(13);

      const startIso = start.replace(' ', 'T');
      const endIso = end.replace(' ', 'T');
      for (const p of points) {
        expect(p.timestamp >= startIso).toBe(true);
        expect(p.timestamp <= endIso).toBe(true);
      }
    });

    it('still returns the full history when the window genuinely covers all of it', () => {
      // Confirms the bound tracks the caller's window rather than being a
      // hidden fixed cap - a window wide enough to cover everything still
      // returns everything.
      seedDailyRuns();

      const { points, meta } = getNetPositionForecast('FR', WIDE_START, WIDE_END, db);
      expect(points).toHaveLength(RUN_COUNT * 24);
      expect(meta.vintages).toHaveLength(RUN_COUNT);
    });
  });

  describe('a null horizon_hours does not silently mislabel the vintage', () => {
    // `forecasts.horizon_hours` has no NOT NULL constraint, and nothing at
    // the ingest HTTP boundary enforces one (netPositionIngestService writes
    // `row.horizon_hours ?? null`). Math.min/Math.max coerce a null to 0 in
    // JS, which would silently turn a D+2+ vintage into horizon_hours_min: 0
    // -> mislabelled "D+1" by horizonDayLabel. Must come back null instead.
    it('reports horizon_hours_min/max as null when every row has a null horizon', () => {
      db.prepare(
        `INSERT INTO forecasts
           (country_code, forecast_type, target_timestamp_utc, generated_at,
            horizon_hours, forecast_value, model_name, model_version)
         VALUES ('BE','net_position','2026-07-28 00:00:00','2026-07-26 07:06:28.960696',
                 NULL, -57.2, 'chronos-2-V010','20260726_070628')`
      ).run();

      const { points, meta } = getNetPositionForecast('BE', WIDE_START, WIDE_END, db);
      expect(points[0].horizon_hours).toBeNull();
      expect(meta.vintages).toHaveLength(1);
      expect(meta.vintages[0].horizon_hours_min).toBeNull();
      expect(meta.vintages[0].horizon_hours_max).toBeNull();
    });

    it('excludes only the null rows from min/max when a vintage mixes null and real horizons', () => {
      db.prepare(
        `INSERT INTO forecasts
           (country_code, forecast_type, target_timestamp_utc, generated_at,
            horizon_hours, forecast_value, model_name, model_version)
         VALUES
           ('BE','net_position','2026-07-28 00:00:00','2026-07-26 07:06:28.960696', NULL, -57.2, 'chronos-2-V010','20260726_070628'),
           ('BE','net_position','2026-07-28 01:00:00','2026-07-26 07:06:28.960696', 41, -50.0, 'chronos-2-V010','20260726_070628')`
      ).run();

      const { meta } = getNetPositionForecast('BE', WIDE_START, WIDE_END, db);
      expect(meta.vintages).toHaveLength(1);
      expect(meta.vintages[0].horizon_hours_min).toBe(41);
      expect(meta.vintages[0].horizon_hours_max).toBe(41);
    });
  });
});

describe('getNetPosition', () => {
  it('combines actuals and forecast in one payload', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    seedActuals(db);
    seedForecast(db, '2026-07-26 07:06:28.960696', -57.2);

    // End extended past the actuals range to 2026-07-28, same shape as the
    // real caller (useNetPositionData.ts extends `end` to now+3d) - the
    // forecast's target_timestamp_utc (2026-07-28, from seedForecast) must
    // be inside the window now that the forecast query is window-bounded.
    const out = getNetPosition('BE', '2026-07-26 00:00:00', '2026-07-28 23:00:00', db);
    expect(out.actual).toHaveLength(3);
    expect(out.forecast).toHaveLength(1);
    expect(out.meta.bidding_zone).toBe('BE');
  });

  it('excludes a forecast whose target falls outside the requested window', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    seedForecast(db, '2026-07-26 07:06:28.960696', -57.2); // targets 2026-07-28

    const out = getNetPosition('BE', '2026-07-01 00:00:00', '2026-07-10 00:00:00', db);
    expect(out.forecast).toHaveLength(0);
    expect(out.meta.vintages).toHaveLength(0);
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

    const { points, meta } = getNetPositionForecast('BE', WIDE_START, WIDE_END, db);
    expect(meta.model_name).toBe('chronos-2-V010');
    expect(points[0].p50).toBe(-57.2);
  });

  it('still takes the newest vintage of the registered model', () => {
    seedModel('chronos-2-V010', '2026-07-26 06:00:00', -100);
    seedModel('chronos-2-V010', '2026-07-26 07:00:00', -57.2);

    const { points } = getNetPositionForecast('BE', WIDE_START, WIDE_END, db);
    expect(points).toHaveLength(1);
    expect(points[0].p50).toBe(-57.2);
  });
});
