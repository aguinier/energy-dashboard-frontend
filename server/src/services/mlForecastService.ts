import db from '../config/database.js';
import { ForecastType, Granularity } from '../types/index.js';

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
  error_pct: number;
  horizon_hours: number;
}

export interface MLForecastAccuracyMetrics {
  mae: number;      // Mean Absolute Error
  mape: number;     // Mean Absolute Percentage Error
  rmse: number;     // Root Mean Square Error
  bias: number;     // Mean Error (positive = over-forecast)
  dataPoints: number;
}

// Helper to normalize timestamps for the forecasts table (uses 'T' format)
function normalizeForForecastsTable(isoTimestamp: string): string {
  return isoTimestamp.replace('Z', '').split('.')[0];
}

// Helper to normalize timestamps for actual data tables (uses space format)
function normalizeForActualsTable(isoTimestamp: string): string {
  return isoTimestamp.replace('T', ' ').replace('Z', '').split('.')[0];
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
 */
export function getMLForecastAccuracy(
  countryCode: string,
  forecastType: ForecastType,
  start: string,
  end: string,
  horizon?: 1 | 2,
  granularity: Granularity = 'hourly'
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
  const normalizedStart = normalizeForForecastsTable(start);
  const normalizedEnd = normalizeForForecastsTable(end);

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

  // For hourly granularity, join forecasts with actuals
  if (granularity === 'hourly') {
    // Handle special case for hydro_total which is a computed column
    const actualColumn = forecastType === 'hydro_total'
      ? '(a.hydro_run_mw + a.hydro_reservoir_mw)'
      : `a.${mapping.column}`;

    const stmt = db.prepare(`
      WITH latest_forecasts AS (
        SELECT
          f1.target_timestamp_utc,
          f1.forecast_value,
          f1.horizon_hours
        FROM forecasts f1
        WHERE f1.country_code = ?
          AND f1.forecast_type = ?
          AND f1.target_timestamp_utc BETWEEN ? AND ?
          ${horizonClauseCTE}
          AND f1.generated_at = (
            SELECT MAX(f2.generated_at)
            FROM forecasts f2
            WHERE f2.country_code = f1.country_code
              AND f2.forecast_type = f1.forecast_type
              AND f2.target_timestamp_utc = f1.target_timestamp_utc
              ${horizonClauseSubquery}
          )
      )
      SELECT
        f.target_timestamp_utc as timestamp,
        f.forecast_value,
        ${actualColumn} as actual_value,
        ROUND(${actualColumn} - f.forecast_value, 2) as error,
        CASE
          WHEN ${actualColumn} > 0 THEN ROUND(100.0 * ABS(${actualColumn} - f.forecast_value) / ${actualColumn}, 2)
          ELSE 0
        END as error_pct,
        f.horizon_hours
      FROM latest_forecasts f
      INNER JOIN ${mapping.table} a
        ON a.country_code = ?
        AND REPLACE(f.target_timestamp_utc, 'T', ' ') = a.${mapping.timestampCol}
      WHERE ${actualColumn} IS NOT NULL
      ORDER BY f.target_timestamp_utc
    `);

    return stmt.all(upperCode, forecastType, normalizedStart, normalizedEnd, upperCode) as MLForecastAccuracyDataPoint[];
  }

  // For aggregated granularity (daily, weekly, monthly)
  const groupByClause = getGroupByClause(granularity);
  const actualColumn = forecastType === 'hydro_total'
    ? '(a.hydro_run_mw + a.hydro_reservoir_mw)'
    : `a.${mapping.column}`;

  const stmt = db.prepare(`
    WITH latest_forecasts AS (
      SELECT
        f1.target_timestamp_utc,
        f1.forecast_value,
        f1.horizon_hours
      FROM forecasts f1
      WHERE f1.country_code = ?
        AND f1.forecast_type = ?
        AND f1.target_timestamp_utc BETWEEN ? AND ?
        ${horizonClauseCTE}
        AND f1.generated_at = (
          SELECT MAX(f2.generated_at)
          FROM forecasts f2
          WHERE f2.country_code = f1.country_code
            AND f2.forecast_type = f1.forecast_type
            AND f2.target_timestamp_utc = f1.target_timestamp_utc
            ${horizonClauseSubquery}
        )
    ),
    joined_data AS (
      SELECT
        f.target_timestamp_utc,
        f.forecast_value,
        ${actualColumn} as actual_value,
        f.horizon_hours
      FROM latest_forecasts f
      INNER JOIN ${mapping.table} a
        ON a.country_code = ?
        AND REPLACE(f.target_timestamp_utc, 'T', ' ') = a.${mapping.timestampCol}
      WHERE ${actualColumn} IS NOT NULL
    )
    SELECT
      ${groupByClause.replace('timestamp_utc', 'target_timestamp_utc')} as timestamp,
      ROUND(AVG(forecast_value), 2) as forecast_value,
      ROUND(AVG(actual_value), 2) as actual_value,
      ROUND(AVG(actual_value - forecast_value), 2) as error,
      ROUND(AVG(CASE WHEN actual_value > 0 THEN 100.0 * ABS(actual_value - forecast_value) / actual_value ELSE 0 END), 2) as error_pct,
      ROUND(AVG(horizon_hours), 0) as horizon_hours
    FROM joined_data
    GROUP BY ${groupByClause.replace('timestamp_utc', 'target_timestamp_utc')}
    ORDER BY timestamp
  `);

  return stmt.all(upperCode, forecastType, normalizedStart, normalizedEnd, upperCode) as MLForecastAccuracyDataPoint[];
}

/**
 * Get aggregate ML forecast accuracy metrics
 */
export function getMLForecastAccuracyMetrics(
  countryCode: string,
  forecastType: ForecastType,
  start: string,
  end: string,
  horizon?: 1 | 2
): MLForecastAccuracyMetrics {
  const data = getMLForecastAccuracy(countryCode, forecastType, start, end, horizon, 'hourly');
  return calculateMetrics(data);
}

/**
 * Calculate accuracy metrics from data points
 */
function calculateMetrics(data: MLForecastAccuracyDataPoint[]): MLForecastAccuracyMetrics {
  if (data.length === 0) {
    return { mae: 0, mape: 0, rmse: 0, bias: 0, dataPoints: 0 };
  }

  const n = data.length;

  // MAE: Mean Absolute Error
  const mae = data.reduce((sum, d) => sum + Math.abs(d.error), 0) / n;

  // MAPE: Mean Absolute Percentage Error (already calculated as error_pct)
  const mape = data.reduce((sum, d) => sum + d.error_pct, 0) / n;

  // RMSE: Root Mean Square Error
  const rmse = Math.sqrt(data.reduce((sum, d) => sum + d.error * d.error, 0) / n);

  // Bias: Mean Error (positive = actual > forecast = under-forecast)
  const bias = data.reduce((sum, d) => sum + d.error, 0) / n;

  return {
    mae: Math.round(mae * 100) / 100,
    mape: Math.round(mape * 100) / 100,
    rmse: Math.round(rmse * 100) / 100,
    bias: Math.round(bias * 100) / 100,
    dataPoints: n,
  };
}

/**
 * Get metrics for both D+1 and D+2 horizons
 */
export function getMLForecastMetricsByHorizon(
  countryCode: string,
  forecastType: ForecastType,
  start: string,
  end: string
): { d1?: MLForecastAccuracyMetrics; d2?: MLForecastAccuracyMetrics } {
  const d1 = getMLForecastAccuracyMetrics(countryCode, forecastType, start, end, 1);
  const d2 = getMLForecastAccuracyMetrics(countryCode, forecastType, start, end, 2);

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
