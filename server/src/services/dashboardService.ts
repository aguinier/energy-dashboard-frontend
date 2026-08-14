import db from '../config/database.js';
import { DashboardOverview, MapDataPoint, MetricType, TimeRange } from '../types/index.js';
import {
  normalizeTimestamp,
  timestampRange,
  rangeClause,
  rangeArgs,
  toIsoUtc,
  type TimestampRange,
} from '../utils/timestamp.js';
import {
  getRenewableShare,
  generationGroupByClause,
  RENEWABLE_MW_SUM,
  TOTAL_POSITIVE_MW_SUM,
} from './generationService.js';
import { measuredLoadClause } from './loadQuality.js';
import { RENEWABLE_COMPONENTS, nullAwareSumSql, WINDOW_AVERAGE } from './renewableTotal.js';

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
  const bounds = timestampRange(rawStart, rawEnd);

  // Latest measured load, deliberately *not* bounded to [start, end] the way
  // its price/peak/renewable siblings below are.
  //
  // Bounding it looks like the obvious fix for the stale-tile incident
  // (ABL-58: GB's freshest row is 2021-06-14, five years old, and the tile
  // printed 37.27 GW under the label "CURRENT LOAD"). It is not: `TimePicker`
  // exposes the forward presets (`next24h`/`next7d`), and
  // `getDateRangeForPreset` starts those windows at now, so a windowed query
  // returns nothing for *every* country the moment the user looks forward -
  // trading one country's wrong number for all 34 countries' missing one.
  //
  // It is still filtered by `measuredLoadClause()` (ABL-35), so "the latest
  // measurement we hold" excludes the impossible exact-0.0 placeholder rows.
  //
  // So this stays "the latest measurement we hold", and `dataTimestamp` below
  // carries its age so the client can disclose or withhold it
  // (client/src/lib/readingFreshness.ts). The number and its age travel
  // together; neither is useful alone.
  const loadStmt = db.prepare(`
    SELECT
      load_mw as current_load,
      timestamp_utc as timestamp
    FROM energy_load
    WHERE country_code = ?
      AND ${measuredLoadClause()}
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
      AND ${rangeClause('timestamp_utc')}
  `);
  const priceResult = priceStmt.get(upperCode, ...rangeArgs(bounds)) as { avg_price: number } | undefined;

  // Get peak demand for the period
  const peakStmt = db.prepare(`
    SELECT
      ROUND(MAX(load_mw), 2) as peak_demand
    FROM energy_load
    WHERE country_code = ?
      AND ${measuredLoadClause()}
      AND ${rangeClause('timestamp_utc')}
  `);
  const peakResult = peakStmt.get(upperCode, ...rangeArgs(bounds)) as { peak_demand: number } | undefined;

  // Renewable share - the same generationService.getRenewableShare every
  // other "Renewable share" figure in the app reads (the Generation tab's
  // donut, the map's renewable_pct choropleth, /renewables/mix and
  // /renewables/percentage). This used to be its own energy_renewable ÷
  // energy_load computation (a different table pair, and a different
  // question - renewable ÷ load, not renewable ÷ generation) and could print
  // a different number than the donut on the same page for the same country.
  // Null - not 0, not a fallback to that old load-based figure - when this
  // country has no energy_generation rows in the window (a window predating
  // its ingest, or a country ENTSO-E does not currently publish) or the
  // window's total positive generation is zero/negative.
  const renewablePct = getRenewableShare(upperCode, rawStart, rawEnd, db);

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
    // Timestamps `currentLoad` specifically (it is that row's own
    // `timestamp_utc`), not the response as a whole. Emitted as an
    // unambiguous ISO-8601 UTC instant - the raw column is UTC but does not
    // say so, and comes in two shapes; see toIsoUtc.
    dataTimestamp: toIsoUtc(loadResult?.timestamp),
  };
}

export function getMapData(
  metric: MetricType = 'load',
  timeRange: TimeRange = '24h',
  range?: DateRange
): MapDataPoint[] {
  const { start: rawStart, end: rawEnd } = range ?? getTimeRangeDates(timeRange);
  const bounds = timestampRange(rawStart, rawEnd);

  switch (metric) {
    case 'load':
      return getMapLoadData(bounds);
    case 'price':
      return getMapPriceData(bounds);
    case 'renewable_pct':
      return getMapRenewableData(bounds);
    case 'net_position':
      return getMapNetPositionData(bounds);
    default:
      return getMapLoadData(bounds);
  }
}

