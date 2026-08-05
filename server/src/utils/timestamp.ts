/**
 * Normalize ISO timestamp to the space-separated SQLite form.
 * Converts "2025-12-27T00:00:00.000Z" to "2025-12-27 00:00:00".
 *
 * This is the *lower* of the two forms this database stores — see
 * `timestampRange` below for why that distinction matters, and prefer that
 * helper for anything that bounds a window.
 */
export function normalizeTimestamp(isoTimestamp: string): string {
  return isoTimestamp.replace('T', ' ').replace('Z', '').split('.')[0];
}

/**
 * The same instant in the 'T'-separated form: "2025-12-27T00:00:00".
 * Only the date/time separator at index 10 is touched.
 */
function toTForm(normalized: string): string {
  return normalized.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T');
}

/**
 * Bounds for a window predicate over a timestamp column.
 *
 * **This database stores two separators in the same column.** The doc comment
 * on `normalizeTimestamp` used to claim "SQLite stores timestamps with space
 * separator"; measured against `energy_dashboard.db` on 2026-08-05 that is
 * false for `forecasts` and only mostly true for the actuals:
 *
 * | column                              | 'T'-separated | space-separated |
 * |-------------------------------------|--------------:|----------------:|
 * | `forecasts.target_timestamp_utc`    |     2,035,692 |           5,208 |
 * | `energy_price.timestamp_utc`        |       828,878 |         701,420 |
 * | `energy_load.timestamp_utc`         |       279,880 |       2,480,336 |
 * | `energy_renewable.timestamp_utc`    |        90,636 |         721,319 |
 *
 * In `forecasts` the split is by writer — every `catboost`/`xgboost`/`lightgbm`
 * /`tso_*` row is 'T', the two `chronos` models write space. In the actuals it
 * is a historical cutover: the last 'T' row is 2025-11-26 (`energy_load`),
 * 2025-11-25 (`energy_price`, `energy_renewable`); everything ingested since is
 * space. `energy_generation`, `net_position`, `crossborder_flows`,
 * `forecast_quantiles`, `energy_load_forecast` and `energy_generation_forecast`
 * measured 100% space, but they are bounded through this helper too so that no
 * caller has to carry a per-table matrix in their head.
 *
 * SQLite compares these as plain strings and `'T'` (84) > `' '` (32), so a
 * space-form upper bound sorts *below* every 'T'-form row on the end date and
 * silently drops the whole day (ABL-21). Substituting a 'T'-form upper bound
 * fixes that but breaks the other direction: it then sorts *above* every
 * space-form row on the end date, pulling in rows past the requested time.
 * Neither single bound is correct while both forms exist.
 *
 * So the predicate is two clauses, and both are load-bearing:
 *
 *   1. `col BETWEEN seekStart AND seekEnd` — a deliberately wide range, space
 *      form to 'T' form, that is a strict superset of the answer. The column
 *      is bare, so this still drives the index.
 *   2. `REPLACE(col, 'T', ' ') BETWEEN start AND end` — the exact test, run
 *      only over rows clause 1 already found.
 *
 * Putting `REPLACE` on the column *alone* would also be correct, and is what
 * `crossCountryMetricsService` already does in its JOIN — but it forfeits the
 * range seek. Measured on FR/load over a 7-day window: bare range 0.086 ms,
 * this two-clause form 0.27 ms, `REPLACE`-only 4.41 ms with the plan degrading
 * from `(country_code=? AND forecast_type=? AND target_timestamp_utc>? AND
 * target_timestamp_utc<?)` to `(country_code=? AND forecast_type=?)`. That is
 * the 51s → 0.009s scar in CLAUDE.md's "Common Issues", so it is worth the
 * extra clause to keep the seek.
 */
export interface TimestampRange {
  /** Index-friendly prefilter, low side. Space form — the lower of the two. */
  seekStart: string;
  /** Index-friendly prefilter, high side. 'T' form — the higher of the two. */
  seekEnd: string;
  /** Exact bound, compared against `REPLACE(col, 'T', ' ')`. */
  start: string;
  /** Exact bound, compared against `REPLACE(col, 'T', ' ')`. */
  end: string;
}

export function timestampRange(start: string, end: string): TimestampRange {
  const normalizedStart = normalizeTimestamp(start);
  const normalizedEnd = normalizeTimestamp(end);
  return {
    seekStart: normalizedStart,
    seekEnd: toTForm(normalizedEnd),
    start: normalizedStart,
    end: normalizedEnd,
  };
}

/**
 * The SQL fragment pairing with `rangeArgs`. `column` is interpolated, so it
 * must be a literal identifier from this codebase and never user input.
 */
export function rangeClause(column: string): string {
  return `(${column} BETWEEN ? AND ? AND REPLACE(${column}, 'T', ' ') BETWEEN ? AND ?)`;
}

/**
 * The four bind parameters `rangeClause` expects, in order. Spread this at the
 * position the two old bounds occupied.
 */
export function rangeArgs(range: TimestampRange): [string, string, string, string] {
  return [range.seekStart, range.seekEnd, range.start, range.end];
}
