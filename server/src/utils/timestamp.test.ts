import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  normalizeTimestamp,
  timestampRange,
  rangeClause,
  rangeArgs,
  toIsoUtc,
  timestampFormOnClause,
} from './timestamp.js';

describe('normalizeTimestamp', () => {
  it('converts an ISO instant to the space form', () => {
    expect(normalizeTimestamp('2025-12-27T00:00:00.000Z')).toBe('2025-12-27 00:00:00');
    expect(normalizeTimestamp('2026-07-22T23:59:59Z')).toBe('2026-07-22 23:59:59');
  });

  it('leaves an already-normalized value alone', () => {
    expect(normalizeTimestamp('2025-12-27 00:00:00')).toBe('2025-12-27 00:00:00');
  });
});

describe('timestampRange', () => {
  it('seeks from the space form up to the T form, and tests exactly in the space form', () => {
    expect(timestampRange('2026-07-15T00:00:00Z', '2026-07-22T23:59:59Z')).toEqual({
      seekStart: '2026-07-15 00:00:00',
      seekEnd: '2026-07-22T23:59:59',
      start: '2026-07-15 00:00:00',
      end: '2026-07-22 23:59:59',
    });
  });

  it('makes the seek range a superset: seekStart <= start and seekEnd >= end', () => {
    const r = timestampRange('2026-07-15T06:00:00Z', '2026-07-22T12:00:00Z');
    // Plain string comparison, which is all SQLite does here.
    expect(r.seekStart <= r.start).toBe(true);
    expect(r.seekEnd >= r.end).toBe(true);
    // ...and the seek range brackets both storage forms of each bound.
    expect(r.seekStart <= '2026-07-15T06:00:00').toBe(true);
    expect(r.seekEnd >= '2026-07-22T12:00:00').toBe(true);
  });

  it('only rewrites the separator at index 10, leaving a malformed bound alone', () => {
    expect(timestampRange('2026-07-15', '2026-07-22').seekEnd).toBe('2026-07-22');
  });
});

describe('rangeClause + rangeArgs against real SQLite', () => {
  // The two storage forms measured in energy_dashboard.db, in one column —
  // which is the situation the helper exists for.
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE t (ts TEXT NOT NULL);`);
  const insert = db.prepare('INSERT INTO t (ts) VALUES (?)');
  const hours = ['00:00:00', '06:00:00', '12:00:00', '18:00:00', '23:00:00'];
  for (const day of ['2026-07-14', '2026-07-15', '2026-07-21', '2026-07-22', '2026-07-23']) {
    for (const h of hours) {
      insert.run(`${day} ${h}`); // space form
      insert.run(`${day}T${h}`); // 'T' form
    }
  }

  const select = (start: string, end: string): string[] => {
    const r = timestampRange(start, end);
    return db
      .prepare(`SELECT ts FROM t WHERE ${rangeClause('ts')} ORDER BY REPLACE(ts, 'T', ' '), ts`)
      .all(...rangeArgs(r))
      .map((row) => (row as { ts: string }).ts);
  };

  it('includes both storage forms of a row on the end date — the ABL-21 regression', () => {
    const got = select('2026-07-15T00:00:00Z', '2026-07-22T23:59:59Z');
    expect(got).toContain('2026-07-22 23:00:00');
    expect(got).toContain('2026-07-22T23:00:00');
    // The 3 seeded days inside the window (07-15, 07-21, 07-22) x 5 hours x 2 forms.
    expect(got).toHaveLength(30);
  });

  it('does not over-include: a mid-day end bound cuts both forms at the same instant', () => {
    const got = select('2026-07-15T00:00:00Z', '2026-07-22T12:00:00Z');
    expect(got).toContain('2026-07-22 12:00:00');
    expect(got).toContain('2026-07-22T12:00:00');
    // The naive fix — a bare 'T'-form upper bound — lets these two through.
    expect(got).not.toContain('2026-07-22 18:00:00');
    expect(got).not.toContain('2026-07-22 23:00:00');
  });

  it('does not over-include on the start side either', () => {
    const got = select('2026-07-15T06:00:00Z', '2026-07-21T23:00:00Z');
    // The old space-form-only lower bound let a 'T' row before the start time
    // through, because 'T' sorts above space on the same date.
    expect(got).not.toContain('2026-07-15T00:00:00');
    expect(got).not.toContain('2026-07-15 00:00:00');
    expect(got).toContain('2026-07-15T06:00:00');
    expect(got).toContain('2026-07-15 06:00:00');
  });

  it('excludes the days either side of the window in both forms', () => {
    const got = select('2026-07-15T00:00:00Z', '2026-07-22T23:59:59Z');
    for (const ts of got) expect(ts.slice(0, 10) >= '2026-07-15').toBe(true);
    for (const ts of got) expect(ts.slice(0, 10) <= '2026-07-22').toBe(true);
  });

  it('keeps the index range seek rather than scanning', () => {
    db.exec('CREATE INDEX idx_t_ts ON t(ts)');
    const r = timestampRange('2026-07-15T00:00:00Z', '2026-07-22T23:59:59Z');
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN SELECT ts FROM t WHERE ${rangeClause('ts')}`)
      .all(...rangeArgs(r))
      .map((row) => (row as { detail: string }).detail)
      .join(' ');
    // The whole reason for the two-clause form: REPLACE() alone would drop the
    // `ts>? AND ts<?` seek and scan the table.
    expect(plan).toMatch(/USING (COVERING )?INDEX idx_t_ts \(ts>\? AND ts<\?\)/);
  });
});

