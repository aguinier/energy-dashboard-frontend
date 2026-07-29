import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import Database, { type Database as DatabaseType } from 'better-sqlite3';

// The module under test imports the shared connection, which opens a real
// SQLite file at import time. getGenerationMix always receives its own
// handle in these tests via the optional `db` parameter, so the default
// export just needs to not exist.
import { vi } from 'vitest';
vi.mock('../config/database.js', () => ({ default: null }));

const { getGenerationMix, GENERATION_MIX_SQL } = await import('./generationService.js');

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
});

describe('getGenerationMix query plan', () => {
  it('uses the (country_code, timestamp_utc) index', () => {
    const db = buildDb();
    insertRow(db, { country_code: 'FR', timestamp_utc: '2026-07-29 13:00:00', nuclear_mw: 40000 });

    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${GENERATION_MIX_SQL}`)
      .all('FR', '2026-07-29 12:00:00', '2026-07-29 14:00:00') as Array<{ detail: string }>;
    const detail = plan.map((row) => row.detail).join('\n');

    expect(detail).toMatch(/SEARCH energy_generation USING (COVERING )?INDEX idx_generation_country_time \(country_code=\? AND timestamp_utc>\? AND timestamp_utc<\?\)/);
  });
});

/**
 * Opportunistic check against the read-only replica used for development on
 * this workstation. Skipped when the replica or the energy_generation table
 * is absent, so this suite never depends on either existing (the backfill
 * this table depends on can still be in flight - see the A75 plan, Task 4).
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
        .all('FR', start.replace('T', ' ').split('.')[0], end.replace('T', ' ').split('.')[0]) as Array<{ detail: string }>;
      const detail = plan.map((row) => row.detail).join('\n');
      expect(detail).toMatch(/SEARCH energy_generation USING (COVERING )?INDEX idx_generation_country_time/);

      const t0 = performance.now();
      const mix = getGenerationMix('FR', start, end, db);
      const elapsedMs = performance.now() - t0;

      expect(elapsedMs).toBeLessThan(2000);
      // Recent history may still be mid-backfill for some countries; only
      // assert shape, not presence, so this suite does not flake on backfill
      // progress.
      expect(mix === null || typeof mix === 'object').toBe(true);
    } finally {
      db.close();
    }
  });
});
