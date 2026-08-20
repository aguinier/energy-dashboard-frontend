import { Router, Request } from 'express';
import * as tsoForecastService from '../services/tsoForecastService.js';
import { cacheMiddleware, TTL } from '../middleware/cache.js';
import { AppError } from '../middleware/errorHandler.js';
import { resolveAccuracyModel } from '../config/forecastModels.js';
import { Granularity } from '../types/index.js';

const router = Router();

interface LoadForecastQuery {
  start?: string;
  end?: string;
  forecastType?: 'day_ahead' | 'week_ahead' | 'all';
  granularity?: Granularity;
}

interface GenerationForecastQuery {
  start?: string;
  end?: string;
  granularity?: Granularity;
}

interface AccuracyQuery {
  start?: string;
  end?: string;
  forecastType?: 'day_ahead' | 'week_ahead' | 'all';
  type?: 'solar' | 'wind_onshore' | 'wind_offshore';
  granularity?: Granularity;
  /** Registered tso model id ('tso-d1' | 'tso-d7'). An alias for the horizon. */
  model?: string;
}

/**
 * Resolve a `model` id on a TSO accuracy route to the horizon it names.
 *
 * On these routes a tso model IS a horizon — `tso-d1` is day-ahead, `tso-d7`
 * is week-ahead — so `model` and `forecastType` are two spellings of one
 * choice. When both are given and disagree, reject: silently honouring one
 * would label the response with a horizon the caller did not ask for, which
 * is the same class of wrong-number bug as a mislabelled model.
 *
 * Returns undefined when no model was given, leaving `forecastType` in charge
 * exactly as before.
 */
function resolveTsoHorizonOr400(
  registryType: string,
  model: string | undefined,
  explicitForecastType: 'day_ahead' | 'week_ahead' | 'all' | undefined
): 'day_ahead' | 'week_ahead' | undefined {
  const resolved = resolveAccuracyModel(registryType, model, 'tso');
  if (!resolved.ok) {
    throw new AppError(resolved.message, 400, resolved.code);
  }
  const horizon = resolved.model?.tsoHorizon;
  if (!horizon) return undefined;

  if (explicitForecastType && explicitForecastType !== horizon) {
    throw new AppError(
      `model='${model}' is the ${horizon} forecast but forecastType='${explicitForecastType}' was also given. ` +
        `Send one or the other.`,
      400,
      'MODEL_HORIZON_CONFLICT'
    );
  }
  return horizon;
}

// GET /api/tso-forecast/load/:countryCode - Get TSO load forecasts
router.get(
  '/load/:countryCode',
  cacheMiddleware(TTL.SHORT),
  (req: Request<{ countryCode: string }, unknown, unknown, LoadForecastQuery>, res) => {
    const { countryCode } = req.params;
    const { start, end, forecastType = 'day_ahead', granularity = 'hourly' } = req.query;

    // Default to next 7 days for forecasts
    const now = new Date();
    const startDate = start || now.toISOString();
    const endDate = end || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const series = tsoForecastService.getServedLoadForecast(
      countryCode,
      startDate,
      endDate,
      forecastType,
      granularity
    );

    res.json({
      success: true,
      data: series.data,
      meta: {
        count: series.data.length,
        timeRange: { start: startDate, end: endDate },
        forecastType,
        granularity,
        // See `/api/forecasts`' meta for why the verdict is on every response
        // rather than only on a withheld one, and why `withheldPoints` cannot
        // be folded into `count`.
        basis: series.basis,
        basisNote: series.basisNote,
        withheldPoints: series.withheldPoints,
      },
    });
  }
);

// GET /api/tso-forecast/generation/:countryCode - Get TSO generation forecasts (solar + wind)
router.get(
  '/generation/:countryCode',
  cacheMiddleware(TTL.SHORT),
  (req: Request<{ countryCode: string }, unknown, unknown, GenerationForecastQuery>, res) => {
    const { countryCode } = req.params;
    const { start, end, granularity = 'hourly' } = req.query;

    // Default to next 7 days for forecasts
    const now = new Date();
    const startDate = start || now.toISOString();
    const endDate = end || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const data = tsoForecastService.getGenerationForecast(
      countryCode,
      startDate,
      endDate,
      granularity
    );

    res.json({
      success: true,
      data,
      meta: {
        count: data.length,
        timeRange: { start: startDate, end: endDate },
        granularity,
      },
    });
  }
);

