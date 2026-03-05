import db from '../config/database.js';
import { Granularity } from '../types/index.js';
import { normalizeTimestamp } from '../utils/timestamp.js';

// Valid generation types for SQL column interpolation - prevents injection
const VALID_GENERATION_TYPES = ['solar', 'wind_onshore', 'wind_offshore'] as const;
type ValidGenerationType = typeof VALID_GENERATION_TYPES[number];

export interface TSOLoadForecastDataPoint {
  timestamp: string;
  forecast_value_mw: number;
  forecast_min_mw: number | null;
  forecast_max_mw: number | null;
  forecast_type: string;
  publication_timestamp_utc: string | null;
}

export interface TSOGenerationForecastDataPoint {
  timestamp: string;
  solar_mw: number | null;
  wind_onshore_mw: number | null;
  wind_offshore_mw: number | null;
  total_forecast_mw: number | null;
}

export interface ForecastAccuracyDataPoint {
  timestamp: string;
  forecast_value: number;
  actual_value: number;
  error: number;
  error_pct: number;
}

export type TSOForecastType = 'day_ahead' | 'week_ahead' | 'all';

/**
 * Get TSO load forecasts for a country
 */
export function getLoadForecast(
  countryCode: string,
  start: string,
  end: string,
  forecastType: TSOForecastType = 'day_ahead',
  granularity: Granularity = 'hourly'
): TSOLoadForecastDataPoint[] {
  const upperCode = countryCode.toUpperCase();
  const normalizedStart = normalizeTimestamp(start);
  const normalizedEnd = normalizeTimestamp(end);

  // Week-ahead forecasts have daily granularity with min/max values
  if (forecastType === 'week_ahead') {
    const stmt = db.prepare(`
      SELECT
        date(target_timestamp_utc) || 'T12:00:00Z' as timestamp,
        ROUND(AVG(forecast_value_mw), 2) as forecast_value_mw,
        ROUND(MIN(forecast_min_mw), 2) as forecast_min_mw,
        ROUND(MAX(forecast_max_mw), 2) as forecast_max_mw,
        forecast_type,
        MAX(publication_timestamp_utc) as publication_timestamp_utc
      FROM energy_load_forecast
      WHERE country_code = ?
        AND target_timestamp_utc BETWEEN ? AND ?
        AND forecast_type = 'week_ahead'
      GROUP BY date(target_timestamp_utc)
      ORDER BY timestamp
    `);
    return stmt.all(upperCode, normalizedStart, normalizedEnd) as TSOLoadForecastDataPoint[];
  }

  // Day-ahead forecasts: no min/max
  let whereClause = 'country_code = ? AND target_timestamp_utc BETWEEN ? AND ?';
  const params: (string | number)[] = [upperCode, normalizedStart, normalizedEnd];

  if (forecastType !== 'all') {
    whereClause += ' AND forecast_type = ?';
    params.push(forecastType);
  }

  if (granularity === 'hourly') {
    // For hourly, aggregate 15-min data to hourly
    const stmt = db.prepare(`
      SELECT
        strftime('%Y-%m-%dT%H:00:00Z', target_timestamp_utc) as timestamp,
        ROUND(AVG(forecast_value_mw), 2) as forecast_value_mw,
        NULL as forecast_min_mw,
        NULL as forecast_max_mw,
        forecast_type,
        MAX(publication_timestamp_utc) as publication_timestamp_utc
      FROM energy_load_forecast
      WHERE ${whereClause}
      GROUP BY strftime('%Y-%m-%dT%H:00:00Z', target_timestamp_utc), forecast_type
      ORDER BY timestamp, forecast_type
    `);
    return stmt.all(...params) as TSOLoadForecastDataPoint[];
  }

  // For daily/weekly/monthly aggregation
  const groupByClause = getGroupByClause(granularity);
  const stmt = db.prepare(`
    SELECT
      ${groupByClause} as timestamp,
      ROUND(AVG(forecast_value_mw), 2) as forecast_value_mw,
      NULL as forecast_min_mw,
      NULL as forecast_max_mw,
      forecast_type,
      MAX(publication_timestamp_utc) as publication_timestamp_utc
    FROM energy_load_forecast
    WHERE ${whereClause}
    GROUP BY ${groupByClause}, forecast_type
    ORDER BY timestamp, forecast_type
  `);
  return stmt.all(...params) as TSOLoadForecastDataPoint[];
}

