import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import Database, { type Database as DatabaseType } from 'better-sqlite3';

// The module under test imports the shared connection, which opens a real
// SQLite file at import time. getRenewablePercentage always receives its own
// handle in these tests via the optional `db` parameter, so the default
// export just needs to not exist.
import { vi } from 'vitest';
vi.mock('../config/database.js', () => ({ default: null }));

const { getRenewablePercentage, RENEWABLE_PERCENTAGE_SQL } = await import('./renewableService.js');

const SCHEMA = `
  CREATE TABLE energy_renewable (
    country_code TEXT NOT NULL,
    timestamp_utc TEXT NOT NULL,
    solar_mw REAL,
    wind_onshore_mw REAL,
    wind_offshore_mw REAL,
    hydro_run_mw REAL,
    hydro_reservoir_mw REAL,
    biomass_mw REAL,
    geothermal_mw REAL,
    other_renewable_mw REAL
  );
  CREATE UNIQUE INDEX idx_renewable_country_time ON energy_renewable(country_code, timestamp_utc);

  CREATE TABLE energy_load (
    country_code TEXT NOT NULL,
    timestamp_utc TEXT NOT NULL,
    load_mw REAL
  );
  CREATE UNIQUE INDEX idx_load_country_time ON energy_load(country_code, timestamp_utc);
`;

/**
 * The pre-fix predicate (Task 23), kept here only so the fan-out it caused
 * can be demonstrated and compared against the fixed behaviour. Production
 * code no longer contains this shape - see RENEWABLE_PERCENTAGE_SQL instead.
 */
const OLD_JOIN_MATCH_COUNT_SQL = `
  SELECT COUNT(*) as matches
  FROM energy_renewable r
  JOIN energy_load l ON r.country_code = l.country_code
    AND date(r.timestamp_utc) = date(l.timestamp_utc)
    AND strftime('%H', r.timestamp_utc) = strftime('%H', l.timestamp_utc)
  WHERE r.country_code = ?
    AND r.timestamp_utc BETWEEN ? AND ?
`;

const OLD_JOIN_VALUE_SQL = `
  SELECT ROUND(AVG(r.solar_mw * 100.0 / NULLIF(l.load_mw, 0)), 2) as pct
  FROM energy_renewable r
  JOIN energy_load l ON r.country_code = l.country_code
    AND date(r.timestamp_utc) = date(l.timestamp_utc)
    AND strftime('%H', r.timestamp_utc) = strftime('%H', l.timestamp_utc)
  WHERE r.country_code = ?
    AND r.timestamp_utc BETWEEN ? AND ?
`;

