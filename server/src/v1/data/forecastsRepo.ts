import { rangeArgs, rangeClause, timestampRange } from '../../utils/timestamp.js';
import { toWireInstant } from './freshnessMap.js';
import { PUBLIC_FORECAST_MODELS } from './models.js';
import type { EnergyQuery, SqlParam } from './energySource.js';
import type { TimeWindow } from './params.js';

/**
 * Reading our own forecast output.
 *
 * Three things make this different from an observation read, and each one is a
 * claim about the data rather than a style choice.
 *
 * ## 1. `generated_at` is mandatory on every row, never an `include=`
 *
 * Our model output has a clock of its own and a **twelve-hour nightly hole**.
 * Measured over the 7 days to 2026-08-11, `catboost` vintages land in exactly
 * four UTC hour buckets — 07:00, 14:00, 15:30, 19:00 — and between 19:00 and
 * 07:00 there is no new vintage at all. A customer calling `/v1/forecasts/latest`
 * at 03:00 UTC is served a forecast generated at 19:00 the previous evening,
 * eight hours earlier, and today nothing in the internal response says so
 * (ABL-293 §2g.E). `forecasts.generated_at` is the field that says it, so it
 * ships on every row, unhidden. The number is not wrong; the claim about the
 * number was.
 *
 * `forecast_runs` is deliberately **not** the source: its newest row was
 * 2026-08-11T15:30 while `forecasts` held a 19:00 vintage from the same day, so
 * a `generated_at` sourced from it would under-report freshness.
 *
 * ## 2. One vintage per target timestamp, and it is the newest
 *
 * `forecasts` holds every run, so a target hour has as many rows as runs that
 * covered it. Returning all of them would make `data` a cross-product a client
 * has to de-duplicate — and the obvious de-duplication (`MAX(generated_at)` per
 * timestamp *across models*) is the emergent per-country argmax that
 * `config/forecastModels.ts` was written to end: whichever model ran most
 * recently wins, including one rejected on evidence. So the correlated
 * `MAX(generated_at)` below is scoped to **one model**, chosen explicitly and
 * echoed on the response.
 *
 * ## 3. Ordering is on the normalised timestamp, not the raw column
 *
 * `forecasts.target_timestamp_utc` is 99.7% `T`-form, but the two chronos models
 * write a space — which is exactly the mirror-image trap the deleted
 * `normalizeForForecastsTable` fell into (`forecastService.ts:7-12`). Ordering
 * on the raw column would interleave the two forms wrongly and break cursor
 * monotonicity, so ordering and the cursor both run on `REPLACE(..., 'T', ' ')`.
 */

export interface ForecastRow {
  timestamp: string;
  value: number;
  /** Which run produced this value. Mandatory — see the module note. */
  generated_at: string | null;
  /** Hours between the run and the target. 2–64 observed; there is no D+3. */
  horizon_hours: number;
  /** Echoed per row so a fallback model is visible in the data, not only in `meta`. */
  model: string;
}

export interface ForecastPage {
  rows: ForecastRow[];
  lastStoredTimestamp: string | null;
  hasMore: boolean;
}

export interface ForecastQuery {
  zone: string;
  forecastType: string;
  model: string;
  window: TimeWindow;
  /** Filter to one horizon, in hours. Absent means every horizon in the window. */
  horizonHours?: number;
  after?: string;
  limit: number;
}

interface RawForecastRow {
  __ts: string;
  value: number;
  generated_at: string | null;
  horizon_hours: number;
  model: string;
}

/**
 * Which of the served models actually has rows for this zone, type and window,
 * in preference order.
 *
 * Run before the data query so the answer can be *echoed* rather than inferred.
 * The alternative — query the preferred model, and if it is empty try the next —
 * cannot distinguish "catboost has no coverage here" from "catboost covers this
 * zone and the window is genuinely empty", and would silently substitute a
 * different model's numbers in the second case.
 *
 * An explicit `?model=` never reaches here: it is honoured strictly, because
 * asking how xgboost forecasts and receiving catboost is the plausible-wrong-
 * number-under-the-wrong-label failure this codebase exists to avoid.
 */
export function resolveServingModel(
  source: EnergyQuery,
  zone: string,
  forecastType: string,
  window: TimeWindow
): string | null {
  const range = timestampRange(window.sqlStart, window.sqlEndInclusive);
  const placeholders = PUBLIC_FORECAST_MODELS.map(() => '?').join(', ');

  const found = source.all<{ model_name: string }>(
    `SELECT DISTINCT model_name
       FROM forecasts
      WHERE country_code = ?
        AND forecast_type = ?
        AND model_name IN (${placeholders})
        AND ${rangeClause('target_timestamp_utc')}`,
    [zone, forecastType, ...PUBLIC_FORECAST_MODELS, ...rangeArgs(range)]
  );

  const available = new Set(found.map((row) => row.model_name));
  return PUBLIC_FORECAST_MODELS.find((model) => available.has(model)) ?? null;
}

