import { Router } from 'express';
import * as countryService from '../services/countryService.js';
import { cacheMiddleware, TTL } from '../middleware/cache.js';
import { AppError } from '../middleware/errorHandler.js';

const router = Router();

// GET /api/countries - List all countries
router.get('/', cacheMiddleware(TTL.COUNTRIES), (_req, res) => {
  const countries = countryService.getAllCountries();
  res.json({
    success: true,
    data: countries,
    meta: { count: countries.length },
  });
});

// GET /api/countries/with-data - Countries that have energy data
router.get('/with-data', cacheMiddleware(TTL.LONG), (_req, res) => {
  const countryCodes = countryService.getCountriesWithData();
  res.json({
    success: true,
    data: countryCodes,
    meta: { count: countryCodes.length },
  });
});

// GET /api/countries/:code - Get single country
router.get('/:code', cacheMiddleware(TTL.COUNTRIES), (req, res) => {
  const { code } = req.params;
  const country = countryService.getCountryByCode(code);

  if (!country) {
    throw new AppError(`Country not found: ${code}`, 404, 'COUNTRY_NOT_FOUND');
  }

  res.json({
    success: true,
    data: country,
  });
});

// GET /api/countries/:code/summary - Get data availability summary
router.get('/:code/summary', cacheMiddleware(TTL.LONG), (req, res) => {
  const { code } = req.params;
  const summary = countryService.getCountrySummary(code);

  res.json({
    success: true,
    data: summary,
  });
});

export default router;
