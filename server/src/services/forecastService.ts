import db from '../config/database.js';
import { ForecastDataPoint, ForecastType, Granularity } from '../types/index.js';
import { normalizeTimestamp } from '../utils/timestamp.js';

// Helper to normalize timestamps for the forecasts table which uses 'T' format
function normalizeForForecastsTable(isoTimestamp: string): string {
  // Remove Z suffix and milliseconds, keep 'T' separator
  return isoTimestamp.replace('Z', '').split('.')[0];
}

export function getForecastData(
  countryCode: string,
  forecastType: ForecastType,
  start: string,
  end: string,
  granularity: Granularity = 'hourly',
  horizon?: number
): ForecastDataPoint[] {
  const upperCode = countryCode.toUpperCase();
  // Use forecast-specific normalization that keeps 'T' format
  const normalizedStart = normalizeForForecastsTable(start);
  const normalizedEnd = normalizeForForecastsTable(end);

  // Build horizon filter clause (D+1 = 0-30h, D+2 = 24-54h)
  let horizonClause = '';
  if (horizon === 1) {
    horizonClause = 'AND horizon_hours BETWEEN 0 AND 30';
  } else if (horizon === 2) {
    horizonClause = 'AND horizon_hours BETWEEN 24 AND 54';
  }

  if (granularity === 'hourly') {
    // Use subquery to get only the most recent forecast for each timestamp
    // This deduplicates when multiple model runs exist for the same target time
    const stmt = db.prepare(`
      SELECT
        target_timestamp_utc as timestamp,
        forecast_value as value,
        forecast_type as type,
        generated_at,
        horizon_hours,
        model_name,
        model_version
      FROM forecasts f1
      WHERE country_code = ?
        AND forecast_type = ?
        AND target_timestamp_utc BETWEEN ? AND ?
        ${horizonClause}
        AND generated_at = (
          SELECT MAX(f2.generated_at)
          FROM forecasts f2
          WHERE f2.country_code = f1.country_code
            AND f2.forecast_type = f1.forecast_type
            AND f2.target_timestamp_utc = f1.target_timestamp_utc
            ${horizonClause}
        )
      ORDER BY target_timestamp_utc
    `);
    return stmt.all(upperCode, forecastType, normalizedStart, normalizedEnd) as ForecastDataPoint[];
  }

  // Aggregated queries for daily/weekly/monthly
  const groupByClause = getGroupByClause(granularity);
  const stmt = db.prepare(`
    SELECT
      ${groupByClause} as timestamp,
      ROUND(AVG(forecast_value), 2) as value,
      forecast_type as type,
      MAX(generated_at) as generated_at,
      ROUND(AVG(horizon_hours), 0) as horizon_hours
    FROM forecasts
    WHERE country_code = ?
      AND forecast_type = ?
      AND target_timestamp_utc BETWEEN ? AND ?
      ${horizonClause}
    GROUP BY ${groupByClause}
    ORDER BY timestamp
  `);
  return stmt.all(upperCode, forecastType, normalizedStart, normalizedEnd) as ForecastDataPoint[];
}

export function getLatestForecast(
  countryCode: string,
  forecastType?: ForecastType
) {
  const upperCode = countryCode.toUpperCase();

  // Get the most recent forecast batch
  const latestGenerated = db.prepare(`
    SELECT MAX(generated_at) as generated_at
    FROM forecasts
    WHERE country_code = ?
    ${forecastType ? 'AND forecast_type = ?' : ''}
  `);

  const params = forecastType ? [upperCode, forecastType] : [upperCode];
  const { generated_at } = latestGenerated.get(...params) as { generated_at: string | null };

  if (!generated_at) {
    return [];
  }

  // Fetch all forecasts from that batch
  const stmt = db.prepare(`
    SELECT
      target_timestamp_utc as timestamp,
      forecast_value as value,
      forecast_type as type,
      generated_at,
      horizon_hours,
      model_name,
      model_version
    FROM forecasts
    WHERE country_code = ?
      AND generated_at = ?
      ${forecastType ? 'AND forecast_type = ?' : ''}
    ORDER BY forecast_type, target_timestamp_utc
  `);

  const fetchParams = forecastType
    ? [upperCode, generated_at, forecastType]
    : [upperCode, generated_at];

  return stmt.all(...fetchParams) as ForecastDataPoint[];
}

export function getAvailableForecastTypes(countryCode: string): string[] {
  const upperCode = countryCode.toUpperCase();

  const stmt = db.prepare(`
    SELECT DISTINCT forecast_type
    FROM forecasts
    WHERE country_code = ?
    ORDER BY forecast_type
  `);

  const result = stmt.all(upperCode) as Array<{ forecast_type: string }>;
  return result.map(r => r.forecast_type);
}

