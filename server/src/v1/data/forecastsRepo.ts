import { rangeArgs, rangeClause, timestampRange } from '../../utils/timestamp.js';
import { toWireInstant } from './freshnessMap.js';
import { PUBLIC_FORECAST_MODELS } from './models.js';
import type { EnergyQuery, SqlParam } from './energySource.js';
import type { TimeWindow } from './params.js';
import type { VersionGate } from '../modelVersions/versionGuard.js';

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
 *
 * ## 4. Every read is restricted to acknowledged artifacts
 *
 * ABL-529. `model_name` names a **family**, so replacing the artifact behind a
 * pair we already serve moves every number under an unchanged label — ToS
 * §9.3.1's material change, invisible on this surface and, until now, invisible
 * to us. A `VersionGate` (`v1/modelVersions/versionGuard.ts`) supplies the
 * `model_version` values a human has signed off, and **all four reads take it**,
 * which is the part that has to stay true:
 *
 * - `readForecasts` and `readLatestVintage` filter the rows, so an
 *   unacknowledged artifact cannot reach a subscriber.
 * - `readForecastEdges` filters too, because `latest_vintage_at` and
 *   `freshness.data_through` are built from it. Leaving it unfiltered would
 *   report the withheld run's timestamp over the previous artifact's numbers —
 *   a series that says it is current while serving something older, which is a
 *   worse claim than the one the guard was added to prevent.
 * - `resolveServingModel` filters as well, so a model whose only rows in the
 *   window are unacknowledged does not win the resolution and then answer with
 *   nothing while the other family had servable rows.
 *
 * The gate withholds rather than rejects, and that is deliberate: the previously
 * acknowledged version keeps serving, so the subscriber gets stale-but-honest
 * numbers instead of an empty page. Nothing about the response *shape* changes —
 * putting `model_version` on the wire is a contract change and explicitly not
 * this issue's.
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
  /** Which artifacts a human has signed off for this triple. See the module note, §4. */
  gate: VersionGate;
}

/**
 * The acknowledged-artifact restriction, as SQL.
 *
 * Three cases, and the middle one is the one an `IN ()` would get wrong:
 *
 * - `null` — the triple is absent from the ledger, so it is a combination we
 *   have never served and is additive under ToS §9.1. No clause.
 * - `[]` — the triple is known and nothing is servable yet, because every
 *   acknowledgement for it is still inside its 30-day notice period. `IN ()` is
 *   a syntax error in SQLite, so this is spelled `AND 1 = 0`: an empty page,
 *   which is the correct answer to "serve me an artifact nobody has cleared".
 * - a list — `AND <prefix>model_version IN (?, …)`.
 *
 * `prefix` exists because the correlated `MAX(generated_at)` subquery has to
 * carry the same restriction under its own alias. Without it the subquery would
 * pick the newest *unacknowledged* run as the target of an equality the outer
 * query then filters away, and every target hour covered by that run would
 * vanish — the series would develop holes rather than fall back.
 */
function versionClause(
  versions: readonly string[] | null,
  prefix: string
): { sql: string; params: SqlParam[] } {
  if (versions === null) return { sql: '', params: [] };
  if (versions.length === 0) return { sql: 'AND 1 = 0', params: [] };
  return {
    sql: `AND ${prefix}model_version IN (${versions.map(() => '?').join(', ')})`,
    params: [...versions],
  };
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
  window: TimeWindow,
  gate: VersionGate
): string | null {
  const range = timestampRange(window.sqlStart, window.sqlEndInclusive);

  // One query per model rather than one `IN` over both, because the acknowledged
  // artifact set is per triple: catboost and xgboost for the same zone and type
  // are two different rows in the ledger with two different notice periods, and
  // a single `IN` could not carry both restrictions. Two index seeks against
  // `idx_forecasts_model_lookup`, and `PUBLIC_FORECAST_MODELS` is length 2.
  for (const model of PUBLIC_FORECAST_MODELS) {
    const versions = versionClause(gate.servableVersions(zone, forecastType, model), '');
    const hit = source.get<{ one: number }>(
      `SELECT 1 AS one
         FROM forecasts
        WHERE country_code = ?
          AND forecast_type = ?
          AND model_name = ?
          AND ${rangeClause('target_timestamp_utc')}
          ${versions.sql}
        LIMIT 1`,
      [zone, forecastType, model, ...rangeArgs(range), ...versions.params]
    );
    if (hit !== undefined) return model;
  }
  return null;
}

