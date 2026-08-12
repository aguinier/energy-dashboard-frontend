import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  RENEWABLE_COMPONENTS,
  RENEWABLE_FIELDS,
  RENEWABLE_MW_COLUMNS,
  sumOrNull,
  nullAwareSumSql,
  renewableFieldSelects,
  RAW_COLUMN,
  WINDOW_AVERAGE,
} from './renewableTotal.js';

// No import of generationService here, deliberately: it pulls in the shared
// connection, which opens a real SQLite file at import time. This module is
// pure and its test stays runnable without a database or a mock - the shape
// CLAUDE.md asks new logic to take. The matching assertion that
// generationService.RENEWABLE_MW_SUM really is built from RENEWABLE_MW_COLUMNS
// lives in generationService.test.ts, which already mocks that connection.

// Mirrors renewableTotal.RENEWABLE_MW_COLUMNS - kept independent of the
// production constant, the same convention generationService.test.ts's
// RENEWABLE_KEYS follows, so these tests actually fail if the renewable
// column set ever drifts from the definition ABL-324 signed off:
// solar, wind onshore/offshore, hydro run + reservoir, biomass, geothermal,
// marine, other renewable. Explicitly NOT hydro_pumped or energy_storage,
// which are stores rather than primary generation.
const EXPECTED_COLUMNS = [
  'solar_mw',
  'wind_onshore_mw',
  'wind_offshore_mw',
  'hydro_run_mw',
  'hydro_reservoir_mw',
  'biomass_mw',
  'geothermal_mw',
  'marine_mw',
  'other_renewable_mw',
];

describe('sumOrNull', () => {
  // The four cases ABL-351 names. Each is a distinct claim about the data and
  // none may collapse into another.

  it('returns null when every component is null - never 0', () => {
    expect(sumOrNull([null, null, null])).toBeNull();
    expect(sumOrNull([undefined, undefined])).toBeNull();
    expect(sumOrNull([null, undefined])).toBeNull();
    expect(sumOrNull([])).toBeNull();
    // The whole point: a country reporting none of these types has no
    // renewable total. `0` would render it as generating no renewable power.
    expect(sumOrNull([null, null])).not.toBe(0);
  });

  it('sums the reported components when some are null', () => {
    expect(sumOrNull([100, null, 50])).toBe(150);
    expect(sumOrNull([null, 42])).toBe(42);
    // FR's shape at 02:00: hydro_run reported, hydro_reservoir not. The
    // reported reading survives instead of being nulled by its sibling, which
    // is what a bare SQL `a + b` would do.
    expect(sumOrNull([40, null])).toBe(40);
  });

  it('treats a measured 0.0 as a value, not a missing reading', () => {
    // Solar overnight, a becalmed wind fleet. These are measurements.
    expect(sumOrNull([0, 0, 0])).toBe(0);
    expect(sumOrNull([0, null])).toBe(0);
    expect(sumOrNull([0, 100])).toBe(100);
    // A truthiness filter would return null here, turning "we measured no
    // output" into "we hold no reading" - the same lie in the other direction.
    expect(sumOrNull([0, 0])).not.toBeNull();
  });

  it('sums ordinary reported components', () => {
    expect(sumOrNull([1, 2, 3])).toBe(6);
    // Negatives are passed through rather than clamped; none of the renewable
    // columns is expected to go negative, but inventing a floor here would be
    // this module deciding something it has not measured.
    expect(sumOrNull([100, -20])).toBe(80);
  });
});

describe('RENEWABLE_COMPONENTS', () => {
  it('maps the seven wire fields the /renewables endpoints have always served', () => {
    expect(RENEWABLE_FIELDS).toEqual([
      'solar', 'wind_onshore', 'wind_offshore', 'hydro', 'biomass', 'geothermal', 'other',
    ]);
  });

  it('splits hydro into run-of-river and reservoir, and excludes pumped storage', () => {
    expect(RENEWABLE_COMPONENTS.hydro).toEqual(['hydro_run_mw', 'hydro_reservoir_mw']);
    expect(RENEWABLE_MW_COLUMNS).not.toContain('hydro_pumped_mw');
    expect(RENEWABLE_MW_COLUMNS).not.toContain('energy_storage_mw');
  });

  it('carries marine in `other`, which the frozen table dropped entirely', () => {
    expect(RENEWABLE_COMPONENTS.other).toEqual(['marine_mw', 'other_renewable_mw']);
  });

  it('flattens to exactly the nine renewable columns', () => {
    expect([...RENEWABLE_MW_COLUMNS].sort()).toEqual([...EXPECTED_COLUMNS].sort());
  });

});

