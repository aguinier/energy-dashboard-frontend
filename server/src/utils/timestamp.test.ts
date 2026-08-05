import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  normalizeTimestamp,
  timestampRange,
  rangeClause,
  rangeArgs,
} from './timestamp.js';

describe('normalizeTimestamp', () => {
  it('converts an ISO instant to the space form', () => {
    expect(normalizeTimestamp('2025-12-27T00:00:00.000Z')).toBe('2025-12-27 00:00:00');
    expect(normalizeTimestamp('2026-07-22T23:59:59Z')).toBe('2026-07-22 23:59:59');
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
