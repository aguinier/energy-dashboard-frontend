import db from '../config/database.js';
import { ForecastType, Granularity } from '../types/index.js';  
import { timestampRange, rangeClause, rangeArgs, timestampFormOnClause } from '../utils/timestamp.js';
import { loadActualGuard } from './loadQuality.js';

/**
 * ML Forecast Accuracy Service
 *
 * Provides functions to calculate accuracy metrics for ML forecasts
 * by joining the forecasts table with actual data tables.
 */

// Valid forecast types for SQL safety
const VALID_FORECAST_TYPES: ForecastType[] = [
  'load', 'price', 'renewable', 'solar',
  'wind_onshore', 'wind_offshore', 'hydro_total', 'biomass'
];

// Mapping from forecast type to actual data source
const ACTUAL_DATA_MAPPING: Record<string, { table: string; column: string; timestampCol: string }> = {
  load: { table: 'energy_load', column: 'load_mw', timestampCol: 'timestamp_utc' },
  price: { table: 'energy_price', column: 'price_eur_mwh', timestampCol: 'timestamp_utc' },
  solar: { table: 'energy_renewable', column: 'solar_mw', timestampCol: 'timestamp_utc' },
  wind_onshore: { table: 'energy_renewable', column: 'wind_onshore_mw', timestampCol: 'timestamp_utc' },
  wind_offshore: { table: 'energy_renewable', column: 'wind_offshore_mw', timestampCol: 'timestamp_utc' },
  hydro_total: { table: 'energy_renewable', column: 'hydro_run_mw + hydro_reservoir_mw', timestampCol: 'timestamp_utc' },
  biomass: { table: 'energy_renewable', column: 'biomass_mw', timestampCol: 'timestamp_utc' },
  renewable: { table: 'energy_renewable', column: 'total_renewable_mw', timestampCol: 'timestamp_utc' },
};

export interface MLForecastAccuracyDataPoint {
  timestamp: string;
  forecast_value: number;
  actual_value: number;
  error: number;
  /** null when actual_value <= 0 — a percentage error is undefined at zero. */
  error_pct: number | null;
  horizon_hours: number;
}

export interface MLForecastAccuracyMetrics {
  mae: number | null;      // Mean Absolute Error — null only when dataPoints is 0
  mape: number | null;     // Mean Absolute Percentage Error — null when no point had a measurable (positive) actual
  rmse: number | null;     // Root Mean Square Error — null only when dataPoints is 0
  bias: number | null;     // Mean Error (positive = over-forecast) — null only when dataPoints is 0
  dataPoints: number;
  /** Count of points with a positive actual — may be lower than dataPoints; mape covers only these. */
  mapeSamples: number;
}

/**
 * Why an accuracy window produced the metrics it did.
 *
 * `no_model_coverage` is a NORMAL answer, not an error: catboost and xgboost
 * cover disjoint country sets (measured 2026-08-05 on `load`: catboost for 21
 * countries, xgboost for AT/BE/FR, zero countries with both). Asking for
 * catboost's accuracy in France is a well-formed question with the answer
 * "that model does not serve this country" — which must never be rendered as a
 * flawless 0% error, and must be distinguishable from a request that failed.
 */
export type MLAccuracyCoverage = 'served' | 'no_model_coverage' | 'no_paired_actuals';

/**
 * Classify an empty accuracy result. Split out as a pure function so the three
 * cases are testable without a database.
 *
 * - `served` — points were paired; the metrics are a measurement.
 * - `no_model_coverage` — the model has no forecast rows here at all.
 * - `no_paired_actuals` — the model forecast this window, but no actual value
 *   lined up with it (actuals not ingested yet, or a future window).
 */
export function classifyCoverage(
  dataPoints: number,
  modelHasForecastRows: boolean
): MLAccuracyCoverage {
  if (dataPoints > 0) return 'served';
  return modelHasForecastRows ? 'no_paired_actuals' : 'no_model_coverage';
}

/**
 * SQL fragment pinning a query to one `forecasts.model_name`, or the empty
 * string when no model was requested.
 *
 * Empty is load-bearing: with no model the query must stay exactly what it was
 * before this parameter existed — the latest run per target timestamp
 * regardless of which model produced it.
 */
export function modelFilterSql(alias: string, modelName?: string): string {
  return modelName ? `AND ${alias}.model_name = ?` : '';
}

