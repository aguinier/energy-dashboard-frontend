import { Router, Request } from 'express';
import * as dashboardService from '../services/dashboardService.js';
import * as loadService from '../services/loadService.js';
import { cacheMiddleware, TTL } from '../middleware/cache.js';
import { AppError } from '../middleware/errorHandler.js';
import { TimeRange, MetricType, Granularity } from '../types/index.js';
import { normalizeTimestamp } from '../utils/timestamp.js';

const router = Router();

interface OverviewQuery {
  country?: string;
  timeRange?: TimeRange;
}

interface MapQuery {
  metric?: MetricType;
  timeRange?: TimeRange;
}

interface TimeseriesQuery {
  country?: string;
  start?: string;
  end?: string;
}

// GET /api/dashboard/overview - Get key metrics for dashboard cards
// Use MEDIUM TTL (5 min) instead of SHORT - overview data changes slowly and this is an expensive query
router.get('/overview', cacheMiddleware(TTL.MEDIUM), (req: Request<object, unknown, unknown, OverviewQuery>, res) => {
  const { country, timeRange = '7d' } = req.query;

  if (!country) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  const data = dashboardService.getDashboardOverview(country, timeRange);

  res.json({
    success: true,
    data,
    meta: {
      country: country.toUpperCase(),
      timeRange,
    },
  });
});

// GET /api/dashboard/map - Get data for all countries (for map visualization)
router.get('/map', cacheMiddleware(TTL.LONG), (req: Request<object, unknown, unknown, MapQuery>, res) => {
  const { metric = 'load', timeRange = '24h' } = req.query;

  const validMetrics: MetricType[] = ['load', 'price', 'renewable_pct'];
  if (!validMetrics.includes(metric)) {
    throw new AppError(
      `Invalid metric. Must be one of: ${validMetrics.join(', ')}`,
      400,
      'INVALID_METRIC'
    );
  }

  const data = dashboardService.getMapData(metric, timeRange);

  res.json({
    success: true,
    data,
    meta: {
      metric,
      timeRange,
      count: data.length,
      unit: metric === 'load' ? 'MW' : metric === 'price' ? 'EUR/MWh' : '%',
    },
  });
});

// GET /api/dashboard/timeseries - Get combined time series for charts
router.get('/timeseries', cacheMiddleware(TTL.MEDIUM), (req: Request<object, unknown, unknown, TimeseriesQuery>, res) => {
  const { country, start, end } = req.query;

  if (!country) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  const endDate = end || new Date().toISOString();
  const startDate = start || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const data = dashboardService.getCombinedTimeseries(country, startDate, endDate);

  res.json({
    success: true,
    data,
    meta: {
      country: country.toUpperCase(),
      timeRange: { start: startDate, end: endDate },
      count: data.length,
    },
  });
});

// GET /api/dashboard/initial - Combined endpoint for initial country load
// Returns overview + load data in a single request to reduce round trips
interface InitialQuery {
  country?: string;
  timeRange?: TimeRange;
  start?: string;
  end?: string;
  granularity?: Granularity;
}

router.get('/initial', cacheMiddleware(TTL.MEDIUM), (req: Request<object, unknown, unknown, InitialQuery>, res) => {
  const { country, timeRange = '7d', start, end, granularity = 'hourly' } = req.query;

  if (!country) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  // Get overview data
  const overview = dashboardService.getDashboardOverview(country, timeRange);

  // Get load data for the default chart
  const endDate = end || new Date().toISOString();
  const startDate = start || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const normalizedStart = normalizeTimestamp(startDate);
  const normalizedEnd = normalizeTimestamp(endDate);
  
  const loadData = loadService.getLoadData(country, normalizedStart, normalizedEnd, granularity);

  res.json({
    success: true,
    data: {
      overview,
      loadData,
    },
    meta: {
      country: country.toUpperCase(),
      timeRange,
      loadDataCount: loadData.length,
    },
  });
});

export default router;
