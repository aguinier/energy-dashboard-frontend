import type { Database as DatabaseType } from 'better-sqlite3';
import defaultDb from '../config/database.js';
import { RenewableMix, RenewableTimeSeriesPoint, Granularity } from '../types/index.js';
import { timestampRange, rangeClause, rangeArgs } from '../utils/timestamp.js';
import { generationGroupByClause } from './generationService.js';
import {
  RENEWABLE_FIELDS,
  renewableFieldSelects,
  sumOrNull,
  RAW_COLUMN,
  WINDOW_AVERAGE,
} from './renewableTotal.js';

/**
 * The renewable breakdown endpoints, read from `energy_generation`.
 *
 * ## Why not `energy_renewable` (ABL-324, tranche 1 of 3)
 *
 * These four queries used to read the frozen `energy_renewable` table, which
 * stores one instant under several timestamp spellings. Measured on the
 * replica 2026-08-12: `energy_renewable` holds **26,694 duplicate instants**,
 * the overwhelming majority of which disagree on at least one value column,
 * while `energy_generation` holds **0 across 3,178,270 rows** and is 100%
 * space-form (zero `T`-separated rows, zero rows of a length other than 19,
 * so none of the trailing-offset rows either).
 *
 * A duplicate instant is not a cosmetic problem for two of these sites: they
 * `AVG()` over the window, so a duplicated hour contributed its two
 * disagreeing values to one mean and the chart drew a point equal to neither
 * stored reading. The other two sites order or `MAX()` on the timestamp
 * string, where `'T'` (84) sorts above `' '` (32) — benign only because no
 * variant row has been written since 2025-11-25, which is a property of the
 * current writer and not a guarantee. All four move together.
 *
 * `energy_generation` is a column superset, is NaN-preserving (no
 * `DEFAULT 0`), and is the same single A75 fetch — no second upstream request
 * is introduced.
 *
 * ## What changed on the wire, deliberately
 *
 * Every field is now `number | null`. It could not stay `number`: the frozen
 * table carried `DEFAULT 0` and these queries wrapped every column in
 * `COALESCE(x, 0)`, so a type a country does not report reached the client as
 * a confident `0 MW`. On `energy_generation` that same absence is NULL and
 * must stay NULL — see `renewableTotal.ts` for the rule and for the two
 * measured figures this move shifts (hydro, and marine reaching `other`).
 *
 * ## The coverage gap this exposes, which must render as a gap
 *
 * `energy_generation` does not cover every hour `energy_renewable` does.
 * Measured on the replica 2026-08-12, France: `energy_renewable` holds 2,208
 * rows across all 23 days of 2026-06-30..2026-07-22, while
 * `energy_generation` holds 135 rows across **2** of them — full days on
 * 06-30 and a partial 07-22, and **nothing at all for 07-01..07-21**
 * (ABL-323, ABL-328). Those 21 days must come back as absent rows, never as
 * zeros: `getRenewableData` groups, so a day with no rows simply produces no
 * bucket, and `getRenewableMix` returns `null` rather than a zero-filled
 * object. Neither interpolates.
 */

/** `AVG()`-per-bucket selects for the seven fields, built once. */
const BUCKET_FIELD_SELECTS = renewableFieldSelects(WINDOW_AVERAGE).join(',\n      ');

/**
 * Renewable generation by source over time.
 *
 * Every field is independently either a number (possibly a measured `0.0`) or
 * `null` — "this country reported none of this field's production types in
 * this bucket". Callers must not read a null as a zero.
 *
 * Returns `[]` when no rows fall in the window: the caller's empty state, not
 * a series of zeros. A bucket with no rows is likewise absent rather than
 * present-and-zero, which is what makes the FR 2026-07-01..21 hole above read
 * as a gap in the chart.
 */
export function getRenewableData(
  countryCode: string,
  start: string,
  end: string,
  granularity: Granularity = 'daily',
  db: DatabaseType = defaultDb
): RenewableTimeSeriesPoint[] {
  const upperCode = countryCode.toUpperCase();
  const range = timestampRange(start, end);
  // date()/strftime() in GROUP BY only, never in WHERE — grouping through a
  // function is fine, filtering through one defeats the
  // (country_code, timestamp_utc) index. Shared with getGenerationSeries so
  // the two cannot bucket a window differently.
  const bucket = generationGroupByClause(granularity);

  const stmt = db.prepare(`
    SELECT
      ${bucket} as timestamp,
      ${BUCKET_FIELD_SELECTS}
    FROM energy_generation
    WHERE country_code = ?
      AND ${rangeClause('timestamp_utc')}
    GROUP BY ${bucket}
    ORDER BY timestamp
  `);

  return stmt.all(upperCode, ...rangeArgs(range)) as RenewableTimeSeriesPoint[];
}

type RenewableMixRow = Omit<RenewableMix, 'total' | 'renewable_percentage'> & { row_count: number };

/**
 * Window-average renewable generation by source.
 *
 * Returns `null` — never a zero-filled object — when no rows fall in the
 * window at all. That distinction is the whole point of `row_count`: "this
 * country has no A75 rows here" (the FR July hole, a window predating a
 * country's ingest) and "rows exist but every renewable column in them is
 * NULL" are different claims, and only the second one has a mix to report.
 *
 * `total` is `sumOrNull` over the seven fields, so it is null only when all
 * seven are — see `renewableTotal.ts`. It is a sum of per-field window
 * averages rather than an average of per-row sums; the two differ when
 * columns have different row coverage, and this is the shape the endpoint has
 * always served and the one `sourceRows.ts` computes client-side.
 */
