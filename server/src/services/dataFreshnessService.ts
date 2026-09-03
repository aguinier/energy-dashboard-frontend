import db from '../config/database.js';
import { measuredLoadClause } from './loadQuality.js';
import {
  classifyMeasuredStream,
  classifyDayAheadStream,
  type FreshnessStream,
} from './freshness.js';
import {
  applyCoverage,
  COVERAGE_BASELINE_DAYS,
  COVERAGE_WINDOW_DAYS,
  type DailyRowCount,
} from './freshnessCoverage.js';
import { rangeArgs, rangeClause, timestampRange } from '../utils/timestamp.js';

/**
 * The five streams the dashboard depends on, each with a verdict on whether it
 * is current. See `freshness.ts` for the two rules and how they were sized, and
 * `freshnessCoverage.ts` for the third (ABL-632) that reads the interior of the
 * window rather than only its newest edge.
 */
export interface DataFreshness {
  load: FreshnessStream;
  price: FreshnessStream;
  generation: FreshnessStream;
  tsoLoadForecast: FreshnessStream;
  tsoGenerationForecast: FreshnessStream;
}

function newest(sql: string, countryCode: string): string | null {
  const row = db.prepare(sql).get(countryCode) as { latest: string | null } | undefined;
  return row?.latest ?? null;
}

const DAY_MS = 86_400_000;

/**
 * How wide a slice of the table each coverage query reads.
 *
 * Back far enough to hold a whole baseline plus the window it anchors, and one
 * spare day because the window ends the day *before* the newest day with rows.
 * Forward two days because three of the five streams are day-ahead publications
 * whose newest rows are legitimately dated into the future — a lookahead of 0
 * would hand `computeCoverage` a window ending yesterday for `price` and score
 * the wrong days. Two days is deliberately short of D+7: it excludes
 * `energy_load_forecast`'s week-ahead rows, which are one row per day and would
 * otherwise anchor the window seven days past the day-ahead data it counts.
 */
const COVERAGE_LOOKBACK_DAYS = COVERAGE_BASELINE_DAYS + COVERAGE_WINDOW_DAYS + 1;
const COVERAGE_LOOKAHEAD_DAYS = 2;

/**
 * Rows per UTC day for one stream, for `freshnessCoverage.ts` to score.
 *
 * `substr(col, 1, 10)` reads the date part of either stored separator form
 * identically, and it sits in the SELECT/GROUP BY rather than the WHERE — the
 * window predicate is `rangeClause`, so the index seek is intact (CLAUDE.md's
 * 51-second scar is a function-of-column in a *filter*). Verified on prod
 * 2026-09-02: `SEARCH energy_load USING INDEX idx_energy_load_country_time`,
 * and all 180 queries behind a whole-fleet ops rollup run in 0.06-0.15 s.
 *
 * The offset-suffixed rows (`...T00:00:00+02:00`, all inside 2025-11-13..28)
 * would have their *local* date read here. They cannot reach a coverage window,
 * which never opens more than ~17 days before `now`.
 */
function dailyCounts(
  table: string,
  column: string,
  countryCode: string,
  now: Date,
  extraClause = '',
): DailyRowCount[] {
  const range = timestampRange(
    new Date(now.getTime() - COVERAGE_LOOKBACK_DAYS * DAY_MS).toISOString(),
    new Date(now.getTime() + COVERAGE_LOOKAHEAD_DAYS * DAY_MS).toISOString(),
  );

  const rows = db
    .prepare(
      `SELECT substr(${column}, 1, 10) AS day, COUNT(*) AS row_count
         FROM ${table}
        WHERE country_code = ? AND ${rangeClause(column)}${extraClause}
        GROUP BY day`,
    )
    .all(countryCode, ...rangeArgs(range)) as { day: string; row_count: number }[];

  return rows.map(({ day, row_count }) => ({ day, rows: row_count }));
}

