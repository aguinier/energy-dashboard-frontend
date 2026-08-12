import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { timestampRange, rangeArgs } from '../utils/timestamp.js';

// The module under test imports the shared connection, which opens a real
// SQLite file at import time. getGenerationMix always receives its own
// handle in these tests via the optional `db` parameter, so the default
// export just needs to not exist.
import { vi } from 'vitest';
vi.mock('../config/database.js', () => ({ default: null }));

const {
  getGenerationMix, GENERATION_MIX_SQL, getRenewableShare, RENEWABLE_SHARE_SQL,
  getGenerationSeries, generationSeriesSql, GENERATION_GROUPS, RENEWABLE_MW_SUM,
  getWindGenerationSeries, windGenerationSeriesSql,
} = await import('./generationService.js');

// Mirrors the real energy_generation schema (Task 1 of the A75 plan),
// confirmed live against prod on 2026-07-29. All *_mw columns default to
// NULL - never 0 - because a type a country does not report is absent, not
// a measured zero.
const SCHEMA = `
  CREATE TABLE energy_generation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL,
    timestamp_utc TIMESTAMP NOT NULL,
    solar_mw REAL,
    wind_onshore_mw REAL,
    wind_offshore_mw REAL,
    hydro_run_mw REAL,
    hydro_reservoir_mw REAL,
    hydro_pumped_mw REAL,
    biomass_mw REAL,
    geothermal_mw REAL,
    marine_mw REAL,
    other_renewable_mw REAL,
    energy_storage_mw REAL,
    nuclear_mw REAL,
    fossil_gas_mw REAL,
    fossil_hard_coal_mw REAL,
    fossil_brown_coal_mw REAL,
    fossil_oil_mw REAL,
    fossil_oil_shale_mw REAL,
    fossil_peat_mw REAL,
    fossil_coal_derived_gas_mw REAL,
    waste_mw REAL,
    other_mw REAL,
    data_quality TEXT DEFAULT 'actual',
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    publication_timestamp_utc TIMESTAMP
  );
  CREATE UNIQUE INDEX idx_generation_country_time ON energy_generation(country_code, timestamp_utc);
  CREATE INDEX idx_generation_time ON energy_generation(timestamp_utc);
`;