/** Read one page of forecasts. `limit + 1` is fetched so truncation is a fact. */
export function readForecasts(source: EnergyQuery, query: ForecastQuery): ForecastPage {
  const { zone, forecastType, model, window, horizonHours, after, limit, gate } = query;
  const range = timestampRange(after ?? window.sqlStart, window.sqlEndInclusive);

  const horizonClause = horizonHours === undefined ? '' : 'AND horizon_hours = ?';
  const cursorClause = after === undefined ? '' : `AND REPLACE(target_timestamp_utc, 'T', ' ') > ?`;
  const servable = gate.servableVersions(zone, forecastType, model);
  const outerVersions = versionClause(servable, '');
  const innerVersions = versionClause(servable, 'f2.');

  const params: SqlParam[] = [zone, forecastType, model, ...rangeArgs(range)];
  if (horizonHours !== undefined) params.push(horizonHours);
  if (after !== undefined) params.push(after);
  params.push(...outerVersions.params);
  // The correlated subquery repeats the model and, when present, the horizon —
  // the newest vintage *for the same slice*, not the newest vintage overall.
  // Dropping the horizon from the inner query would compare a 6-hour-ahead run
  // against a 60-hour-ahead one and return neither consistently. It repeats the
  // version restriction for the same reason: the newest *servable* run, or the
  // equality would target a run the outer filter then discards, punching holes
  // in the series instead of falling back to the acknowledged artifact.
  params.push(model);
  if (horizonHours !== undefined) params.push(horizonHours);
  params.push(...innerVersions.params);
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
        ${outerVersions.sql}
        AND generated_at = (
          SELECT MAX(f2.generated_at)
            FROM forecasts f2
           WHERE f2.country_code = f1.country_code
             AND f2.forecast_type = f1.forecast_type
             AND f2.target_timestamp_utc = f1.target_timestamp_utc
             AND f2.model_name = ?
             ${horizonClause.replace('horizon_hours', 'f2.horizon_hours')}
             ${innerVersions.sql}
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
  model: string,
  gate: VersionGate
): ForecastRow[] {
  const servable = gate.servableVersions(zone, forecastType, model);
  const outer = versionClause(servable, '');
  const inner = versionClause(servable, '');

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
        ${outer.sql}
        AND generated_at = (
          SELECT MAX(generated_at)
            FROM forecasts
           WHERE country_code = ?
             AND forecast_type = ?
             AND model_name = ?
             ${inner.sql}
        )
      ORDER BY REPLACE(target_timestamp_utc, 'T', ' ')`,
    [
      zone,
      forecastType,
      model,
      ...outer.params,
      zone,
      forecastType,
      model,
      ...inner.params,
    ]
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
  model: string,
  gate: VersionGate
): ForecastEdges {
  // Both edges are restricted to the acknowledged artifacts, and that is not
  // tidiness. These two values become `latest_vintage_at`, `freshness.status`
  // and `freshness.data_through`. Reading them unfiltered while the rows are
  // filtered would date a withheld run over the previous artifact's numbers —
  // a series reporting itself fresh while serving something older, which is a
  // sharper false claim than the silent swap the guard exists to stop.
  const servable = gate.servableVersions(zone, forecastType, model);
  const versions = versionClause(servable, '');

  const tail = source.all<{ target_timestamp_utc: string }>(
    `SELECT target_timestamp_utc
       FROM forecasts
      WHERE country_code = ? AND forecast_type = ? AND model_name = ?
        ${versions.sql}
      ORDER BY target_timestamp_utc DESC
      LIMIT 500`,
    [zone, forecastType, model, ...versions.params]
  );

  let newestTarget: string | null = null;
  for (const row of tail) {
    const candidate = row.target_timestamp_utc.replace('T', ' ');
    if (newestTarget === null || candidate > newestTarget) newestTarget = candidate;
  }

  const vintage = source.get<{ mx: string | null }>(
    `SELECT MAX(generated_at) AS mx
       FROM forecasts
      WHERE country_code = ? AND forecast_type = ? AND model_name = ?
        ${versions.sql}`,
    [zone, forecastType, model, ...versions.params]
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