function getMapLoadData(range: TimestampRange): MapDataPoint[] {
  const stmt = db.prepare(`
    SELECT
      l.country_code,
      c.country_name,
      ROUND(AVG(l.load_mw), 0) as value,
      MAX(l.timestamp_utc) as timestamp
    FROM energy_load l
    JOIN countries c ON l.country_code = c.country_code
    WHERE ${measuredLoadClause('l.load_mw')}
      AND ${rangeClause('l.timestamp_utc')}
    GROUP BY l.country_code, c.country_name
    ORDER BY c.country_name
  `);
  return stmt.all(...rangeArgs(range)) as MapDataPoint[];
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
function getMapNetPositionData(range: TimestampRange): MapDataPoint[] {
  const stmt = db.prepare(`
    SELECT
      n.country_code,
      c.country_name,
      ROUND(AVG(n.net_position_mw), 0) as value,
      MAX(n.timestamp_utc) as timestamp
    FROM net_position n
    JOIN countries c ON n.country_code = c.country_code
    WHERE ${rangeClause('n.timestamp_utc')}
    GROUP BY n.country_code, c.country_name
    ORDER BY c.country_name
  `);
  const rows = stmt.all(...rangeArgs(range)) as MapDataPoint[];

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

function getMapPriceData(range: TimestampRange): MapDataPoint[] {
  const stmt = db.prepare(`
    SELECT
      p.country_code,
      c.country_name,
      ROUND(AVG(p.price_eur_mwh), 2) as value,
      MAX(p.timestamp_utc) as timestamp
    FROM energy_price p
    JOIN countries c ON p.country_code = c.country_code
    WHERE ${rangeClause('p.timestamp_utc')}
    GROUP BY p.country_code, c.country_name
    ORDER BY c.country_name
  `);
  return stmt.all(...rangeArgs(range)) as MapDataPoint[];
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
 * A country with no energy_generation rows in the window simply has no group
 * here. The A75 backfill has since finished - all 34 countries carry rows,
 * 33 of them back to 2021-01-01 - so the remaining case is a country ENTSO-E
 * stopped publishing: measured 2026-08-04, AL is the only one (nothing after
 * 2026-06-23), and it drops out of every window the UI can reach. HAVING
 * drops a country whose total positive generation is zero/negative too, for
 * the same reason NULLIF makes it NULL in getRenewableShare: a share of
 * nothing is undefined, not 0%. Either way the map already renders an absent
 * country as "no data" (EuropeMap filters `value == null`), never a
 * fabricated reading.
 */
function getMapRenewableData(range: TimestampRange): MapDataPoint[] {
  const stmt = db.prepare(`
    SELECT
      g.country_code,
      c.country_name,
      ROUND(SUM${RENEWABLE_MW_SUM} * 100.0 / NULLIF(SUM${TOTAL_POSITIVE_MW_SUM}, 0), 2) as value,
      MAX(g.timestamp_utc) as timestamp
    FROM energy_generation g
    JOIN countries c ON c.country_code = g.country_code
    WHERE ${rangeClause('g.timestamp_utc')}
    GROUP BY g.country_code, c.country_name
    HAVING value IS NOT NULL
    ORDER BY c.country_name
  `);
  return stmt.all(...rangeArgs(range)) as MapDataPoint[];
}

/**
 * The six renewable fields `/dashboard/timeseries` has always served. It is
 * `renewableTotal.RENEWABLE_FIELDS` minus `other`, and stays that way
 * deliberately: `other` (marine + other renewable) is part of the `/renewables`
 * contract, not this one, and adding a seventh key here would be a wire change
 * nobody asked for. Naming them as a subset of the shared map rather than
 * re-listing columns is what keeps this endpoint's idea of "solar" or "hydro"
 * from drifting away from `/renewables`' — the second-mapping failure ABL-324
 * exists to prevent.
 */
const TIMESERIES_RENEWABLE_FIELDS = [
  'solar',
  'wind_onshore',
  'wind_offshore',
  'hydro',
  'biomass',
  'geothermal',
] as const satisfies ReadonlyArray<keyof typeof RENEWABLE_COMPONENTS>;

/** Shared with `getGenerationSeries`, so the two cannot bucket a day differently. */
const TIMESERIES_BUCKET = generationGroupByClause('daily');

const TIMESERIES_RENEWABLE_SELECTS = TIMESERIES_RENEWABLE_FIELDS.map((field) =>
  nullAwareSumSql(RENEWABLE_COMPONENTS[field], field, WINDOW_AVERAGE)
).join(',\n      ');

/**
 * Load, price and renewable output merged onto one row per day.
 *
 * ## The renewable leg reads `energy_generation` (ABL-324, tranche 2 of 3)
 *
 * It used to read the frozen `energy_renewable`, and it `AVG()`s over a
 * `date()` bucket — which is the worst thing to do to a table that stores one
 * instant under several timestamp spellings. A duplicated hour contributed
 * both of its disagreeing values to one mean, so the rendered daily point
 * equalled neither stored reading. Measured on the replica 2026-08-13, the
 * inflation is 34,440 rows table-wide and is not evenly spread: **BA holds
 * 65,868 rows for 48,766 distinct instants** (26% duplicated), against
 * **0 duplicate instants across `energy_generation`'s 3,178,270 rows**.
 *
 * ## `COALESCE(x, 0)` is gone, and every field is now `number | null`
 *
 * The old query wrapped all six columns in `COALESCE(…, 0)`, so a type a
 * country does not report was served as a confident `0 MW`. That was not
 * theoretical: `energy_renewable` carries `DEFAULT 0`, and measured on the
 * replica 2026-08-13, Germany's newest row (`2026-08-12 13:00:00`) stores
 * `solar_mw = 0`, `wind_onshore_mw = 0`, `total_renewable_mw = 0` where
 * `energy_generation`'s row for the same instant holds NULL in every column —
 * a leading-edge A75 document that has not been filled in yet. The sum rule
 * is `renewableTotal.nullAwareSumSql`, shared with `/renewables`, so `hydro`
 * is NULL only when run-of-river *and* reservoir are both unreported and not
 * when one of the two is.
 *
 * ## The FR hole must stay a hole
 *
 * `energy_generation` does not cover every hour `energy_renewable` does:
 * measured 2026-08-13, France holds 2,208 rows across all 23 days of
 * 2026-06-30..2026-07-22 in the frozen table against 135 rows across **2** of
 * them here (ABL-323, ABL-328). Because this query groups, a day with no rows
 * produces no bucket at all and the merge below never invents one — verified
 * on the replica, an FR 30-day window ending 2026-08-12 returns 22 buckets
 * where the frozen table returned 31. Nine absent days, not nine zeros.
 */
export function getCombinedTimeseries(
  countryCode: string,
  start: string,
  end: string
) {
  const upperCode = countryCode.toUpperCase();
  const range = timestampRange(start, end);

  // Get load data
  const loadStmt = db.prepare(`
    SELECT
      date(timestamp_utc) as date,
      ROUND(AVG(load_mw), 2) as load
    FROM energy_load
    WHERE country_code = ?
      AND ${measuredLoadClause()}
      AND ${rangeClause('timestamp_utc')}
    GROUP BY date(timestamp_utc)
    ORDER BY date
  `);
  const loadData = loadStmt.all(upperCode, ...rangeArgs(range)) as Array<{ date: string; load: number }>;

  // Get price data
  const priceStmt = db.prepare(`
    SELECT
      date(timestamp_utc) as date,
      ROUND(AVG(price_eur_mwh), 2) as price
    FROM energy_price
    WHERE country_code = ?
      AND ${rangeClause('timestamp_utc')}
    GROUP BY date(timestamp_utc)
    ORDER BY date
  `);
  const priceData = priceStmt.all(upperCode, ...rangeArgs(range)) as Array<{ date: string; price: number }>;

  // Get renewable data
  const renewableStmt = db.prepare(`
    SELECT
      ${TIMESERIES_BUCKET} as date,
      ${TIMESERIES_RENEWABLE_SELECTS}
    FROM energy_generation
    WHERE country_code = ?
      AND ${rangeClause('timestamp_utc')}
    GROUP BY ${TIMESERIES_BUCKET}
    ORDER BY date
  `);
  interface RenewableRow {
    date: string;
    solar: number | null;
    wind_onshore: number | null;
    wind_offshore: number | null;
    hydro: number | null;
    biomass: number | null;
    geothermal: number | null;
  }
  const renewableData = renewableStmt.all(upperCode, ...rangeArgs(range)) as RenewableRow[];

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
