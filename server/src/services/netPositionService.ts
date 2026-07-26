import type { Database as DatabaseType } from 'better-sqlite3';
import defaultDb from '../config/database.js';
import { normalizeTimestamp } from '../utils/timestamp.js';
import { resolveModelName } from '../config/forecastModels.js';
import {
  NetPositionActualPoint,
  NetPositionForecastPoint,
  NetPositionResponse,
} from '../types/index.js';

/** Forecast metadata, before the window-independent last_seen is attached. */
type ForecastMeta = Omit<NetPositionResponse['meta'], 'last_seen'>;

/**
 * Net positions are published per BIDDING ZONE, which is not always the
 * two-letter country code. Germany's is DE_LU, the Core CCR zone covering
 * Germany and Luxembourg, so both DE and LU resolve to the same series.
 *
 * Mirrors ENTSOEClient.NET_POSITION_BIDDING_ZONES in energy-data-gathering.
 * Kept deliberately separate from price bidding zones, which map differently
 * (IT -> IT_NORD), and would be wrong for a national net position.
 */
const NET_POSITION_BIDDING_ZONES: Record<string, string> = {
  DE: 'DE_LU',
  LU: 'DE_LU',
};

/** Ingestion stores the DE_LU zone under country_code 'DE'. */
const ZONE_STORED_UNDER: Record<string, string> = {
  DE_LU: 'DE',
};

export function resolveBiddingZone(countryCode: string): string {
  const upper = countryCode.toUpperCase();
  return NET_POSITION_BIDDING_ZONES[upper] ?? upper;
}

/** The country_code actually present in the tables for a given zone. */
function storageCode(countryCode: string): string {
  const zone = resolveBiddingZone(countryCode);
  return ZONE_STORED_UNDER[zone] ?? zone;
}

function hasTable(db: DatabaseType, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name) as { present: number } | undefined;
  return row !== undefined;
}

export function getNetPositionActuals(
  countryCode: string,
  start: string,
  end: string,
  db: DatabaseType = defaultDb
): NetPositionActualPoint[] {
  const stmt = db.prepare(`
    SELECT
      REPLACE(timestamp_utc, ' ', 'T') as timestamp,
      net_position_mw as net_position_mw
    FROM net_position
    WHERE country_code = ?
      AND timestamp_utc BETWEEN ? AND ?
    ORDER BY timestamp_utc
  `);
  return stmt.all(
    storageCode(countryCode),
    normalizeTimestamp(start),
    normalizeTimestamp(end)
  ) as NetPositionActualPoint[];
}

/**
 * Latest forecast vintage only. Several runs a day accumulate as separate
 * generated_at values (each a distinct vintage, deliberately kept), so the
 * newest one is selected rather than blending them.
 *
 * The p10/p90 band comes from forecast_quantiles. That table does not exist
 * on every deployment - it is created on first forecast write - so a missing
 * table degrades to a median-only forecast rather than failing the request.
 */
export function getNetPositionForecast(
  countryCode: string,
  db: DatabaseType = defaultDb,
  modelId?: string
): { points: NetPositionForecastPoint[]; meta: ForecastMeta } {
  const code = storageCode(countryCode);
  // Pin to the registered model. Selecting purely on generated_at let any
  // newer run take over the display by being newer - including V011, rejected
  // on evidence 2026-07-25 at +11.7% pooled MAE. A model must be registered.
  const modelName = resolveModelName('net_position', modelId);

  const latest = db
    .prepare(
      `SELECT generated_at, model_name, model_version
         FROM forecasts
        WHERE country_code = ? AND forecast_type = 'net_position'
          AND model_name = ?
        ORDER BY generated_at DESC
        LIMIT 1`
    )
    .get(code, modelName) as
    | { generated_at: string; model_name: string; model_version: string }
    | undefined;

  const meta: ForecastMeta = {
    bidding_zone: resolveBiddingZone(countryCode),
    model_name: latest?.model_name ?? null,
    model_version: latest?.model_version ?? null,
    generated_at: latest ? latest.generated_at.replace(' ', 'T') : null,
    has_band: false,
  };

  if (!latest) return { points: [], meta };

  const withBand = hasTable(db, 'forecast_quantiles');
  meta.has_band = withBand;

  if (!withBand) {
    const rows = db
      .prepare(
        `SELECT REPLACE(target_timestamp_utc, ' ', 'T') as timestamp,
                forecast_value as p50
           FROM forecasts
          WHERE country_code = ? AND forecast_type = 'net_position'
            AND model_name = ? AND generated_at = ?
          ORDER BY target_timestamp_utc`
      )
      .all(code, modelName, latest.generated_at) as Array<{ timestamp: string; p50: number }>;
    return { points: rows.map((r) => ({ ...r, p10: null, p90: null })), meta };
  }

  const rows = db
    .prepare(
      `SELECT
         REPLACE(f.target_timestamp_utc, ' ', 'T') as timestamp,
         f.forecast_value as p50,
         MAX(CASE WHEN q.quantile = 0.1 THEN q.forecast_value END) as p10,
         MAX(CASE WHEN q.quantile = 0.9 THEN q.forecast_value END) as p90
       FROM forecasts f
       LEFT JOIN forecast_quantiles q
              ON q.country_code         = f.country_code
             AND q.forecast_type        = f.forecast_type
             AND q.target_timestamp_utc = f.target_timestamp_utc
             AND q.generated_at         = f.generated_at
             AND q.model_name           = f.model_name
      WHERE f.country_code = ? AND f.forecast_type = 'net_position'
        AND f.model_name = ? AND f.generated_at = ?
      GROUP BY f.target_timestamp_utc, f.forecast_value
      ORDER BY f.target_timestamp_utc`
    )
    .all(code, modelName, latest.generated_at) as NetPositionForecastPoint[];

  return { points: rows, meta };
}

/**
 * Newest published hour for this zone, ignoring the query window.
 *
 * Needed to tell "nothing in the last 7 days" apart from "this zone stopped
 * publishing in March". Both look identical inside the window, and only the
 * unbounded maximum can name the date - GR and IE both went silent on
 * 2026-03-14, which no recent window will ever contain.
 */
export function getLastSeen(
  countryCode: string,
  db: DatabaseType = defaultDb
): string | null {
  const row = db
    .prepare(`SELECT MAX(timestamp_utc) AS last FROM net_position WHERE country_code = ?`)
    .get(storageCode(countryCode)) as { last: string | null } | undefined;
  return row?.last ? row.last.replace(' ', 'T') : null;
}

export function getNetPosition(
  countryCode: string,
  start: string,
  end: string,
  db: DatabaseType = defaultDb
): NetPositionResponse {
  const actual = getNetPositionActuals(countryCode, start, end, db);
  const { points, meta } = getNetPositionForecast(countryCode, db);
  return {
    actual,
    forecast: points,
    meta: { ...meta, last_seen: getLastSeen(countryCode, db) },
  };
}
