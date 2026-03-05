import db from '../config/database.js';
import { LoadDataPoint, AggregatedLoad, Granularity } from '../types/index.js';
import { normalizeTimestamp } from '../utils/timestamp.js';

export function getLoadData(
  countryCode: string,
  start: string,
  end: string,
  granularity: Granularity = 'hourly'
): LoadDataPoint[] | AggregatedLoad[] {
  const upperCode = countryCode.toUpperCase();
  const normalizedStart = normalizeTimestamp(start);
  const normalizedEnd = normalizeTimestamp(end);

  if (granularity === 'hourly') {
    const stmt = db.prepare(`
      SELECT
        REPLACE(timestamp_utc, ' ', 'T') as timestamp,
        load_mw as load,
        data_quality as quality
      FROM energy_load
      WHERE country_code = ?
        AND timestamp_utc BETWEEN ? AND ?
      ORDER BY timestamp_utc
    `);
    return stmt.all(upperCode, normalizedStart, normalizedEnd) as LoadDataPoint[];
  }

  // Aggregated queries
  const groupByClause = getGroupByClause(granularity);
  const stmt = db.prepare(`
    SELECT
      ${groupByClause} as date,
      ROUND(AVG(load_mw), 2) as avg_load,
      ROUND(MAX(load_mw), 2) as max_load,
      ROUND(MIN(load_mw), 2) as min_load
    FROM energy_load
    WHERE country_code = ?
      AND timestamp_utc BETWEEN ? AND ?
    GROUP BY ${groupByClause}
    ORDER BY date
  `);
  return stmt.all(upperCode, normalizedStart, normalizedEnd) as AggregatedLoad[];
}

export function getLatestLoad(countryCode?: string) {
  if (countryCode) {
    const stmt = db.prepare(`
      SELECT
        e.country_code,
        c.country_name,
        e.timestamp_utc as timestamp,
        e.load_mw as load,
        e.data_quality as quality
      FROM energy_load e
      JOIN countries c ON e.country_code = c.country_code
      WHERE e.country_code = ?
      ORDER BY e.timestamp_utc DESC
      LIMIT 1
    `);
    return stmt.get(countryCode.toUpperCase());
  }

  // Get latest for all countries
  const stmt = db.prepare(`
    SELECT
      e.country_code,
      c.country_name,
      e.timestamp_utc as timestamp,
      e.load_mw as load,
      e.data_quality as quality
    FROM energy_load e
    JOIN countries c ON e.country_code = c.country_code
    WHERE e.timestamp_utc = (
      SELECT MAX(timestamp_utc)
      FROM energy_load
      WHERE country_code = e.country_code
    )
    ORDER BY c.country_name
  `);
  return stmt.all();
}

export function getLoadComparison(
  countries: string[],
  start: string,
  end: string,
  granularity: Granularity = 'daily'
) {
  const upperCodes = countries.map(c => c.toUpperCase());
  const placeholders = upperCodes.map(() => '?').join(',');
  const groupByClause = getGroupByClause(granularity);
  const normalizedStart = normalizeTimestamp(start);
  const normalizedEnd = normalizeTimestamp(end);

  const stmt = db.prepare(`
    SELECT
      ${groupByClause} as date,
      country_code,
      ROUND(AVG(load_mw), 2) as avg_load
    FROM energy_load
    WHERE country_code IN (${placeholders})
      AND timestamp_utc BETWEEN ? AND ?
    GROUP BY ${groupByClause}, country_code
    ORDER BY date, country_code
  `);

  const rawData = stmt.all(...upperCodes, normalizedStart, normalizedEnd) as Array<{
    date: string;
    country_code: string;
    avg_load: number;
  }>;

  // Pivot the data to have countries as columns
  const pivoted = new Map<string, Record<string, number>>();
  for (const row of rawData) {
    if (!pivoted.has(row.date)) {
      pivoted.set(row.date, { date: row.date } as unknown as Record<string, number>);
    }
    const entry = pivoted.get(row.date)!;
    entry[row.country_code] = row.avg_load;
  }

  return Array.from(pivoted.values());
}

export function getLoadStats(countryCode: string, start: string, end: string) {
  const normalizedStart = normalizeTimestamp(start);
  const normalizedEnd = normalizeTimestamp(end);
  const stmt = db.prepare(`
    SELECT
      ROUND(AVG(load_mw), 2) as avg_load,
      ROUND(MAX(load_mw), 2) as max_load,
      ROUND(MIN(load_mw), 2) as min_load,
      COUNT(*) as data_points
    FROM energy_load
    WHERE country_code = ?
      AND timestamp_utc BETWEEN ? AND ?
  `);
  return stmt.get(countryCode.toUpperCase(), normalizedStart, normalizedEnd);
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
