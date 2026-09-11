import db from '../config/database.js';
import { measuredLoadClause } from './loadQuality.js';
import {
  classifyMeasuredStream,
  classifyDayAheadStream,
  publicationObligationUtc,
  type FreshnessStream,
} from './freshness.js';
import {
  applyCoverage,
  COVERAGE_BASELINE_DAYS,
  COVERAGE_WINDOW_DAYS,
  type DailyRowCount,
} from './freshnessCoverage.js';
import { INGEST_PIPELINES } from './ingestLog.js';
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
 * the wrong days. Two days is deliberately short of D+7, so a week-ahead row
 * cannot anchor a window seven days past the day-ahead data it counts. The
 * `forecast_type` filter below is the primary guard against that; this bound
 * also holds it for any future table that mixes horizons without a filter.
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

/**
 * The log's own stamp shape, cut to the second: `2026-09-09T16:00:00`.
 *
 * `data_ingestion_log` writes Python's `datetime.now(pytz.UTC).isoformat()`:
 * 32 characters, `T`-separated, ending `+00:00`. That is 20,635 of 20,635
 * `wind_solar_forecast` rows on the replica on 2026-09-11. A bound in this prefix
 * form sorts correctly against that fixed width. The space form every *data*
 * table uses does not, because `'T' > ' '`. Measured on the replica,
 * `start_time >= '2026-09-10 16:00:00'` also matched DE's 13:34 attempt, 4 rows
 * where the correct answer is 1. That attempt was made before upstream owed us
 * anything.
 */
function logStamp(at: Date): string {
  return at.toISOString().slice(0, 19);
}

/**
 * When the newest ingest attempt at a stream began, counting only attempts that
 * started no earlier than `since` and had finished by `now`. Returns `null` if
 * there are none.
 *
 * ABL-717. This reads `data_ingestion_log` for **when we looked**, never for
 * whether rows landed. `records_inserted` is not consulted, and it would lie if
 * it were: on 2026-09-09 DE's 18:30 fetch stored 684 rows and logged
 * `completed`, and none of those rows was tomorrow's. Whether tomorrow is held
 * is still decided by the table's own `MAX` above. Every finished attempt
 * counts, including one that errored, because a fetch that got a 503 did go
 * and look (ABL-637). A `running` row has no `end_time` yet, so it has not
 * looked at anything.
 *
 * It uses `start_time`, not the `end_time` that ABL-295's `lastChecked`
 * reports. A fetch issued before upstream's obligation cannot be expected to
 * carry the day, however late it finished, and an overrunning 13:30 pass does
 * reach countries after 16:00 UTC.
 *
 * The bounds only narrow the read. `classifyDayAheadStream` compares the
 * instant against the obligation itself, so a bound that over-matched could not
 * put a pre-obligation attempt into a verdict. A bound that under-matched would
 * fall back to the 21:00 backstop, and the negative control in
 * `dataFreshnessService.test.ts` fails if that happens. The query plan is
 * `SEARCH … USING INDEX idx_ingestion_log_pipeline (pipeline_type=? AND
 * start_time>?)`, and all 39 countries take 1.1 ms on the replica.
 */
