import type { Database as DatabaseType } from 'better-sqlite3';
import defaultDb from '../config/database.js';
import { normalizeTimestamp } from '../utils/timestamp.js';
import { resolveBiddingZone } from './netPositionService.js';

/**
 * Append-only capture of JAO's Core CCR net position (ABL-230, step 2 of
 * ABL-219) — the pipeline's first non-ENTSO-E source. Board-approved via
 * `confirmation:e4484ddc-7dcc-4e96-bb3d-23883577e078:core-netpos-ingest:v3`.
 *
 * WHY THIS TABLE EXISTS, AND HOW IT DIFFERS FROM `net_position`
 *
 * `net_position.net_position_mw` (read by `netPositionService.ts`) is a zone's
 * net position over every SDAC implicitly-coupled border. This table is a
 * DIFFERENT, separately-published quantity: the same zone's net position
 * counting only exchanges inside the Core CCR flow-based domain. They can
 * disagree, including in sign — see ABL-219's research brief (issue comment
 * `5ba93873`) for the measured evidence (France 2026-08-09 08:00 UTC: Core
 * -114.9 MW vs the all-borders +1,557.7 MW). Do not merge this table into
 * `net_position` or treat one as a correction of the other — they answer
 * different questions and both are correct for what they measure.
 *
 * Do not call the distinction "AC vs DC" anywhere near this table. The
 * measured distinction is which borders are in scope, not conductor type:
 * Germany's Core figure already nets in its HVDC links (modelled as virtual
 * hubs inside the flow-based domain), and France's Core figure excludes its
 * AC borders to ES/IT. An AC/DC label would be wrong in both directions.
 *
 * SOURCE SHAPE — measured directly against the live endpoint, 2026-08-11
 *
 * `GET https://publicationtool.jao.eu/core/api/data/netPos?FromUtc=<iso>&ToUtc=<iso>`
 * returns `{ data: [{ id, dateTimeUtc, hub_AT, hub_BE, ..., hub_ALBE,
 * hub_ALDE, hub_DE_NO2_BigHub, ... }], rejected, messages }` — one object per
 * 15-minute interval, one field per JAO "hub". 23 `hub_*` fields total: 12
 * Core CCR zone hubs, 2 ALEGrO hubs, 9 other external/DC virtual hubs. Only
 * the 12 zone hubs are stored — see `CORE_ZONE_HUB_TO_COUNTRY`.
 *
 * WRITER / READER SPLIT
 *
 * This module owns the table and is imported by both sides: the write path
 * (`jaoCoreNetPositionCapture.ts`, run from `workers/
 * captureCoreNetPositionWorker.ts` on its own writable connection, never on
 * Express's request thread) and the read path (`getCoreNetPosition`, called
 * from `routes/coreNetPosition.ts` against the ordinary readonly connection).
 * Both sides open the same underlying SQLite file through different handles,
 * exactly like `net_position` already is written by the sibling
 * `energy-data-gathering` module and read here readonly.
 *
 * SINGLE-FORMAT TIMESTAMPS — DELIBERATELY NOT `rangeClause`/`rangeArgs`
 *
 * `CLAUDE.md`'s "Timestamp storage: two separators in one column" section
 * documents that most tables in this database hold a historical mix of
 * `T`-separated and space-separated timestamps, which is why window
 * predicates elsewhere go through `rangeClause`/`rangeArgs`. That problem
 * cannot arise here: `core_net_position` has exactly one writer
 * (`storeCoreNetPositionRows`, below), which always routes every timestamp
 * through `normalizeTimestamp` before it is stored, so the column is 100%
 * space-form by construction, not by measurement. `getCoreNetPosition` uses a
 * plain `BETWEEN` on the normalized bounds — reaching for the two-clause
 * machinery here would imply a mixed-format risk this table structurally
 * cannot have.
 */