export function getForecastWithActuals(
  countryCode: string,
  forecastType: ForecastType,
  start: string,
  end: string
) {
  const upperCode = countryCode.toUpperCase();
  const normalizedStart = normalizeTimestamp(start);
  const normalizedEnd = normalizeTimestamp(end);

  // Map forecast type to actual data table and column
  const tableMapping: Record<string, { table: string; column: string }> = {
    load: { table: 'energy_load', column: 'load_mw' },
    price: { table: 'energy_price', column: 'price_eur_mwh' },
    renewable: { table: 'energy_renewable', column: 'total_mw' },
    solar: { table: 'energy_renewable', column: 'solar_mw' },
    wind_onshore: { table: 'energy_renewable', column: 'wind_onshore_mw' },
    wind_offshore: { table: 'energy_renewable', column: 'wind_offshore_mw' },
    hydro_total: { table: 'energy_renewable', column: 'hydro_mw' },
    biomass: { table: 'energy_renewable', column: 'biomass_mw' },
  };

  const mapping = tableMapping[forecastType];
  if (!mapping) {
    return { forecasts: [], actuals: [] };
  }

  // Get forecasts
  const forecastStmt = db.prepare(`
    SELECT
      target_timestamp_utc as timestamp,
      forecast_value as value,
      generated_at,
      horizon_hours
    FROM forecasts
    WHERE country_code = ?
      AND forecast_type = ?
      AND target_timestamp_utc BETWEEN ? AND ?
    ORDER BY target_timestamp_utc
  `);
  const forecasts = forecastStmt.all(upperCode, forecastType, normalizedStart, normalizedEnd);

  // Get actuals
  const actualStmt = db.prepare(`
    SELECT
      timestamp_utc as timestamp,
      ${mapping.column} as value
    FROM ${mapping.table}
    WHERE country_code = ?
      AND timestamp_utc BETWEEN ? AND ?
    ORDER BY timestamp_utc
  `);
  const actuals = actualStmt.all(upperCode, normalizedStart, normalizedEnd);

  return { forecasts, actuals };
}

function getGroupByClause(granularity: Granularity): string {
  switch (granularity) {
    case 'daily':
      return "date(target_timestamp_utc)";
    case 'weekly':
      return "strftime('%Y-W%W', target_timestamp_utc)";
    case 'monthly':
      return "strftime('%Y-%m', target_timestamp_utc)";
    default:
      return "target_timestamp_utc";
  }
}

export interface MultiHorizonDataPoint {
  timestamp: string;
  forecast_d1?: number;
  forecast_d2?: number;
}

/**
 * Get multi-horizon forecasts (D+1 and D+2) for overlay view
 */
export function getMultiHorizonForecastData(
  countryCode: string,
  forecastType: ForecastType,
  start: string,
  end: string
): MultiHorizonDataPoint[] {
  const upperCode = countryCode.toUpperCase();
  const normalizedStart = normalizeForForecastsTable(start);
  const normalizedEnd = normalizeForForecastsTable(end);

  // Get D+1 forecasts (horizon 0-30 hours)
  const d1Stmt = db.prepare(`
    SELECT
      target_timestamp_utc as timestamp,
      forecast_value as value
    FROM forecasts f1
    WHERE country_code = ?
      AND forecast_type = ?
      AND target_timestamp_utc BETWEEN ? AND ?
      AND horizon_hours BETWEEN 0 AND 30
      AND generated_at = (
        SELECT MAX(f2.generated_at)
        FROM forecasts f2
        WHERE f2.country_code = f1.country_code
          AND f2.forecast_type = f1.forecast_type
          AND f2.target_timestamp_utc = f1.target_timestamp_utc
          AND f2.horizon_hours BETWEEN 0 AND 30
      )
    ORDER BY target_timestamp_utc
  `);
  const d1Data = d1Stmt.all(upperCode, forecastType, normalizedStart, normalizedEnd) as Array<{ timestamp: string; value: number }>;

  // Get D+2 forecasts (horizon 24-54 hours)
  const d2Stmt = db.prepare(`
    SELECT
      target_timestamp_utc as timestamp,
      forecast_value as value
    FROM forecasts f1
    WHERE country_code = ?
      AND forecast_type = ?
      AND target_timestamp_utc BETWEEN ? AND ?
      AND horizon_hours BETWEEN 24 AND 54
      AND generated_at = (
        SELECT MAX(f2.generated_at)
        FROM forecasts f2
        WHERE f2.country_code = f1.country_code
          AND f2.forecast_type = f1.forecast_type
          AND f2.target_timestamp_utc = f1.target_timestamp_utc
          AND f2.horizon_hours BETWEEN 24 AND 54
      )
    ORDER BY target_timestamp_utc
  `);
  const d2Data = d2Stmt.all(upperCode, forecastType, normalizedStart, normalizedEnd) as Array<{ timestamp: string; value: number }>;

  // Merge into a map by timestamp
  const dataMap = new Map<string, MultiHorizonDataPoint>();

  for (const item of d1Data) {
    dataMap.set(item.timestamp, { timestamp: item.timestamp, forecast_d1: item.value });
  }

  for (const item of d2Data) {
    const existing = dataMap.get(item.timestamp);
    if (existing) {
      existing.forecast_d2 = item.value;
    } else {
      dataMap.set(item.timestamp, { timestamp: item.timestamp, forecast_d2: item.value });
    }
  }

  // Convert to array and sort by timestamp
  return Array.from(dataMap.values()).sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}
