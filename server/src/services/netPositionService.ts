import type { Database as DatabaseType } from 'better-sqlite3';
import defaultDb from '../config/database.js';
import { timestampRange, rangeClause, rangeArgs } from '../utils/timestamp.js';
import { resolveModelName } from '../config/forecastModels.js';
import {
  NetPositionActualPoint,
  NetPositionForecastPoint,
  NetPositionForecastVintage,
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
      AND ${rangeClause('timestamp_utc')}
    ORDER BY timestamp_utc
  `);
  return stmt.all(
    storageCode(countryCode),
    ...rangeArgs(timestampRange(start, end))
  ) as NetPositionActualPoint[];
}

/** Raw row shared by both variants of the per-timestamp query below. */
interface RawForecastRow {
  timestamp: string;
  p50: number;
  p10: number | null;
  p90: number | null;
  generated_at: string;
  /** `forecasts.horizon_hours` has no NOT NULL constraint. */
  horizon_hours: number | null;
  model_version: string | null;
}

/**
 * Groups rows already resolved to their winning vintage (see the `winners`
 * CTE in `getNetPositionForecast`) into one summary per distinct
 * `generated_at`, newest first.
 */
function buildVintages(rows: RawForecastRow[]): NetPositionForecastVintage[] {
  const byGeneratedAt = new Map<
    string,
    { model_version: string | null; horizons: number[]; targets: string[] }
  >();

  for (const r of rows) {
    let group = byGeneratedAt.get(r.generated_at);
    if (!group) {
      group = { model_version: r.model_version, horizons: [], targets: [] };
      byGeneratedAt.set(r.generated_at, group);
    }
    // horizon_hours is nullable at the DB layer - a null must never enter a
    // Math.min/Math.max reduction below, where JS coerces it to 0 and would
    // silently mislabel a D+2 (or later) vintage as D+1 downstream in
    // horizonDayLabel. Excluded here, not defaulted.
    if (r.horizon_hours != null) group.horizons.push(r.horizon_hours);
    group.targets.push(r.timestamp);
  }

  return [...byGeneratedAt.entries()]
    .map(([generated_at, g]) => ({
      generated_at,
      model_version: g.model_version,
      // null when every row in this vintage had a null horizon_hours - honest
      // "unknown" rather than a fabricated 0.
      horizon_hours_min: g.horizons.length ? Math.min(...g.horizons) : null,
      horizon_hours_max: g.horizons.length ? Math.max(...g.horizons) : null,
      target_count: g.targets.length,
      first_target: g.targets.reduce((a, b) => (a < b ? a : b)),
      last_target: g.targets.reduce((a, b) => (a > b ? a : b)),
    }))
    .sort((a, b) => (a.generated_at < b.generated_at ? 1 : -1));
}

/**
 * Freshest-per-target-timestamp forecast, across every vintage that exists.
 *
 * A country can have several runs on file at once - a daily D+2 job means
 * "today", "yesterday" and the day before all wrote a distinct generated_at,
 * each covering a *different* 24h target block. Pinning to the single newest
 * generated_at (the previous behaviour) discarded every other run wholesale,
 * so the day a new run landed, every day it used to cover went blank - see
 * the France "why is tomorrow empty" report this fixes.
 *
 * The fix is a per-timestamp MAX(generated_at), not a per-country one: for
 * each target_timestamp_utc, take the row from whichever vintage is newest
 * *for that timestamp*. Vintages are never blended within a single
 * timestamp - the quantile join below is keyed on the same winning
 * (timestamp, generated_at) pair, so a p50 from one run can never be paired
 * with a p10/p90 band from another.
 *
 * The model is still pinned via the registry (`resolveModelName`): this
 * maximises coverage across a model's own runs, it does not reopen "any
 * newer run of any model wins" - that was rejected on evidence (V011,
 * 2026-07-25, +11.7% pooled MAE) and stays rejected here.
 *
 * The p10/p90 band comes from forecast_quantiles. That table does not exist
 * on every deployment - it is created on first forecast write - so a missing
 * table degrades to a median-only forecast rather than failing the request.
 *
 * Bounded by [start, end] on `target_timestamp_utc`, same as
 * `getNetPositionActuals`. Without this bound the `winners` CTE resolves
 * MAX(generated_at) per timestamp across the model's *entire* history: since
 * nothing ever deletes an old vintage (each daily run targets a distinct
 * calendar day, so it never collides with - and therefore never supersedes -
 * an earlier run), every run this job has ever produced would accumulate as
 * a permanent "winner" and the response would grow without bound.
 */
export function getNetPositionForecast(
  countryCode: string,
  start: string,
  end: string,
  db: DatabaseType = defaultDb,
  modelId?: string
): { points: NetPositionForecastPoint[]; meta: ForecastMeta } {
  const code = storageCode(countryCode);
  const range = timestampRange(start, end);
  // Pin to the registered model. Selecting purely on generated_at let any
  // newer run take over the display by being newer - including V011, rejected
  // on evidence 2026-07-25 at +11.7% pooled MAE. A model must be registered.
  const modelName = resolveModelName('net_position', modelId);

  const emptyMeta: ForecastMeta = {
    bidding_zone: resolveBiddingZone(countryCode),
    model_name: null,
    vintages: [],
    has_band: false,
  };

  if (!modelName) return { points: [], meta: emptyMeta };

  const hasAny = db
    .prepare(
      `SELECT 1 AS present FROM forecasts
        WHERE country_code = ? AND forecast_type = 'net_position' AND model_name = ?
        LIMIT 1`
    )
    .get(code, modelName) as { present: number } | undefined;

  if (!hasAny) return { points: [], meta: emptyMeta };

  const withBand = hasTable(db, 'forecast_quantiles');

  // `winners` resolves, per target timestamp, the single freshest generated_at
  // among this model's runs. Everything downstream joins back onto that exact
  // (target_timestamp_utc, generated_at) pair, so a timestamp is always
  // sourced from one vintage end-to-end.
  const rows = (
    withBand
      ? db.prepare(
          `WITH winners AS (
             SELECT target_timestamp_utc, MAX(generated_at) AS generated_at
               FROM forecasts
              WHERE country_code = ? AND forecast_type = 'net_position' AND model_name = ?
                AND ${rangeClause('target_timestamp_utc')}
              GROUP BY target_timestamp_utc
           )
           SELECT
             REPLACE(f.target_timestamp_utc, ' ', 'T') as timestamp,
             f.forecast_value as p50,
             MAX(CASE WHEN q.quantile = 0.1 THEN q.forecast_value END) as p10,
             MAX(CASE WHEN q.quantile = 0.9 THEN q.forecast_value END) as p90,
             REPLACE(f.generated_at, ' ', 'T') as generated_at,
             f.horizon_hours as horizon_hours,
             f.model_version as model_version
           FROM forecasts f
           JOIN winners w
             ON w.target_timestamp_utc = f.target_timestamp_utc
            AND w.generated_at         = f.generated_at
           LEFT JOIN forecast_quantiles q
                  ON q.country_code         = f.country_code
                 AND q.forecast_type        = f.forecast_type
                 AND q.target_timestamp_utc = f.target_timestamp_utc
                 AND q.generated_at         = f.generated_at
                 AND q.model_name           = f.model_name
          WHERE f.country_code = ? AND f.forecast_type = 'net_position' AND f.model_name = ?
            AND ${rangeClause('f.target_timestamp_utc')}
          GROUP BY f.target_timestamp_utc, f.forecast_value, f.generated_at, f.horizon_hours, f.model_version
          ORDER BY f.target_timestamp_utc`
        )
      : db.prepare(
          `WITH winners AS (
             SELECT target_timestamp_utc, MAX(generated_at) AS generated_at
               FROM forecasts
              WHERE country_code = ? AND forecast_type = 'net_position' AND model_name = ?
                AND ${rangeClause('target_timestamp_utc')}
              GROUP BY target_timestamp_utc
           )
           SELECT
             REPLACE(f.target_timestamp_utc, ' ', 'T') as timestamp,
             f.forecast_value as p50,
             NULL as p10,
             NULL as p90,
             REPLACE(f.generated_at, ' ', 'T') as generated_at,
             f.horizon_hours as horizon_hours,
             f.model_version as model_version
           FROM forecasts f
           JOIN winners w
             ON w.target_timestamp_utc = f.target_timestamp_utc
            AND w.generated_at         = f.generated_at
          WHERE f.country_code = ? AND f.forecast_type = 'net_position' AND f.model_name = ?
            AND ${rangeClause('f.target_timestamp_utc')}
          ORDER BY f.target_timestamp_utc`
        )
  ).all(code, modelName, ...rangeArgs(range), code, modelName, ...rangeArgs(range)) as RawForecastRow[];

  const meta: ForecastMeta = {
    bidding_zone: resolveBiddingZone(countryCode),
    model_name: modelName,
    vintages: buildVintages(rows),
    has_band: withBand,
  };

  const points: NetPositionForecastPoint[] = rows.map((r) => ({
    timestamp: r.timestamp,
    p50: r.p50,
    p10: r.p10,
    p90: r.p90,
    generated_at: r.generated_at,
    horizon_hours: r.horizon_hours,
  }));

  return { points, meta };
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
  const { points, meta } = getNetPositionForecast(countryCode, start, end, db);
  return {
    actual,
    forecast: points,
    meta: { ...meta, last_seen: getLastSeen(countryCode, db) },
  };
}
