import { Router, Request } from 'express';
import * as forecastComparisonService from '../services/forecastComparisonService.js';
import * as mlForecastService from '../services/mlForecastService.js';
import { cacheMiddleware, TTL } from '../middleware/cache.js';
import { AppError } from '../middleware/errorHandler.js';
import { resolveAccuracyModel } from '../config/forecastModels.js';
import { ForecastType } from '../types/index.js';

const router = Router();

// Valid forecast types for comparison
const VALID_FORECAST_TYPES: ForecastType[] = [
  'load', 'price', 'solar', 'wind_onshore', 'wind_offshore'
];

interface ComparisonQuery {
  forecastType?: ForecastType;
  start?: string;
  end?: string;
  /** Registered ml model id. Pins only the ml side; TSO metrics are unaffected. */
  model?: string;
}

interface MLAccuracyQuery {
  forecastType?: ForecastType;
  start?: string;
  end?: string;
  horizon?: string; // '1' for D+1, '2' for D+2
  /** Registered ml model id from the registry. Omit to keep the pre-existing unpinned behaviour. */
  model?: string;
}

/**
 * Resolve an accuracy request's `model` to a `forecasts.model_name`, or throw a
 * 400. Rejecting beats querying for an unregistered model: an unregistered id
 * returns no rows, which is indistinguishable from a model that legitimately
 * has no coverage here.
 */
function resolveMlModelOr400(forecastType: string, model: string | undefined) {
  const resolved = resolveAccuracyModel(forecastType, model, 'ml');
  if (!resolved.ok) {
    throw new AppError(resolved.message, 400, resolved.code);
  }
  return resolved.model;
}

interface RollingAccuracyQuery {
  forecastType?: ForecastType;
  start?: string;
  end?: string;
  windowDays?: string; // default: 7
  /** Registered ml model id. Pins only the ml series; TSO is unaffected. */
  model?: string;
}

/**
 * GET /api/forecast-comparison/:countryCode
 *
 * Get unified comparison metrics for all forecast providers and horizons.
 * Returns TSO (day-ahead, week-ahead) and ML (D+1, D+2) metrics.
 */
router.get(
  '/:countryCode',
  cacheMiddleware(TTL.MEDIUM),
  (req: Request<{ countryCode: string }, unknown, unknown, ComparisonQuery>, res) => {
    const { countryCode } = req.params;
    const { forecastType = 'load', start, end, model } = req.query;

    // Validate forecast type
    if (!VALID_FORECAST_TYPES.includes(forecastType)) {
      throw new AppError(
        `Invalid forecast type. Must be one of: ${VALID_FORECAST_TYPES.join(', ')}`,
        400,
        'INVALID_FORECAST_TYPE'
      );
    }

    const selectedModel = resolveMlModelOr400(forecastType, model);

    // Default to last 30 days for historical accuracy comparison
    const now = new Date();
    const endDate = end || now.toISOString();
    const startDate = start || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const data = forecastComparisonService.getUnifiedComparison(
      countryCode,
      forecastType,
      startDate,
      endDate,
      selectedModel?.modelName
    );

    res.json({
      success: true,
      data,
    });
  }
);

/**
 * GET /api/forecast-comparison/:countryCode/summary
 *
 * Get comparison metrics for all forecast types at once.
 */
router.get(
  '/:countryCode/summary',
  cacheMiddleware(TTL.LONG),
  (req: Request<{ countryCode: string }, unknown, unknown, { start?: string; end?: string }>, res) => {
    const { countryCode } = req.params;
    const { start, end } = req.query;

    // Default to last 30 days
    const now = new Date();
    const endDate = end || now.toISOString();
    const startDate = start || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const data = forecastComparisonService.getComparisonSummary(
      countryCode,
      startDate,
      endDate
    );

    res.json({
      success: true,
      data,
      meta: {
        countryCode: countryCode.toUpperCase(),
        timeRange: { start: startDate, end: endDate },
      },
    });
  }
);

/**
 * GET /api/forecast-comparison/:countryCode/best
 *
 * Get the best performing forecast for a specific type (lowest MAPE).
 */
router.get(
  '/:countryCode/best',
  cacheMiddleware(TTL.MEDIUM),
  (req: Request<{ countryCode: string }, unknown, unknown, ComparisonQuery>, res) => {
    const { countryCode } = req.params;
    const { forecastType = 'load', start, end, model } = req.query;

    // Validate forecast type
    if (!VALID_FORECAST_TYPES.includes(forecastType)) {
      throw new AppError(
        `Invalid forecast type. Must be one of: ${VALID_FORECAST_TYPES.join(', ')}`,
        400,
        'INVALID_FORECAST_TYPE'
      );
    }

    const selectedModel = resolveMlModelOr400(forecastType, model);

    // Default to last 30 days
    const now = new Date();
    const endDate = end || now.toISOString();
    const startDate = start || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const best = forecastComparisonService.getBestForecastByType(
      countryCode,
      forecastType,
      startDate,
      endDate,
      selectedModel?.modelName
    );

    res.json({
      success: true,
      data: best,
      meta: {
        countryCode: countryCode.toUpperCase(),
        forecastType,
        timeRange: { start: startDate, end: endDate },
        // Which ml model the 'ml' candidates were measured from. null = unpinned.
        mlModel: selectedModel?.id ?? null,
      },
    });
  }
);

