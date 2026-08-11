import type { Database as DatabaseType } from 'better-sqlite3';

/**
 * Append-only capture of every distinct forecast value ever observed, keyed so
 * a re-refresh that carries the same value is a no-op and a re-refresh that
 * carries a DIFFERENT value under the same natural key lands as a new row
 * rather than overwriting the old one (ABL-184).
 *
 * WHY THIS EXISTS
 *
 * `forecasts` and the two TSO tables (`energy_load_forecast`,
 * `energy_generation_forecast`) are replace-on-refresh: a new fetch/run can
 * overwrite the row for a given target timestamp before anything has read the
 * value it replaced. `ingestNetPositionForecast` in
 * `netPositionIngestService.ts` is a concrete, in-repo example — its
 * `deletePoints`/`deleteQuantiles` statements delete-then-reinsert every row
 * for a (forecast_type, model_name, generated_at, country_code) vintage on
 * every POST, so a corrected re-run under the same `generated_at` destroys the
 * value it replaces with nothing keeping the original. The TSO tables are
 * worse: their unique constraint is `(country_code, target_timestamp_utc,
 * forecast_type)` with no run/issue-time dimension at all, so ANY refresh for
 * an existing target timestamp is a guaranteed overwrite (ABL-134).
 *
 * This archive does not change any of that — it is a second, additive reader
 * that races to record a value before the next refresh can destroy it.
 *
 * IDENTITY / DEDUPE KEY
 *
 * `UNIQUE(source, forecast_type, country_code, target_timestamp_utc,
 * model_name, run_timestamp_utc, forecast_value)` — the five columns the issue
 * asked for, plus `source` (ml vs tso, since the two live in different upstream
 * tables) and `forecast_value` itself. Including the value is what makes "a
 * changed value under an unchanged key lands as a new vintage" work even in
 * the worst case, where an upstream UPDATE changes `forecast_value` in place
 * without bumping any timestamp column at all: without the value in the key, a
 * second capture would see an identical (type, country, target, model,
 * run_timestamp) tuple and silently skip the correction. With it, the two
 * value's rows are simply two different tuples, and both are kept.
 *
 * TSO RUN TIMESTAMP
 *
 * Neither TSO table reliably carries a run/issue timestamp — the DDL has a
 * `forecast_run_time` column but it is never populated (an ENTSO-E API
 * limitation, per `database_structure.md`). `run_timestamp_utc` here is
 * `COALESCE(publication_timestamp_utc, created_at)`: ENTSO-E's own publication
 * time when we have it, falling back to when THIS ROW was written (a real,
 * already-stored value — not a fabrication) when we don't. This is not a
 * backfill of `publication_timestamp_utc` itself (forbidden — see CLAUDE.md
 * "Boundaries"): the source column is never written to, only read.
 *
 * `energy_generation_forecast` is wide (solar_mw, wind_onshore_mw,
 * wind_offshore_mw in one row); it is unpivoted into one archive row per
 * populated metric so the archive is uniformly one-row-per-(type, country,
 * target, model, run), matching how `forecasts` already stores each renewable
 * type as its own row.
 *
 * SCAN COST — MEASURED, AND WHY THIS NEVER RUNS ON THE MAIN THREAD
 *
 * Deliberately a full `INSERT OR IGNORE ... SELECT` over each source table on
 * every call, made idempotent by the UNIQUE index rather than by an
 * incremental watermark. A watermark (only rescan rows newer than the last
 * captured run) would cut the scan cost, but its correctness depends on the
 * upstream write pattern always advancing a timestamp column on overwrite —
 * true for the delete-then-reinsert pattern this repo's own
 * `netPositionIngestService` uses, unverified for whatever writes the other
 * eight ML forecast types and the two TSO tables (both live in the sibling
 * `energy_forecast` / `energy-data-gathering` repos, out of this codebase's
 * view). Flagged as a follow-up rather than guessed at here.
 *
 * Measured against a full copy of the production-scale replica (2026-08-11,
 * `forecasts` 2.1M rows, `energy_load_forecast` 2.4M, `energy_generation_forecast`
 * 3.0M): a first capture pass takes **~147s**, and even a fully idempotent
 * no-op rescan of unchanged data takes **~23s**. better-sqlite3 is
 * synchronous, so calling this function from Express's request-handling
 * thread would freeze every other dashboard API response for that long —
 * `captureForecastVintages` itself is a plain synchronous function for
 * testability, but its only production caller,
 * `services/forecastVintageArchiveScheduler.ts`, always runs it inside
 * `workers/captureForecastVintagesWorker.ts`, on a separate thread, on a
 * timer. Do not call it directly from a route handler.
 */

const FORECAST_VINTAGE_ARCHIVE_DDL = `
  CREATE TABLE IF NOT EXISTS forecast_vintage_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL CHECK (source IN ('ml', 'tso')),
    forecast_type TEXT NOT NULL,
    country_code TEXT NOT NULL,
    target_timestamp_utc TEXT NOT NULL,
    model_name TEXT NOT NULL,
    run_timestamp_utc TEXT NOT NULL,
    horizon_hours INTEGER,
    forecast_value REAL NOT NULL,
    first_seen_at TEXT NOT NULL
  )
`;

