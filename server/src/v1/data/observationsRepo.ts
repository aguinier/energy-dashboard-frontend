import { rangeArgs, rangeClause, timestampRange } from '../../utils/timestamp.js';
import { measuredLoadClause } from '../../services/loadQuality.js';
import { STREAMS, type ObservationStream, type SeriesDefinition } from './series.js';
import type { EnergyQuery, SqlParam } from './energySource.js';
import type { TimeWindow } from './params.js';
import type { ExcludedNote } from './envelope.js';

/**
 * Reading observations: three ENTSO-E streams, one query shape, and four
 * correctness rules that are each a scar in this repository.
 *
 * ## 1. Every window uses `rangeClause`, without exception
 *
 * This database stores **two separators in one column** — `2026-07-20T00:00:00`
 * and `2026-07-20 00:00:00` — and SQLite compares them as text where `'T'`(84)
 * sorts above `' '`(32). So a space-form upper bound sorts *below* every T-form
 * row on the end date and silently drops the whole day (**ABL-21**, a lost day
 * of forecasts), while a T-form upper bound pulls in rows past the requested
 * time. Neither single bound is correct while both forms exist.
 * `utils/timestamp.ts` solves it with a wide index-friendly prefilter plus an
 * exact `REPLACE`-based test, and keeps the index seek: measured 0.27 ms against
 * 4.41 ms for the `REPLACE`-only form, with the query plan degrading from a
 * range seek to a scan. That is the 51s → 0.009s scar in CLAUDE.md.
 *
 * It is imported rather than reimplemented for the obvious reason: a second
 * implementation of this in `v1/` is a second thing to get right, and the first
 * one was got wrong once already.
 *
 * ## 2. Rows carrying a UTC offset are excluded, and the exclusion is declared
 *
 * 26,405 rows across `energy_price`, `energy_load` and `energy_renewable` are
 * stored as `2025-11-28T00:00:00+02:00` rather than as a bare instant, all
 * inside 2025-11-13..28 (CLAUDE.md:1824-1831). **A `+02:00` row is two hours
 * from where it belongs.** ABL-293 §2a requires whoever builds this to choose
 * explicitly between normalising them on read and excluding them; the choice
 * here is to **exclude**, for two reasons:
 *
 * - Serving them as though they were UTC publishes a two-hour error under a
 *   contract whose first sentence is that every timestamp is UTC.
 * - Shifting them publishes a *correction* we cannot validate. The offset says
 *   what the wall clock was; whether the instant or the label is the wrong half
 *   is not knowable from the row, and this is the sibling module's ingest to
 *   fix, not ours to guess at.
 *
 * The predicate is `LENGTH(timestamp_utc) = 19`, and it is exact rather than
 * heuristic. Measured on the replica 2026-08-13: `energy_load` holds 2,631,796
 * rows of length 19 and 11,717 of length 25; `energy_price` 1,543,996 and 6,942;
 * `energy_generation` 3,178,270 and **zero**. There is no third length. The
 * clause is a bare-column function on rows the range seek has already found, so
 * it costs nothing at the plan level.
 *
 * Excluded rows are named on the response ({@link OFFSET_ROWS_EXCLUDED}) rather
 * than silently dropped: a customer reconciling our counts against ENTSO-E's
 * should find the reason in the response body.
 *
 * ## 3. `null` is not `0`
 *
 * Every production type is emitted on every generation row, `null` where the
 * zone does not report it. `nuclear_mw` is reported by 14 of 34 zones and
 * `marine_mw` by 2. Solar at 03:00 is `0.0` and *that is a measurement*. The
 * serializer never omits-as-zero, never coalesces and never fills — the SQL
 * driver hands back `null` and it goes on the wire as `null`.
 *
 * ## 4. Load's impossible zeros are not measurements
 *
 * `measuredLoadClause()` — `load_mw > 0`. A national grid never draws exactly
 * 0 MW; 543 stored zeros across 11 zones are the ingest writing a placeholder,
 * and MK reads `0.0` for entire days against a real 543-717 MW peak. Serving
 * one as a measurement is how the dashboard header came to read `0 MW`. Applied
 * to `load` only: a `0.0` is impossible for load and completely ordinary for
 * solar overnight, so applying it to generation would delete real measurements
 * and bias every renewable series upward.
 */