/**
 * The 12 Core CCR zone hubs JAO's `netPos` response carries, mapped to the
 * country code this table stores them under. Every other `hub_*` field in the
 * same response — the 2 ALEGrO hubs (`hub_ALBE`, `hub_ALDE`) and the 9
 * external/DC virtual hubs Germany's own Core figure already nets in
 * (`hub_DE_NO2_BigHub`, `hub_NL_NO2_NorNed`, `hub_DE_DK2_BigHub`,
 * `hub_DE_SE4_Baltic`, `hub_PL_SE4_SwePol`, `hub_PL_LT_BigHub`,
 * `hub_RO_BG_VH`, `hub_NL_DK1_COBRA`, `hub_DE_DK1_VH`) — is deliberately NOT
 * in this map, so `parseJaoCoreNetPositionResponse` never stores it: none of
 * those is a standalone bidding-zone net position, and storing one as if it
 * were would misrepresent a virtual/external hub as a 13th-plus Core zone.
 *
 * `hub_DE` is the DE_LU bidding zone (Germany and Luxembourg share one zone,
 * the same mapping `NET_POSITION_BIDDING_ZONES` in `netPositionService.ts`
 * and in the sibling `energy-data-gathering` module already use for
 * `net_position`). It is stored ONCE here, under `'DE'`, never duplicated
 * under `'LU'` — creating that duplicate is the exact defect ABL-35 (defect 4)
 * already cost a dedicated fix to remove from `net_position`, by skipping the
 * redundant fetch before it ever reached storage rather than deduping after
 * the fact. `resolveCoreCountryCode` below aliases a caller's `'LU'` lookup to
 * `'DE'` at READ time instead, mirroring `netPositionService.ts`'s own
 * `storageCode` (not exported, so not reused directly, but the same shape).
 */
export const CORE_ZONE_HUB_TO_COUNTRY: Readonly<Record<string, string>> = {
  hub_AT: 'AT',
  hub_BE: 'BE',
  hub_CZ: 'CZ',
  hub_DE: 'DE',
  hub_FR: 'FR',
  hub_HR: 'HR',
  hub_HU: 'HU',
  hub_NL: 'NL',
  hub_PL: 'PL',
  hub_RO: 'RO',
  hub_SI: 'SI',
  hub_SK: 'SK',
};

export interface CoreNetPositionRow {
  countryCode: string;
  /** Space-separated, e.g. `2026-08-09 00:00:00` — see the module doc above. */
  timestampUtc: string;
  netPositionMw: number;
}

/**
 * Parse a raw JAO `netPos` response into one row per (Core zone, interval).
 *
 * Pure and defensive: a record missing `dateTimeUtc`, or a hub field that is
 * missing/null/non-numeric for a given interval, is skipped rather than
 * fabricated — the same "NULL is not 0" discipline this codebase applies to
 * `energy_generation`. JAO reporting nothing for one hub on one interval is a
 * gap, not a zero.
 *
 * Throws when the response does not even have the expected top-level `data`
 * array — a genuine contract change upstream — or when JAO's own `rejected`
 * flag is true (e.g. an invalid FromUtc/ToUtc pair). Both should surface as a
 * loud capture failure (logged by the scheduler) rather than a silent
 * zero-row capture.
 */
export function parseJaoCoreNetPositionResponse(raw: unknown): CoreNetPositionRow[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { data?: unknown }).data)) {
    throw new Error('JAO netPos response has no "data" array — API contract may have changed.');
  }
  if ((raw as { rejected?: unknown }).rejected === true) {
    const messages = (raw as { messages?: unknown }).messages;
    throw new Error(`JAO netPos request was rejected: ${JSON.stringify(messages)}`);
  }

  const rows: CoreNetPositionRow[] = [];
  for (const record of (raw as { data: unknown[] }).data) {
    if (!record || typeof record !== 'object') continue;
    const fields = record as Record<string, unknown>;

    const dateTimeUtc = fields.dateTimeUtc;
    if (typeof dateTimeUtc !== 'string' || !dateTimeUtc.trim()) continue;
    const timestampUtc = normalizeTimestamp(dateTimeUtc);

    for (const [hubField, countryCode] of Object.entries(CORE_ZONE_HUB_TO_COUNTRY)) {
      const value = fields[hubField];
      if (typeof value === 'number' && Number.isFinite(value)) {
        rows.push({ countryCode, timestampUtc, netPositionMw: value });
      }
    }
  }
  return rows;
}

const CORE_NET_POSITION_DDL = `
  CREATE TABLE IF NOT EXISTS core_net_position (
    country_code TEXT NOT NULL,
    timestamp_utc TEXT NOT NULL,
    net_position_mw REAL NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (country_code, timestamp_utc)
  )
`;

/**
 * Additive, non-breaking: only ever `CREATE TABLE IF NOT EXISTS`. Never
 * touches any existing table, mirroring `ensureForecastVintageArchiveTable`.
 */
export function ensureCoreNetPositionTable(db: DatabaseType): void {
  db.exec(CORE_NET_POSITION_DDL);
}

/**
 * Store rows already produced by `parseJaoCoreNetPositionResponse`.
 *
 * `INSERT OR IGNORE` against the `(country_code, timestamp_utc)` primary key:
 * idempotent, and — unlike `forecast_vintage_archive` — deliberately NOT
 * keyed on value as well. The Core net position is a published day-ahead
 * market-coupling result, not a forecast; nothing about it is revised in
 * place the way a model's re-run is, so there is no "changed value under an
 * unchanged key" case this table needs to preserve both sides of. Re-running
 * a capture over an already-captured window is a pure no-op.
 *
 * Returns the count of rows actually inserted (new intervals only).
 */