export function getDataFreshness(countryCode: string, now: Date = new Date()): DataFreshness {
  // `measuredLoadClause()` matters here as much as it does on a chart, and this
  // was the one `energy_load` read site without it. A national grid never draws
  // 0 MW, so those rows are placeholders (ABL-35) — and this endpoint was
  // dating the pipeline's health from one. Measured on the replica 2026-08-07:
  // SI's raw MAX is `2026-08-07 00:15` with `load_mw = 0`, against a guarded
  // MAX of `00:00`. Small in hours, wrong in kind: freshness computed from a
  // row every other query in the codebase refuses to serve.
  const load = newest(
    `SELECT MAX(timestamp_utc) as latest FROM energy_load
      WHERE country_code = ? AND ${measuredLoadClause()}`,
    countryCode,
  );

  const price = newest(
    `SELECT MAX(timestamp_utc) as latest FROM energy_price WHERE country_code = ?`,
    countryCode,
  );

  // `energy_generation`, not the frozen `energy_renewable` this used to read.
  // Both are written from one A75 fetch per country per window, so they cannot
  // disagree about when we last stored something — verified on the replica
  // 2026-08-07, MAX(timestamp_utc) identical for all 34 countries — which makes
  // this a free correction rather than a behaviour change. It is worth making
  // anyway: `GenerationTab` has drawn `energy_generation` since ABL-44, and a
  // freshness signal should describe the table the user is looking at, not the
  // frozen one beside it.
  const generation = newest(
    `SELECT MAX(timestamp_utc) as latest FROM energy_generation WHERE country_code = ?`,
    countryCode,
  );

  const tsoLoadForecast = newest(
    `SELECT MAX(target_timestamp_utc) as latest FROM energy_load_forecast WHERE country_code = ?`,
    countryCode,
  );

  const tsoGenerationForecast = newest(
    `SELECT MAX(target_timestamp_utc) as latest FROM energy_generation_forecast WHERE country_code = ?`,
    countryCode,
  );

  // ABL-632. Age alone is blind to a pipeline that limps: one surviving row per
  // pass keeps `MAX` recent while the window behind it fills with holes, which
  // is how a four-day prod degradation (2026-08-30..09-02) reported `live`
  // throughout. Each stream is now also scored on how full its trailing window
  // is; `applyCoverage` publishes that measurement beside the verdict and
  // downgrades only a `live` stream, never `ended` or `none`.
  //
  // Every count is scoped exactly as its `MAX` above — the same
  // `measuredLoadClause()` on load — with one deliberate exception:
  // `tsoLoadForecast` counts `day_ahead` rows only. `energy_load_forecast` also
  // holds week-ahead rows at one per day, and pooling two resolutions into one
  // total would put a wrong denominator under a published ratio. `latest` there
  // still spans both types, as it always has; the two fields answer different
  // questions and each is internally consistent.
  return {
    load: applyCoverage(
      classifyMeasuredStream(load, now),
      dailyCounts('energy_load', 'timestamp_utc', countryCode, now, ` AND ${measuredLoadClause()}`),
      'load',
    ),
    generation: applyCoverage(
      classifyMeasuredStream(generation, now),
      dailyCounts('energy_generation', 'timestamp_utc', countryCode, now),
      'generation',
    ),
    // Day-ahead publications are legitimately dated in the future, so they are
    // judged on coverage. Judging them on age would report a healthy price as
    // impossibly fresh and never notice a missing tomorrow — ABL-51.
    //
    // Each names its own stream because the deadline is per document, not
    // fleet-wide: A44 and A65 publish around midday Brussels, A69 (day-ahead
    // wind & solar) has until 18:00 Brussels D-1, so one shared 14:00 UTC cutoff
    // flagged every country's generation forecast stale every afternoon
    // (ABL-494). See `DAY_AHEAD_REQUIRED_AFTER_UTC_HOUR` for the derivations.
    price: applyCoverage(
      classifyDayAheadStream(price, now, 'price'),
      dailyCounts('energy_price', 'timestamp_utc', countryCode, now),
      'price',
    ),
    tsoLoadForecast: applyCoverage(
      classifyDayAheadStream(tsoLoadForecast, now, 'tsoLoadForecast'),
      dailyCounts(
        'energy_load_forecast',
        'target_timestamp_utc',
        countryCode,
        now,
        ` AND forecast_type = 'day_ahead'`,
      ),
      'tsoLoadForecast',
    ),
    tsoGenerationForecast: applyCoverage(
      classifyDayAheadStream(tsoGenerationForecast, now, 'tsoGenerationForecast'),
      dailyCounts('energy_generation_forecast', 'target_timestamp_utc', countryCode, now),
      'tsoGenerationForecast',
    ),
  };
}