/** Read one page of forecasts. `limit + 1` is fetched so truncation is a fact. */
export function readForecasts(source: EnergyQuery, query: ForecastQuery): ForecastPage {
  const { zone, forecastType, model, window, horizonHours, after, limit } = query;
  const range = timestampRange(after ?? window.sqlStart, window.sqlEndInclusive);

  const horizonClause = horizonHours === undefined ? '' : 'AND horizon_hours = ?';
  const cursorClause = after === undefined ? '' : `AND REPLACE(target_timestamp_utc, 'T', ' ') > ?`;

  const params: SqlParam[] = [zone, forecastType, model, ...rangeArgs(range)];
  if (horizonHours !== undefined) params.push(horizonHours);
  if (after !== undefined) params.push(after);
  // The correlated subquery repeats the model and, when present, the horizon —
  // the newest vintage *for the same slice*, not the newest vintage overall.
  // Dropping the horizon from the inner query would compare a 6-hour-ahead run
  // against a 60-hour-ahead one and return neither consistently.
  params.push(model);
  if (horizonHours !== undefined) params.push(horizonHours);
  params.push(limit + 1);

  const rows = source.all<RawForecastRow>(
    `SELECT REPLACE(target_timestamp_utc, 'T', ' ') AS "__ts",
            forecast_value AS "value",
            generated_at,
            horizon_hours,
            model_name AS "model"
       FROM forecasts f1
      WHERE country_code = ?
        AND forecast_type = ?
        AND model_name = ?
        AND ${rangeClause('target_timestamp_utc')}
        ${horizonClause}
        ${cursorClause}
        AND generated_at = (
          SELECT MAX(f2.generated_at)
            FROM forecasts f2
           WHERE f2.country_code = f1.country_code
             AND f2.forecast_type = f1.forecast_type
             AND f2.target_timestamp_utc = f1.target_timestamp_utc
             AND f2.model_name = ?
             ${horizonClause.replace('horizon_hours', 'f2.horizon_hours')}
        )
      ORDER BY REPLACE(target_timestamp_utc, 'T', ' ')
      LIMIT ?`,
    params
  );

  const page = rows.slice(0, limit);
  return {
    rows: page.map(shape),
    lastStoredTimestamp: page.length === 0 ? null : page[page.length - 1].__ts,
    hasMore: rows.length > page.length,
  };
}

/**
 * The newest complete vintage for a zone, type and model.
 *
 * Not "the newest value for each target timestamp" — the newest *run*, whole.
 * The difference matters: a run covers a contiguous horizon, so one vintage is
 * an internally consistent forecast a customer can act on, whereas a
 * per-timestamp newest stitches several runs together and produces a series with
 * discontinuities at the seams that no model ever emitted.
 *
 * Bounded by the horizon rather than by a window parameter: a vintage is at most
 * 64 rows, so this endpoint takes no `from`/`to` and cannot be paged.
 */
export function readLatestVintage(
  source: EnergyQuery,
  zone: string,
  forecastType: string,
  model: string
): ForecastRow[] {
  const rows = source.all<RawForecastRow>(
    `SELECT REPLACE(target_timestamp_utc, 'T', ' ') AS "__ts",
            forecast_value AS "value",
            generated_at,
            horizon_hours,
            model_name AS "model"
       FROM forecasts
      WHERE country_code = ?
        AND forecast_type = ?
        AND model_name = ?
        AND generated_at = (
          SELECT MAX(generated_at)
            FROM forecasts
           WHERE country_code = ?
             AND forecast_type = ?
             AND model_name = ?
        )
      ORDER BY REPLACE(target_timestamp_utc, 'T', ' ')`,
    [zone, forecastType, model, zone, forecastType, model]
  );
  return rows.map(shape);
}

export interface ForecastEdges {
  /** Newest target hour we hold for this zone, type and model, in stored form. */
  newestTarget: string | null;
  /** Newest run stamp, in stored form. `null` when we hold nothing for the triple. */
  newestVintage: string | null;
}

/**
 * The two edges a forecast response's freshness block is built from.
 *
 * `newestTarget` answers "how far ahead does our forecast reach", and is read
 * off the tail of `idx_forecasts_model_lookup` rather than with
 * `MAX(REPLACE(target_timestamp_utc, …))`, which would forfeit the index — the
 * same trade the freshness map documents at length, and the same 500-row margin
 * for the two-separator ordering (both served models write `T`-form targets, so
 * the first row read is the answer in practice).
 *
 * `newestVintage` answers "how old is our newest run", which is the number
 * `status` is judged on: target age is meaningless for a series dated up to 64
 * hours into the future.
 */
export function readForecastEdges(
  source: EnergyQuery,
  zone: string,
  forecastType: string,
  model: string
): ForecastEdges {
  const tail = source.all<{ target_timestamp_utc: string }>(
    `SELECT target_timestamp_utc
       FROM forecasts
      WHERE country_code = ? AND forecast_type = ? AND model_name = ?
      ORDER BY target_timestamp_utc DESC
      LIMIT 500`,
    [zone, forecastType, model]
  );

  let newestTarget: string | null = null;
  for (const row of tail) {
    const candidate = row.target_timestamp_utc.replace('T', ' ');
    if (newestTarget === null || candidate > newestTarget) newestTarget = candidate;
  }

  const vintage = source.get<{ mx: string | null }>(
    `SELECT MAX(generated_at) AS mx
       FROM forecasts
      WHERE country_code = ? AND forecast_type = ? AND model_name = ?`,
    [zone, forecastType, model]
  );

  return { newestTarget, newestVintage: vintage?.mx ?? null };
}

function shape(row: RawForecastRow): ForecastRow {
  return {
    timestamp: `${row.__ts.replace(' ', 'T')}Z`,
    value: row.value,
    // Stored with microsecond precision and a `T` separator for both served
    // models; normalised to the contract's second precision here so a client
    // parsing `generated_at` and `timestamp` uses one format, not two.
    generated_at: toWireInstant(row.generated_at),
    horizon_hours: row.horizon_hours,
    model: row.model,
  };
}