export function storeCoreNetPositionRows(
  db: DatabaseType,
  rows: CoreNetPositionRow[],
  fetchedAt: string = new Date().toISOString()
): number {
  ensureCoreNetPositionTable(db);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO core_net_position (country_code, timestamp_utc, net_position_mw, fetched_at)
     VALUES (@countryCode, @timestampUtc, @netPositionMw, @fetchedAt)`
  );

  const run = db.transaction((values: CoreNetPositionRow[]): number => {
    let inserted = 0;
    for (const row of values) {
      inserted += insert.run({ ...row, fetchedAt }).changes;
    }
    return inserted;
  });

  return run(rows);
}

/** LU has no rows of its own here — see `CORE_ZONE_HUB_TO_COUNTRY`'s doc comment. */
export function resolveCoreCountryCode(countryCode: string): string {
  const zone = resolveBiddingZone(countryCode);
  return zone === 'DE_LU' ? 'DE' : zone;
}

/**
 * The 12 Core CCR zones, derived from the ingest's own hub map rather than
 * restated as a second literal — a hand-copied list is exactly how two
 * definitions of one set drift apart (`lib/dataScale.ts`'s and
 * `NoDataHatch.tsx`'s doc comments both record this repo paying for that).
 * `resolveCoreCountryCode` is applied first, so `'LU'` is in Core (it shares
 * the DE_LU zone) even though no row is ever stored under it.
 */
const CORE_STORED_CODES: ReadonlySet<string> = new Set(
  Object.values(CORE_ZONE_HUB_TO_COUNTRY)
);

export function isCoreZone(countryCode: string): boolean {
  return CORE_STORED_CODES.has(resolveCoreCountryCode(countryCode));
}

export interface CoreNetPositionPoint {
  timestamp: string;
  net_position_mw: number;
}

/**
 * Why a country has no Core series, as four claims that are NOT
 * interchangeable — the whole reason this endpoint exists rather than an
 * empty array with a shrug (ABL-234):
 *
 * - `out_of_core`: the zone is not one of the 12 Core CCR zones, so no Core
 *   net position exists for it, ever. GB and CH are the obvious cases, but so
 *   are ES, IT and the Nordics. This is NOT missing data, and the map must
 *   not render it with the same claim as one that is.
 * - `not_captured`: `core_net_position` does not exist in this deployment —
 *   the JAO capture has never run here (it is gated off by default; see
 *   `coreNetPositionScheduler.ts`). A deployment-state fact, not a fact about
 *   the zone.
 * - `no_data`: a Core zone, capture has run, but this window holds no rows.
 * - `served`: rows returned.
 */
export type CoreNetPositionCoverage =
  | 'served'
  | 'no_data'
  | 'out_of_core'
  | 'not_captured';

export interface CoreNetPositionSeries {
  actual: CoreNetPositionPoint[];
  meta: {
    country_code: string;
    bidding_zone: string;
    in_core: boolean;
    coverage: CoreNetPositionCoverage;
    /** Newest stored hour for this zone, ignoring the window. */
    last_seen: string | null;
  };
}

function hasCoreTable(db: DatabaseType): boolean {
  const row = db
    .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name = 'core_net_position'`)
    .get() as { present: number } | undefined;
  return row !== undefined;
}

/**
 * Raw rows for one zone and window. Callers want `getCoreNetPositionSeries`;
 * this stays exported because the route tests and the capture's own
 * round-trip check read the rows without the coverage vocabulary.
 */
export function getCoreNetPosition(
  countryCode: string,
  start: string,
  end: string,
  db: DatabaseType = defaultDb
): CoreNetPositionPoint[] {
  if (!hasCoreTable(db)) return [];
  const stmt = db.prepare(`
    SELECT
      REPLACE(timestamp_utc, ' ', 'T') as timestamp,
      net_position_mw
    FROM core_net_position
    WHERE country_code = ?
      AND timestamp_utc BETWEEN ? AND ?
    ORDER BY timestamp_utc
  `);
  return stmt.all(
    resolveCoreCountryCode(countryCode),
    normalizeTimestamp(start),
    normalizeTimestamp(end)
  ) as CoreNetPositionPoint[];
}

/** Newest stored hour for a zone, window-independent — dates an outage. */
export function getCoreLastSeen(
  countryCode: string,
  db: DatabaseType = defaultDb
): string | null {
  if (!hasCoreTable(db)) return null;
  const row = db
    .prepare(
      `SELECT MAX(REPLACE(timestamp_utc, 'T', ' ')) AS last
         FROM core_net_position WHERE country_code = ?`
    )
    .get(resolveCoreCountryCode(countryCode)) as { last: string | null } | undefined;
  return row?.last ? row.last.replace(' ', 'T') : null;
}