export function getRenewableMix(
  countryCode: string,
  start: string,
  end: string,
  db: DatabaseType = defaultDb
): RenewableMix | null {
  const upperCode = countryCode.toUpperCase();
  const range = timestampRange(start, end);

  const stmt = db.prepare(`
    SELECT
      COUNT(*) as row_count,
      ${BUCKET_FIELD_SELECTS}
    FROM energy_generation
    WHERE country_code = ?
      AND ${rangeClause('timestamp_utc')}
  `);

  const row = stmt.get(upperCode, ...rangeArgs(range)) as RenewableMixRow | undefined;

  if (!row || row.row_count === 0) return null;

  const { row_count: _rowCount, ...mix } = row;
  return { ...mix, total: sumOrNull(RENEWABLE_FIELDS.map((f) => mix[f])) };
}

/** Single-row selects, aliased to the `r` this query joins `countries` on. */
const LATEST_FIELD_SELECTS = renewableFieldSelects(RAW_COLUMN, 'r.').join(',\n        ');

/**
 * The most recent renewable reading: one country's full breakdown, or every
 * country's total.
 *
 * `ORDER BY r.timestamp_utc DESC` and `MAX(timestamp_utc)` compare the stored
 * strings, which is chronological order exactly as long as one instant has
 * one spelling. On `energy_generation` that holds by measurement — 100%
 * space-form, zero duplicate instants, see this module's header — and it is
 * what keeps the read an index seek rather than a sort over every row a
 * country has. Wrapping the column in `REPLACE()` here would be correct and
 * would cost a full scan; it is unnecessary on this table and was the reason
 * these two sites moved off the frozen one.
 *
 * A latest row whose renewable columns are all NULL yields nulls and a null
 * total. That is the honest answer — the newest A75 document reports no
 * renewable production — and not "0 MW of renewables".
 */
export function getLatestRenewable(countryCode?: string, db: DatabaseType = defaultDb) {
  if (countryCode) {
    const stmt = db.prepare(`
      SELECT
        r.country_code,
        c.country_name,
        r.timestamp_utc as timestamp,
        ${LATEST_FIELD_SELECTS}
      FROM energy_generation r
      JOIN countries c ON r.country_code = c.country_code
      WHERE r.country_code = ?
      ORDER BY r.timestamp_utc DESC
      LIMIT 1
    `);
    const row = stmt.get(countryCode.toUpperCase()) as
      | (Record<string, unknown> & Partial<Record<(typeof RENEWABLE_FIELDS)[number], number | null>>)
      | undefined;
    if (!row) return undefined;
    return { ...row, total_renewable: sumOrNull(RENEWABLE_FIELDS.map((f) => row[f])) };
  }

  // Latest for every country. The correlated MAX() is per country_code, so
  // countries that stopped publishing at different times each report their
  // own newest row rather than being dropped by one shared cutoff — AL's
  // stands at 2026-06-23, its last A75 document, while everyone else's is
  // today.
  //
  // `CROSS JOIN` is load-bearing and is not a cartesian product: it is an
  // inner join with the same ON clause, and in SQLite it additionally pins
  // `countries` as the outer loop. Left to reorder, the planner drives from
  // `energy_generation` and evaluates the correlated subquery per row —
  // `SCAN r USING COVERING INDEX` over all 3,178,270 entries. Measured on the
  // replica 2026-08-12: **2.819s reordered vs 0.002s pinned**, same 34 rows.
  // The frozen table this moved off is a quarter the size, so porting the
  // query unchanged would have made a live endpoint several times slower than
  // it was.
  const stmt = db.prepare(`
    SELECT
      r.country_code,
      c.country_name,
      r.timestamp_utc as timestamp,
      ${LATEST_FIELD_SELECTS}
    FROM countries c
    CROSS JOIN energy_generation r
      ON r.country_code = c.country_code
     AND r.timestamp_utc = (
       SELECT MAX(timestamp_utc)
       FROM energy_generation
       WHERE country_code = c.country_code
     )
    ORDER BY c.country_name
  `);
  const rows = stmt.all() as Array<
    Record<string, unknown> & Partial<Record<(typeof RENEWABLE_FIELDS)[number], number | null>>
  >;
  return rows.map((row) => ({
    ...row,
    total_renewable: sumOrNull(RENEWABLE_FIELDS.map((f) => row[f])),
  }));
}

// getRenewablePercentage / RENEWABLE_PERCENTAGE_SQL (energy_renewable JOIN
// energy_load, matched on r.timestamp_utc = l.timestamp_utc) used to live
// here - a mean of per-timestamp renewable-over-load ratios. It has been
// replaced everywhere by generationService.getRenewableShare, a ratio of
// window sums read from energy_generation (renewable ÷ total generation, not
// ÷ load), which is now the single definition behind every "Renewable share"
// figure in the app - see generationService.ts for the full rationale. This
// also removes the energy_renewable→energy_load join entirely: the join
// needed a real-column-equality rewrite to stop timing out (51s → 0.009s on
// the replica, history preserved in git blame), and the new definition has
// no join at all, so that failure mode cannot recur.
