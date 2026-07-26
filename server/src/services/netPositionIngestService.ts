import type { Database as DatabaseType } from 'better-sqlite3';
import type { NetPositionForecastIngestPayload } from '../types/index.js';

export interface IngestResult {
  points: number;
  quantiles: number;
  /** True when an earlier copy of this same run was replaced. */
  replaced: boolean;
}

/**
 * DDL copied from energy-forecast/src/db.py::create_forecast_quantiles_table.
 * The forecast job creates this table in its own sidecar; the canonical
 * database has never had it, so the first write here creates it.
 */
const FORECAST_QUANTILES_DDL = `
  CREATE TABLE IF NOT EXISTS forecast_quantiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL,
    forecast_type TEXT NOT NULL,
    target_timestamp_utc TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    quantile REAL NOT NULL,
    forecast_value REAL NOT NULL,
    model_name TEXT NOT NULL
  )
`;

const FORECAST_QUANTILES_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_fq_lookup
  ON forecast_quantiles(country_code, forecast_type, target_timestamp_utc, model_name)
`;

export function ensureForecastQuantilesTable(db: DatabaseType): void {
  db.exec(FORECAST_QUANTILES_DDL);
  db.exec(FORECAST_QUANTILES_INDEX);
}

/**
 * Replace-then-insert one forecast vintage, in a single transaction.
 *
 * The delete is keyed on (country_code, forecast_type, model_name,
 * generated_at) so re-posting an identical run is a no-op in row count, while
 * separate runs - several a day is normal - are preserved as distinct
 * vintages that the read path can order by.
 */
export function ingestNetPositionForecast(
  db: DatabaseType,
  payload: NetPositionForecastIngestPayload
): IngestResult {
  ensureForecastQuantilesTable(db);

  const { model, generated_at, rows } = payload;
  const countries = [...new Set(rows.map((r) => r.country_code.toUpperCase()))];

  const countExisting = db.prepare(
    `SELECT COUNT(*) AS n FROM forecasts
      WHERE forecast_type = 'net_position'
        AND model_name = ? AND generated_at = ? AND country_code = ?`
  );
  const deletePoints = db.prepare(
    `DELETE FROM forecasts
      WHERE forecast_type = 'net_position'
        AND model_name = ? AND generated_at = ? AND country_code = ?`
  );
  const deleteQuantiles = db.prepare(
    `DELETE FROM forecast_quantiles
      WHERE forecast_type = 'net_position'
        AND model_name = ? AND generated_at = ? AND country_code = ?`
  );
  const insertPoint = db.prepare(
    `INSERT INTO forecasts
       (country_code, forecast_type, target_timestamp_utc, generated_at,
        horizon_hours, forecast_value, model_name, model_version)
     VALUES (?, 'net_position', ?, ?, ?, ?, ?, ?)`
  );
  const insertQuantile = db.prepare(
    `INSERT INTO forecast_quantiles
       (country_code, forecast_type, target_timestamp_utc, generated_at,
        quantile, forecast_value, model_name)
     VALUES (?, 'net_position', ?, ?, ?, ?, ?)`
  );

  const run = db.transaction((): IngestResult => {
    let replaced = false;
    for (const country of countries) {
      const existing = countExisting.get(model.name, generated_at, country) as { n: number };
      if (existing.n > 0) replaced = true;
      deletePoints.run(model.name, generated_at, country);
      deleteQuantiles.run(model.name, generated_at, country);
    }

    let points = 0;
    let quantiles = 0;
    for (const row of rows) {
      const country = row.country_code.toUpperCase();
      insertPoint.run(
        country,
        row.target_timestamp_utc,
        generated_at,
        row.horizon_hours ?? null,
        row.forecast_value,
        model.name,
        model.version ?? null
      );
      points += 1;

      for (const [level, value] of Object.entries(row.quantiles ?? {})) {
        const q = Number(level);
        if (!Number.isFinite(q) || !Number.isFinite(value)) continue;
        insertQuantile.run(
          country,
          row.target_timestamp_utc,
          generated_at,
          q,
          value,
          model.name
        );
        quantiles += 1;
      }
    }
    return { points, quantiles, replaced };
  });

  return run();
}
