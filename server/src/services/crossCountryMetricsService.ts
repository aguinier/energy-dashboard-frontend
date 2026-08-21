import db from '../config/database.js';
import { ForecastType } from '../types/index.js';
import { timestampRange, rangeClause, rangeArgs, timestampFormOnClause } from '../utils/timestamp.js';
import { loadActualGuard } from './loadQuality.js';
import { actualsSourceFor } from './actualsSource.js';
import { runReadQueryInWorker } from './readQueryWorker.js';
import { computeSkillVsSeasonalNaive, type SkillVsSeasonalNaive } from './skillScore.js';
import {
  DIVERGENT_BASIS_FORECAST_TYPE,
  suppressIfDivergentBasis,
  type MeasuresClassified,
} from './loadForecastBasis.js';

/**
 * Cross-Country Forecast Metrics Service
 *
 * Computes ML forecast accuracy metrics (MAE, WAPE, RMSE, bias)
 * across all countries for a given forecast type, using the same
 * deduplication and join patterns as mlForecastService.
 */

// Valid forecast types
export const VALID_FORECAST_TYPES: ForecastType[] = [
  'load', 'price', 'renewable', 'solar',
  'wind_onshore', 'wind_offshore', 'hydro_total', 'biomass'
];

// The actuals mapping this module used to keep its own copy of — annotated
// "same as mlForecastService", which is a promise a literal cannot keep — now
// lives once in `actualsSource.ts` (ABL-399), which is also what moved these
// six types off the frozen `energy_renewable`.

export interface CountryMetrics {
  /**
   * `null` when the pair cannot support the measure — which since ABL-493 also
   * covers a country whose two series measure different quantities, not only
   * an empty window. Never 0: a 0 here is a flawless forecast.
   */
  mae: number | null;
  wape: number | null;
  rmse: number | null;
  bias: number | null;
  /** How many rows paired. Truthful even when every measure above is null. */
  dataPoints: number;
  /** Skill vs the D-7 seasonal-naive baseline, on this WAPE's own pair intersection (ABL-186). */
  skillVsSeasonalNaive: SkillVsSeasonalNaive;
  /**
   * Present **only** when the measures above were withheld, so a comparable
   * country's entry is byte-identical to its pre-ABL-493 shape. Absent means
   * "no finding" — see `suppressIfDivergentBasis`.
   */
  basis?: 'divergent_basis';
  /** The sentence to print in place of the numbers. Present with `basis`, never alone. */
  basisNote?: string;
}

/**
 * Compile-time: every error measure this entry publishes is one
 * `loadForecastBasis` knows to blank, or one it knows to keep. Adding a sixth
 * to `CountryMetrics` without classifying it fails the build rather than
 * silently publishing it for a divergent-basis country — `bias` reaching prod
 * unsuppressed is the concrete cost of not having had this (ABL-490/ABL-493).
 */
const _countryMetricsMeasuresClassified: MeasuresClassified<CountryMetrics> = true;

export type CrossCountryMetricsResult = Record<string, CountryMetrics>;

interface MetricsRow {
  forecast_type: ForecastType;
  country_code: string;
  mae: number | null;
  wape: number | null;
  rmse: number | null;
  bias: number | null;
  data_points: number;
  skill_n: number;
  skill_actual_abs_sum: number;
  skill_model_err_abs_sum: number;
  skill_baseline_err_abs_sum: number;
}

// A private `normalizeTimestamp` used to shadow the shared one here, keeping
// the 'T' separator "for the forecasts table". That shadow is why this endpoint
// and /forecasts/compare disagreed about the same window over the same table
// (ABL-21): compare normalised its bounds to a space and lost the end day,
// this one kept 'T' and did not. Both were wrong in opposite directions; see
// `timestampRange`.

/**
 * Weighted absolute percentage error: 100 * sum|e| / sum|actual|.
 *
 * Moved to `wape.ts` by ABL-388, which gave it a second caller
 * (`tsoForecastService.calculateMetrics`). Re-exported here because this is
 * where it has been imported from since ABL-19 — the definition, and the
 * measurements that justify it, now live in that module.
 */
