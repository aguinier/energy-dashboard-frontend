import { Router, Request } from 'express';
import * as renewableService from '../services/renewableService.js';
import { cacheMiddleware, TTL } from '../middleware/cache.js';
import { AppError } from '../middleware/errorHandler.js';
import { Granularity } from '../types/index.js';

const router = Router();

interface RenewableQuery {
  country?: string;
  start?: string;
  end?: string;
  granularity?: Granularity;
}

// GET /api/renewables - Get renewable time series data
router.get('/', cacheMiddleware(TTL.MEDIUM), (req: Request<object, unknown, unknown, RenewableQuery>, res) => {
  const { country, start, end, granularity = 'daily' } = req.query;

  if (!country) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  const endDate = end || new Date().toISOString();
  const startDate = start || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const data = renewableService.getRenewableData(country, startDate, endDate, granularity);

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

// GET /api/renewables/mix - Get renewable mix breakdown
router.get('/mix', cacheMiddleware(TTL.MEDIUM), (req: Request<object, unknown, unknown, RenewableQuery>, res) => {
  const { country, start, end } = req.query;

  if (!country) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  const endDate = end || new Date().toISOString();
  const startDate = start || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const mix = renewableService.getRenewableMix(country, startDate, endDate);
  const percentage = renewableService.getRenewablePercentage(country, startDate, endDate);

  res.json({
    success: true,
    data: {
      ...mix,
      renewable_percentage: percentage,
    },
    meta: {
      timeRange: { start: startDate, end: endDate },
    },
  });
});

// GET /api/renewables/latest - Get latest renewable data
router.get('/latest', cacheMiddleware(TTL.SHORT), (req: Request<object, unknown, unknown, { country?: string }>, res) => {
  const { country } = req.query;
  const data = renewableService.getLatestRenewable(country);

  res.json({
    success: true,
    data,
  });
});

// GET /api/renewables/percentage - Get renewable percentage
router.get('/percentage', cacheMiddleware(TTL.MEDIUM), (req: Request<object, unknown, unknown, RenewableQuery>, res) => {
  const { country, start, end } = req.query;

  if (!country) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  const endDate = end || new Date().toISOString();
  const startDate = start || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const percentage = renewableService.getRenewablePercentage(country, startDate, endDate);

  res.json({
    success: true,
    data: {
      country_code: country.toUpperCase(),
      renewable_percentage: percentage,
    },
    meta: {
      timeRange: { start: startDate, end: endDate },
    },
  });
});

export default router;
