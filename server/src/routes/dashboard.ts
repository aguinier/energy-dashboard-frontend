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
  start?: string;
  end?: string;
}

interface MapQuery {
  metric?: MetricType;
  timeRange?: TimeRange;
  start?: string;
  end?: string;
}

interface TimeseriesQuery {
  country?: string;
  start?: string;
  end?: string;
}

// GET /api/dashboard/overview - Get key metrics for dashboard cards
// Use MEDIUM TTL (5 min) instead of SHORT - overview data changes slowly and this is an expensive query
//
// Accepts an explicit `start`/`end` window (what every other endpoint already
// takes) in addition to the legacy `timeRange` enum. When both `start` and
// `end` are present they win; `timeRange` is only consulted as the fallback,
// so an older client that never learned about `start`/`end` keeps getting
// exactly the enum-derived window it always did (see `getTimeRangeDates` in
// dashboardService.ts). This is what let the client stop faking `timePreset`
// (e.g. `next24h`, `today`) through the closed 5-value `TimeRange` enum — the
// enum collapse is what produced the "+24h" mislabeled-window bug.
router.get('/overview', cacheMiddleware(TTL.MEDIUM), (req: Request<object, unknown, unknown, OverviewQuery>, res) => {
  const { country, timeRange = '7d', start, end } = req.query;

  if (!country) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  const range = start && end ? { start, end } : undefined;
  const data = dashboardService.getDashboardOverview(country, timeRange, range);

  res.json({
    success: true,
    data,
    meta: {
      country: country.toUpperCase(),
      timeRange: range ?? timeRange,
    },
  });
});

// GET /api/dashboard/map - Get data for all countries (for map visualization)
// Same `start`/`end`-wins-over-`timeRange` backward compatibility as `/overview` above.
router.get('/map', cacheMiddleware(TTL.LONG), (req: Request<object, unknown, unknown, MapQuery>, res) => {
  const { metric = 'load', timeRange = '24h', start, end } = req.query;

  const validMetrics: MetricType[] = ['load', 'price', 'renewable_pct', 'net_position'];
  if (!validMetrics.includes(metric)) {
    throw new AppError(
      `Invalid metric. Must be one of: ${validMetrics.join(', ')}`,
      400,
      'INVALID_METRIC'
    );
  }

  const range = start && end ? { start, end } : undefined;
  const data = dashboardService.getMapData(metric, timeRange, range);

  res.json({
    success: true,
    data,
    meta: {
      metric,
      timeRange: range ?? timeRange,
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

  // Get overview data. Same start/end-wins-over-timeRange rule as /overview
  // above, so the overview this endpoint returns can never disagree with a
  // direct GET /overview call for the same window — usePrefetch.ts seeds the
  // useDashboardOverview query cache straight from this response, so the two
  // must be computed the same way or the seeded cache would silently carry a
  // different window than a live fetch would have produced.
  const range = start && end ? { start, end } : undefined;
  const overview = dashboardService.getDashboardOverview(country, timeRange, range);

  // Get load data for the default chart
  const endDate = end || new Date().toISOString();
  const startDate = start || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  // Passed as raw ISO; getLoadData derives its own bounds via `timestampRange`.
  const loadData = loadService.getLoadData(country, startDate, endDate, granularity);

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
