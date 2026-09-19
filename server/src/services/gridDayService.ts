import type { Database as DatabaseType } from 'better-sqlite3';
import defaultDb from '../config/database.js';
import { timestampRange, rangeClause, rangeArgs } from '../utils/timestamp.js';
import {
  brusselsDayWindow,
  currentHourInGridTimezone,
  todayInGridTimezone,
  type GridDayWindow,
} from './livingGrid/brusselsDay.js';
import {
  emptySeries,
  hourSlotIndex,
  isEmptySeries,
  placeRows,
  type HourSeries,
} from './livingGrid/hourBuckets.js';
import {
  FUEL_KEYS,
  GENERATION_MW_COLUMNS,
  groupFuels,
  type FuelKey,
  type GenerationColumns,
} from './livingGrid/fuelGroups.js';
import { netFlows, type FlowRow } from './livingGrid/flowNetting.js';
import { resolveBiddingZone } from './netPositionService.js';

/**
 * One day of every stream the Living Grid renders, for every zone at once.
 *
 * WHY ONE ROUTE INSTEAD OF THE EXISTING PER-COUNTRY ONES
 *
 * The view draws ~30 zones simultaneously and scrubs an hour slider across
 * them. Composed from the per-country endpoints that is 30 x 4 requests for
 * one screen, against a server whose SQLite handle is synchronous and
 * single-threaded — the shape CLAUDE.md warns about under the retry policy.
 * One payload per day is ~20 KB gzipped and the UI never asks again while the
 * hour changes, because every stream is already indexed by hour.
 *
 * WHAT IT DOES NOT DO
 *
 * It serves no forecast. Load, price and net position exist day-ahead, but the
 * generation mix does not (only wind and solar are forecast) and cross-border
 * flows are realized physical values arriving about an hour late. Mixing a
 * forecast mix into a realized one behind a single `date` parameter would put
 * two different claims under one label, so every stream here is the measured
 * one and a zone that has not reported yet reads `null`.
 *
 * The route answers any valid calendar date, including one ahead of today, and
 * that is not a loosening of the above: a future date returns these same
 * measured streams, empty beyond what has been published. The absence is the
 * answer. `energy_price` reaching D+1 is a published auction result, not a
 * forecast, which is why tomorrow colours and the day after does not.
 */

/** Zone-level series. Any stream a zone does not publish is 24 nulls. */
export interface GridDayZone {
  load: HourSeries;
  price: HourSeries;
  net: HourSeries;
  mix: Record<FuelKey, HourSeries>;
}

export interface GridDayPayload {
  zones: Record<string, GridDayZone>;
  /** Signed MW per border, keyed alphabetically; + = first zone exports. */
  flows: Record<string, HourSeries>;
}

export interface GridDayMeta {
  date: string;
  timezone: string;
  hoursUtc: (string | null)[];
  /** Zones whose series is another zone's, and which one. */
  sharedZones: Record<string, string>;
  /** The hour it is right now in Brussels, so the client's Live button agrees. */
  currentHour: number;
  /** True when `date` is today — i.e. when `currentHour` is meaningful. */
  isToday: boolean;
  /**
   * Today's date here, whatever date was asked for.
   *
   * Sent unconditionally because the client's day control has to reason about
   * dates the server has not been asked about — whether one more step forward
   * is still inside the reach — and `date` alone cannot answer that once a day
   * is pinned. `isToday` is exactly `date === today`.
   */
  today: string;
  zoneCount: number;
  borderCount: number;
}

export interface GridDayResult {
  data: GridDayPayload;
  meta: GridDayMeta;
}

/**
 * The bucket key rows are grouped by: the UTC hour, separator-normalised.
 *
 * `REPLACE`/`substr` appear only in the SELECT and GROUP BY, never in the
 * WHERE — the filter keeps the column bare so the range predicate can still
 * seek its index, which is the 51-second scar recorded in CLAUDE.md.
 */
const HOUR_KEY_SQL = `substr(REPLACE(timestamp_utc, 'T', ' '), 1, 13)`;

/**
 * Rank the rows that describe one instant so the space form comes first.
 *
 * Both separator forms exist in these tables for the same country-hour, and
 * they do not always agree — `utils/timestamp.ts` counts 107,047 conflicting
 * pairs in `energy_load` alone. Normalising the separator in the GROUP BY is
 * what makes an hour bucket correct; on its own it also drops both rows of a
 * conflicting pair into that bucket, where `AVG` means them into a third
 * number that neither row holds. Which of a pair is right is not knowable
 * here, so this takes the same answer the rest of the codebase takes — prefer
 * the space form — rather than inventing a reading.
 *
 * This ranks rows, not values: a space-form row whose value is NULL still
 * wins, because "reported nothing" is a reading too.
 */
