import db from '../config/database.js';
import { DashboardOverview, MapDataPoint, MetricType, TimeRange } from '../types/index.js';
import { normalizeTimestamp } from '../utils/timestamp.js';
import { getRenewableShare, RENEWABLE_MW_SUM, TOTAL_POSITIVE_MW_SUM } from './generationService.js';

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

/** Explicit window, when the caller has one, instead of deriving from the `TimeRange` enum. */
interface DateRange {
  start: string;
  end: string;
}

export function getDashboardOverview(
  countryCode: string,
  timeRange: TimeRange = '7d',
  range?: DateRange
): DashboardOverview {
  const upperCode = countryCode.toUpperCase();
  const { start: rawStart, end: rawEnd } = range ?? getTimeRangeDates(timeRange);
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

  // Renewable share - the same generationService.getRenewableShare every
  // other "Renewable share" figure in the app reads (the Generation tab's
  // donut, the map's renewable_pct choropleth, /renewables/mix and
  // /renewables/percentage). This used to be its own energy_renewable ÷
  // energy_load computation (a different table pair, and a different
  // question - renewable ÷ load, not renewable ÷ generation) and could print
  // a different number than the donut on the same page for the same country.
  // Null - not 0, not a fallback to that old load-based figure - when this
  // country has no energy_generation rows yet (still mid-backfill) or the
  // window's total positive generation is zero/negative.
  const renewablePct = getRenewableShare(upperCode, start, end, db);

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
    renewablePercentage: renewablePct,
    peakDemand: peakResult?.peak_demand ?? null,
    priceChange24h: priceChangeResult?.price_change ?? undefined,
    dataTimestamp: loadResult?.timestamp,
  };
}

export function getMapData(
  metric: MetricType = 'load',
  timeRange: TimeRange = '24h',
  range?: DateRange
): MapDataPoint[] {
  const { start: rawStart, end: rawEnd } = range ?? getTimeRangeDates(timeRange);
  const start = normalizeTimestamp(rawStart);
  const end = normalizeTimestamp(rawEnd);

  switch (metric) {
    case 'load':
      return getMapLoadData(start, end);
    case 'price':
      return getMapPriceData(start, end);
    case 'renewable_pct':
      return getMapRenewableData(start, end);
    case 'net_position':
      return getMapNetPositionData(start, end);
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

/**
 * Average net position per country over the window (MW, positive = exporter).
 *
 * Averaged like the other map metrics, so this reads as "net exporter over
 * this period" rather than at one instant. Intraday sign flips partly cancel,
 * which is why the legend labels it as an average.
 *
 * DE_LU is one bidding zone stored under 'DE', so Luxembourg is forced to
 * Germany's value. LU also carries ~180 rows of its own, which are an ingest
 * artifact from before the zone mapping existed: left alone they rendered LU
 * at -6201 MW next to DE at +355 MW, two contradictory colours for one zone.
 * Overwriting is deliberate - a hole would at least read as missing, but a
 * wrong number reads as fact.
 */
function getMapNetPositionData(start: string, end: string): MapDataPoint[] {
  const stmt = db.prepare(`
    SELECT
      n.country_code,
      c.country_name,
      ROUND(AVG(n.net_position_mw), 0) as value,
      MAX(n.timestamp_utc) as timestamp
    FROM net_position n
    JOIN countries c ON n.country_code = c.country_code
    WHERE n.timestamp_utc BETWEEN ? AND ?
    GROUP BY n.country_code, c.country_name
    ORDER BY c.country_name
  `);
  const rows = stmt.all(start, end) as MapDataPoint[];

  const de = rows.find((r) => r.country_code === 'DE');
  if (!de) return rows;

  const existingLu = rows.find((r) => r.country_code === 'LU');
  if (existingLu) {
    existingLu.value = de.value;
    existingLu.timestamp = de.timestamp;
    return rows;
  }

  const lu = db
    .prepare(`SELECT country_name FROM countries WHERE country_code = 'LU'`)
    .get() as { country_name: string } | undefined;
  if (lu) rows.push({ ...de, country_code: 'LU', country_name: lu.country_name });
  return rows;
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

/**
 * Renewable share per country over the window - energy_generation ÷
 * energy_generation, the same ratio-of-window-sums definition as
 * generationService.getRenewableShare, reusing its exact
 * RENEWABLE_MW_SUM/TOTAL_POSITIVE_MW_SUM fragments so the map can never
 * define "renewable" differently than the header stat or the Generation
 * tab's donut for the same country/window (see generationService.ts). This
 * used to be its own energy_renewable ÷ energy_load computation - a
 * different table pair and a different question.
 *
 * A country with no energy_generation rows in the window (still mid-backfill
 * for 15 of 34 as of the A75 rollout) simply has no group here - HAVING
 * drops a country whose total positive generation is zero/negative too, for
 * the same reason NULLIF makes it NULL in getRenewableShare: a share of
 * nothing is undefined, not 0%. Either way the map already renders an absent
 * country as "no data" (EuropeMap filters `value == null`), never a
 * fabricated reading.
 */
function getMapRenewableData(start: string, end: string): MapDataPoint[] {
  const stmt = db.prepare(`
    SELECT
      g.country_code,
      c.country_name,
      ROUND(SUM${RENEWABLE_MW_SUM} * 100.0 / NULLIF(SUM${TOTAL_POSITIVE_MW_SUM}, 0), 2) as value,
      MAX(g.timestamp_utc) as timestamp
    FROM energy_generation g
    JOIN countries c ON c.country_code = g.country_code
    WHERE g.timestamp_utc BETWEEN ? AND ?
    GROUP BY g.country_code, c.country_name
    HAVING value IS NOT NULL
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