/** Named on every `load` and `price` response. Generation holds no such rows. */
export const OFFSET_ROWS_EXCLUDED: ExcludedNote = {
  reason: 'non_utc_stored_timestamp',
  detail:
    'Rows stored with a trailing UTC offset instead of a bare UTC instant are not served. ' +
    '26,405 such rows exist across load and price, all dated 2025-11-13 to 2025-11-28, and ' +
    'each is offset from its true position by up to two hours. They are excluded rather than ' +
    'corrected because the correction cannot be verified from the row. See ' +
    '/v1/catalog/coverage for the affected span.',
};

/** A data row: an RFC 3339 timestamp plus one field per requested series. */
export interface ObservationRow {
  timestamp: string;
  [field: string]: string | number | null;
}

export interface ObservationPage {
  rows: ObservationRow[];
  /** The last stored-form timestamp on this page, for the cursor. `null` when empty. */
  lastStoredTimestamp: string | null;
  /** Whether a further row exists past this page. A fact, not an inference — see below. */
  hasMore: boolean;
}

export interface ObservationQuery {
  stream: ObservationStream;
  zone: string;
  window: TimeWindow;
  /** Which series to emit. Always the full set for load/price; a subset for generation. */
  series: readonly SeriesDefinition[];
  /** Exclusive lower bound from a cursor, in stored form. */
  after?: string;
  /** One more than the page size is fetched; see {@link readObservations}. */
  limit: number;
}

/**
 * Read one page.
 *
 * **`limit + 1` rows are fetched and the extra one is discarded.** That is what
 * makes `meta.truncated` a fact rather than an inference: with exactly `limit`
 * rows in hand, "was there more" is unanswerable, and reporting
 * `truncated: row_count === row_limit` would claim truncation on a window that
 * happens to hold exactly 10,000 rows — handing that caller a `next` link to an
 * empty page, forever, one billed request at a time.
 */
export function readObservations(source: EnergyQuery, query: ObservationQuery): ObservationPage {
  const { stream, zone, window, series, after, limit } = query;
  const { table } = STREAMS[stream];

  // The cursor raises the *seek* bound as well as the exact bound. Sound
  // because the space form is the lower of the two: any row whose normalised
  // value is above a space-form bound also sorts above it raw, since the only
  // difference is a 'T' at position 10 and 'T' > ' '. So nothing is skipped,
  // and page N does not rescan pages 1..N-1.
  const range = timestampRange(after ?? window.sqlStart, window.sqlEndInclusive);

  const columns = series.map((s) => `${s.column} AS "${s.field}"`).join(', ');
  const quality = stream === 'load' ? `AND ${measuredLoadClause()}` : '';
  const cursorClause = after === undefined ? '' : `AND REPLACE(timestamp_utc, 'T', ' ') > ?`;

  const params: SqlParam[] = [zone, ...rangeArgs(range)];
  if (after !== undefined) params.push(after);
  params.push(limit + 1);

  const rows = source.all<Record<string, unknown>>(
    `SELECT REPLACE(timestamp_utc, 'T', ' ') AS "__ts", ${columns}
       FROM ${table}
      WHERE country_code = ?
        AND LENGTH(timestamp_utc) = 19
        AND ${rangeClause('timestamp_utc')}
        ${quality}
        ${cursorClause}
      ORDER BY REPLACE(timestamp_utc, 'T', ' ')
      LIMIT ?`,
    params
  );

  const page = rows.slice(0, limit);
  const shaped: ObservationRow[] = page.map((row) => {
    const stored = row.__ts as string;
    const shapedRow: ObservationRow = { timestamp: `${stored.replace(' ', 'T')}Z` };
    for (const definition of series) {
      const value = row[definition.field];
      // `null` stays `null` — the whole point of rule 3 above. `undefined`
      // cannot occur (every requested column is in the SELECT) but would
      // serialise to an absent key, so it is mapped rather than spread.
      shapedRow[definition.field] = (value as number | null) ?? null;
    }
    return shapedRow;
  });

  return {
    rows: shaped,
    lastStoredTimestamp: page.length === 0 ? null : (page[page.length - 1].__ts as string),
    hasMore: rows.length > page.length,
  };
}