function newestFinishedAttemptStart(
  pipelines: readonly string[],
  countryCode: string,
  since: Date,
  now: Date,
): string | null {
  const row = db
    .prepare(
      `SELECT MAX(start_time) AS started
         FROM data_ingestion_log
        WHERE pipeline_type IN (${pipelines.map(() => '?').join(', ')})
          AND country_code = ?
          AND start_time >= ?
          AND end_time IS NOT NULL
          AND end_time <= ?`,
    )
    .get(...pipelines, countryCode, logStamp(since), logStamp(now)) as
    | { started: string | null }
    | undefined;
  return row?.started ?? null;
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

  // `forecast_type = 'day_ahead'`, because the verdict below is
  // `classifyDayAheadStream(…, 'tsoLoadForecast')` — a *day-ahead publication
  // deadline*. `energy_load_forecast` holds two documents under one country
  // (A65/A01 day-ahead and A65/A31 week-ahead, `fetch_load_forecast.py:43-47`),
  // and week-ahead targets always sit further out, so an unfiltered MAX can
  // only ever be answered by the week-ahead half. It cannot report the
  // day-ahead half late; it can only hide it.
  //
  // It did. ABL-663: IE's day-ahead load forecast stopped upstream at
  // `2026-09-01 22:30` and this endpoint went on reporting `tsoLoadForecast:
  // live` for eight days, because the 00:30 pass kept re-storing week-ahead
  // rows dated a week out. Measured read-only on prod 2026-09-10 07:xx UTC:
  //
  //   IE day_ahead : 10,546 rows, MAX target 2026-09-01 22:30
  //   IE week_ahead:    227 rows, MAX target 2026-09-09 23:00  <- what MAX returned
  //
  // Filtering cannot strand a country that only publishes week-ahead, because
  // no such country exists: measured across all 34 countries in
  // `energy_load_forecast` on the same read, every one has day-ahead rows
  // (BA/MD/MK/SI have day-ahead and *no* week-ahead; none is the reverse). On
  // that same read this changes exactly one verdict — IE's, to the true one.
  const tsoLoadForecast = newest(
    `SELECT MAX(target_timestamp_utc) as latest FROM energy_load_forecast
      WHERE country_code = ? AND forecast_type = 'day_ahead'`,
    countryCode,
  );

  const tsoGenerationForecast = newest(
    `SELECT MAX(target_timestamp_utc) as latest FROM energy_generation_forecast WHERE country_code = ?`,
    countryCode,
  );

  // ABL-717. When our own ingest last looked at this country's A69, counting
  // only attempts that began once upstream owed us tomorrow. It is read for A69
  // alone: price and the A65 load forecast keep their clock deadline
  // (`DAY_AHEAD_PUBLISHED_BY_BRUSSELS_HOUR`), so no read is spent on them.
  // Before the obligation, which is 16:00 UTC under CEST, no attempt can
  // qualify, so the read is skipped rather than run for an answer already known.
  const a69Obligation = publicationObligationUtc(now, 'tsoGenerationForecast');
  const tsoGenerationAttempt =
    a69Obligation !== null && a69Obligation.getTime() <= now.getTime()
      ? newestFinishedAttemptStart(
          INGEST_PIPELINES.tsoGenerationForecast,
          countryCode,
          a69Obligation,
          now,
        )
      : null;

  // ABL-632. Age alone is blind to a pipeline that limps: one surviving row per
  // pass keeps `MAX` recent while the window behind it fills with holes, which
  // is how a four-day prod degradation (2026-08-30..09-02) reported `live`
  // throughout. Each stream is now also scored on how full its trailing window
  // is; `applyCoverage` publishes that measurement beside the verdict and
  // downgrades only a `live` stream, never `ended` or `none`.
  //
  // Every count is scoped exactly as the `MAX` it sits beside: the same
  // `measuredLoadClause()` on load, and the same `forecast_type = 'day_ahead'`
  // on `tsoLoadForecast`. Matching them is not cosmetic on either read, and the
  // forecast one has its own reason to hold here — `energy_load_forecast` stores
  // week-ahead rows at one per day against day-ahead's 24-96, so pooling the two
  // would put a resolution nothing publishes under a ratio we display. Keep them
  // matched: a coverage ratio scoped differently from the `latest` printed next
  // to it is two answers to one question.
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
    //
    // A69 alone also takes our newest post-deadline attempt (ABL-717), so its
    // requirement moves when this country has been looked at, not when a
    // pass-duration guess says it probably has. `price` and `tsoLoadForecast`
    // are deliberately not given one; `DAY_AHEAD_PUBLISHED_BY_BRUSSELS_HOUR`
    // says why.
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
      classifyDayAheadStream(
        tsoGenerationForecast,
        now,
        'tsoGenerationForecast',
        tsoGenerationAttempt,
      ),
      dailyCounts('energy_generation_forecast', 'target_timestamp_utc', countryCode, now),
      'tsoGenerationForecast',
    ),
  };
}
