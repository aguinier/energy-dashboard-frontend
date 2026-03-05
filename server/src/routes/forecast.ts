import { Router, Request } from 'express';
import * as forecastService from '../services/forecastService.js';
import { cacheMiddleware, TTL } from '../middleware/cache.js';
import { AppError } from '../middleware/errorHandler.js';
import { ForecastType, Granularity } from '../types/index.js';

const router = Router();

interface ForecastQuery {
  country?: string;
  type?: ForecastType;
  start?: string;
  end?: string;
  granularity?: Granularity;
  horizon?: string; // 1 for D+1, 2 for D+2
}

// GET /api/forecasts - Get forecast data with filters
// Query params: country, type, start, end, granularity, horizon (optional: 1 for D+1, 2 for D+2)
router.get('/', cacheMiddleware(TTL.MEDIUM), (req: Request<object, unknown, unknown, ForecastQuery>, res) => {
  const { country, type, start, end, granularity = 'hourly', horizon } = req.query;

  if (!country) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  if (!type) {
    throw new AppError('Forecast type is required (load, price, renewable, solar, wind_onshore, wind_offshore, hydro_total, biomass)', 400, 'MISSING_FORECAST_TYPE');
  }

  // Default to next 48 hours if not specified
  const startDate = start || new Date().toISOString();
  const endDate = end || new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  // Parse horizon parameter
  const horizonDays = horizon ? parseInt(horizon, 10) : undefined;

  const data = forecastService.getForecastData(country, type, startDate, endDate, granularity, horizonDays);

  res.json({
    success: true,
    data,
    meta: {
      count: data.length,
      timeRange: { start: startDate, end: endDate },
      granularity,
      forecastType: type,
      horizon: horizonDays,
    },
  });
});

// GET /api/forecasts/latest - Get latest forecast batch
router.get('/latest', cacheMiddleware(TTL.SHORT), (req: Request<object, unknown, unknown, { country?: string; type?: ForecastType }>, res) => {
  const { country, type } = req.query;

  if (!country) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  const data = forecastService.getLatestForecast(country, type);

  res.json({
    success: true,
    data,
    meta: {
      count: data.length,
      forecastType: type || 'all',
    },
  });
});

// GET /api/forecasts/types - Get available forecast types for a country
router.get('/types', cacheMiddleware(TTL.LONG), (req: Request<object, unknown, unknown, { country?: string }>, res) => {
  const { country } = req.query;

  if (!country) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  const types = forecastService.getAvailableForecastTypes(country);

  res.json({
    success: true,
    data: types,
  });
});

// GET /api/forecasts/compare - Get forecast with actuals for comparison
router.get('/compare', cacheMiddleware(TTL.MEDIUM), (req: Request<object, unknown, unknown, ForecastQuery>, res) => {
  const { country, type, start, end } = req.query;

  if (!country) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  if (!type) {
    throw new AppError('Forecast type is required', 400, 'MISSING_FORECAST_TYPE');
  }

  // Default to last 7 days for historical comparison
  const endDate = end || new Date().toISOString();
  const startDate = start || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const data = forecastService.getForecastWithActuals(country, type, startDate, endDate);

  res.json({
    success: true,
    data,
    meta: {
      timeRange: { start: startDate, end: endDate },
      forecastType: type,
    },
  });
});

// GET /api/forecasts/multi-horizon - Get D+1 and D+2 forecasts for overlay view
router.get('/multi-horizon', cacheMiddleware(TTL.MEDIUM), (req: Request<object, unknown, unknown, ForecastQuery>, res) => {
  const { country, type, start, end } = req.query;

  if (!country) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  if (!type) {
    throw new AppError('Forecast type is required', 400, 'MISSING_FORECAST_TYPE');
  }

  // Default to next 48 hours if not specified
  const startDate = start || new Date().toISOString();
  const endDate = end || new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  const data = forecastService.getMultiHorizonForecastData(country, type, startDate, endDate);

  res.json({
    success: true,
    data,
    meta: {
      count: data.length,
      timeRange: { start: startDate, end: endDate },
      forecastType: type,
    },
  });
});

export default router;