// GET /api/tso-forecast/accuracy/load/:countryCode - Get load forecast accuracy comparison
router.get(
  '/accuracy/load/:countryCode',
  cacheMiddleware(TTL.MEDIUM),
  (req: Request<{ countryCode: string }, unknown, unknown, AccuracyQuery>, res) => {
    const { countryCode } = req.params;
    const { start, end, forecastType, granularity = 'hourly', model } = req.query;

    // `model` is an alias for the horizon here; when absent, forecastType keeps
    // its pre-existing 'day_ahead' default.
    const horizon = resolveTsoHorizonOr400('load', model, forecastType);
    const resolvedForecastType = horizon ?? forecastType ?? 'day_ahead';

    // Default to last 7 days for accuracy comparison
    const now = new Date();
    const endDate = end || now.toISOString();
    const startDate = start || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const data = tsoForecastService.getLoadForecastAccuracy(
      countryCode,
      startDate,
      endDate,
      resolvedForecastType,
      granularity
    );

    const metrics = tsoForecastService.getLoadForecastAccuracyMetrics(
      countryCode,
      startDate,
      endDate,
      resolvedForecastType
    );

    res.json({
      success: true,
      data,
      metrics,
      meta: {
        count: data.length,
        timeRange: { start: startDate, end: endDate },
        forecastType: resolvedForecastType,
        granularity,
        // The registry id for the horizon that served, so a caller that asked
        // by model gets its own vocabulary back.
        model: resolvedForecastType === 'week_ahead' ? 'tso-d7'
          : resolvedForecastType === 'day_ahead' ? 'tso-d1' : null,
        modelRequested: model ?? null,
        // Whether realized load and this forecast measure the same quantity.
        // `data` is still the real paired series either way — it is only the
        // aggregate error in `metrics` that a divergent basis invalidates.
        basis: metrics.basis,
        basisNote: metrics.basisNote,
      },
    });
  }
);

// GET /api/tso-forecast/accuracy/generation/:countryCode - Get generation forecast accuracy comparison
router.get(
  '/accuracy/generation/:countryCode',
  cacheMiddleware(TTL.MEDIUM),
  (req: Request<{ countryCode: string }, unknown, unknown, AccuracyQuery>, res) => {
    const { countryCode } = req.params;
    const { start, end, type, granularity = 'hourly', model } = req.query;

    if (!type || !['solar', 'wind_onshore', 'wind_offshore'].includes(type)) {
      throw new AppError(
        'Generation type is required (solar, wind_onshore, or wind_offshore)',
        400,
        'INVALID_GENERATION_TYPE'
      );
    }

    // Generation TSO forecasts are day-ahead only in the registry, so `model`
    // here can only ever be 'tso-d1'. Validating it still matters: asking for
    // 'tso-d7' solar must be rejected, not silently answered with D+1.
    resolveTsoHorizonOr400(type, model, undefined);

    // Default to last 7 days for accuracy comparison
    const now = new Date();
    const endDate = end || now.toISOString();
    const startDate = start || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const data = tsoForecastService.getGenerationForecastAccuracy(
      countryCode,
      startDate,
      endDate,
      type,
      granularity
    );

    const metrics = tsoForecastService.getGenerationForecastAccuracyMetrics(
      countryCode,
      startDate,
      endDate,
      type
    );

    res.json({
      success: true,
      data,
      metrics,
      meta: {
        count: data.length,
        timeRange: { start: startDate, end: endDate },
        generationType: type,
        granularity,
        // Day-ahead is the only registered generation TSO forecast.
        model: 'tso-d1',
        modelRequested: model ?? null,
      },
    });
  }
);

// GET /api/tso-forecast/metrics/:countryCode - Get aggregate accuracy metrics
router.get(
  '/metrics/:countryCode',
  cacheMiddleware(TTL.MEDIUM),
  (req: Request<{ countryCode: string }, unknown, unknown, { start?: string; end?: string }>, res) => {
    const { countryCode } = req.params;
    const { start, end } = req.query;

    // Default to last 30 days for metrics
    const now = new Date();
    const endDate = end || now.toISOString();
    const startDate = start || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const loadMetrics = tsoForecastService.getLoadForecastAccuracyMetrics(
      countryCode,
      startDate,
      endDate,
      'day_ahead'
    );

    const solarMetrics = tsoForecastService.getGenerationForecastAccuracyMetrics(
      countryCode,
      startDate,
      endDate,
      'solar'
    );

    const windOnshoreMetrics = tsoForecastService.getGenerationForecastAccuracyMetrics(
      countryCode,
      startDate,
      endDate,
      'wind_onshore'
    );

    const windOffshoreMetrics = tsoForecastService.getGenerationForecastAccuracyMetrics(
      countryCode,
      startDate,
      endDate,
      'wind_offshore'
    );

    res.json({
      success: true,
      data: {
        load: loadMetrics,
        solar: solarMetrics,
        wind_onshore: windOnshoreMetrics,
        wind_offshore: windOffshoreMetrics,
      },
      meta: {
        timeRange: { start: startDate, end: endDate },
      },
    });
  }
);

export default router;