function buildDb(): DatabaseType {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

const COLUMNS = [
  'country_code', 'timestamp_utc',
  'solar_mw', 'wind_onshore_mw', 'wind_offshore_mw',
  'hydro_run_mw', 'hydro_reservoir_mw', 'hydro_pumped_mw',
  'biomass_mw', 'geothermal_mw', 'marine_mw', 'other_renewable_mw', 'energy_storage_mw',
  'nuclear_mw', 'fossil_gas_mw', 'fossil_hard_coal_mw', 'fossil_brown_coal_mw',
  'fossil_oil_mw', 'fossil_oil_shale_mw', 'fossil_peat_mw', 'fossil_coal_derived_gas_mw',
  'waste_mw', 'other_mw',
];

function insertRow(db: DatabaseType, row: Partial<Record<(typeof COLUMNS)[number], string | number | null>>) {
  const cols = COLUMNS.filter((c) => c in row);
  const placeholders = cols.map(() => '?').join(', ');
  const stmt = db.prepare(`INSERT INTO energy_generation (${cols.join(', ')}) VALUES (${placeholders})`);
  stmt.run(...cols.map((c) => row[c] ?? null));
}

// Mirrors generationService.RENEWABLE_MW_SUM - the renewable numerator's
// column set - kept independent of the production constant so these tests
// would actually fail if that set ever drifted from the task's definition
// (solar, wind, hydro run/reservoir, biomass, geothermal, marine, other
// renewable; explicitly not hydro_pumped or energy_storage, which are stores).
const RENEWABLE_KEYS = [
  'solar_mw', 'wind_onshore_mw', 'wind_offshore_mw',
  'hydro_run_mw', 'hydro_reservoir_mw', 'biomass_mw',
  'geothermal_mw', 'marine_mw', 'other_renewable_mw',
];

// Every *_mw column GENERATION_MIX_SQL carries, renewable and not - the
// denominator sums all of them (clamped to >=0 each), including
// hydro_pumped/energy_storage despite both being excluded from
// RENEWABLE_KEYS above (see TOTAL_POSITIVE_MW_SUM's doc comment).
const ALL_GENERATION_KEYS = COLUMNS.filter((c) => c.endsWith('_mw'));

/** Reference implementation of the ratio-of-window-sums formula, computed in
 * plain JS from the same row objects the tests insert, so a test failure
 * means the SQL and this description of "renewable ÷ total positive
 * generation" actually disagree - not a hand-copied expected number. */
function expectedRenewableShare(rows: Array<Record<string, number | null | undefined>>): number | null {
  let renewableSum = 0;
  let totalPositiveSum = 0;
  for (const row of rows) {
    for (const key of RENEWABLE_KEYS) renewableSum += row[key] ?? 0;
    for (const key of ALL_GENERATION_KEYS) totalPositiveSum += Math.max(row[key] ?? 0, 0);
  }
  if (totalPositiveSum <= 0) return null;
  return Math.round((renewableSum / totalPositiveSum) * 10000) / 100;
}

describe('GENERATION_MIX_SQL shape', () => {
  it('does not wrap timestamp_utc in date()/strftime()', () => {
    // A weak guard on its own, but cheap, and catches a regression back to
    // the function-on-indexed-column shape that cost 51s/30d in
    // renewableService before RENEWABLE_PERCENTAGE_SQL was fixed.
    expect(GENERATION_MIX_SQL).not.toMatch(/date\(\s*timestamp_utc\s*\)/);
    expect(GENERATION_MIX_SQL).not.toMatch(/strftime\(\s*'[^']*'\s*,\s*timestamp_utc\s*\)/);
  });

  it('filters directly on country_code and timestamp_utc', () => {
    expect(GENERATION_MIX_SQL).toMatch(/WHERE country_code = \?/);
    expect(GENERATION_MIX_SQL).toMatch(/timestamp_utc BETWEEN \? AND \?/);
  });

  it('never wraps a value in COALESCE', () => {
    // COALESCE(x, 0) would turn "not reported" into a fabricated 0 - the
    // exact thing this table exists to stop doing.
    expect(GENERATION_MIX_SQL).not.toMatch(/COALESCE/i);
  });
});

describe('getGenerationMix', () => {
  it('keeps nuclear and fossil types the old renewable-only mapping discarded', () => {
    const db = buildDb();
    insertRow(db, {
      country_code: 'FR', timestamp_utc: '2026-07-29 13:45:00',
      nuclear_mw: 40346.23, fossil_gas_mw: 1131.62, waste_mw: 402.32, solar_mw: 18866.4,
    });

    const mix = getGenerationMix('FR', '2026-07-29 13:00:00', '2026-07-29 14:00:00', db);

    expect(mix).not.toBeNull();
    expect(mix!.nuclear).toBe(40346.23);
    expect(mix!.fossil_gas).toBe(1131.62);
    expect(mix!.waste).toBe(402.32);
    expect(mix!.solar).toBe(18866.4);
  });

  it('reports a type this country never sends as null, not zero', () => {
    const db = buildDb();
    // FR does not report geothermal or fossil_brown_coal - column omitted
    // entirely, same as a country whose A75 document never includes them.
    insertRow(db, { country_code: 'FR', timestamp_utc: '2026-07-29 13:00:00', nuclear_mw: 40000 });

    const mix = getGenerationMix('FR', '2026-07-29 12:00:00', '2026-07-29 14:00:00', db);

    expect(mix!.geothermal).toBeNull();
    expect(mix!.fossil_brown_coal).toBeNull();
  });

  it('keeps a reported zero as zero, not null', () => {
    const db = buildDb();
    // Solar at night is a measured 0, not a missing reading.
    insertRow(db, { country_code: 'FR', timestamp_utc: '2026-07-29 02:00:00', solar_mw: 0 });

    const mix = getGenerationMix('FR', '2026-07-29 01:00:00', '2026-07-29 03:00:00', db);

    expect(mix!.solar).toBe(0);
    expect(mix!.solar).not.toBeNull();
  });

  it('preserves a negative average (pumped storage net-consuming)', () => {
    const db = buildDb();
    insertRow(db, { country_code: 'FR', timestamp_utc: '2026-07-29 03:00:00', hydro_pumped_mw: -1827.98 });
    insertRow(db, { country_code: 'FR', timestamp_utc: '2026-07-29 03:15:00', hydro_pumped_mw: -1900.0 });

    const mix = getGenerationMix('FR', '2026-07-29 02:00:00', '2026-07-29 04:00:00', db);

    expect(mix!.hydro_pumped).toBeLessThan(0);
    expect(mix!.hydro_pumped).toBeCloseTo(-1863.99, 2);
  });

  it('averages across multiple rows in the window', () => {
    const db = buildDb();
    insertRow(db, { country_code: 'FR', timestamp_utc: '2026-07-29 13:00:00', nuclear_mw: 40000 });
    insertRow(db, { country_code: 'FR', timestamp_utc: '2026-07-29 13:15:00', nuclear_mw: 41000 });

    const mix = getGenerationMix('FR', '2026-07-29 12:00:00', '2026-07-29 14:00:00', db);

    expect(mix!.nuclear).toBe(40500);
  });

  it('returns null when no rows fall in the window', () => {
    const db = buildDb();
    expect(getGenerationMix('FR', '2026-01-01 00:00:00', '2026-01-02 00:00:00', db)).toBeNull();
  });

  it('does not leak another country into the average', () => {
    const db = buildDb();
    insertRow(db, { country_code: 'DE', timestamp_utc: '2026-07-29 13:00:00', nuclear_mw: 5000 });

    const mix = getGenerationMix('FR', '2026-07-29 12:00:00', '2026-07-29 14:00:00', db);

    expect(mix).toBeNull();
  });

  it('attaches renewable_percentage, identical to what getRenewableShare returns standalone for the same window', () => {
    const db = buildDb();
    insertRow(db, { country_code: 'FR', timestamp_utc: '2026-07-29 13:00:00', solar_mw: 100, nuclear_mw: 300 });

    const mix = getGenerationMix('FR', '2026-07-29 12:00:00', '2026-07-29 14:00:00', db);
    const standalone = getRenewableShare('FR', '2026-07-29 12:00:00', '2026-07-29 14:00:00', db);

    // Same table, same country, same window, same function underneath - the
    // donut (which reads mix.renewable_percentage) and anything calling
    // getRenewableShare directly (the header stat, the map) cannot disagree.
    expect(mix!.renewable_percentage).toBe(standalone);
    expect(mix!.renewable_percentage).toBeCloseTo(25, 2); // 100 / (100 + 300)
  });

  it('nulls renewable_percentage when nothing measured is positive, without nulling the rest of the mix', () => {
    const db = buildDb();
    insertRow(db, { country_code: 'FR', timestamp_utc: '2026-07-29 13:00:00', hydro_pumped_mw: -50 });

    const mix = getGenerationMix('FR', '2026-07-29 12:00:00', '2026-07-29 14:00:00', db);

    expect(mix).not.toBeNull();
    expect(mix!.hydro_pumped).toBe(-50);
    expect(mix!.renewable_percentage).toBeNull();
  });
});

describe('getGenerationMix query plan', () => {
  it('uses the (country_code, timestamp_utc) index', () => {
    const db = buildDb();
    insertRow(db, { country_code: 'FR', timestamp_utc: '2026-07-29 13:00:00', nuclear_mw: 40000 });

    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${GENERATION_MIX_SQL}`)
      .all('FR', ...rangeArgs(timestampRange('2026-07-29T12:00:00Z', '2026-07-29T14:00:00Z'))) as Array<{ detail: string }>;
    const detail = plan.map((row) => row.detail).join('\n');

    expect(detail).toMatch(/SEARCH energy_generation USING (COVERING )?INDEX idx_generation_country_time \(country_code=\? AND timestamp_utc>\? AND timestamp_utc<\?\)/);
  });
});

describe('RENEWABLE_SHARE_SQL shape', () => {
  it('does not wrap timestamp_utc in date()/strftime()', () => {
    expect(RENEWABLE_SHARE_SQL).not.toMatch(/date\(\s*timestamp_utc\s*\)/);
    expect(RENEWABLE_SHARE_SQL).not.toMatch(/strftime\(\s*'[^']*'\s*,\s*timestamp_utc\s*\)/);
  });

  it('filters directly on country_code and timestamp_utc', () => {
    expect(RENEWABLE_SHARE_SQL).toMatch(/WHERE country_code = \?/);
    expect(RENEWABLE_SHARE_SQL).toMatch(/timestamp_utc BETWEEN \? AND \?/);
  });

  it('has no JOIN - the definition this replaces needed one (energy_renewable to energy_load), and the join was the whole performance problem', () => {
    expect(RENEWABLE_SHARE_SQL).not.toMatch(/JOIN/i);
  });

  it('builds the numerator from renewableTotal.RENEWABLE_MW_COLUMNS, and from nothing else', () => {
    // ABL-324 tranche 1: the /renewables breakdown's seven fields and this
    // numerator are served side by side on one /renewables/mix object, so
    // they are generated from one column list. RENEWABLE_KEYS above is this
    // file's independent mirror of that list; asserting against it here is
    // what would fail if the shared constant drifted from the definition the
    // Board signed off, rather than both moving together silently.
    const inSum = [...RENEWABLE_MW_SUM.matchAll(/COALESCE\((\w+), 0\)/g)].map((m) => m[1]);
    expect(inSum.sort()).toEqual([...RENEWABLE_KEYS].sort());
    expect(RENEWABLE_MW_SUM).not.toMatch(/hydro_pumped_mw|energy_storage_mw/);
  });
});

describe('getRenewableShare', () => {
  it('computes renewable ÷ total positive generation as a ratio of window sums', () => {
    const db = buildDb();
    const row1 = {
      country_code: 'FR', timestamp_utc: '2026-07-29 13:00:00',
      solar_mw: 100, wind_onshore_mw: 50, wind_offshore_mw: 0,
      hydro_run_mw: 20, hydro_reservoir_mw: 10, biomass_mw: 5,
      hydro_pumped_mw: -30, nuclear_mw: 200, fossil_gas_mw: 40,
    };
    const row2 = {
      country_code: 'FR', timestamp_utc: '2026-07-29 13:15:00',
      solar_mw: 60, wind_onshore_mw: 70, wind_offshore_mw: 10,
      hydro_run_mw: 15, hydro_reservoir_mw: 5, biomass_mw: 3,
      hydro_pumped_mw: 80, nuclear_mw: 180, fossil_gas_mw: 20, fossil_hard_coal_mw: -5,
    };
    insertRow(db, row1);
    insertRow(db, row2);

    const pct = getRenewableShare('FR', '2026-07-29 13:00:00', '2026-07-29 13:15:00', db);

    expect(pct).toBeCloseTo(expectedRenewableShare([row1, row2])!, 2);
  });

  it('excludes hydro_pumped and energy_storage from the renewable numerator, but counts them (when positive) in the total', () => {
    const db = buildDb();
    const row = {
      country_code: 'FR', timestamp_utc: '2026-07-29 13:00:00',
      solar_mw: 100, hydro_pumped_mw: 500, energy_storage_mw: 50, nuclear_mw: 100,
    };
    insertRow(db, row);

    const pct = getRenewableShare('FR', '2026-07-29 12:00:00', '2026-07-29 14:00:00', db);

    // renewable = 100 (solar only, not the discharging battery/pumped hydro);
    // total = 100 + 500 + 50 + 100 = 750.
    expect(pct).toBeCloseTo((100 / 750) * 100, 2);
    expect(pct).toBeCloseTo(expectedRenewableShare([row])!, 2);
  });

  it('is energy-weighted: a high-output hour dominates a low-output hour, unlike a mean of per-hour percentages', () => {
    const db = buildDb();
    // Hour A: tiny output, 100% renewable. Hour B: 100x the output, 0%
    // renewable. A naive mean of the two hours' percentages would read 50%;
    // a share of generation must weight each hour by how much it actually
    // generated, so the window figure should sit close to 0%, not 50%.
    const hourA = { country_code: 'FR', timestamp_utc: '2026-07-29 03:00:00', solar_mw: 10 };
    const hourB = { country_code: 'FR', timestamp_utc: '2026-07-29 13:00:00', nuclear_mw: 1000 };
    insertRow(db, hourA);
    insertRow(db, hourB);

    const pct = getRenewableShare('FR', '2026-07-29 00:00:00', '2026-07-29 23:45:00', db);

    expect(pct).toBeCloseTo((10 / 1010) * 100, 2);
    expect(pct).toBeLessThan(5);
  });

  it('treats a type this country does not report as contributing nothing, not as breaking the sum', () => {
    const db = buildDb();
    // No geothermal/marine/other_renewable column at all this window.
    const row = { country_code: 'FR', timestamp_utc: '2026-07-29 13:00:00', solar_mw: 100, nuclear_mw: 100 };
    insertRow(db, row);

    const pct = getRenewableShare('FR', '2026-07-29 12:00:00', '2026-07-29 14:00:00', db);

    expect(pct).toBeCloseTo(50, 2); // 100 / (100 + 100)
  });

  it('returns null when total positive generation is zero - a share of nothing, not 0%', () => {
    const db = buildDb();
    // Only a negative pumped-storage reading in the window.
    insertRow(db, { country_code: 'FR', timestamp_utc: '2026-07-29 13:00:00', hydro_pumped_mw: -50 });

    const pct = getRenewableShare('FR', '2026-07-29 12:00:00', '2026-07-29 14:00:00', db);

    expect(pct).toBeNull();
  });

  it('returns null when no rows fall in the window - never 0, never a fallback to another definition', () => {
    const db = buildDb();
    expect(getRenewableShare('FR', '2026-01-01 00:00:00', '2026-01-02 00:00:00', db)).toBeNull();
  });

  it('does not leak another country into the sum', () => {
    const db = buildDb();
    insertRow(db, { country_code: 'DE', timestamp_utc: '2026-07-29 13:00:00', solar_mw: 999, nuclear_mw: 1 });

    const pct = getRenewableShare('FR', '2026-07-29 12:00:00', '2026-07-29 14:00:00', db);

    expect(pct).toBeNull();
  });
});

describe('getRenewableShare query plan', () => {
  it('uses the (country_code, timestamp_utc) index', () => {
    const db = buildDb();
    insertRow(db, { country_code: 'FR', timestamp_utc: '2026-07-29 13:00:00', solar_mw: 100 });

    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${RENEWABLE_SHARE_SQL}`)
      .all('FR', ...rangeArgs(timestampRange('2026-07-29T12:00:00Z', '2026-07-29T14:00:00Z'))) as Array<{ detail: string }>;
    const detail = plan.map((row) => row.detail).join('\n');

    expect(detail).toMatch(/SEARCH energy_generation USING (COVERING )?INDEX idx_generation_country_time \(country_code=\? AND timestamp_utc>\? AND timestamp_utc<\?\)/);
  });
});

// ---------------------------------------------------------------------------
// getGenerationSeries — the trend counterpart of getGenerationMix (ABL-44).
// ---------------------------------------------------------------------------

describe('GENERATION_GROUPS', () => {
  it('partitions all 21 A75 columns exactly once', () => {
    const grouped = Object.values(GENERATION_GROUPS).flat();

    // Every column is claimed by exactly one group — no column silently
    // dropped off the chart, and none double-counted into two stacked bands.
    expect([...grouped].sort()).toEqual([...ALL_GENERATION_KEYS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });
});

describe('generationSeriesSql shape', () => {
  it('does not wrap timestamp_utc in date()/strftime() inside WHERE', () => {
    for (const g of ['hourly', 'daily', 'weekly', 'monthly'] as const) {
      const where = generationSeriesSql(g).split('WHERE')[1].split('GROUP BY')[0];
      expect(where).not.toMatch(/date\(\s*timestamp_utc\s*\)/);
      expect(where).not.toMatch(/strftime\(/);
      expect(where).toMatch(/timestamp_utc BETWEEN \? AND \?/);
    }
  });

  it('guards every group with an all-null CASE rather than a bare COALESCE sum', () => {
    // The bare `ROUND(COALESCE(AVG(a),0) + COALESCE(AVG(b),0), 2)` would
    // report a country that reports none of a group's types as a flat 0 MW
    // band — a fabricated series, and precisely what this chart must not draw.
    const sql = generationSeriesSql('hourly');
    for (const [alias, columns] of Object.entries(GENERATION_GROUPS)) {
      const allNull = columns.map((c) => `AVG(${c}) IS NULL`).join(' AND ');
      expect(sql).toContain(`CASE WHEN ${allNull} THEN NULL`);
      expect(sql).toContain(`END as ${alias}`);
    }
  });
});

describe('getGenerationSeries', () => {
  const W = ['2026-07-29T00:00:00Z', '2026-07-29T04:00:00Z'] as const;

  it('groups the 21 columns into the nine families the tab draws', () => {
    const db = buildDb();
    insertRow(db, {
      country_code: 'DE', timestamp_utc: '2026-07-29 01:00:00',
      solar_mw: 100, wind_onshore_mw: 200, wind_offshore_mw: 50,
      hydro_run_mw: 10, hydro_reservoir_mw: 20, hydro_pumped_mw: -5,
      nuclear_mw: 300, fossil_gas_mw: 400, fossil_hard_coal_mw: 60,
      biomass_mw: 7, waste_mw: 3, geothermal_mw: 1, other_mw: 2,
    });

    const [point] = getGenerationSeries('DE', W[0], W[1], 'hourly', db);

    expect(point).toEqual({
      timestamp: '2026-07-29T01:00:00',
      nuclear: 300, solar: 100,
      wind: 250,          // onshore + offshore
      hydro: 30,          // run + reservoir, pumped kept out
      hydro_pumped: -5,
      fossil: 460,        // gas + hard coal
      biomass: 7, waste: 3,
      other: 3,           // geothermal + other
    });
  });

  it('reports a group this country never sends as null, not a zero series', () => {
    // PT's live shape: rows exist, every column NULL. A 0 here would draw a
    // flat band claiming the country generates nothing rather than that we
    // have not been told.
    const db = buildDb();
    for (const h of [1, 2]) {
      insertRow(db, { country_code: 'PT', timestamp_utc: `2026-07-29 0${h}:00:00` });
    }

    const series = getGenerationSeries('PT', W[0], W[1], 'hourly', db);

    expect(series).toHaveLength(2);
    for (const point of series) {
      for (const alias of Object.keys(GENERATION_GROUPS)) {
        expect(point[alias as keyof typeof point]).toBeNull();
      }
    }
  });

  it('keeps a measured zero as zero while an unreported sibling stays out of the sum', () => {
    // FR's real row shape: solar measured 0.0, wind never reported. The two
    // must stay distinguishable — 0 and null on the same point.
    const db = buildDb();
    insertRow(db, {
      country_code: 'FR', timestamp_utc: '2026-07-29 01:00:00',
      solar_mw: 0, hydro_run_mw: 100, // hydro_reservoir_mw absent => NULL
    });

    const [point] = getGenerationSeries('FR', W[0], W[1], 'hourly', db);

    expect(point.solar).toBe(0);
    expect(point.wind).toBeNull();
    // NOT null: SQL's `+` would propagate hydro_reservoir's NULL and delete a
    // real 100 MW run-of-river reading.
    expect(point.hydro).toBe(100);
  });

  it('returns negatives signed, never clamped', () => {
    const db = buildDb();
    insertRow(db, {
      country_code: 'FR', timestamp_utc: '2026-07-29 01:00:00',
      hydro_pumped_mw: -300, fossil_hard_coal_mw: -50, nuclear_mw: 700,
    });

    const [point] = getGenerationSeries('FR', W[0], W[1], 'hourly', db);

    expect(point.hydro_pumped).toBe(-300);
    expect(point.fossil).toBe(-50);
    expect(point.nuclear).toBe(700);
  });

  it('averages a group over the rows in a bucket, skipping rows where a member is absent', () => {
    // Daily bucket, two rows. `fossil_gas_mw` is reported in both (400, 600 =>
    // 500). `fossil_oil_mw` only in the second (100 => 100, its own average
    // over the hours it was reported). The group is the sum of the two
    // per-column averages, exactly as buildSourceRows would sum them.
    const db = buildDb();
    insertRow(db, { country_code: 'DE', timestamp_utc: '2026-07-29 01:00:00', fossil_gas_mw: 400 });
    insertRow(db, { country_code: 'DE', timestamp_utc: '2026-07-29 02:00:00', fossil_gas_mw: 600, fossil_oil_mw: 100 });

    const [point] = getGenerationSeries('DE', W[0], W[1], 'daily', db);

    expect(point.timestamp).toBe('2026-07-29');
    expect(point.fossil).toBe(600);
  });

  it('over one bucket spanning the window, matches getGenerationMix group for group', () => {
    // The property that keeps the trend chart and the donut from disagreeing:
    // same table, same window, same per-column AVG, same sum-or-null rule.
    const db = buildDb();
    insertRow(db, {
      country_code: 'FR', timestamp_utc: '2026-07-29 01:00:00',
      solar_mw: 0, hydro_run_mw: 100, hydro_reservoir_mw: 40, nuclear_mw: 700,
      hydro_pumped_mw: -300, fossil_hard_coal_mw: -50, fossil_gas_mw: 120,
    });
    insertRow(db, {
      country_code: 'FR', timestamp_utc: '2026-07-29 02:00:00',
      solar_mw: 10, hydro_run_mw: 120, nuclear_mw: 690,
      hydro_pumped_mw: 200, fossil_gas_mw: 80,
    });

    const [point] = getGenerationSeries('FR', W[0], W[1], 'monthly', db);
    const mix = getGenerationMix('FR', W[0], W[1], db)!;

    // Hand-summed from the mix the donut reads, with sourceRows' sum-or-null
    // rule applied to each family.
    expect(point.solar).toBe(mix.solar);
    expect(point.nuclear).toBe(mix.nuclear);
    expect(point.hydro_pumped).toBe(mix.hydro_pumped);
    expect(point.hydro).toBeCloseTo((mix.hydro_run ?? 0) + (mix.hydro_reservoir ?? 0), 6);
    expect(point.fossil).toBeCloseTo((mix.fossil_gas ?? 0) + (mix.fossil_hard_coal ?? 0), 6);
    expect(point.wind).toBeNull();
    expect(mix.wind_onshore).toBeNull();
  });

  it('returns [] when no rows fall in the window, rather than a series of zeros', () => {
    const db = buildDb();
    insertRow(db, { country_code: 'AT', timestamp_utc: '2026-06-01 01:00:00', solar_mw: 5 });

    expect(getGenerationSeries('AT', W[0], W[1], 'hourly', db)).toEqual([]);
  });

  it('does not leak another country into a bucket', () => {
    const db = buildDb();
    insertRow(db, { country_code: 'FR', timestamp_utc: '2026-07-29 01:00:00', nuclear_mw: 700 });
    insertRow(db, { country_code: 'DE', timestamp_utc: '2026-07-29 01:00:00', nuclear_mw: 300 });

    const [point] = getGenerationSeries('FR', W[0], W[1], 'hourly', db);

    expect(point.nuclear).toBe(700);
  });

  it('excludes a row on the end date stored with the other separator', () => {
    // Both separator forms live in this column class (see utils/timestamp.ts).
    // The window bound has to admit the in-range one and exclude the later
    // out-of-range one whichever way each is spelled.
    const db = buildDb();
    insertRow(db, { country_code: 'DE', timestamp_utc: '2026-07-29T01:00:00', nuclear_mw: 300 });
    insertRow(db, { country_code: 'DE', timestamp_utc: '2026-07-29 09:00:00', nuclear_mw: 999 });

    const series = getGenerationSeries('DE', W[0], W[1], 'hourly', db);

    expect(series.map((p) => p.nuclear)).toEqual([300]);
  });
});

describe('getGenerationSeries query plan', () => {
  it('uses the (country_code, timestamp_utc) index at every granularity', () => {
    const db = buildDb();
    insertRow(db, { country_code: 'FR', timestamp_utc: '2026-07-29 13:00:00', solar_mw: 100 });

    for (const g of ['hourly', 'daily', 'weekly', 'monthly'] as const) {
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${generationSeriesSql(g)}`)
        .all('FR', ...rangeArgs(timestampRange('2026-07-29T12:00:00Z', '2026-07-29T14:00:00Z'))) as Array<{ detail: string }>;
      const detail = plan.map((row) => row.detail).join('\n');

      expect(detail).toMatch(/SEARCH energy_generation USING (COVERING )?INDEX idx_generation_country_time \(country_code=\? AND timestamp_utc>\? AND timestamp_utc<\?\)/);
    }
  });
});

// ---------------------------------------------------------------------------
// getWindGenerationSeries — onshore/offshore split for the wind forecast tab
// (ABL-235). Same source table as getGenerationSeries, but wind_onshore_mw and
// wind_offshore_mw are kept apart rather than summed into one `wind` family,
// so each can be plotted against its own registered forecast models.
// ---------------------------------------------------------------------------

describe('windGenerationSeriesSql shape', () => {
  it('does not wrap timestamp_utc in date()/strftime() inside WHERE', () => {
    for (const g of ['hourly', 'daily', 'weekly', 'monthly'] as const) {
      const where = windGenerationSeriesSql(g).split('WHERE')[1].split('GROUP BY')[0];
      expect(where).not.toMatch(/date\(\s*timestamp_utc\s*\)/);
      expect(where).not.toMatch(/strftime\(/);
      expect(where).toMatch(/timestamp_utc BETWEEN \? AND \?/);
    }
  });

  it('never wraps a value in COALESCE', () => {
    expect(windGenerationSeriesSql('hourly')).not.toMatch(/COALESCE/i);
  });
});

describe('getWindGenerationSeries', () => {
  const W = ['2026-07-29T00:00:00Z', '2026-07-29T04:00:00Z'] as const;

  it('keeps onshore and offshore apart rather than summing them', () => {
    const db = buildDb();
    insertRow(db, {
      country_code: 'DE', timestamp_utc: '2026-07-29 01:00:00',
      wind_onshore_mw: 200, wind_offshore_mw: 50,
    });

    const [point] = getWindGenerationSeries('DE', W[0], W[1], 'hourly', db);

    expect(point).toEqual({
      timestamp: '2026-07-29T01:00:00',
      wind_onshore: 200,
      wind_offshore: 50,
    });
  });

  it('keeps a measured zero for one type distinguishable from an unreported sibling', () => {
    // BE's real shape: wind_onshore measured 0.0, wind_offshore never reported.
    const db = buildDb();
    insertRow(db, { country_code: 'BE', timestamp_utc: '2026-07-29 01:00:00', wind_onshore_mw: 0 });

    const [point] = getWindGenerationSeries('BE', W[0], W[1], 'hourly', db);

    expect(point.wind_onshore).toBe(0);
    expect(point.wind_onshore).not.toBeNull();
    expect(point.wind_offshore).toBeNull();
  });

  it('reports a country that never sends either type as null, not zero', () => {
    const db = buildDb();
    insertRow(db, { country_code: 'PT', timestamp_utc: '2026-07-29 01:00:00' });

    const [point] = getWindGenerationSeries('PT', W[0], W[1], 'hourly', db);

    expect(point.wind_onshore).toBeNull();
    expect(point.wind_offshore).toBeNull();
  });

  it('averages within a bucket, one column at a time', () => {
    const db = buildDb();
    insertRow(db, { country_code: 'DE', timestamp_utc: '2026-07-29 01:00:00', wind_onshore_mw: 100 });
    insertRow(db, { country_code: 'DE', timestamp_utc: '2026-07-29 02:00:00', wind_onshore_mw: 300, wind_offshore_mw: 40 });

    const [point] = getWindGenerationSeries('DE', W[0], W[1], 'daily', db);

    expect(point.wind_onshore).toBe(200);
    expect(point.wind_offshore).toBe(40);
  });

  it('returns [] when no rows fall in the window, rather than a series of zeros', () => {
    const db = buildDb();
    insertRow(db, { country_code: 'AT', timestamp_utc: '2026-06-01 01:00:00', wind_onshore_mw: 5 });

    expect(getWindGenerationSeries('AT', W[0], W[1], 'hourly', db)).toEqual([]);
  });

  it('does not leak another country into a bucket', () => {
    const db = buildDb();
    insertRow(db, { country_code: 'FR', timestamp_utc: '2026-07-29 01:00:00', wind_onshore_mw: 700 });
    insertRow(db, { country_code: 'DE', timestamp_utc: '2026-07-29 01:00:00', wind_onshore_mw: 300 });

    const [point] = getWindGenerationSeries('FR', W[0], W[1], 'hourly', db);

    expect(point.wind_onshore).toBe(700);
  });
});

describe('getWindGenerationSeries query plan', () => {
  it('uses the (country_code, timestamp_utc) index at every granularity', () => {
    const db = buildDb();
    insertRow(db, { country_code: 'FR', timestamp_utc: '2026-07-29 13:00:00', wind_onshore_mw: 100 });

    for (const g of ['hourly', 'daily', 'weekly', 'monthly'] as const) {
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${windGenerationSeriesSql(g)}`)
        .all('FR', ...rangeArgs(timestampRange('2026-07-29T12:00:00Z', '2026-07-29T14:00:00Z'))) as Array<{ detail: string }>;
      const detail = plan.map((row) => row.detail).join('\n');

      expect(detail).toMatch(/SEARCH energy_generation USING (COVERING )?INDEX idx_generation_country_time \(country_code=\? AND timestamp_utc>\? AND timestamp_utc<\?\)/);
    }
  });
});

/**
 * Opportunistic check against the read-only replica used for development on
 * this workstation. Skipped when the replica or the energy_generation table
 * is absent, so this suite never depends on either existing - CI and any
 * checkout without a local replica simply skip it.
 */
const REPLICA_PATH = 'C:/Code/able/data/energy_dashboard.db';
const replicaAvailable = fs.existsSync(REPLICA_PATH);

function replicaHasGenerationTable(): boolean {
  if (!replicaAvailable) return false;
  const db = new Database(REPLICA_PATH, { readonly: true });
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='energy_generation'")
      .get();
    return !!row;
  } finally {
    db.close();
  }
}

describe.skipIf(!replicaHasGenerationTable())('getGenerationMix against the replica (opportunistic)', () => {
  it('uses the index and returns quickly for a recent window', () => {
    const db = new Database(REPLICA_PATH, { readonly: true });
    try {
      const end = new Date().toISOString();
      const start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${GENERATION_MIX_SQL}`)
        .all('FR', ...rangeArgs(timestampRange(start, end))) as Array<{ detail: string }>;
      const detail = plan.map((row) => row.detail).join('\n');
      expect(detail).toMatch(/SEARCH energy_generation USING (COVERING )?INDEX idx_generation_country_time/);

      const t0 = performance.now();
      const mix = getGenerationMix('FR', start, end, db);
      const elapsedMs = performance.now() - t0;

      expect(elapsedMs).toBeLessThan(2000);
      // Assert shape, not presence: whichever replica this runs against
      // decides whether FR has rows in the last 24h, and that is not this
      // test's subject (it is checking the index and the latency).
      expect(mix === null || typeof mix === 'object').toBe(true);
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!replicaHasGenerationTable())('getRenewableShare against the replica (opportunistic)', () => {
  it('uses the index and returns quickly for a recent window', () => {
    const db = new Database(REPLICA_PATH, { readonly: true });
    try {
      const end = new Date().toISOString();
      const start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${RENEWABLE_SHARE_SQL}`)
        .all('FR', ...rangeArgs(timestampRange(start, end))) as Array<{ detail: string }>;
      const detail = plan.map((row) => row.detail).join('\n');
      expect(detail).toMatch(/SEARCH energy_generation USING (COVERING )?INDEX idx_generation_country_time/);

      const t0 = performance.now();
      const pct = getRenewableShare('FR', start, end, db);
      const elapsedMs = performance.now() - t0;

      expect(elapsedMs).toBeLessThan(2000);
      // Assert shape, not presence: whichever replica this runs against
      // decides whether FR has rows in the last 24h, and its positive total
      // may be degenerate either way.
      expect(pct === null || (typeof pct === 'number' && pct >= 0 && pct <= 100)).toBe(true);
    } finally {
      db.close();
    }
  });
});