export { wape } from './wape.js';

/**
 * Get cross-country accuracy metrics for a single forecast type.
 *
 * Uses MAX(generated_at) CTE to deduplicate forecasts, then joins
 * with the actual data table and computes aggregate metrics grouped
 * by country_code.
 */
export function getCrossCountryMetrics(
  forecastType: ForecastType,
  start: string,
  end: string
): CrossCountryMetricsResult {
  if (!VALID_FORECAST_TYPES.includes(forecastType)) {
    return {};
  }

  const range = timestampRange(start, end);
  const rows = db.prepare(crossCountryMetricsSql([forecastType]))
    .all(...rangeArgs(range)) as MetricsRow[];
  return rowsToResult(rows)[forecastType] ?? {};
}

function metricSelect(forecastType: ForecastType): string {
  const source = actualsSourceFor(forecastType);
  if (!source) {
    throw new Error(`No actuals source for forecast type: ${forecastType}`);
  }
  const rawColumn = (alias: string) => source.valueExpr(`${alias}.`);

  // Actuals: prefer the space-form row (`a`), falling back to the 'T'-form-only
  // row (`a2`) only when no space row exists for that country-hour at all — see
  // `timestampFormOnClause` for why this is two LEFT JOINs and a COALESCE
  // rather than one join matching either form.
  const actualColumn = `COALESCE(${rawColumn('a')}, ${rawColumn('a2')})`;
  // Same table, same rule, aliased `s`/`s2` — the D-7 seasonal-naive baseline
  // (source of the `skill_*` aggregates below).
  const baselineColumn = `COALESCE(${rawColumn('s')}, ${rawColumn('s2')})`;
  const dayAgoExpr = `datetime(REPLACE(f.target_timestamp_utc, 'T', ' '), '-7 days')`;

  return `
    SELECT
      '${forecastType}' AS forecast_type,
      f.country_code,
      ROUND(AVG(ABS(${actualColumn} - f.forecast_value)), 2) AS mae,
      CASE WHEN SUM(ABS(${actualColumn})) > 0
        THEN ROUND(100.0 * SUM(ABS(${actualColumn} - f.forecast_value)) / SUM(ABS(${actualColumn})), 2)
        ELSE NULL
      END AS wape,
      ROUND(SQRT(AVG((${actualColumn} - f.forecast_value) * (${actualColumn} - f.forecast_value))), 2) AS rmse,
      ROUND(AVG(${actualColumn} - f.forecast_value), 2) AS bias,
      COUNT(*) AS data_points,
      SUM(CASE WHEN ${baselineColumn} IS NOT NULL THEN 1 ELSE 0 END) AS skill_n,
      SUM(CASE WHEN ${baselineColumn} IS NOT NULL THEN ABS(${actualColumn}) ELSE 0 END) AS skill_actual_abs_sum,
      SUM(CASE WHEN ${baselineColumn} IS NOT NULL THEN ABS(${actualColumn} - f.forecast_value) ELSE 0 END) AS skill_model_err_abs_sum,
      SUM(CASE WHEN ${baselineColumn} IS NOT NULL THEN ABS(${actualColumn} - ${baselineColumn}) ELSE 0 END) AS skill_baseline_err_abs_sum
    FROM latest_forecasts f
    LEFT JOIN ${source.table} a
      ON a.country_code = f.country_code
      AND ${timestampFormOnClause(`a.${source.timestampCol}`, 'f.target_timestamp_utc', 'space')}
    LEFT JOIN ${source.table} a2
      ON a2.country_code = f.country_code
      AND ${timestampFormOnClause(`a2.${source.timestampCol}`, 'f.target_timestamp_utc', 't')}
    LEFT JOIN ${source.table} s
      ON s.country_code = f.country_code
      AND ${timestampFormOnClause(`s.${source.timestampCol}`, dayAgoExpr, 'space')}
      ${loadActualGuard(forecastType, rawColumn('s'))}
    LEFT JOIN ${source.table} s2
      ON s2.country_code = f.country_code
      AND ${timestampFormOnClause(`s2.${source.timestampCol}`, dayAgoExpr, 't')}
      ${loadActualGuard(forecastType, rawColumn('s2'))}
    WHERE f.forecast_type = '${forecastType}'
      AND ${actualColumn} IS NOT NULL
      ${loadActualGuard(forecastType, actualColumn)}
    GROUP BY f.country_code`;
}

