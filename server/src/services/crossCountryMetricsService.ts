import db from '../config/database.js';
import { ForecastType } from '../types/index.js';

/**
 * Cross-Country Forecast Metrics Service
 *
 * Computes ML forecast accuracy metrics (MAE, MAPE, RMSE, bias)
 * across all countries for a given forecast type, using the same
 * deduplication and join patterns as mlForecastService.
 */

// Valid forecast types
const VALID_FORECAST_TYPES: ForecastType[] = [
  'load', 'price', 'renewable', 'solar',
  'wind_onshore', 'wind_offshore', 'hydro_total', 'biomass'
];

// Mapping from forecast type to actual data source (same as mlForecastService)
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

export interface CountryMetrics {
  mae: number;
  mape: number;
  rmse: number;
  bias: number;
  dataPoints: number;
}

export type CrossCountryMetricsResult = Record<string, CountryMetrics>;

// Helper to normalize timestamps for the forecasts table (uses 'T' format)
function normalizeTimestamp(isoTimestamp: string): string {
  return isoTimestamp.replace('Z', '').split('.')[0];
}

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

  const mapping = ACTUAL_DATA_MAPPING[forecastType];
  if (!mapping) {
    return {};
  }

  const normalizedStart = normalizeTimestamp(start);
  const normalizedEnd = normalizeTimestamp(end);

  // Handle special case for hydro_total which is a computed column
  const actualColumn = forecastType === 'hydro_total'
    ? '(a.hydro_run_mw + a.hydro_reservoir_mw)'
    : `a.${mapping.column}`;

  const stmt = db.prepare(`
    WITH latest_forecasts AS (
      SELECT
        f1.country_code,
        f1.target_timestamp_utc,
        f1.forecast_value
      FROM forecasts f1
      WHERE f1.forecast_type = ?
        AND f1.target_timestamp_utc BETWEEN ? AND ?
        AND f1.generated_at = (
          SELECT MAX(f2.generated_at)
          FROM forecasts f2
          WHERE f2.country_code = f1.country_code
            AND f2.forecast_type = f1.forecast_type
            AND f2.target_timestamp_utc = f1.target_timestamp_utc
        )
    )
    SELECT
      f.country_code,
      ROUND(AVG(ABS(${actualColumn} - f.forecast_value)), 2) as mae,
      ROUND(AVG(
        CASE WHEN ${actualColumn} > 0
          THEN 100.0 * ABS(${actualColumn} - f.forecast_value) / ${actualColumn}
          ELSE NULL
        END
      ), 2) as mape,
      ROUND(SQRT(AVG((${actualColumn} - f.forecast_value) * (${actualColumn} - f.forecast_value))), 2) as rmse,
      ROUND(AVG(${actualColumn} - f.forecast_value), 2) as bias,
      COUNT(*) as data_points
    FROM latest_forecasts f
    INNER JOIN ${mapping.table} a
      ON a.country_code = f.country_code
      AND REPLACE(f.target_timestamp_utc, 'T', ' ') = a.${mapping.timestampCol}
    WHERE ${actualColumn} IS NOT NULL
    GROUP BY f.country_code
    ORDER BY f.country_code
  `);

  const rows = stmt.all(forecastType, normalizedStart, normalizedEnd) as Array<{
    country_code: string;
    mae: number | null;
    mape: number | null;
    rmse: number | null;
    bias: number | null;
    data_points: number;
  }>;

  const result: CrossCountryMetricsResult = {};
  for (const row of rows) {
    result[row.country_code] = {
      mae: row.mae ?? 0,
      mape: row.mape ?? 0,
      rmse: row.rmse ?? 0,
      bias: row.bias ?? 0,
      dataPoints: row.data_points,
    };
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
  const result: Record<string, CrossCountryMetricsResult> = {};

  for (const forecastType of VALID_FORECAST_TYPES) {
    const metrics = getCrossCountryMetrics(forecastType, start, end);
    // Only include types that have data
    if (Object.keys(metrics).length > 0) {
      result[forecastType] = metrics;
    }
  }

  return result;
}