/**
 * Get TSO generation forecasts (solar + wind) for a country
 */
export function getGenerationForecast(
  countryCode: string,
  start: string,
  end: string,
  granularity: Granularity = 'hourly'
): TSOGenerationForecastDataPoint[] {
  const upperCode = countryCode.toUpperCase();
  const normalizedStart = normalizeTimestamp(start);
  const normalizedEnd = normalizeTimestamp(end);

  if (granularity === 'hourly') {
    const stmt = db.prepare(`
      SELECT
        REPLACE(target_timestamp_utc, ' ', 'T') as timestamp,
        ROUND(solar_mw, 2) as solar_mw,
        ROUND(wind_onshore_mw, 2) as wind_onshore_mw,
        ROUND(wind_offshore_mw, 2) as wind_offshore_mw,
        ROUND(total_forecast_mw, 2) as total_forecast_mw
      FROM energy_generation_forecast
      WHERE country_code = ?
        AND target_timestamp_utc BETWEEN ? AND ?
      ORDER BY target_timestamp_utc
    `);
    return stmt.all(upperCode, normalizedStart, normalizedEnd) as TSOGenerationForecastDataPoint[];
  }

  // For aggregated granularity
  const groupByClause = getGroupByClause(granularity);
  const stmt = db.prepare(`
    SELECT
      ${groupByClause} as timestamp,
      ROUND(AVG(solar_mw), 2) as solar_mw,
      ROUND(AVG(wind_onshore_mw), 2) as wind_onshore_mw,
      ROUND(AVG(wind_offshore_mw), 2) as wind_offshore_mw,
      ROUND(AVG(total_forecast_mw), 2) as total_forecast_mw
    FROM energy_generation_forecast
    WHERE country_code = ?
      AND target_timestamp_utc BETWEEN ? AND ?
    GROUP BY ${groupByClause}
    ORDER BY timestamp
  `);
  return stmt.all(upperCode, normalizedStart, normalizedEnd) as TSOGenerationForecastDataPoint[];
}

/**
 * Get load forecast accuracy by comparing forecast vs actual
 */
