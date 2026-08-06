import { Router, Request } from 'express';
import * as generationService from '../services/generationService.js';
import { cacheMiddleware, TTL } from '../middleware/cache.js';
import { AppError } from '../middleware/errorHandler.js';
import { Granularity } from '../types/index.js';

const router = Router();

interface GenerationQuery {
  country?: string;
  start?: string;
  end?: string;
  granularity?: Granularity;
}

// GET /api/generation/mix - window-average generation by production type,
// straight from the full A75 document (energy_generation), including
// nuclear and the fossil types that energy_renewable never carried.
router.get('/mix', cacheMiddleware(TTL.MEDIUM), (req: Request<object, unknown, unknown, GenerationQuery>, res) => {
  const { country, start, end } = req.query;

  if (!country) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  const endDate = end || new Date().toISOString();
  const startDate = start || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const mix = generationService.getGenerationMix(country, startDate, endDate);

  res.json({
    success: true,
    data: mix,
    meta: {
      timeRange: { start: startDate, end: endDate },
    },
  });
});

// GET /api/generation/series - generation by source over time, from the same
// full A75 document and the same nine-family grouping /mix serves, so the
// Generation tab's trend chart cannot describe a different mix than the donut
// and by-source table beside it. Groups are independently nullable ("this
// country reports none of these types") and can be negative (pumped storage
// charging) - see generationService.getGenerationSeries.
router.get('/series', cacheMiddleware(TTL.MEDIUM), (req: Request<object, unknown, unknown, GenerationQuery>, res) => {
  const { country, start, end, granularity = 'hourly' } = req.query;

  if (!country) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  const endDate = end || new Date().toISOString();
  const startDate = start || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const data = generationService.getGenerationSeries(country, startDate, endDate, granularity);

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

export default router;