// Two local normalizers used to live here — `normalizeForForecastsTable`
// (kept 'T') and `normalizeForActualsTable` (kept space, and had no caller at
// all). Neither form is correct on its own: both `forecasts` and the actuals
// tables store a mix of the two separators. See `timestampRange` (ABL-21) for
// window bounds and `resolvedActualJoin`/`timestampFormOnClause` (ABL-214) for
// the join below — normalizing only the forecast side of the join dropped
// every T-separated actual (energy_load and energy_price both, not just
// energy_price).

/**
 * The actuals-side JOIN for an accuracy query, resolving whichever separator
 * form the row happens to be stored in (ABL-214) — see `timestampFormOnClause`
 * for why this is two LEFT JOINs and a COALESCE rather than one join matching
 * either form: `energy_load`/`energy_price`/`energy_renewable` all hold
 * country-hours where a 'T' row and a space row both exist with CONFLICTING
 * values, and a single join would silently return both.
 *
 * `alias` lets a correlated `EXISTS`/subquery reuse this against a different
 * outer alias (none does today, but the two aliases this always introduces —
 * `<alias>` for the space match, `<alias>2` for the 'T' fallback — must not
 * collide with anything else in the surrounding query).
 */
function resolvedActualJoin(
  mapping: { table: string; column: string; timestampCol: string },
  forecastType: ForecastType,
  alias = 'a'
): { actualColumn: string; joinClause: string } {
  const rawColumn = (a: string) =>
    forecastType === 'hydro_total' ? `(${a}.hydro_run_mw + ${a}.hydro_reservoir_mw)` : `${a}.${mapping.column}`;
  const fallbackAlias = `${alias}2`;
  return {
    actualColumn: `COALESCE(${rawColumn(alias)}, ${rawColumn(fallbackAlias)})`,
    joinClause: `
      LEFT JOIN ${mapping.table} ${alias}
        ON ${alias}.country_code = ?
        AND ${timestampFormOnClause(`${alias}.${mapping.timestampCol}`, 'f.target_timestamp_utc', 'space')}
      LEFT JOIN ${mapping.table} ${fallbackAlias}
        ON ${fallbackAlias}.country_code = ?
        AND ${timestampFormOnClause(`${fallbackAlias}.${mapping.timestampCol}`, 'f.target_timestamp_utc', 't')}`,
  };
}

/**
 * Get ML forecast accuracy data by comparing forecasts with actuals
 *
 * @param countryCode - Country code (e.g., 'DE')
 * @param forecastType - Type of forecast (load, price, solar, etc.)
 * @param start - Start date ISO string
 * @param end - End date ISO string
 * @param horizon - Optional horizon filter (1 for D+1, 2 for D+2)
 * @param granularity - Data granularity
 * @param modelName - Optional `forecasts.model_name` to pin to. Omit for the
 *   pre-existing behaviour: the latest run per target timestamp, whichever
 *   model produced it. When set, the MAX(generated_at) dedup also narrows to
 *   that model, so the result is that model's own latest run rather than
 *   whichever model happened to run last.
 */
