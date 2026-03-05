import db from '../config/database.js';
import { DashboardOverview, MapDataPoint, MetricType, TimeRange } from '../types/index.js';
import { normalizeTimestamp } from '../utils/timestamp.js';

function getTimeRangeDates(timeRange: TimeRange): { start: string; end: string } {
  const end = new Date().toISOString();
  let start: Date;

  switch (timeRange) {
    case '24h':
      start = new Date(Date.now() - 24 * 60 * 60 * 1000);
      break;
    case '7d':
      start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      break;
    case '30d':
      start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      break;
    case '90d':
      start = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      break;
    case '1y':
      start = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
      break;
    default:
      start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  }

  return { start: start.toISOString(), end };
}

export function getDashboardOverview(
  countryCode: string,
  timeRange: TimeRange = '7d'
): DashboardOverview {
  const upperCode = countryCode.toUpperCase();
  const { start: rawStart, end: rawEnd } = getTimeRangeDates(timeRange);
  const start = normalizeTimestamp(rawStart);
  const end = normalizeTimestamp(rawEnd);

  // Get current load
  const loadStmt = db.prepare(`
    SELECT
      load_mw as current_load,
      timestamp_utc as timestamp
    FROM energy_load
    WHERE country_code = ?
    ORDER BY timestamp_utc DESC
    LIMIT 1
  `);
  const loadResult = loadStmt.get(upperCode) as { current_load: number; timestamp: string } | undefined;

  // Get average price for the period
  const priceStmt = db.prepare(`
    SELECT
      ROUND(AVG(price_eur_mwh), 2) as avg_price
    FROM energy_price
    WHERE country_code = ?
      AND timestamp_utc BETWEEN ? AND ?
  `);
  const priceResult = priceStmt.get(upperCode, start, end) as { avg_price: number } | undefined;

  // Get peak demand for the period
  const peakStmt = db.prepare(`
    SELECT
      ROUND(MAX(load_mw), 2) as peak_demand
    FROM energy_load
    WHERE country_code = ?
      AND timestamp_utc BETWEEN ? AND ?
  `);
  const peakResult = peakStmt.get(upperCode, start, end) as { peak_demand: number } | undefined;

  // Calculate renewable percentage - optimized version
  // Instead of expensive JOIN with date()/strftime(), calculate averages separately
  // This uses indexes efficiently and is much faster
  const renewableAvgStmt = db.prepare(`
    SELECT
      AVG(COALESCE(solar_mw, 0) + COALESCE(wind_onshore_mw, 0) +
          COALESCE(wind_offshore_mw, 0) + COALESCE(hydro_run_mw, 0) +
          COALESCE(hydro_reservoir_mw, 0) + COALESCE(biomass_mw, 0) +
          COALESCE(geothermal_mw, 0) + COALESCE(other_renewable_mw, 0)) as avg_renewable
    FROM energy_renewable
    WHERE country_code = ?
      AND timestamp_utc BETWEEN ? AND ?
  `);
  const loadAvgStmt = db.prepare(`
    SELECT AVG(load_mw) as avg_load
    FROM energy_load
    WHERE country_code = ?
      AND timestamp_utc BETWEEN ? AND ?
  `);
  const renewableAvg = renewableAvgStmt.get(upperCode, start, end) as { avg_renewable: number | null } | undefined;
  const loadAvg = loadAvgStmt.get(upperCode, start, end) as { avg_load: number | null } | undefined;
  
  const renewablePct = (renewableAvg?.avg_renewable && loadAvg?.avg_load && loadAvg.avg_load > 0)
    ? Math.round((renewableAvg.avg_renewable / loadAvg.avg_load) * 1000) / 10
    : null;
  const renewableResult = { renewable_pct: renewablePct };

  // Calculate 24h changes
  const change24hStart = normalizeTimestamp(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
  const change24hMid = normalizeTimestamp(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  const priceChangeStmt = db.prepare(`
    SELECT
      ROUND(AVG(CASE WHEN timestamp_utc >= ? THEN price_eur_mwh END) -
            AVG(CASE WHEN timestamp_utc < ? THEN price_eur_mwh END), 2) as price_change
    FROM energy_price
    WHERE country_code = ?
      AND timestamp_utc BETWEEN ? AND datetime('now')
  `);
  const priceChangeResult = priceChangeStmt.get(change24hMid, change24hMid, upperCode, change24hStart) as { price_change: number | null } | undefined;

  return {
    currentLoad: loadResult?.current_load ?? null,
    avgPrice: priceResult?.avg_price ?? null,
    renewablePercentage: renewableResult?.renewable_pct ?? null,
    peakDemand: peakResult?.peak_demand ?? null,
    priceChange24h: priceChangeResult?.price_change ?? undefined,
    dataTimestamp: loadResult?.timestamp,
  };
}

export function getMapData(
  metric: MetricType = 'load',
  timeRange: TimeRange = '24h'
): MapDataPoint[] {
  const { start: rawStart, end: rawEnd } = getTimeRangeDates(timeRange);
  const start = normalizeTimestamp(rawStart);
  const end = normalizeTimestamp(rawEnd);

  switch (metric) {
    case 'load':
      return getMapLoadData(start, end);
    case 'price':
      return getMapPriceData(start, end);
    case 'renewable_pct':
      return getMapRenewableData(start, end);
    default:
      return getMapLoadData(start, end);
  }
}

function getMapLoadData(start: string, end: string): MapDataPoint[] {
  const stmt = db.prepare(`
    SELECT
      l.country_code,
      c.country_name,
      ROUND(AVG(l.load_mw), 0) as value,
      MAX(l.timestamp_utc) as timestamp
    FROM energy_load l
    JOIN countries c ON l.country_code = c.country_code
    WHERE l.timestamp_utc BETWEEN ? AND ?
    GROUP BY l.country_code, c.country_name
    ORDER BY c.country_name
  `);
  return stmt.all(start, end) as MapDataPoint[];
}

function getMapPriceData(start: string, end: string): MapDataPoint[] {
  const stmt = db.prepare(`
    SELECT
      p.country_code,
      c.country_name,
      ROUND(AVG(p.price_eur_mwh), 2) as value,
      MAX(p.timestamp_utc) as timestamp
    FROM energy_price p
    JOIN countries c ON p.country_code = c.country_code
    WHERE p.timestamp_utc BETWEEN ? AND ?
    GROUP BY p.country_code, c.country_name
    ORDER BY c.country_name
  `);
  return stmt.all(start, end) as MapDataPoint[];
}

function getMapRenewableData(start: string, end: string): MapDataPoint[] {
  const stmt = db.prepare(`
    SELECT
      r.country_code,
      c.country_name,
      ROUND(
        AVG(
          (COALESCE(r.solar_mw, 0) + COALESCE(r.wind_onshore_mw, 0) +
           COALESCE(r.wind_offshore_mw, 0) + COALESCE(r.hydro_run_mw, 0) +
           COALESCE(r.hydro_reservoir_mw, 0) + COALESCE(r.biomass_mw, 0) +
           COALESCE(r.geothermal_mw, 0) + COALESCE(r.other_renewable_mw, 0)) * 100.0 / NULLIF(l.load_mw, 0)
        ), 1
      ) as value,
      MAX(r.timestamp_utc) as timestamp
    FROM energy_renewable r
    JOIN countries c ON r.country_code = c.country_code
    JOIN energy_load l ON r.country_code = l.country_code
      AND date(r.timestamp_utc) = date(l.timestamp_utc)
      AND strftime('%H', r.timestamp_utc) = strftime('%H', l.timestamp_utc)
    WHERE r.timestamp_utc BETWEEN ? AND ?
    GROUP BY r.country_code, c.country_name
    ORDER BY c.country_name
  `);
  return stmt.all(start, end) as MapDataPoint[];
}

export function getCombinedTimeseries(
  countryCode: string,
  start: string,
  end: string
) {
  const upperCode = countryCode.toUpperCase();
  const normalizedStart = normalizeTimestamp(start);
  const normalizedEnd = normalizeTimestamp(end);

  // Get load data
  const loadStmt = db.prepare(`
    SELECT
      date(timestamp_utc) as date,
      ROUND(AVG(load_mw), 2) as load
    FROM energy_load
    WHERE country_code = ?
      AND timestamp_utc BETWEEN ? AND ?
    GROUP BY date(timestamp_utc)
    ORDER BY date
  `);
  const loadData = loadStmt.all(upperCode, normalizedStart, normalizedEnd) as Array<{ date: string; load: number }>;

  // Get price data
  const priceStmt = db.prepare(`
    SELECT
      date(timestamp_utc) as date,
      ROUND(AVG(price_eur_mwh), 2) as price
    FROM energy_price
    WHERE country_code = ?
      AND timestamp_utc BETWEEN ? AND ?
    GROUP BY date(timestamp_utc)
    ORDER BY date
  `);
  const priceData = priceStmt.all(upperCode, normalizedStart, normalizedEnd) as Array<{ date: string; price: number }>;

  // Get renewable data
  const renewableStmt = db.prepare(`
    SELECT
      date(timestamp_utc) as date,
      ROUND(AVG(COALESCE(solar_mw, 0)), 2) as solar,
      ROUND(AVG(COALESCE(wind_onshore_mw, 0)), 2) as wind_onshore,
      ROUND(AVG(COALESCE(wind_offshore_mw, 0)), 2) as wind_offshore,
      ROUND(AVG(COALESCE(hydro_mw, 0)), 2) as hydro,
      ROUND(AVG(COALESCE(biomass_mw, 0)), 2) as biomass,
      ROUND(AVG(COALESCE(geothermal_mw, 0)), 2) as geothermal
    FROM energy_renewable
    WHERE country_code = ?
      AND timestamp_utc BETWEEN ? AND ?
    GROUP BY date(timestamp_utc)
    ORDER BY date
  `);
  interface RenewableRow {
    date: string;
    solar: number;
    wind_onshore: number;
    wind_offshore: number;
    hydro: number;
    biomass: number;
    geothermal: number;
  }
  const renewableData = renewableStmt.all(upperCode, normalizedStart, normalizedEnd) as RenewableRow[];

  // Merge data by date
  const mergedMap = new Map<string, Record<string, unknown>>();

  for (const row of loadData) {
    mergedMap.set(row.date, { date: row.date, load: row.load });
  }

  for (const row of priceData) {
    const existing = mergedMap.get(row.date) || { date: row.date };
    mergedMap.set(row.date, { ...existing, price: row.price });
  }

  for (const row of renewableData) {
    const existing = mergedMap.get(row.date) || { date: row.date };
    mergedMap.set(row.date, { ...existing, ...row });
  }

  return Array.from(mergedMap.values()).sort((a, b) =>
    (a.date as string).localeCompare(b.date as string)
  );
}
