import { Router, Request } from 'express';
import * as generationService from '../services/generationService.js';
import { cacheMiddleware, TTL } from '../middleware/cache.js';
import { AppError } from '../middleware/errorHandler.js';

const router = Router();

interface GenerationQuery {
  country?: string;
  start?: string;
  end?: string;
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

export default router;