export function getMLForecastAccuracy(
  countryCode: string,
  forecastType: ForecastType,
  start: string,
  end: string,
  horizon?: 1 | 2,
  granularity: Granularity = 'hourly',
  modelName?: string
): MLForecastAccuracyDataPoint[] {
  // Validate forecast type
  if (!VALID_FORECAST_TYPES.includes(forecastType)) {
    throw new Error(`Invalid forecast type: ${forecastType}`);
  }

  const mapping = ACTUAL_DATA_MAPPING[forecastType];
  if (!mapping) {
    return [];
  }

  const upperCode = countryCode.toUpperCase();
  const range = timestampRange(start, end);

  // Build horizon filter for CTE (uses f1 alias)
  let horizonClauseCTE = '';
  if (horizon === 1) {
    horizonClauseCTE = 'AND f1.horizon_hours BETWEEN 0 AND 30';
  } else if (horizon === 2) {
    horizonClauseCTE = 'AND f1.horizon_hours BETWEEN 24 AND 54';
  }

  // Build horizon filter for subquery (uses f2 alias)
  let horizonClauseSubquery = '';
  if (horizon === 1) {
    horizonClauseSubquery = 'AND f2.horizon_hours BETWEEN 0 AND 30';
  } else if (horizon === 2) {
    horizonClauseSubquery = 'AND f2.horizon_hours BETWEEN 24 AND 54';
  }

  // Model pin. Empty string when no model was requested, which leaves the
  // query semantically identical to the pre-existing one.
  const modelClauseCTE = modelFilterSql('f1', modelName);
  const modelClauseSubquery = modelFilterSql('f2', modelName);

  // Bound in the order the `?` placeholders appear in the SQL below: the CTE's
  // own model pin, then the correlated MAX(generated_at) subquery's.
  const modelParams = modelName ? [modelName, modelName] : [];

  // For hourly granularity, join forecasts with actuals
  if (granularity === 'hourly') {
    const { actualColumn, joinClause } = resolvedActualJoin(mapping, forecastType);

    const stmt = db.prepare(`
      WITH latest_forecasts AS (
        SELECT
          f1.target_timestamp_utc,
          f1.forecast_value,
          f1.horizon_hours
        FROM forecasts f1
        WHERE f1.country_code = ?
          AND f1.forecast_type = ?
          AND ${rangeClause('f1.target_timestamp_utc')}
          ${horizonClauseCTE}
          ${modelClauseCTE}
          AND f1.generated_at = (
            SELECT MAX(f2.generated_at)
            FROM forecasts f2
            WHERE f2.country_code = f1.country_code
              AND f2.forecast_type = f1.forecast_type
              AND f2.target_timestamp_utc = f1.target_timestamp_utc
              ${horizonClauseSubquery}
              ${modelClauseSubquery}
          )
      )
      SELECT
        f.target_timestamp_utc as timestamp,
        f.forecast_value,
        ${actualColumn} as actual_value,
        ROUND(${actualColumn} - f.forecast_value, 2) as error,
        CASE
          WHEN ${actualColumn} > 0 THEN ROUND(100.0 * ABS(${actualColumn} - f.forecast_value) / ${actualColumn}, 2)
          ELSE NULL
        END as error_pct,
        f.horizon_hours
      FROM latest_forecasts f
      ${joinClause}
      WHERE ${actualColumn} IS NOT NULL
        ${loadActualGuard(forecastType, actualColumn)}
      ORDER BY f.target_timestamp_utc
    `);

    return stmt.all(
      upperCode, forecastType, ...rangeArgs(range), ...modelParams, upperCode, upperCode
    ) as MLForecastAccuracyDataPoint[];
  }

  // For aggregated granularity (daily, weekly, monthly)
  const groupByClause = getGroupByClause(granularity);
  const { actualColumn, joinClause } = resolvedActualJoin(mapping, forecastType);

  const stmt = db.prepare(`
    WITH latest_forecasts AS (
      SELECT
        f1.target_timestamp_utc,
        f1.forecast_value,
        f1.horizon_hours
      FROM forecasts f1
      WHERE f1.country_code = ?
        AND f1.forecast_type = ?
        AND ${rangeClause('f1.target_timestamp_utc')}
        ${horizonClauseCTE}
        ${modelClauseCTE}
        AND f1.generated_at = (
          SELECT MAX(f2.generated_at)
          FROM forecasts f2
          WHERE f2.country_code = f1.country_code
            AND f2.forecast_type = f1.forecast_type
            AND f2.target_timestamp_utc = f1.target_timestamp_utc
            ${horizonClauseSubquery}
            ${modelClauseSubquery}
        )
    ),
    joined_data AS (
      SELECT
        f.target_timestamp_utc,
        f.forecast_value,
        ${actualColumn} as actual_value,
        f.horizon_hours
      FROM latest_forecasts f
      ${joinClause}
      WHERE ${actualColumn} IS NOT NULL
        ${loadActualGuard(forecastType, actualColumn)}
    )
    SELECT
      ${groupByClause.replace('timestamp_utc', 'target_timestamp_utc')} as timestamp,
      ROUND(AVG(forecast_value), 2) as forecast_value,
      ROUND(AVG(actual_value), 2) as actual_value,
      ROUND(AVG(actual_value - forecast_value), 2) as error,
      ROUND(AVG(CASE WHEN actual_value > 0 THEN 100.0 * ABS(actual_value - forecast_value) / actual_value ELSE NULL END), 2) as error_pct,
      ROUND(AVG(horizon_hours), 0) as horizon_hours
    FROM joined_data
    GROUP BY ${groupByClause.replace('timestamp_utc', 'target_timestamp_utc')}
    ORDER BY timestamp
  `);

  return stmt.all(
    upperCode, forecastType, ...rangeArgs(range), ...modelParams, upperCode, upperCode
  ) as MLForecastAccuracyDataPoint[];
}

/**
 * Get aggregate ML forecast accuracy metrics
 */
export function getMLForecastAccuracyMetrics(
  countryCode: string,
  forecastType: ForecastType,
  start: string,
  end: string,
  horizon?: 1 | 2,
  modelName?: string
): MLForecastAccuracyMetrics {
  const data = getMLForecastAccuracy(countryCode, forecastType, start, end, horizon, 'hourly', modelName);
  return calculateMetrics(data);
}

