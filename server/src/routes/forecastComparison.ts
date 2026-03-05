import { Router, Request } from 'express';
import * as forecastComparisonService from '../services/forecastComparisonService.js';
import * as mlForecastService from '../services/mlForecastService.js';
import { cacheMiddleware, TTL } from '../middleware/cache.js';
import { AppError } from '../middleware/errorHandler.js';
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
}

interface MLAccuracyQuery {
  forecastType?: ForecastType;
  start?: string;
  end?: string;
  horizon?: string; // '1' for D+1, '2' for D+2
}

interface RollingAccuracyQuery {
  forecastType?: ForecastType;
  start?: string;
  end?: string;
  windowDays?: string; // default: 7
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
    const { forecastType = 'load', start, end } = req.query;

    // Validate forecast type
    if (!VALID_FORECAST_TYPES.includes(forecastType)) {
      throw new AppError(
        `Invalid forecast type. Must be one of: ${VALID_FORECAST_TYPES.join(', ')}`,
        400,
        'INVALID_FORECAST_TYPE'
      );
    }

    // Default to last 30 days for historical accuracy comparison
    const now = new Date();
    const endDate = end || now.toISOString();
    const startDate = start || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const data = forecastComparisonService.getUnifiedComparison(
      countryCode,
      forecastType,
      startDate,
      endDate
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
    const { forecastType = 'load', start, end } = req.query;

    // Validate forecast type
    if (!VALID_FORECAST_TYPES.includes(forecastType)) {
      throw new AppError(
        `Invalid forecast type. Must be one of: ${VALID_FORECAST_TYPES.join(', ')}`,
        400,
        'INVALID_FORECAST_TYPE'
      );
    }

    // Default to last 30 days
    const now = new Date();
    const endDate = end || now.toISOString();
    const startDate = start || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const best = forecastComparisonService.getBestForecastByType(
      countryCode,
      forecastType,
      startDate,
      endDate
    );

    res.json({
      success: true,
      data: best,
      meta: {
        countryCode: countryCode.toUpperCase(),
        forecastType,
        timeRange: { start: startDate, end: endDate },
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
    const { forecastType = 'load', start, end, windowDays: windowDaysStr } = req.query;

    // Validate forecast type
    if (!VALID_FORECAST_TYPES.includes(forecastType)) {
      throw new AppError(
        `Invalid forecast type. Must be one of: ${VALID_FORECAST_TYPES.join(', ')}`,
        400,
        'INVALID_FORECAST_TYPE'
      );
    }

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
      windowDays
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
    const { forecastType = 'load', start, end, horizon } = req.query;

    // Validate forecast type
    if (!VALID_FORECAST_TYPES.includes(forecastType) && forecastType !== 'renewable') {
      throw new AppError(
        `Invalid forecast type. Must be one of: ${VALID_FORECAST_TYPES.join(', ')}`,
        400,
        'INVALID_FORECAST_TYPE'
      );
    }

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
      'hourly'
    );

    const metrics = mlForecastService.getMLForecastAccuracyMetrics(
      countryCode,
      forecastType,
      startDate,
      endDate,
      horizonNum
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
      },
    });
  }
);

export default router;