/**
 * One forecast-table pass for every requested type.
 *
 * The second join deliberately retains every row tied at the newest
 * generated_at. The old correlated MAX query did the same, including distinct
 * horizons/models sharing that timestamp, so collapsing this to one row would
 * silently change the metrics.
 */
export function crossCountryMetricsSql(forecastTypes: ForecastType[]): string {
  const typeList = forecastTypes.map((type) => `'${type}'`).join(', ');
  return `
    WITH latest_keys AS MATERIALIZED (
      SELECT
        country_code,
        forecast_type,
        target_timestamp_utc,
        MAX(generated_at) AS generated_at
      FROM forecasts
      WHERE forecast_type IN (${typeList})
        AND ${rangeClause('target_timestamp_utc')}
      GROUP BY country_code, forecast_type, target_timestamp_utc
    ),
    latest_forecasts AS MATERIALIZED (
      SELECT
        f.country_code,
        f.forecast_type,
        f.target_timestamp_utc,
        f.forecast_value
      FROM latest_keys k
      INNER JOIN forecasts f
        ON f.country_code = k.country_code
        AND f.forecast_type = k.forecast_type
        AND f.target_timestamp_utc = k.target_timestamp_utc
        AND f.generated_at = k.generated_at
    )
    ${forecastTypes.map(metricSelect).join('\n    UNION ALL\n')}`;
}

function rowsToResult(rows: MetricsRow[]): Record<string, CrossCountryMetricsResult> {
  const result: Record<string, CrossCountryMetricsResult> = {};
  for (const row of rows) {
    const byCountry = result[row.forecast_type] ??= {};
    const measured: CountryMetrics = {
      mae: row.mae ?? 0,
      wape: row.wape,
      rmse: row.rmse ?? 0,
      bias: row.bias ?? 0,
      dataPoints: row.data_points,
      skillVsSeasonalNaive: computeSkillVsSeasonalNaive({
        n: row.skill_n,
        actualAbsSum: row.skill_actual_abs_sum,
        modelErrAbsSum: row.skill_model_err_abs_sum,
        baselineErrAbsSum: row.skill_baseline_err_abs_sum,
      }),
    };
    // The basis rule runs **after** the `?? 0` coercions above, and the order
    // is load-bearing: applied first, those `?? 0`s would turn a withheld
    // measure straight back into a confident zero — a flawless forecast, which
    // is the failure this whole endpoint's WAPE was introduced to avoid.
    //
    // Gated on the forecast type because `DIVERGENT_LOAD_BASIS` is a *load*
    // finding: NL's price and generation numbers are unaffected by the
    // behind-the-meter-solar gap, and blanking them would be a second false
    // claim in the other direction. See `DIVERGENT_BASIS_FORECAST_TYPE`.
    byCountry[row.country_code] =
      row.forecast_type === DIVERGENT_BASIS_FORECAST_TYPE
        ? suppressIfDivergentBasis(row.country_code, measured)
        : measured;
  }
  return result;
}

/**
 * Get cross-country metrics for all forecast types.
 */
export function getCrossCountryMetricsAll(
  start: string,
  end: string
): Record<string, CrossCountryMetricsResult> {
  const range = timestampRange(start, end);
  const rows = db.prepare(crossCountryMetricsSql(VALID_FORECAST_TYPES))
    .all(...rangeArgs(range)) as MetricsRow[];
  return rowsToResult(rows);
}

/** Run the cold all-types read away from Express's event-loop thread. */
export async function getCrossCountryMetricsAllAsync(
  start: string,
  end: string
): Promise<Record<string, CrossCountryMetricsResult>> {
  const range = timestampRange(start, end);
  const rows = await runReadQueryInWorker<MetricsRow>(
    crossCountryMetricsSql(VALID_FORECAST_TYPES),
    rangeArgs(range)
  );
  return rowsToResult(rows);
}