const separatorRank = (partition: string): string => `
      ROW_NUMBER() OVER (
        PARTITION BY ${partition}REPLACE(timestamp_utc, 'T', ' ')
        ORDER BY (timestamp_utc LIKE '%T%')
      ) AS separatorRank`;

/**
 * Load, price and generation are published every 15 minutes, so an hour is the
 * mean of up to four readings. `AVG` skips NULLs and yields NULL only when
 * every reading in the hour is NULL, which is exactly the distinction between
 * "did not report" and "reported zero" this codebase refuses to collapse.
 */
const zoneHourSql = (table: string, expression: string): string => `
    SELECT zone, hourKey, AVG(value) AS value
    FROM (
      SELECT
        country_code AS zone,
        ${HOUR_KEY_SQL} AS hourKey,
        ${expression} AS value,${separatorRank('country_code, ')}
      FROM ${table}
      WHERE ${rangeClause('timestamp_utc')}
    )
    WHERE separatorRank = 1
    GROUP BY zone, hourKey
  `;

const GENERATION_SQL = `
    SELECT
      zone,
      hourKey,
      ${GENERATION_MW_COLUMNS.map((c) => `AVG(${c}) AS ${c}`).join(',\n      ')}
    FROM (
      SELECT
        country_code AS zone,
        ${HOUR_KEY_SQL} AS hourKey,
        ${GENERATION_MW_COLUMNS.join(',\n        ')},${separatorRank('country_code, ')}
      FROM energy_generation
      WHERE ${rangeClause('timestamp_utc')}
    )
    WHERE separatorRank = 1
    GROUP BY zone, hourKey
  `;

/**
 * Net position is hourly and its only index is (country_code, timestamp_utc),
 * so it is read one zone at a time — a seek each, against a full scan of
 * 667k rows for a window predicate that cannot use that index.
 */
const NET_POSITION_SQL = `
    SELECT hourKey, AVG(value) AS value
    FROM (
      SELECT
        ${HOUR_KEY_SQL} AS hourKey,
        net_position_mw AS value,${separatorRank('')}
      FROM net_position
      WHERE country_code = ?
        AND ${rangeClause('timestamp_utc')}
    )
    WHERE separatorRank = 1
    GROUP BY hourKey
  `;

/**
 * Flows read per zone, one statement per direction.
 *
 * Both directions must be read because the table stores flows by BORDER, not
 * by zone: GB publishes no load, price or net position — it is not a zone —
 * yet its return legs (GB->FR, GB->NL, …) are current, and reading only
 * exports FROM zones served those borders as the zone-side leg gross, as if
 * it were the net. The table has no timestamp index, so each direction seeks
 * its own country index (idx_cbf_from / idx_cbf_to) rather than scanning.
 */
const flowsSql = (direction: 'country_from' | 'country_to') => `
    SELECT country_from, country_to, hourKey, SUM(flow_mw) AS flow_mw
    FROM (
      SELECT
        country_from,
        country_to,
        ${HOUR_KEY_SQL} AS hourKey,
        flow_mw,${separatorRank('country_from, country_to, ')}
      FROM crossborder_flows
      WHERE ${direction} = ?
        AND ${rangeClause('timestamp_utc')}
    )
    WHERE separatorRank = 1
    GROUP BY country_from, country_to, hourKey
  `;

interface ZoneHourRow {
  zone: string;
  hourKey: string;
  value: number | null;
}

interface GenerationRow extends GenerationColumns {
  zone: string;
  hourKey: string;
  [column: string]: unknown;
}

function emptyMix(): Record<FuelKey, HourSeries> {
  const mix = {} as Record<FuelKey, HourSeries>;
  for (const fuel of FUEL_KEYS) mix[fuel] = emptySeries();
  return mix;
}

function tableExists(db: DatabaseType, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name) as { present: number } | undefined;
  return row !== undefined;
}

/**
 * Assemble one Living Grid day.
 *
 * `date` is a Brussels calendar date; an invalid one throws `RangeError`,
 * which the route answers with 400.
 */