export function getLoadForecastAccuracy(
  countryCode: string,
  start: string,
  end: string,
  forecastType: TSOForecastType = 'day_ahead',
  granularity: Granularity = 'hourly'
): ForecastAccuracyDataPoint[] {
  const upperCode = countryCode.toUpperCase();
  const normalizedStart = normalizeTimestamp(start);
  const normalizedEnd = normalizeTimestamp(end);

  let forecastTypeFilter = '';
  const params: (string | number)[] = [upperCode, normalizedStart, normalizedEnd];

  if (forecastType !== 'all') {
    forecastTypeFilter = 'AND forecast_type = ?';
    params.push(forecastType);
  }

  if (granularity === 'hourly') {
    // Join forecast with actual load data, aggregating 15-min to hourly
    const stmt = db.prepare(`
      WITH hourly_forecast AS (
        SELECT
          strftime('%Y-%m-%dT%H:00:00Z', target_timestamp_utc) as timestamp,
          ROUND(AVG(forecast_value_mw), 2) as forecast_value
        FROM energy_load_forecast
        WHERE country_code = ?
          AND target_timestamp_utc BETWEEN ? AND ?
          ${forecastTypeFilter}
        GROUP BY strftime('%Y-%m-%dT%H:00:00Z', target_timestamp_utc)
      ),
      hourly_actual AS (
        SELECT
          strftime('%Y-%m-%dT%H:00:00Z', timestamp_utc) as timestamp,
          ROUND(AVG(load_mw), 2) as actual_value
        FROM energy_load
        WHERE country_code = ?
          AND timestamp_utc BETWEEN ? AND ?
        GROUP BY strftime('%Y-%m-%dT%H:00:00Z', timestamp_utc)
      )
      SELECT
        f.timestamp,
        f.forecast_value,
        a.actual_value,
        ROUND(a.actual_value - f.forecast_value, 2) as error,
        CASE
          WHEN a.actual_value > 0 THEN ROUND(100.0 * ABS(a.actual_value - f.forecast_value) / a.actual_value, 2)
          ELSE 0
        END as error_pct
      FROM hourly_forecast f
      INNER JOIN hourly_actual a ON f.timestamp = a.timestamp
      ORDER BY f.timestamp
    `);
    // Need to add country and date range params twice (for forecast and actual CTEs)
    return stmt.all(...params, upperCode, normalizedStart, normalizedEnd) as ForecastAccuracyDataPoint[];
  }

  // For aggregated granularity
  const groupByClause = getGroupByClause(granularity);
  const stmt = db.prepare(`
    WITH agg_forecast AS (
      SELECT
        ${groupByClause.replace('timestamp_utc', 'target_timestamp_utc')} as timestamp,
        ROUND(AVG(forecast_value_mw), 2) as forecast_value
      FROM energy_load_forecast
      WHERE country_code = ?
        AND target_timestamp_utc BETWEEN ? AND ?
        ${forecastTypeFilter}
      GROUP BY ${groupByClause.replace('timestamp_utc', 'target_timestamp_utc')}
    ),
    agg_actual AS (
      SELECT
        ${groupByClause} as timestamp,
        ROUND(AVG(load_mw), 2) as actual_value
      FROM energy_load
      WHERE country_code = ?
        AND timestamp_utc BETWEEN ? AND ?
      GROUP BY ${groupByClause}
    )
    SELECT
      f.timestamp,
      f.forecast_value,
      a.actual_value,
      ROUND(a.actual_value - f.forecast_value, 2) as error,
      CASE
        WHEN a.actual_value > 0 THEN ROUND(100.0 * ABS(a.actual_value - f.forecast_value) / a.actual_value, 2)
        ELSE 0
      END as error_pct
    FROM agg_forecast f
    INNER JOIN agg_actual a ON f.timestamp = a.timestamp
    ORDER BY f.timestamp
  `);
  return stmt.all(...params, upperCode, normalizedStart, normalizedEnd) as ForecastAccuracyDataPoint[];
}

/**
 * Get generation forecast accuracy for a specific type (solar, wind_onshore, wind_offshore)
 */
