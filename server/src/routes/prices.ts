import { Router, Request } from 'express';
import * as priceService from '../services/priceService.js';
import { cacheMiddleware, TTL } from '../middleware/cache.js';
import { AppError } from '../middleware/errorHandler.js';
import { Granularity } from '../types/index.js';

const router = Router();

interface PriceQuery {
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

interface HeatmapQuery {
  country?: string;
  days?: string;
}

// GET /api/prices - Get price data with filters
router.get('/', cacheMiddleware(TTL.MEDIUM), (req: Request<object, unknown, unknown, PriceQuery>, res) => {
  const { country, start, end, granularity = 'daily' } = req.query;

  if (!country) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  const endDate = end || new Date().toISOString();
  const startDate = start || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const data = priceService.getPriceData(country, startDate, endDate, granularity);

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

// GET /api/prices/latest - Get latest prices
router.get('/latest', cacheMiddleware(TTL.SHORT), (req: Request<object, unknown, unknown, { country?: string }>, res) => {
  const { country } = req.query;
  const data = priceService.getLatestPrices(country);

  res.json({
    success: true,
    data,
  });
});

// GET /api/prices/stats - Get price statistics
router.get('/stats', cacheMiddleware(TTL.MEDIUM), (req: Request<object, unknown, unknown, PriceQuery>, res) => {
  const { country, start, end } = req.query;

  if (!country) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  const endDate = end || new Date().toISOString();
  const startDate = start || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const data = priceService.getPriceStats(country, startDate, endDate);

  res.json({
    success: true,
    data,
    meta: {
      timeRange: { start: startDate, end: endDate },
    },
  });
});

// GET /api/prices/heatmap - Get price heatmap data
router.get('/heatmap', cacheMiddleware(TTL.LONG), (req: Request<object, unknown, unknown, HeatmapQuery>, res) => {
  const { country, days = '30' } = req.query;

  if (!country) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  const daysNum = parseInt(days, 10);
  if (isNaN(daysNum) || daysNum < 1 || daysNum > 365) {
    throw new AppError('Days must be between 1 and 365', 400, 'INVALID_DAYS');
  }

  const data = priceService.getPriceHeatmap(country, daysNum);

  res.json({
    success: true,
    data,
    meta: {
      days: daysNum,
      structure: '7 days (0=Sun) x 24 hours',
    },
  });
});

// GET /api/prices/compare - Compare multiple countries
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

  const data = priceService.getPriceComparison(countryList, startDate, endDate, granularity);

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

export default router;