export function getGridDay(date: string, db: DatabaseType = defaultDb): GridDayResult {
  const window: GridDayWindow = brusselsDayWindow(date);
  const index = hourSlotIndex(window.hourKeys);
  const range = timestampRange(window.startUtc, window.endUtc);
  const args = rangeArgs(range);

  const zones: Record<string, GridDayZone> = {};
  const zoneOf = (code: string): GridDayZone => {
    let zone = zones[code];
    if (zone === undefined) {
      zone = { load: emptySeries(), price: emptySeries(), net: emptySeries(), mix: emptyMix() };
      zones[code] = zone;
    }
    return zone;
  };

  const loadRows = db.prepare(zoneHourSql('energy_load', 'load_mw')).all(...args) as ZoneHourRow[];
  for (const row of loadRows) zoneOf(row.zone);
  regroup(loadRows, index, zones, 'load');

  const priceRows = db
    .prepare(zoneHourSql('energy_price', 'price_eur_mwh'))
    .all(...args) as ZoneHourRow[];
  for (const row of priceRows) zoneOf(row.zone);
  regroup(priceRows, index, zones, 'price');

  const generationRows = db.prepare(GENERATION_SQL).all(...args) as GenerationRow[];
  for (const row of generationRows) {
    const slot = index.get(row.hourKey);
    if (slot === undefined) continue;
    const mix = zoneOf(row.zone).mix;
    const grouped = groupFuels(row);
    for (const fuel of FUEL_KEYS) {
      mix[fuel][slot] = grouped[fuel];
    }
  }

  // Net position, per zone. Candidates are the zones the streams above found,
  // plus every zone the net_position table knows — a zone can publish a net
  // position without appearing in any of them, and dropping it would blank a
  // country the map is meant to colour. The candidate scan reads the
  // (country_code, timestamp_utc) index only, so it costs a distinct walk of
  // the index rather than a scan of the table.
  const netStatement = db.prepare(NET_POSITION_SQL);
  const sharedZones: Record<string, string> = {};
  const netCache = new Map<string, HourSeries>();

  const netSeriesFor = (code: string): HourSeries => {
    const zoneId = resolveBiddingZone(code);
    // DE_LU is stored under 'DE'; LU has its own contradictory rows that the
    // bidding-zone map deliberately overrides.
    const storage = zoneId === 'DE_LU' ? 'DE' : zoneId;
    if (storage !== code) sharedZones[code] = zoneId;

    let series = netCache.get(storage);
    if (series === undefined) {
      series = placeRows(netStatement.all(storage, ...args) as ZoneHourRow[], index, (r) => r.value);
      netCache.set(storage, series);
    }
    return series.slice();
  };

  for (const code of Object.keys(zones)) {
    zones[code].net = netSeriesFor(code);
  }

  const netCandidates = db
    .prepare('SELECT DISTINCT country_code AS zone FROM net_position')
    .all() as { zone: string }[];
  for (const { zone: code } of netCandidates) {
    if (zones[code] !== undefined) continue;
    const series = netSeriesFor(code);
    // Only admit a zone that actually published in this window; the candidate
    // list spans all of history, and an empty zone is noise on the wire.
    if (isEmptySeries(series)) {
      delete sharedZones[code];
      continue;
    }
    zoneOf(code).net = series;
  }

  // Flows, per zone in both directions. The table is absent from some
  // deployments' replicas, in which case the border layer is simply empty.
  let flows: Record<string, HourSeries> = {};
  if (tableExists(db, 'crossborder_flows')) {
    const fromStatement = db.prepare(flowsSql('country_from'));
    const toStatement = db.prepare(flowsSql('country_to'));
    const zoneSet = new Set(Object.keys(zones));
    const flowRows: FlowRow[] = [];
    for (const code of zoneSet) {
      flowRows.push(...(fromStatement.all(code, ...args) as FlowRow[]));
      // The mirror pass exists for exporters that are not zones (GB, UA);
      // a row whose exporter IS a zone was already read by the pass above.
      for (const row of toStatement.all(code, ...args) as FlowRow[]) {
        if (!zoneSet.has(row.country_from)) flowRows.push(row);
      }
    }
    flows = netFlows(flowRows, index);
  }

  const today = todayInGridTimezone();
  return {
    data: { zones, flows },
    meta: {
      date: window.date,
      timezone: window.timezone,
      hoursUtc: window.hoursUtc,
      sharedZones,
      currentHour: currentHourInGridTimezone(),
      isToday: window.date === today,
      today,
      zoneCount: Object.keys(zones).length,
      borderCount: Object.keys(flows).length,
    },
  };
}

/** Scatter one stream's rows across every zone's series. */
function regroup(
  rows: readonly ZoneHourRow[],
  index: Map<string, number>,
  zones: Record<string, GridDayZone>,
  stream: 'load' | 'price',
): void {
  for (const row of rows) {
    const slot = index.get(row.hourKey);
    if (slot === undefined) continue;
    const zone = zones[row.zone];
    if (zone === undefined) continue;
    const value = row.value;
    zone[stream][slot] = value === null || Number.isNaN(value) ? null : value;
  }
}
