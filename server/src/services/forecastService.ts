import db from '../config/database.js';
import { ForecastDataPoint, ForecastType, Granularity } from '../types/index.js';
import { timestampRange, rangeClause, rangeArgs } from '../utils/timestamp.js';
import { resolveModelCandidates } from '../config/forecastModels.js';
import { loadActualGuard } from './loadQuality.js';

// There used to be a second normalizer here, `normalizeForForecastsTable`,
// which kept the 'T' separator "for the forecasts table". It had the mirror of
// the ABL-21 defect: `forecasts` is 99.7% 'T' but the two chronos models write
// a space, so a 'T'-form lower bound dropped every space-form row later in the
// start day, and a 'T'-form upper bound pulled in every space-form row later in
// the end day. Neither single form is right — see `timestampRange`.

export function getForecastData(
  countryCode: string,
  forecastType: ForecastType,
  start: string,
  end: string,
  granularity: Granularity = 'hourly',
  horizon?: number,
  modelId?: string
): ForecastDataPoint[] {
  const upperCode = countryCode.toUpperCase();
  // Try the production model first, then the other registered ml models.
  // catboost and xgboost cover disjoint country sets, so an absolute pin would
  // blank AT/BE/FR for load rather than harmonise them. Callers can read
  // model_name off the returned rows to label what actually served.
  const candidates = resolveModelCandidates(forecastType, modelId)
    .filter((m) => m.modelName)
    .map((m) => m.modelName as string);

  for (const candidate of candidates) {
    const rows = queryForecasts(
      upperCode, forecastType, start, end, granularity, horizon, candidate
    );
    if (rows.length > 0) return rows;
  }
  return [];
}

function queryForecasts(
  upperCode: string,
  forecastType: ForecastType,
  start: string,
  end: string,
  granularity: Granularity,
  horizon: number | undefined,
  modelName: string
): ForecastDataPoint[] {
  const range = timestampRange(start, end);

  const modelClause = 'AND model_name = ?';

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
        AND ${rangeClause('target_timestamp_utc')}
        ${modelClause}
        ${horizonClause}
        AND generated_at = (
          SELECT MAX(f2.generated_at)
          FROM forecasts f2
          WHERE f2.country_code = f1.country_code
            AND f2.forecast_type = f1.forecast_type
            AND f2.target_timestamp_utc = f1.target_timestamp_utc
            ${modelClause.replace('model_name', 'f2.model_name')}
            ${horizonClause}
        )
      ORDER BY target_timestamp_utc
    `);
    return stmt.all(
      upperCode, forecastType, ...rangeArgs(range), modelName, modelName
    ) as ForecastDataPoint[];
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
      AND ${rangeClause('target_timestamp_utc')}
      ${modelClause}
      ${horizonClause}
    GROUP BY ${groupByClause}
    ORDER BY timestamp
  `);
  return stmt.all(
    upperCode, forecastType, ...rangeArgs(range), modelName
  ) as ForecastDataPoint[];
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
  const range = timestampRange(start, end);

  // Map forecast type to actual data table and column.
  //
  // These column names are interpolated straight into the SELECT below, so a
  // name that does not exist on the table is not a wrong number — better-sqlite3
  // throws at prepare() and the request 500s. `renewable` named `total_mw` and
  // `hydro_total` named `hydro_mw`; neither exists on `energy_renewable`, whose
  // columns are `total_renewable_mw` and the `hydro_run_mw`/`hydro_reservoir_mw`
  // pair. Kept identical to the mapping every other consumer already uses
  // (`mlForecastService.ts:20-29`, `crossCountryMetricsService.ts:19-28`) so the
  // three cannot drift apart again.
  //
  // The hydro sum is deliberately not COALESCE'd to 0: if either component is
  // NULL the total is unknown, and `NULL + 30` reading as 30 would invent a
  // measurement.
  const tableMapping: Record<string, { table: string; column: string }> = {
    load: { table: 'energy_load', column: 'load_mw' },
    price: { table: 'energy_price', column: 'price_eur_mwh' },
    renewable: { table: 'energy_renewable', column: 'total_renewable_mw' },
    solar: { table: 'energy_renewable', column: 'solar_mw' },
    wind_onshore: { table: 'energy_renewable', column: 'wind_onshore_mw' },
    wind_offshore: { table: 'energy_renewable', column: 'wind_offshore_mw' },
    hydro_total: { table: 'energy_renewable', column: 'hydro_run_mw + hydro_reservoir_mw' },
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
      AND ${rangeClause('target_timestamp_utc')}
    ORDER BY target_timestamp_utc
  `);
  const forecasts = forecastStmt.all(upperCode, forecastType, ...rangeArgs(range));

  // Get actuals
  //
  // `loadActualGuard` and not a bare `> 0`: this query is generic over forecast
  // type, and a `0.0` is impossible only for `load`. It is completely ordinary
  // for `solar` overnight, for `wind_*` in still air, and for a `price` hour
  // that cleared at zero — BE's fixture day is negative throughout. A blanket
  // floor here would delete real measurements and bias every renewable metric
  // upward, which is the same defect pointing the other way.
  //
  // This site was the last unguarded `energy_load` read (ABL-262). It is the
  // ABL-60 shape again: measured read-only against prod 2026-08-12, a
  // `?country=MK&type=load` window over 2026-08-01..03 returned 24 actuals of
  // which all 24 were exactly `0` MW, against MK's documented 543-717 MW daily
  // peak — served as real measurements by a live public endpoint that the Load
  // tab already fetches on every render.
  const actualStmt = db.prepare(`
    SELECT
      timestamp_utc as timestamp,
      ${mapping.column} as value
    FROM ${mapping.table}
    WHERE country_code = ?
      AND ${rangeClause('timestamp_utc')}
      ${loadActualGuard(forecastType, mapping.column)}
    ORDER BY timestamp_utc
  `);
  const actuals = actualStmt.all(upperCode, ...rangeArgs(range));

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
  const range = timestampRange(start, end);

  // Get D+1 forecasts (horizon 0-30 hours)
  const d1Stmt = db.prepare(`
    SELECT
      target_timestamp_utc as timestamp,
      forecast_value as value
    FROM forecasts f1
    WHERE country_code = ?
      AND forecast_type = ?
      AND ${rangeClause('target_timestamp_utc')}
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
  const d1Data = d1Stmt.all(upperCode, forecastType, ...rangeArgs(range)) as Array<{ timestamp: string; value: number }>;

  // Get D+2 forecasts (horizon 24-54 hours)
  const d2Stmt = db.prepare(`
    SELECT
      target_timestamp_utc as timestamp,
      forecast_value as value
    FROM forecasts f1
    WHERE country_code = ?
      AND forecast_type = ?
      AND ${rangeClause('target_timestamp_utc')}
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
  const d2Data = d2Stmt.all(upperCode, forecastType, ...rangeArgs(range)) as Array<{ timestamp: string; value: number }>;

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
