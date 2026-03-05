import db from '../config/database.js';
import { RenewableMix, RenewableTimeSeriesPoint, Granularity } from '../types/index.js';
import { normalizeTimestamp } from '../utils/timestamp.js';

export function getRenewableData(
  countryCode: string,
  start: string,
  end: string,
  granularity: Granularity = 'daily'
): RenewableTimeSeriesPoint[] {
  const upperCode = countryCode.toUpperCase();
  const normalizedStart = normalizeTimestamp(start);
  const normalizedEnd = normalizeTimestamp(end);
  const groupByClause = getGroupByClause(granularity);

  const stmt = db.prepare(`
    SELECT
      ${groupByClause} as timestamp,
      ROUND(AVG(COALESCE(solar_mw, 0)), 2) as solar,
      ROUND(AVG(COALESCE(wind_onshore_mw, 0)), 2) as wind_onshore,
      ROUND(AVG(COALESCE(wind_offshore_mw, 0)), 2) as wind_offshore,
      ROUND(AVG(COALESCE(hydro_run_mw, 0) + COALESCE(hydro_reservoir_mw, 0)), 2) as hydro,
      ROUND(AVG(COALESCE(biomass_mw, 0)), 2) as biomass,
      ROUND(AVG(COALESCE(geothermal_mw, 0)), 2) as geothermal,
      ROUND(AVG(COALESCE(other_renewable_mw, 0)), 2) as other
    FROM energy_renewable
    WHERE country_code = ?
      AND timestamp_utc BETWEEN ? AND ?
    GROUP BY ${groupByClause}
    ORDER BY timestamp
  `);

  return stmt.all(upperCode, normalizedStart, normalizedEnd) as RenewableTimeSeriesPoint[];
}

export function getRenewableMix(
  countryCode: string,
  start: string,
  end: string
): RenewableMix {
  const upperCode = countryCode.toUpperCase();
  const normalizedStart = normalizeTimestamp(start);
  const normalizedEnd = normalizeTimestamp(end);

  const stmt = db.prepare(`
    SELECT
      ROUND(AVG(COALESCE(solar_mw, 0)), 2) as solar,
      ROUND(AVG(COALESCE(wind_onshore_mw, 0)), 2) as wind_onshore,
      ROUND(AVG(COALESCE(wind_offshore_mw, 0)), 2) as wind_offshore,
      ROUND(AVG(COALESCE(hydro_run_mw, 0) + COALESCE(hydro_reservoir_mw, 0)), 2) as hydro,
      ROUND(AVG(COALESCE(biomass_mw, 0)), 2) as biomass,
      ROUND(AVG(COALESCE(geothermal_mw, 0)), 2) as geothermal,
      ROUND(AVG(COALESCE(other_renewable_mw, 0)), 2) as other
    FROM energy_renewable
    WHERE country_code = ?
      AND timestamp_utc BETWEEN ? AND ?
  `);

  const data = stmt.get(upperCode, normalizedStart, normalizedEnd) as RenewableMix | undefined;

  if (!data) {
    return {
      solar: 0,
      wind_onshore: 0,
      wind_offshore: 0,
      hydro: 0,
      biomass: 0,
      geothermal: 0,
      other: 0,
      total: 0,
    };
  }

  const total =
    data.solar +
    data.wind_onshore +
    data.wind_offshore +
    data.hydro +
    data.biomass +
    data.geothermal +
    data.other;

  return { ...data, total };
}

export function getLatestRenewable(countryCode?: string) {
  if (countryCode) {
    const stmt = db.prepare(`
      SELECT
        r.country_code,
        c.country_name,
        r.timestamp_utc as timestamp,
        ROUND(COALESCE(r.solar_mw, 0), 2) as solar,
        ROUND(COALESCE(r.wind_onshore_mw, 0), 2) as wind_onshore,
        ROUND(COALESCE(r.wind_offshore_mw, 0), 2) as wind_offshore,
        ROUND(COALESCE(r.hydro_run_mw, 0) + COALESCE(r.hydro_reservoir_mw, 0), 2) as hydro,
        ROUND(COALESCE(r.biomass_mw, 0), 2) as biomass,
        ROUND(COALESCE(r.geothermal_mw, 0), 2) as geothermal,
        ROUND(COALESCE(r.other_renewable_mw, 0), 2) as other
      FROM energy_renewable r
      JOIN countries c ON r.country_code = c.country_code
      WHERE r.country_code = ?
      ORDER BY r.timestamp_utc DESC
      LIMIT 1
    `);
    return stmt.get(countryCode.toUpperCase());
  }

  // Get latest for all countries
  const stmt = db.prepare(`
    SELECT
      r.country_code,
      c.country_name,
      r.timestamp_utc as timestamp,
      ROUND(COALESCE(r.solar_mw, 0) + COALESCE(r.wind_onshore_mw, 0) +
            COALESCE(r.wind_offshore_mw, 0) + COALESCE(r.hydro_run_mw, 0) +
            COALESCE(r.hydro_reservoir_mw, 0) + COALESCE(r.biomass_mw, 0) +
            COALESCE(r.geothermal_mw, 0) + COALESCE(r.other_renewable_mw, 0), 2) as total_renewable
    FROM energy_renewable r
    JOIN countries c ON r.country_code = c.country_code
    WHERE r.timestamp_utc = (
      SELECT MAX(timestamp_utc)
      FROM energy_renewable
      WHERE country_code = r.country_code
    )
    ORDER BY c.country_name
  `);
  return stmt.all();
}

export function getRenewablePercentage(countryCode: string, start: string, end: string): number | null {
  const upperCode = countryCode.toUpperCase();
  const normalizedStart = normalizeTimestamp(start);
  const normalizedEnd = normalizeTimestamp(end);

  // Use the pre-built view if available, otherwise calculate
  const stmt = db.prepare(`
    SELECT
      ROUND(
        AVG(
          (COALESCE(r.solar_mw, 0) + COALESCE(r.wind_onshore_mw, 0) +
           COALESCE(r.wind_offshore_mw, 0) + COALESCE(r.hydro_run_mw, 0) +
           COALESCE(r.hydro_reservoir_mw, 0) + COALESCE(r.biomass_mw, 0) +
           COALESCE(r.geothermal_mw, 0) + COALESCE(r.other_renewable_mw, 0)) * 100.0 / NULLIF(l.load_mw, 0)
        ), 2
      ) as renewable_pct
    FROM energy_renewable r
    JOIN energy_load l ON r.country_code = l.country_code
      AND date(r.timestamp_utc) = date(l.timestamp_utc)
      AND strftime('%H', r.timestamp_utc) = strftime('%H', l.timestamp_utc)
    WHERE r.country_code = ?
      AND r.timestamp_utc BETWEEN ? AND ?
  `);

  const result = stmt.get(upperCode, normalizedStart, normalizedEnd) as { renewable_pct: number | null } | undefined;
  return result?.renewable_pct ?? null;
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
      // Use 'T' separator for ISO 8601 format consistency with TSO forecasts
      return "REPLACE(timestamp_utc, ' ', 'T')";
  }
}