/**
 * Does this model have any forecast row for this country/type/window at all?
 *
 * Only meaningful to ask when the accuracy join produced nothing: it separates
 * "this model does not serve this country" (expected — disjoint coverage) from
 * "it forecast this window but no actual has landed against it yet".
 */
export function hasMLForecastRowsInWindow(
  countryCode: string,
  forecastType: ForecastType,
  start: string,
  end: string,
  modelName?: string
): boolean {
  const stmt = db.prepare(`
    SELECT 1 FROM forecasts f1
    WHERE f1.country_code = ?
      AND f1.forecast_type = ?
      AND ${rangeClause('f1.target_timestamp_utc')}
      ${modelFilterSql('f1', modelName)}
    LIMIT 1
  `);
  const params = modelName ? [modelName] : [];
  return stmt.get(
    countryCode.toUpperCase(),
    forecastType,
    ...rangeArgs(timestampRange(start, end)),
    ...params
  ) !== undefined;
}

/**
 * Calculate accuracy metrics from data points.
 *
 * Returns nulls rather than zeros for an empty window: zeros render as
 * "MAE 0 MW / MAPE 0%", which reads as a flawless forecast when nothing was
 * measured at all.
 *
 * `mape` covers only points with a positive actual — a percentage error is
 * undefined at zero. Those points previously contributed 0, which understated
 * mape wherever actuals legitimately hit zero (solar overnight) or negative
 * (price). Mirrors tsoForecastService.calculateMetrics — same bug, same fix.
 */
export function calculateMetrics(data: MLForecastAccuracyDataPoint[]): MLForecastAccuracyMetrics {
  if (data.length === 0) {
    return { mae: null, mape: null, rmse: null, bias: null, dataPoints: 0, mapeSamples: 0 };
  }

  const n = data.length;
  const round2 = (x: number) => Math.round(x * 100) / 100;

  // MAE: Mean Absolute Error
  const mae = data.reduce((sum, d) => sum + Math.abs(d.error), 0) / n;

  // MAPE: Mean Absolute Percentage Error — averaged only over points with a
  // measurable (positive) actual.
  const pctPoints = data.filter((d) => d.error_pct != null);
  const mape = pctPoints.length
    ? pctPoints.reduce((sum, d) => sum + (d.error_pct as number), 0) / pctPoints.length
    : null;

  // RMSE: Root Mean Square Error
  const rmse = Math.sqrt(data.reduce((sum, d) => sum + d.error * d.error, 0) / n);

  // Bias: Mean Error (positive = actual > forecast = under-forecast)
  const bias = data.reduce((sum, d) => sum + d.error, 0) / n;

  return {
    mae: round2(mae),
    mape: mape == null ? null : round2(mape),
    rmse: round2(rmse),
    bias: round2(bias),
    dataPoints: n,
    mapeSamples: pctPoints.length,
  };
}

/**
 * Get metrics for both D+1 and D+2 horizons
 */
export function getMLForecastMetricsByHorizon(
  countryCode: string,
  forecastType: ForecastType,
  start: string,
  end: string,
  modelName?: string
): { d1?: MLForecastAccuracyMetrics; d2?: MLForecastAccuracyMetrics } {
  const d1 = getMLForecastAccuracyMetrics(countryCode, forecastType, start, end, 1, modelName);
  const d2 = getMLForecastAccuracyMetrics(countryCode, forecastType, start, end, 2, modelName);

  return {
    d1: d1.dataPoints > 0 ? d1 : undefined,
    d2: d2.dataPoints > 0 ? d2 : undefined,
  };
}

/**
 * Check if ML forecasts exist for a country/type combination
 */
export function hasMLForecasts(countryCode: string, forecastType: ForecastType): boolean {
  const upperCode = countryCode.toUpperCase();
  const stmt = db.prepare(`
    SELECT 1 FROM forecasts
    WHERE country_code = ? AND forecast_type = ?
    LIMIT 1
  `);
  const result = stmt.get(upperCode, forecastType);
  return result !== undefined;
}

function getGroupByClause(granularity: Granularity): string {
  switch (granularity) {
    case 'daily':
      return "date(timestamp_utc)";
    case 'weekly':
      return "strftime('%Y-W%W', timestamp_utc)";
    case 'monthly':
      return "strftime('%Y-%m', timestamp_utc)";
    default:
      return "timestamp_utc";
  }
}