export function getGenerationForecastAccuracy(
  countryCode: string,
  start: string,
  end: string,
  generationType: 'solar' | 'wind_onshore' | 'wind_offshore',
  granularity: Granularity = 'hourly'
): ForecastAccuracyDataPoint[] {
  // Validate generation type to prevent SQL injection via column interpolation
  if (!VALID_GENERATION_TYPES.includes(generationType)) {
    throw new Error(`Invalid generation type: ${generationType}`);
  }
  
  const upperCode = countryCode.toUpperCase();
  const normalizedStart = normalizeTimestamp(start);
  const normalizedEnd = normalizeTimestamp(end);

  const forecastColumn = `${generationType}_mw`;
  const actualColumn = `${generationType}_mw`;

  if (granularity === 'hourly') {
    const stmt = db.prepare(`
      SELECT
        f.target_timestamp_utc as timestamp,
        ROUND(f.${forecastColumn}, 2) as forecast_value,
        ROUND(a.${actualColumn}, 2) as actual_value,
        ROUND(a.${actualColumn} - f.${forecastColumn}, 2) as error,
        CASE
          WHEN a.${actualColumn} > 0 THEN ROUND(100.0 * ABS(a.${actualColumn} - f.${forecastColumn}) / a.${actualColumn}, 2)
          ELSE 0
        END as error_pct
      FROM energy_generation_forecast f
      INNER JOIN energy_renewable a
        ON f.country_code = a.country_code
        AND f.target_timestamp_utc = a.timestamp_utc
      WHERE f.country_code = ?
        AND f.target_timestamp_utc BETWEEN ? AND ?
        AND f.${forecastColumn} IS NOT NULL
        AND a.${actualColumn} IS NOT NULL
      ORDER BY f.target_timestamp_utc
    `);
    return stmt.all(upperCode, normalizedStart, normalizedEnd) as ForecastAccuracyDataPoint[];
  }

  // For aggregated granularity
  const groupByClause = getGroupByClause(granularity);
  const stmt = db.prepare(`
    WITH agg_forecast AS (
      SELECT
        ${groupByClause.replace('timestamp_utc', 'target_timestamp_utc')} as timestamp,
        ROUND(AVG(${forecastColumn}), 2) as forecast_value
      FROM energy_generation_forecast
      WHERE country_code = ?
        AND target_timestamp_utc BETWEEN ? AND ?
        AND ${forecastColumn} IS NOT NULL
      GROUP BY ${groupByClause.replace('timestamp_utc', 'target_timestamp_utc')}
    ),
    agg_actual AS (
      SELECT
        ${groupByClause} as timestamp,
        ROUND(AVG(${actualColumn}), 2) as actual_value
      FROM energy_renewable
      WHERE country_code = ?
        AND timestamp_utc BETWEEN ? AND ?
        AND ${actualColumn} IS NOT NULL
      GROUP BY ${groupByClause}
    )
    SELECT
      f.timestamp,
      f.forecast_value,
      a.actual_value,
      ROUND(a.actual_value - f.forecast_value, 2) as error,
      CASE
        WHEN a.actual_value > 0 THEN ROUND(100.0 * ABS(a.actual_value - f.forecast_value) / a.actual_value, 2)
        ELSE 0
      END as error_pct
    FROM agg_forecast f
    INNER JOIN agg_actual a ON f.timestamp = a.timestamp
    ORDER BY f.timestamp
  `);
  return stmt.all(upperCode, normalizedStart, normalizedEnd, upperCode, normalizedStart, normalizedEnd) as ForecastAccuracyDataPoint[];
}

/**
 * Get aggregate accuracy metrics
 */
export function getLoadForecastAccuracyMetrics(
  countryCode: string,
  start: string,
  end: string,
  forecastType: TSOForecastType = 'day_ahead'
) {
  const data = getLoadForecastAccuracy(countryCode, start, end, forecastType, 'hourly');
  return calculateMetrics(data);
}

export function getGenerationForecastAccuracyMetrics(
  countryCode: string,
  start: string,
  end: string,
  generationType: 'solar' | 'wind_onshore' | 'wind_offshore'
) {
  const data = getGenerationForecastAccuracy(countryCode, start, end, generationType, 'hourly');
  return calculateMetrics(data);
}

function calculateMetrics(data: ForecastAccuracyDataPoint[]) {
  if (data.length === 0) {
    return { mae: 0, mape: 0, rmse: 0, dataPoints: 0 };
  }

  const n = data.length;
  const mae = data.reduce((sum, d) => sum + Math.abs(d.error), 0) / n;
  const mape = data.reduce((sum, d) => sum + d.error_pct, 0) / n;
  const rmse = Math.sqrt(data.reduce((sum, d) => sum + d.error * d.error, 0) / n);

  return {
    mae: Math.round(mae * 100) / 100,
    mape: Math.round(mape * 100) / 100,
    rmse: Math.round(rmse * 100) / 100,
    dataPoints: n,
  };
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
