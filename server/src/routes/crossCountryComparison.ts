import { Router, Request } from 'express';
import * as crossCountryMetricsService from '../services/crossCountryMetricsService.js';
import { cacheMiddleware, TTL } from '../middleware/cache.js';
import { AppError } from '../middleware/errorHandler.js';
import { ForecastType } from '../types/index.js';

const router = Router();

const VALID_FORECAST_TYPES: ForecastType[] = [
  'load', 'price', 'renewable', 'solar',
  'wind_onshore', 'wind_offshore', 'hydro_total', 'biomass'
];

interface MetricsQuery {
  start?: string;
  end?: string;
}

/**
 * GET /api/cross-country/metrics
 *
 * Returns accuracy metrics for ALL forecast types across all countries.
 */
router.get(
  '/metrics',
  cacheMiddleware(TTL.LONG),
  (req: Request<Record<string, never>, unknown, unknown, MetricsQuery>, res) => {
    const { start, end } = req.query;

    // Default to last 30 days
    const now = new Date();
    const endDate = end || now.toISOString();
    const startDate = start || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const data = crossCountryMetricsService.getCrossCountryMetricsAll(startDate, endDate);

    // Collect metadata
    const countriesSet = new Set<string>();
    const forecastTypes: string[] = [];
    for (const [type, countryMetrics] of Object.entries(data)) {
      forecastTypes.push(type);
      for (const cc of Object.keys(countryMetrics)) {
        countriesSet.add(cc);
      }
    }

    res.json({
      success: true,
      data,
      meta: {
        timeRange: { start: startDate, end: endDate },
        countriesWithData: Array.from(countriesSet).sort(),
        forecastTypes,
      },
    });
  }
);

/**
 * GET /api/cross-country/metrics/:forecastType
 *
 * Returns accuracy metrics for a single forecast type across all countries.
 */
router.get(
  '/metrics/:forecastType',
  cacheMiddleware(TTL.LONG),
  (req: Request<{ forecastType: string }, unknown, unknown, MetricsQuery>, res) => {
    const { forecastType } = req.params;
    const { start, end } = req.query;

    if (!VALID_FORECAST_TYPES.includes(forecastType as ForecastType)) {
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

    const countryMetrics = crossCountryMetricsService.getCrossCountryMetrics(
      forecastType as ForecastType,
      startDate,
      endDate
    );

    res.json({
      success: true,
      data: { [forecastType]: countryMetrics },
      meta: {
        timeRange: { start: startDate, end: endDate },
        countriesWithData: Object.keys(countryMetrics).sort(),
        forecastTypes: [forecastType],
      },
    });
  }
);

export default router;