const FORECAST_VINTAGE_ARCHIVE_IDENTITY_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_forecast_vintage_archive_identity
  ON forecast_vintage_archive (
    source, forecast_type, country_code, target_timestamp_utc,
    model_name, run_timestamp_utc, forecast_value
  )
`;

const FORECAST_VINTAGE_ARCHIVE_LOOKUP_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_forecast_vintage_archive_lookup
  ON forecast_vintage_archive (forecast_type, country_code, target_timestamp_utc)
`;

/**
 * Additive, non-breaking: only ever CREATE TABLE/INDEX IF NOT EXISTS. Never
 * touches any existing table. Safe to call on every capture, mirroring
 * `ensureForecastQuantilesTable` in `netPositionIngestService.ts`.
 */
export function ensureForecastVintageArchiveTable(db: DatabaseType): void {
  db.exec(FORECAST_VINTAGE_ARCHIVE_DDL);
  db.exec(FORECAST_VINTAGE_ARCHIVE_IDENTITY_INDEX);
  db.exec(FORECAST_VINTAGE_ARCHIVE_LOOKUP_INDEX);
}

export interface CaptureResult {
  /** New rows captured from `forecasts` (all nine ML forecast types). */
  ml: number;
  /** New rows captured from `energy_load_forecast` (TSO day/week-ahead load). */
  tsoLoad: number;
  /** New rows captured from `energy_generation_forecast`, one metric each. */
  tsoSolar: number;
  tsoWindOnshore: number;
  tsoWindOffshore: number;
  total: number;
}

/** The three unpivoted metrics `energy_generation_forecast` carries in one row. */
const TSO_GENERATION_METRICS = [
  { forecastType: 'solar', column: 'solar_mw' },
  { forecastType: 'wind_onshore', column: 'wind_onshore_mw' },
  { forecastType: 'wind_offshore', column: 'wind_offshore_mw' },
] as const;

/**
 * Capture every forecast row currently sitting in `forecasts`,
 * `energy_load_forecast` and `energy_generation_forecast` that this archive
 * has not already recorded, i.e. whose (source, forecast_type, country,
 * target time, model, run timestamp, value) tuple is new.
 *
 * Idempotent: calling this twice with no change to the source tables inserts
 * nothing the second time (`INSERT OR IGNORE` against the UNIQUE identity
 * index) and never updates or deletes an existing archive row.
 */
export function captureForecastVintages(
  db: DatabaseType,
  firstSeenAt: string = new Date().toISOString()
): CaptureResult {
  ensureForecastVintageArchiveTable(db);

  const run = db.transaction((): CaptureResult => {
    const ml = db
      .prepare(
        `INSERT OR IGNORE INTO forecast_vintage_archive
           (source, forecast_type, country_code, target_timestamp_utc,
            model_name, run_timestamp_utc, horizon_hours, forecast_value, first_seen_at)
         SELECT 'ml', forecast_type, country_code, target_timestamp_utc,
                model_name, generated_at, horizon_hours, forecast_value, ?
         FROM forecasts`
      )
      .run(firstSeenAt).changes;

    const tsoLoad = db
      .prepare(
        `INSERT OR IGNORE INTO forecast_vintage_archive
           (source, forecast_type, country_code, target_timestamp_utc,
            model_name, run_timestamp_utc, horizon_hours, forecast_value, first_seen_at)
         SELECT 'tso', 'load', country_code, target_timestamp_utc,
                'tso-' || forecast_type, COALESCE(publication_timestamp_utc, created_at),
                horizon_hours, forecast_value_mw, ?
         FROM energy_load_forecast`
      )
      .run(firstSeenAt).changes;

    const tsoGen: Record<string, number> = {};
    for (const { forecastType, column } of TSO_GENERATION_METRICS) {
      // `column` and `forecastType` are literal identifiers from the fixed
      // array above, never external input — safe to interpolate, same
      // discipline as `rangeClause()` in `utils/timestamp.ts`.
      tsoGen[forecastType] = db
        .prepare(
          `INSERT OR IGNORE INTO forecast_vintage_archive
             (source, forecast_type, country_code, target_timestamp_utc,
              model_name, run_timestamp_utc, horizon_hours, forecast_value, first_seen_at)
           SELECT 'tso', '${forecastType}', country_code, target_timestamp_utc,
                  'tso-' || forecast_type, COALESCE(publication_timestamp_utc, created_at),
                  NULL, ${column}, ?
           FROM energy_generation_forecast
           WHERE ${column} IS NOT NULL`
        )
        .run(firstSeenAt).changes;
    }

    const tsoSolar = tsoGen.solar ?? 0;
    const tsoWindOnshore = tsoGen.wind_onshore ?? 0;
    const tsoWindOffshore = tsoGen.wind_offshore ?? 0;

    return {
      ml,
      tsoLoad,
      tsoSolar,
      tsoWindOnshore,
      tsoWindOffshore,
      total: ml + tsoLoad + tsoSolar + tsoWindOnshore + tsoWindOffshore,
    };
  });

  return run();
}