describe('timestampFormOnClause + a paired LEFT JOIN (ABL-214)', () => {
  // A forecasts-shaped table joined to an actuals-shaped table that — like
  // energy_load/energy_price/energy_renewable in production — can hold a 'T'
  // row and a space row for the SAME country-hour, sometimes with conflicting
  // values (ABL-211/ABL-215).
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE f (country_code TEXT, target_timestamp_utc TEXT);
    CREATE TABLE a (country_code TEXT, ts TEXT, value REAL);
    CREATE UNIQUE INDEX idx_a ON a(country_code, ts);
    INSERT INTO f VALUES
      ('DE', '2026-07-01T00:00:00'), -- actual exists ONLY as space form
      ('DE', '2026-07-01T01:00:00'), -- actual exists ONLY as 'T' form
      ('DE', '2026-07-01T02:00:00'), -- actual exists in BOTH forms, CONFLICTING
      ('DE', '2026-07-01T03:00:00'); -- no actual in either form
    INSERT INTO a VALUES
      ('DE', '2026-07-01 00:00:00', 100),
      ('DE', '2026-07-01T01:00:00', 200),
      ('DE', '2026-07-01 02:00:00', 300), ('DE', '2026-07-01T02:00:00', 999);
  `);

  const resolved = () =>
    db
      .prepare(`
        SELECT f.target_timestamp_utc as ts, COALESCE(a1.value, a2.value) as resolved
        FROM f
        LEFT JOIN a a1 ON a1.country_code = f.country_code
          AND ${timestampFormOnClause('a1.ts', 'f.target_timestamp_utc', 'space')}
        LEFT JOIN a a2 ON a2.country_code = f.country_code
          AND ${timestampFormOnClause('a2.ts', 'f.target_timestamp_utc', 't')}
        ORDER BY f.target_timestamp_utc
      `)
      .all() as Array<{ ts: string; resolved: number | null }>;

  it('matches a space-form-only row via the space clause', () => {
    expect(resolved().find((r) => r.ts === '2026-07-01T00:00:00')?.resolved).toBe(100);
  });

  it("rescues a 'T'-form-only row via the fallback clause — the ABL-214 fix", () => {
    expect(resolved().find((r) => r.ts === '2026-07-01T01:00:00')?.resolved).toBe(200);
  });

  it('never fans out on a conflicting pair, and keeps preferring the space-form value', () => {
    const rows = db
      .prepare(`
        SELECT COUNT(*) as n FROM f
        LEFT JOIN a a1 ON a1.country_code = f.country_code
          AND ${timestampFormOnClause('a1.ts', 'f.target_timestamp_utc', 'space')}
        LEFT JOIN a a2 ON a2.country_code = f.country_code
          AND ${timestampFormOnClause('a2.ts', 'f.target_timestamp_utc', 't')}
        WHERE f.target_timestamp_utc = '2026-07-01T02:00:00'
      `)
      .get() as { n: number };
    expect(rows.n).toBe(1); // not 2 — a naive `IN(spaceForm, tForm)` join would double this
    expect(resolved().find((r) => r.ts === '2026-07-01T02:00:00')?.resolved).toBe(300); // space-form, not 999
  });

  it('resolves to null when neither form exists', () => {
    expect(resolved().find((r) => r.ts === '2026-07-01T03:00:00')?.resolved).toBeNull();
  });

  it('keeps the index seek on each side of the pair', () => {
    const plan = db
      .prepare(`
        EXPLAIN QUERY PLAN
        SELECT f.target_timestamp_utc FROM f
        LEFT JOIN a a1 ON a1.country_code = f.country_code
          AND ${timestampFormOnClause('a1.ts', 'f.target_timestamp_utc', 'space')}
        LEFT JOIN a a2 ON a2.country_code = f.country_code
          AND ${timestampFormOnClause('a2.ts', 'f.target_timestamp_utc', 't')}
      `)
      .all()
      .map((row) => (row as { detail: string }).detail)
      .join(' ');
    expect(plan).toMatch(/SEARCH a1 USING (COVERING )?INDEX idx_a \(country_code=\? AND ts=\?\)/);
    expect(plan).toMatch(/SEARCH a2 USING (COVERING )?INDEX idx_a \(country_code=\? AND ts=\?\)/);
  });
});

describe('toIsoUtc', () => {
  // Both shapes really are in the table — see the module comment, and the
  // per-column matrix on `timestampRange` above.
  it('stamps the zone on the space-separated form', () => {
    expect(toIsoUtc('2026-08-06 23:45:00')).toBe('2026-08-06T23:45:00Z');
  });

  it("stamps the zone on the 'T'-separated form (GB/UA's rows)", () => {
    expect(toIsoUtc('2021-06-14T09:00:00')).toBe('2021-06-14T09:00:00Z');
  });

  it("parses back to the same instant regardless of the reader's timezone", () => {
    // The point of the whole helper: no local-time reinterpretation.
    expect(Date.parse(toIsoUtc('2021-06-14T09:00:00')!)).toBe(Date.UTC(2021, 5, 14, 9, 0, 0));
    expect(Date.parse(toIsoUtc('2021-06-14 09:00:00')!)).toBe(Date.UTC(2021, 5, 14, 9, 0, 0));
  });

  it('does not double-stamp a value that already carries a zone', () => {
    expect(toIsoUtc('2026-08-06T23:45:00Z')).toBe('2026-08-06T23:45:00Z');
    expect(toIsoUtc('2026-08-06T23:45:00+02:00')).toBe('2026-08-06T23:45:00+02:00');
  });

  it('returns undefined for a missing or blank value', () => {
    expect(toIsoUtc(undefined)).toBeUndefined();
    expect(toIsoUtc(null)).toBeUndefined();
    expect(toIsoUtc('')).toBeUndefined();
    expect(toIsoUtc('   ')).toBeUndefined();
  });
});
