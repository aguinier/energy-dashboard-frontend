import { Router, Request } from 'express';
import * as tsoForecastService from '../services/tsoForecastService.js';
import { cacheMiddleware, TTL } from '../middleware/cache.js';
import { AppError } from '../middleware/errorHandler.js';
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

    const data = tsoForecastService.getLoadForecast(
      countryCode,
      startDate,
      endDate,
      forecastType,
      granularity
    );

    res.json({
      success: true,
      data,
      meta: {
        count: data.length,
        timeRange: { start: startDate, end: endDate },
        forecastType,
        granularity,
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
    const { start, end, forecastType = 'day_ahead', granularity = 'hourly' } = req.query;

    // Default to last 7 days for accuracy comparison
    const now = new Date();
    const endDate = end || now.toISOString();
    const startDate = start || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const data = tsoForecastService.getLoadForecastAccuracy(
      countryCode,
      startDate,
      endDate,
      forecastType,
      granularity
    );

    const metrics = tsoForecastService.getLoadForecastAccuracyMetrics(
      countryCode,
      startDate,
      endDate,
      forecastType
    );

    res.json({
      success: true,
      data,
      metrics,
      meta: {
        count: data.length,
        timeRange: { start: startDate, end: endDate },
        forecastType,
        granularity,
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
    const { start, end, type, granularity = 'hourly' } = req.query;

    if (!type || !['solar', 'wind_onshore', 'wind_offshore'].includes(type)) {
      throw new AppError(
        'Generation type is required (solar, wind_onshore, or wind_offshore)',
        400,
        'INVALID_GENERATION_TYPE'
      );
    }

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
