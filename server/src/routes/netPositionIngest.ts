import { Router } from 'express';
import { getWriteDb } from '../config/writeDatabase.js';
import { writeAuth } from '../middleware/writeAuth.js';
import { AppError } from '../middleware/errorHandler.js';
import { ingestNetPositionForecast } from '../services/netPositionIngestService.js';
import type { NetPositionForecastIngestPayload } from '../types/index.js';

/**
 * POST /forecasts/net-position
 *
 * The workstation's daily Chronos-2 run posts its net-position forecast here.
 * Forecasts are produced on the GPU box but must live in the canonical
 * database for either dashboard to show them.
 *
 * Generalized under ABL-240 to accept an optional `forecast_type` -
 * 'net_position' (the default, unchanged), 'wind_onshore' or 'wind_offshore'
 * - rather than duplicating this route for the ABL-239 wind shadow-candidate
 * backfill. The keying, auth gate and row limit are identical for every
 * type; only which `forecasts.forecast_type` value the rows land under
 * varies. Omitting the field preserves the exact pre-existing behavior, so
 * the Chronos-2 job (which never sends it) needs no change.
 *
 * Authentication: Bearer token (HELIO_WRITE_TOKEN on server), same as
 * POST /api/weather/snapshot.
 *
 * Request body:
 * {
 *   "forecast_type": "net_position",
 *   "model": { "name": "chronos-2-V010", "version": "20260726_070628" },
 *   "generated_at": "2026-07-26 07:06:28.960696",
 *   "rows": [
 *     { "country_code": "BE",
 *       "target_timestamp_utc": "2026-07-28 00:00:00",
 *       "horizon_hours": 40,
 *       "forecast_value": -57.2,
 *       "quantiles": { "0.1": -166.5, "0.5": -57.2, "0.9": 56.1 } }
 *   ]
 * }
 *
 * Response 201:
 *   { "success": true, "data": { "points": 24, "quantiles": 216, "replaced": true } }
 *
 * Re-posting the same run is safe: rows for a given
 * (country, forecast_type, model_name, generated_at) are replaced, not
 * appended. Re-running the job after a failure is normal operation, and
 * duplicated forecast rows would silently corrupt later accuracy work.
 *
 * Errors:
 *   400 - invalid payload/forecast_type   401 - missing/invalid token
 *   413 - too many rows                   503 - write token not configured
 */

const router = Router();

const MAX_ROWS = 5000;
const ALLOWED_FORECAST_TYPES = new Set(['net_position', 'wind_onshore', 'wind_offshore']);

router.post('/net-position', writeAuth, (req, res, next) => {
  try {
    const body = req.body as NetPositionForecastIngestPayload;

    if (!body || typeof body !== 'object') {
      throw new AppError('Request body must be a JSON object.', 400, 'BAD_PAYLOAD');
    }
    if (!body.model?.name || !body.generated_at || !Array.isArray(body.rows)) {
      throw new AppError(
        'Missing required fields: model.name, generated_at, rows.',
        400, 'BAD_PAYLOAD',
      );
    }
    if (body.forecast_type !== undefined && !ALLOWED_FORECAST_TYPES.has(body.forecast_type)) {
      throw new AppError(
        `Unknown forecast_type '${body.forecast_type}'. Allowed: ${[...ALLOWED_FORECAST_TYPES].join(', ')}.`,
        400, 'UNKNOWN_FORECAST_TYPE',
      );
    }
    if (body.rows.length === 0) {
      res.status(201).json({
        success: true,
        data: { points: 0, quantiles: 0, replaced: false },
      });
      return;
    }
    if (body.rows.length > MAX_ROWS) {
      throw new AppError(
        `Too many rows (${body.rows.length}); max ${MAX_ROWS}.`,
        413, 'PAYLOAD_TOO_LARGE',
      );
    }

    for (const row of body.rows) {
      if (
        typeof row?.country_code !== 'string' ||
        typeof row?.target_timestamp_utc !== 'string' ||
        typeof row?.forecast_value !== 'number' ||
        !Number.isFinite(row.forecast_value)
      ) {
        throw new AppError(
          'Each row needs country_code, target_timestamp_utc and a finite forecast_value.',
          400, 'BAD_ROW',
        );
      }
    }

    const result = ingestNetPositionForecast(getWriteDb(), body);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

export default router;
