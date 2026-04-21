import { Router, Request, Response, NextFunction } from 'express';
import writeDb from '../config/writeDatabase.js';
import { writeAuth } from '../middleware/writeAuth.js';
import { AppError } from '../middleware/errorHandler.js';

/**
 * POST /api/weather/snapshot
 *
 * Heliocast writes its hourly per-NWP-model weather pulls into the
 * canonical `weather_observation` table via this endpoint. Each call
 * inserts up to ~300 rows (one per target hour in the forecast window)
 * keyed by (source_id, location_id, valid_at, fetched_at).
 *
 * Authentication: Bearer token (HELIO_WRITE_TOKEN on server).
 *
 * Request body:
 * {
 *   "source": { "provider": "open_meteo_forecast", "model_id": "best_match",
 *                "lead_time_hours": -1 },
 *   "location": { "country_code": "BE", "zone_id": "central" },
 *   "fetched_at": "2026-04-21T12:45:02Z",
 *   "rows": [
 *     { "valid_at": "2026-04-21T13:00:00Z",
 *       "shortwave_radiation_wm2": 456.7,
 *       "temperature_2m_c": 12.3, ... },
 *     ...
 *   ]
 * }
 *
 * Response 201:
 *   { "success": true, "data": { "inserted": 288 } }
 *
 * Errors:
 *   400 - invalid payload (missing fields, bad types)
 *   401 - missing/invalid token
 *   404 - unknown location or source
 *   413 - payload too large (> MAX_ROWS)
 *   503 - write token not configured
 */

const router = Router();

const MAX_ROWS = 1000;

const WEATHER_COLS = [
  'shortwave_radiation_wm2', 'direct_radiation_wm2',
  'direct_normal_irradiance_wm2', 'diffuse_radiation_wm2',
  'global_tilted_irradiance_wm2', 'terrestrial_radiation_wm2',
  'shortwave_radiation_instant_wm2', 'direct_radiation_instant_wm2',
  'direct_normal_irradiance_instant_wm2', 'diffuse_radiation_instant_wm2',
  'global_tilted_irradiance_instant_wm2', 'terrestrial_radiation_instant_wm2',
  'cloud_cover_frac', 'cloud_cover_low_frac', 'cloud_cover_mid_frac',
  'cloud_cover_high_frac', 'sunshine_duration_s',
  'temperature_2m_c', 'dew_point_2m_c', 'relative_humidity_2m_frac',
  'pressure_msl_hpa',
  'wind_speed_10m_ms', 'wind_direction_10m_deg', 'wind_gusts_10m_ms',
  'wind_speed_100m_ms',
  'precip_mm', 'rain_mm', 'snowfall_mm',
];

interface SnapshotPayload {
  source: { provider: string; model_id: string; lead_time_hours: number };
  location: { country_code: string; zone_id: string };
  fetched_at: string;
  forecast_run_time?: string | null;
  rows: Array<{ valid_at: string } & Record<string, number | null | undefined>>;
}

function lookupSourceId(provider: string, model_id: string, lead: number): number | null {
  const row = writeDb.prepare(
    `SELECT source_id FROM weather_source
     WHERE provider = ? AND model_id = ? AND lead_time_hours = ?`
  ).get(provider, model_id, lead) as { source_id: number } | undefined;
  return row ? row.source_id : null;
}

function lookupLocationId(country_code: string, zone_id: string): number | null {
  const row = writeDb.prepare(
    `SELECT location_id FROM weather_location
     WHERE country_code = ? AND zone_id = ?`
  ).get(country_code, zone_id) as { location_id: number } | undefined;
  return row ? row.location_id : null;
}

router.post('/snapshot', writeAuth, (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as SnapshotPayload;

    // Basic schema validation.
    if (!body || typeof body !== 'object') {
      throw new AppError('Request body must be a JSON object.', 400, 'BAD_PAYLOAD');
    }
    if (!body.source || !body.location || !body.fetched_at || !Array.isArray(body.rows)) {
      throw new AppError(
        'Missing required fields: source, location, fetched_at, rows.',
        400, 'BAD_PAYLOAD',
      );
    }
    if (body.rows.length === 0) {
      res.status(201).json({ success: true, data: { inserted: 0 } });
      return;
    }
    if (body.rows.length > MAX_ROWS) {
      throw new AppError(
        `Too many rows (${body.rows.length}); max ${MAX_ROWS}.`,
        413, 'PAYLOAD_TOO_LARGE',
      );
    }

    // Look up dimension IDs.
    const source_id = lookupSourceId(
      body.source.provider, body.source.model_id, body.source.lead_time_hours,
    );
    if (source_id === null) {
      throw new AppError(
        `Unknown source (${body.source.provider}/${body.source.model_id}/${body.source.lead_time_hours})`,
        404, 'UNKNOWN_SOURCE',
      );
    }

    const location_id = lookupLocationId(
      body.location.country_code, body.location.zone_id,
    );
    if (location_id === null) {
      throw new AppError(
        `Unknown location (${body.location.country_code}/${body.location.zone_id})`,
        404, 'UNKNOWN_LOCATION',
      );
    }

    // Prepare INSERT statement once (better-sqlite3 caches compiled plans).
    const cols = [
      'source_id', 'location_id', 'valid_at', 'forecast_run_time', 'fetched_at',
      ...WEATHER_COLS,
    ];
    const placeholders = cols.map(() => '?').join(',');
    const sql = `INSERT OR IGNORE INTO weather_observation (${cols.join(',')}) VALUES (${placeholders})`;
    const stmt = writeDb.prepare(sql);

    const runTx = writeDb.transaction((rows: SnapshotPayload['rows']) => {
      let inserted = 0;
      for (const row of rows) {
        if (!row.valid_at || typeof row.valid_at !== 'string') continue;
        const values: Array<number | string | null> = [
          source_id,
          location_id,
          row.valid_at,
          body.forecast_run_time ?? null,
          body.fetched_at,
        ];
        for (const col of WEATHER_COLS) {
          const v = row[col];
          values.push(v === undefined || v === null || Number.isNaN(v as number) ? null : v);
        }
        const r = stmt.run(...values);
        inserted += r.changes;
      }
      return inserted;
    });

    const inserted = runTx(body.rows);

    res.status(201).json({
      success: true,
      data: {
        inserted,
        source_id,
        location_id,
        fetched_at: body.fetched_at,
        rows_submitted: body.rows.length,
      },
    });
  } catch (e) {
    next(e);
  }
});

export default router;