function buildDb(): DatabaseType {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

/**
 * Both energy_renewable and energy_load carry 15-minute readings. Seeds two
 * hours (08:00-08:45, 09:00-09:45) of FR data. Within hour 08 the renewable
 * output peaks exactly when load dips (anti-correlated, e.g. midday solar vs.
 * the evening demand peak), so a 1:1 join and a date+hour join land on
 * materially different averages - not just different row counts.
 */
const HOUR_08_SOLAR_MW = [80, 20, 20, 20];
const HOUR_08_LOAD_MW = [400, 1000, 1000, 1000];
const HOUR_09_SOLAR_MW = [30, 30, 30, 30];
const HOUR_09_LOAD_MW = [600, 600, 600, 600];

function seedFifteenMinuteData(db: DatabaseType) {
  const insR = db.prepare(
    'INSERT INTO energy_renewable (country_code, timestamp_utc, solar_mw) VALUES (?, ?, ?)'
  );
  const insL = db.prepare(
    'INSERT INTO energy_load (country_code, timestamp_utc, load_mw) VALUES (?, ?, ?)'
  );
  const minutes = ['00', '15', '30', '45'];
  const solar = [...HOUR_08_SOLAR_MW, ...HOUR_09_SOLAR_MW];
  const load = [...HOUR_08_LOAD_MW, ...HOUR_09_LOAD_MW];
  const hours = ['08', '08', '08', '08', '09', '09', '09', '09'];
  for (let i = 0; i < 8; i++) {
    const ts = `2026-07-27 ${hours[i]}:${minutes[i % 4]}:00`;
    insR.run('FR', ts, solar[i]);
    insL.run('FR', ts, load[i]);
  }
}

describe('RENEWABLE_PERCENTAGE_SQL shape', () => {
  it('does not wrap the joined timestamp column in date()/strftime()', () => {
    // Weak on its own (see the behavioural tests below), but cheap and
    // catches a regression back to the function-on-joined-column shape.
    expect(RENEWABLE_PERCENTAGE_SQL).not.toMatch(/date\(\s*[rl]\.timestamp_utc\s*\)/);
    expect(RENEWABLE_PERCENTAGE_SQL).not.toMatch(/strftime\(\s*'[^']*'\s*,\s*[rl]\.timestamp_utc\s*\)/);
  });

  it('joins on direct timestamp equality', () => {
    expect(RENEWABLE_PERCENTAGE_SQL).toMatch(/l\.timestamp_utc\s*=\s*r\.timestamp_utc/);
  });
});

describe('getRenewablePercentage join behaviour', () => {
  it('matches each renewable row to exactly one load row (no 4x fan-out)', () => {
    const db = buildDb();
    seedFifteenMinuteData(db);

    const { matches: newMatches } = db
      .prepare(
        `SELECT COUNT(*) as matches FROM energy_renewable r
         JOIN energy_load l ON l.country_code = r.country_code AND l.timestamp_utc = r.timestamp_utc
         WHERE r.country_code = ?`
      )
      .get('FR') as { matches: number };
    expect(newMatches).toBe(8); // 8 renewable rows in, 8 matched pairs out

    const { matches: oldMatches } = db
      .prepare(OLD_JOIN_MATCH_COUNT_SQL)
      .get('FR', '2026-07-27 08:00:00', '2026-07-27 09:45:00') as { matches: number };
    expect(oldMatches).toBe(32); // old predicate: each row joined to all 4 load rows sharing its hour
  });

  it('returns the exact 1:1 average rather than the fan-out-skewed one', () => {
    const db = buildDb();
    seedFifteenMinuteData(db);

    const newPct = getRenewablePercentage('FR', '2026-07-27 08:00:00', '2026-07-27 09:45:00', db);

    const solar = [...HOUR_08_SOLAR_MW, ...HOUR_09_SOLAR_MW];
    const load = [...HOUR_08_LOAD_MW, ...HOUR_09_LOAD_MW];
    const sum = solar.reduce((acc, s, i) => acc + (s * 100) / load[i], 0);
    const expected = Math.round((sum / 8) * 100) / 100;

    expect(newPct).toBeCloseTo(expected, 2);

    const { pct: oldPct } = db
      .prepare(OLD_JOIN_VALUE_SQL)
      .get('FR', '2026-07-27 08:00:00', '2026-07-27 09:45:00') as { pct: number };

    // The two predicates disagree here by construction (renewable output is
    // anti-correlated with load inside the hour), demonstrating the fan-out
    // actually moves the number - not just the row count.
    expect(Math.abs((newPct as number) - oldPct)).toBeGreaterThan(0.5);
  });

  it('returns null when there is no data in range', () => {
    const db = buildDb();
    expect(getRenewablePercentage('FR', '2026-01-01 00:00:00', '2026-01-02 00:00:00', db)).toBeNull();
  });

  it('does not match rows from a different country', () => {
    const db = buildDb();
    seedFifteenMinuteData(db);
    db.prepare(
      'INSERT INTO energy_renewable (country_code, timestamp_utc, solar_mw) VALUES (?, ?, ?)'
    ).run('DE', '2026-07-27 08:00:00', 999);
    // No matching DE load row inserted - DE's renewable row must not fall
    // back to matching FR's load row via a country-blind join.
    const pct = getRenewablePercentage('DE', '2026-07-27 08:00:00', '2026-07-27 08:00:00', db);
    expect(pct).toBeNull();
  });
});

describe('getRenewablePercentage query plan', () => {
  it('uses the (country_code, timestamp_utc) index on both tables', () => {
    const db = buildDb();
    seedFifteenMinuteData(db);

    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${RENEWABLE_PERCENTAGE_SQL}`)
      .all('FR', '2026-07-27 08:00:00', '2026-07-27 09:45:00') as Array<{ detail: string }>;
    const detail = plan.map((row) => row.detail).join('\n');

    // SQLite drives the loop from l, range-bound (the WHERE r.timestamp_utc
    // BETWEEN ? AND ? filter propagates to l through the equality join)...
    expect(detail).toMatch(/SEARCH l USING (COVERING )?INDEX idx_load_country_time \(country_code=\? AND timestamp_utc>\? AND timestamp_utc<\?\)/);
    // ...then looks up the matching r row per l row by exact equality.
    expect(detail).toMatch(/SEARCH r USING (COVERING )?INDEX idx_renewable_country_time \(country_code=\? AND timestamp_utc=\?\)/);
  });
});

/**
 * Opportunistic check against the read-only replica used for development on
 * this workstation (see server/.env.example - the path is machine-specific,
 * so this suite must not depend on it existing). When present, it proves the
 * fix holds against real production-shaped data and real index statistics,
 * not just the small synthetic tables above.
 *
 * Uses a fixed historical window (May 2026), not one relative to "now", so
 * the expected value stays stable across days instead of drifting with the
 * live dataset the way a "last 30 days" window would.
 */
const REPLICA_PATH = 'C:/Code/able/data/energy_dashboard.db';
const replicaAvailable = fs.existsSync(REPLICA_PATH);

describe.skipIf(!replicaAvailable)('getRenewablePercentage against the replica (opportunistic)', () => {
  it('uses the index on both sides and returns quickly', () => {
    const db = new Database(REPLICA_PATH, { readonly: true });
    try {
      const start = '2026-05-01 00:00:00';
      const end = '2026-05-31 23:45:00';

      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${RENEWABLE_PERCENTAGE_SQL}`)
        .all('FR', start, end) as Array<{ detail: string }>;
      const detail = plan.map((row) => row.detail).join('\n');
      expect(detail).toMatch(/SEARCH l USING INDEX idx_load_country_time/);
      expect(detail).toMatch(/SEARCH r USING INDEX idx_renewable_country_time/);

      const t0 = performance.now();
      const pct = getRenewablePercentage('FR', start, end, db);
      const elapsedMs = performance.now() - t0;

      // Before the fix this window took ~51-66s on this replica; well under
      // a second confirms the fan-out scan is gone, without pinning an exact
      // millisecond figure that would be flaky across machines.
      expect(elapsedMs).toBeLessThan(2000);
      expect(pct).not.toBeNull();
      expect(pct as number).toBeGreaterThan(0);
      expect(pct as number).toBeLessThan(100);
    } finally {
      db.close();
    }
  });
});
