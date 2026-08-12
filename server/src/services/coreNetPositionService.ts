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

export interface CoreNetPositionPoint {
  timestamp: string;
  net_position_mw: number;
}

/**
 * Minimal read for `core_net_position` — deliberately thin. This exists so
 * the ingest can be exercised end to end; the real endpoint shape for the
 * client toggle is owned by the follow-up UI issue (ABL-230's description),
 * which should revise or replace this rather than treat it as fixed.
 */
export function getCoreNetPosition(
  countryCode: string,
  start: string,
  end: string,
  db: DatabaseType = defaultDb
): CoreNetPositionPoint[] {
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
