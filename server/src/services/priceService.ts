import db from '../config/database.js';
import { PriceDataPoint, PriceStats, Granularity } from '../types/index.js';
import { normalizeTimestamp } from '../utils/timestamp.js';

export function getPriceData(
  countryCode: string,
  start: string,
  end: string,
  granularity: Granularity = 'hourly'
): PriceDataPoint[] {
  const upperCode = countryCode.toUpperCase();
  const normalizedStart = normalizeTimestamp(start);
  const normalizedEnd = normalizeTimestamp(end);

  if (granularity === 'hourly') {
    const stmt = db.prepare(`
      SELECT
        timestamp_utc as timestamp,
        ROUND(price_eur_mwh, 2) as price
      FROM energy_price
      WHERE country_code = ?
        AND timestamp_utc BETWEEN ? AND ?
      ORDER BY timestamp_utc
    `);
    return stmt.all(upperCode, normalizedStart, normalizedEnd) as PriceDataPoint[];
  }

  // Aggregated queries
  const groupByClause = getGroupByClause(granularity);
  const stmt = db.prepare(`
    SELECT
      ${groupByClause} as timestamp,
      ROUND(AVG(price_eur_mwh), 2) as price
    FROM energy_price
    WHERE country_code = ?
      AND timestamp_utc BETWEEN ? AND ?
    GROUP BY ${groupByClause}
    ORDER BY timestamp
  `);
  return stmt.all(upperCode, normalizedStart, normalizedEnd) as PriceDataPoint[];
}

export function getLatestPrices(countryCode?: string) {
  if (countryCode) {
    const stmt = db.prepare(`
      SELECT
        e.country_code,
        c.country_name,
        e.timestamp_utc as timestamp,
        ROUND(e.price_eur_mwh, 2) as price
      FROM energy_price e
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
      ROUND(e.price_eur_mwh, 2) as price
    FROM energy_price e
    JOIN countries c ON e.country_code = c.country_code
    WHERE e.timestamp_utc = (
      SELECT MAX(timestamp_utc)
      FROM energy_price
      WHERE country_code = e.country_code
    )
    ORDER BY c.country_name
  `);
  return stmt.all();
}

export function getPriceStats(
  countryCode: string,
  start: string,
  end: string
): PriceStats {
  const upperCode = countryCode.toUpperCase();
  const normalizedStart = normalizeTimestamp(start);
  const normalizedEnd = normalizeTimestamp(end);

  const stmt = db.prepare(`
    SELECT
      ROUND(AVG(price_eur_mwh), 2) as avg,
      ROUND(MIN(price_eur_mwh), 2) as min,
      ROUND(MAX(price_eur_mwh), 2) as max
    FROM energy_price
    WHERE country_code = ?
      AND timestamp_utc BETWEEN ? AND ?
  `);
  const stats = stmt.get(upperCode, normalizedStart, normalizedEnd) as { avg: number; min: number; max: number };

  // Get current (latest) price
  const currentStmt = db.prepare(`
    SELECT ROUND(price_eur_mwh, 2) as current
    FROM energy_price
    WHERE country_code = ?
    ORDER BY timestamp_utc DESC
    LIMIT 1
  `);
  const current = currentStmt.get(upperCode) as { current: number } | undefined;

  return {
    avg: stats?.avg ?? 0,
    min: stats?.min ?? 0,
    max: stats?.max ?? 0,
    current: current?.current ?? 0,
  };
}

export function getPriceHeatmap(countryCode: string, days: number = 30) {
  const upperCode = countryCode.toUpperCase();

  // Get hourly average prices by day of week and hour
  const stmt = db.prepare(`
    SELECT
      CAST(strftime('%w', timestamp_utc) AS INTEGER) as day_of_week,
      CAST(strftime('%H', timestamp_utc) AS INTEGER) as hour,
      ROUND(AVG(price_eur_mwh), 2) as avg_price,
      COUNT(*) as data_points
    FROM energy_price
    WHERE country_code = ?
      AND timestamp_utc >= datetime('now', '-' || ? || ' days')
    GROUP BY day_of_week, hour
    ORDER BY day_of_week, hour
  `);

  const rawData = stmt.all(upperCode, days) as Array<{
    day_of_week: number;
    hour: number;
    avg_price: number;
    data_points: number;
  }>;

  // Create a 7x24 matrix
  const heatmapData: Array<{ day: number; hour: number; price: number }> = [];
  for (const row of rawData) {
    heatmapData.push({
      day: row.day_of_week,
      hour: row.hour,
      price: row.avg_price,
    });
  }

  return heatmapData;
}

export function getPriceComparison(
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
      ROUND(AVG(price_eur_mwh), 2) as avg_price
    FROM energy_price
    WHERE country_code IN (${placeholders})
      AND timestamp_utc BETWEEN ? AND ?
    GROUP BY ${groupByClause}, country_code
    ORDER BY date, country_code
  `);

  const rawData = stmt.all(...upperCodes, normalizedStart, normalizedEnd) as Array<{
    date: string;
    country_code: string;
    avg_price: number;
  }>;

  // Pivot the data to have countries as columns
  const pivoted = new Map<string, Record<string, number>>();
  for (const row of rawData) {
    if (!pivoted.has(row.date)) {
      pivoted.set(row.date, { date: row.date } as unknown as Record<string, number>);
    }
    const entry = pivoted.get(row.date)!;
    entry[row.country_code] = row.avg_price;
  }

  return Array.from(pivoted.values());
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
