import { Router, Request } from 'express';
import * as loadService from '../services/loadService.js';
import { cacheMiddleware, TTL } from '../middleware/cache.js';
import { AppError } from '../middleware/errorHandler.js';
import { Granularity } from '../types/index.js';

const router = Router();

interface LoadQuery {
  country?: string;
  start?: string;
  end?: string;
  granularity?: Granularity;
}

interface CompareQuery {
  countries?: string;
  start?: string;
  end?: string;
  granularity?: Granularity;
}

// GET /api/load - Get load data with filters
router.get('/', cacheMiddleware(TTL.MEDIUM), (req: Request<object, unknown, unknown, LoadQuery>, res) => {
  const { country, start, end, granularity = 'daily' } = req.query;

  if (!country) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  // Default to last 7 days if not specified
  const endDate = end || new Date().toISOString();
  const startDate = start || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const data = loadService.getLoadData(country, startDate, endDate, granularity);

  res.json({
    success: true,
    data,
    meta: {
      count: data.length,
      timeRange: { start: startDate, end: endDate },
      granularity,
    },
  });
});

// GET /api/load/latest - Get latest load values
router.get('/latest', cacheMiddleware(TTL.SHORT), (req: Request<object, unknown, unknown, { country?: string }>, res) => {
  const { country } = req.query;
  const data = loadService.getLatestLoad(country);

  res.json({
    success: true,
    data,
  });
});

// GET /api/load/compare - Compare multiple countries
router.get('/compare', cacheMiddleware(TTL.MEDIUM), (req: Request<object, unknown, unknown, CompareQuery>, res) => {
  const { countries, start, end, granularity = 'daily' } = req.query;

  if (!countries) {
    throw new AppError('Countries parameter is required (comma-separated)', 400, 'MISSING_COUNTRIES');
  }

  const countryList = countries.split(',').map(c => c.trim()).filter(Boolean);
  if (countryList.length < 2) {
    throw new AppError('At least 2 countries required for comparison', 400, 'INSUFFICIENT_COUNTRIES');
  }
  if (countryList.length > 5) {
    throw new AppError('Maximum 5 countries allowed for comparison', 400, 'TOO_MANY_COUNTRIES');
  }

  const endDate = end || new Date().toISOString();
  const startDate = start || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const data = loadService.getLoadComparison(countryList, startDate, endDate, granularity);

  res.json({
    success: true,
    data,
    meta: {
      countries: countryList,
      timeRange: { start: startDate, end: endDate },
      granularity,
    },
  });
});

// GET /api/load/stats - Get load statistics
router.get('/stats', cacheMiddleware(TTL.MEDIUM), (req: Request<object, unknown, unknown, LoadQuery>, res) => {
  const { country, start, end } = req.query;

  if (!country) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  const endDate = end || new Date().toISOString();
  const startDate = start || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const data = loadService.getLoadStats(country, startDate, endDate);

  res.json({
    success: true,
    data,
    meta: {
      timeRange: { start: startDate, end: endDate },
    },
  });
});

export default router;