describe('nullAwareSumSql', () => {
  it('guards the sum with an all-null CASE rather than a bare COALESCE sum', () => {
    expect(nullAwareSumSql(['a_mw', 'b_mw'], 'grp')).toBe(
      'CASE WHEN a_mw IS NULL AND b_mw IS NULL THEN NULL ' +
        'ELSE ROUND(COALESCE(a_mw, 0) + COALESCE(b_mw, 0), 2) END as grp'
    );
  });

  it('reads through AVG() for a grouped or whole-window query', () => {
    expect(nullAwareSumSql(['a_mw'], 'grp', WINDOW_AVERAGE)).toBe(
      'CASE WHEN AVG(a_mw) IS NULL THEN NULL ELSE ROUND(COALESCE(AVG(a_mw), 0), 2) END as grp'
    );
  });

  it('emits the text generationService.groupExpression used to build by hand', () => {
    // The consolidation must be byte-identical, or it silently reshapes the
    // Generation tab's SQL along with the /renewables breakdown's.
    const columns = ['hydro_run_mw', 'hydro_reservoir_mw'];
    const allNull = columns.map((c) => `AVG(${c}) IS NULL`).join(' AND ');
    const sum = columns.map((c) => `COALESCE(AVG(${c}), 0)`).join(' + ');
    expect(nullAwareSumSql(columns, 'hydro', WINDOW_AVERAGE)).toBe(
      `CASE WHEN ${allNull} THEN NULL ELSE ROUND(${sum}, 2) END as hydro`
    );
  });
});

describe('renewableFieldSelects', () => {
  it('produces one null-aware select per wire field', () => {
    const selects = renewableFieldSelects(WINDOW_AVERAGE);
    expect(selects).toHaveLength(7);
    for (const field of RENEWABLE_FIELDS) {
      expect(selects.join(' ')).toContain(`END as ${field}`);
    }
  });

  it('applies a table alias to the raw column names', () => {
    const [solar] = renewableFieldSelects(RAW_COLUMN, 'r.');
    expect(solar).toBe(
      'CASE WHEN r.solar_mw IS NULL THEN NULL ELSE ROUND(COALESCE(r.solar_mw, 0), 2) END as solar'
    );
  });
});

// The SQL and the TypeScript are two statements of one rule, on opposite
// sides of a database driver. Asserting the text alone would not catch a rule
// that reads correctly and evaluates wrongly, so this runs it.
describe('nullAwareSumSql evaluated in SQLite', () => {
  function evaluate(rows: Array<{ a: number | null; b: number | null }>, term = WINDOW_AVERAGE) {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (a REAL, b REAL)');
    const insert = db.prepare('INSERT INTO t (a, b) VALUES (?, ?)');
    for (const row of rows) insert.run(row.a, row.b);
    const sql = `SELECT ${nullAwareSumSql(['a', 'b'], 'total', term)} FROM t`;
    const result = (db.prepare(sql).get() as { total: number | null } | undefined)?.total ?? null;
    db.close();
    return result;
  }

  it('returns NULL when every column is NULL in every row', () => {
    expect(evaluate([{ a: null, b: null }, { a: null, b: null }])).toBeNull();
  });

  it('returns the reported column when its sibling is NULL throughout', () => {
    // A bare `AVG(a + b)` returns NULL here - SQL's + propagates - deleting a
    // real reading. That is the failure this CASE/COALESCE pairing prevents.
    expect(evaluate([{ a: 40, b: null }, { a: 60, b: null }])).toBe(50);
  });

  it('does not charge a bucket for the rows a column is absent from', () => {
    // Each column averages over the rows it was actually reported in:
    // a = (40+60)/2 = 50, b = 10/1 = 10, so the group reads 60.
    // `AVG(COALESCE(a,0) + COALESCE(b,0))` reads 55 instead - it divides b's
    // single reading by both rows, understating a type the country reports
    // intermittently. That is the other half of why this is not a one-liner.
    expect(evaluate([{ a: 40, b: null }, { a: 60, b: 10 }])).toBe(60);
  });

  it('keeps a measured 0.0 as a value', () => {
    expect(evaluate([{ a: 0, b: null }, { a: 0, b: null }])).toBe(0);
  });

  it('agrees with sumOrNull on a single row read raw', () => {
    expect(evaluate([{ a: 0, b: null }], RAW_COLUMN)).toBe(sumOrNull([0, null]));
    expect(evaluate([{ a: null, b: null }], RAW_COLUMN)).toBe(sumOrNull([null, null]));
    expect(evaluate([{ a: 12, b: 30 }], RAW_COLUMN)).toBe(sumOrNull([12, 30]));
  });
});