/**
 * The Core series for one zone, with the reason named when it is empty.
 *
 * DELIBERATELY NOT GUARDED BY `classifyActualSeries`, unlike
 * `netPositionService.getNetPositionActualSeries` — and that asymmetry is a
 * decision, not an oversight. That guard withholds a series whose largest
 * |value| is under 1 MW, because ENTSO-E's sparse-document forward-fill
 * manufactured a full year of exact-`0.0` GR rows that were false by better
 * than a gigawatt. Neither half of that reasoning transfers here:
 *
 * - There is no forward-fill on this path. `parseJaoCoreNetPositionResponse`
 *   skips a hub that is missing or non-numeric for an interval rather than
 *   carrying the previous value forward, so a stored Core row is a value JAO
 *   actually published for that interval.
 * - The 1 MW floor is sized from a measurement over 26,882 `net_position`
 *   country-days. No equivalent measurement exists for `core_net_position` —
 *   nothing has been captured yet — so importing the threshold would be an
 *   uncalibrated cutoff, exactly what `comparisonConstants.ts`'s removed
 *   `METRIC_THRESHOLDS` was. A Core zone genuinely balanced across a window
 *   is an ordinary outcome, and withholding it would be its own defect.
 *
 * If a fabrication mode ever shows up in this table, size a threshold against
 * it and add the guard then.
 */
export function getCoreNetPositionSeries(
  countryCode: string,
  start: string,
  end: string,
  db: DatabaseType = defaultDb
): CoreNetPositionSeries {
  const upper = countryCode.toUpperCase();
  const meta = {
    country_code: upper,
    bidding_zone: resolveBiddingZone(upper),
    in_core: isCoreZone(upper),
  };

  if (!meta.in_core) {
    return { actual: [], meta: { ...meta, coverage: 'out_of_core', last_seen: null } };
  }
  if (!hasCoreTable(db)) {
    return { actual: [], meta: { ...meta, coverage: 'not_captured', last_seen: null } };
  }

  const actual = getCoreNetPosition(upper, start, end, db);
  return {
    actual,
    meta: {
      ...meta,
      coverage: actual.length > 0 ? 'served' : 'no_data',
      last_seen: getCoreLastSeen(upper, db),
    },
  };
}

export interface CoreNetPositionMapPoint {
  country_code: string;
  country_name: string;
  value: number;
  timestamp: string;
}

/**
 * Window-average Core net position per zone, shaped like `/dashboard/map`'s
 * `MapDataPoint` so the choropleth can colour it with the metric's existing
 * diverging scale.
 *
 * Two properties carried over from `dashboardService.getMapNetPositionData`,
 * for the same reasons stated there:
 *
 * - Averaged over the window, so it reads as "net exporter over this period"
 *   rather than at one instant. Note the two series are averaged at different
 *   native resolutions — JAO publishes Core at 15 minutes, ENTSO-E publishes
 *   the all-coupled figure hourly — which is not a discrepancy: measured
 *   2026-08-09 08:00 UTC, DE-LU's four Core quarters (7594.9, 9583.5, 9676.6,
 *   10840.5) average to 9423.875, exactly its all-coupled hourly value.
 * - LU is emitted with DE's value rather than left out. DE_LU is one bidding
 *   zone and Luxembourg is inside Core; a hole there would read as "outside
 *   the Core region", which is the one claim this view must get right.
 */
export function getCoreNetPositionMap(
  start: string,
  end: string,
  db: DatabaseType = defaultDb
): CoreNetPositionMapPoint[] {
  if (!hasCoreTable(db)) return [];

  const rows = db
    .prepare(
      `SELECT
         n.country_code,
         c.country_name,
         ROUND(AVG(n.net_position_mw), 0) as value,
         MAX(REPLACE(n.timestamp_utc, 'T', ' ')) as timestamp
       FROM core_net_position n
       JOIN countries c ON c.country_code = n.country_code
       WHERE n.timestamp_utc BETWEEN ? AND ?
       GROUP BY n.country_code, c.country_name
       ORDER BY c.country_name`
    )
    .all(normalizeTimestamp(start), normalizeTimestamp(end)) as CoreNetPositionMapPoint[];

  const de = rows.find((r) => r.country_code === 'DE');
  if (!de) return rows;

  const lu = db
    .prepare(`SELECT country_name FROM countries WHERE country_code = 'LU'`)
    .get() as { country_name: string } | undefined;
  if (lu) rows.push({ ...de, country_code: 'LU', country_name: lu.country_name });
  return rows;
}