/**
 * GET /api/forecast-comparison/:countryCode/rolling
 *
 * Get rolling accuracy metrics over time for trend chart.
 * Returns daily data points with MAPE/MAE for each provider/horizon.
 */
router.get(
  '/:countryCode/rolling',
  cacheMiddleware(TTL.MEDIUM),
  (req: Request<{ countryCode: string }, unknown, unknown, RollingAccuracyQuery>, res) => {
    const { countryCode } = req.params;
    const { forecastType = 'load', start, end, windowDays: windowDaysStr, model } = req.query;

    // Validate forecast type
    if (!VALID_FORECAST_TYPES.includes(forecastType)) {
      throw new AppError(
        `Invalid forecast type. Must be one of: ${VALID_FORECAST_TYPES.join(', ')}`,
        400,
        'INVALID_FORECAST_TYPE'
      );
    }

    const selectedModel = resolveMlModelOr400(forecastType, model);

    // Parse window days (default 7, max 30)
    const windowDays = windowDaysStr ? Math.min(Math.max(parseInt(windowDaysStr, 10), 1), 30) : 7;

    // Default to last 30 days
    const now = new Date();
    const endDate = end || now.toISOString();
    const startDate = start || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const data = forecastComparisonService.getRollingAccuracy(
      countryCode,
      forecastType,
      startDate,
      endDate,
      windowDays,
      selectedModel?.modelName
    );

    res.json({
      success: true,
      ...data,
    });
  }
);

/**
 * GET /api/forecast-comparison/:countryCode/ml-accuracy
 *
 * Get ML forecast accuracy data points (for charting).
 */
router.get(
  '/:countryCode/ml-accuracy',
  cacheMiddleware(TTL.MEDIUM),
  (req: Request<{ countryCode: string }, unknown, unknown, MLAccuracyQuery>, res) => {
    const { countryCode } = req.params;
    const { forecastType = 'load', start, end, horizon, model } = req.query;

    // Validate forecast type
    if (!VALID_FORECAST_TYPES.includes(forecastType) && forecastType !== 'renewable') {
      throw new AppError(
        `Invalid forecast type. Must be one of: ${VALID_FORECAST_TYPES.join(', ')}`,
        400,
        'INVALID_FORECAST_TYPE'
      );
    }

    const selectedModel = resolveMlModelOr400(forecastType, model);

    // Parse horizon
    const horizonNum = horizon ? parseInt(horizon, 10) as 1 | 2 : undefined;
    if (horizon && horizonNum !== 1 && horizonNum !== 2) {
      throw new AppError(
        'Horizon must be 1 (D+1) or 2 (D+2)',
        400,
        'INVALID_HORIZON'
      );
    }

    // Default to last 7 days for detailed accuracy data
    const now = new Date();
    const endDate = end || now.toISOString();
    const startDate = start || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const data = mlForecastService.getMLForecastAccuracy(
      countryCode,
      forecastType,
      startDate,
      endDate,
      horizonNum,
      'hourly',
      selectedModel?.modelName
    );

    const metrics = mlForecastService.getMLForecastAccuracyMetrics(
      countryCode,
      forecastType,
      startDate,
      endDate,
      horizonNum,
      selectedModel?.modelName
    );

    // Only ask the coverage question when the join produced nothing — that is
    // the only case where the answer is ambiguous.
    const coverage = mlForecastService.classifyCoverage(
      metrics.dataPoints,
      metrics.dataPoints > 0 ||
        mlForecastService.hasMLForecastRowsInWindow(
          countryCode, forecastType, startDate, endDate, selectedModel?.modelName
        )
    );

    res.json({
      success: true,
      data,
      metrics,
      meta: {
        count: data.length,
        countryCode: countryCode.toUpperCase(),
        forecastType,
        horizon: horizonNum,
        timeRange: { start: startDate, end: endDate },
        // What served. `model: null` means unpinned — the latest run per
        // timestamp regardless of model — NOT "catboost". Naming a model here
        // that was not filtered on would be a fabricated attribution.
        model: selectedModel?.id ?? null,
        modelRequested: model ?? null,
        // 'no_model_coverage' is a normal answer for a disjoint-coverage model,
        // not an error. It is what stops a country reading as a flawless 0%.
        coverage,
      },
    });
  }
);

export default router;
