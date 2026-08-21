import { Router, Request } from 'express';
import * as forecastService from '../services/forecastService.js';
import { cacheMiddleware, TTL } from '../middleware/cache.js';
import { AppError } from '../middleware/errorHandler.js';
import { FORECAST_MODELS, getTypeConfig } from '../config/forecastModels.js';
import { getRecommendedModel } from '../services/recommendedModelService.js';
import { ForecastType, Granularity } from '../types/index.js';

const router = Router();

interface ForecastQuery {
  country?: string;
  type?: ForecastType;
  start?: string;
  end?: string;
  granularity?: Granularity;
  horizon?: string; // 1 for D+1, 2 for D+2
  /** Model id from the registry. Omit for the type's production model. */
  model?: string;
}

/**
 * GET /forecasts/models[?type=load[&country=DE]]
 *
 * The model registry: which models may serve which forecast type, and which is
 * production. The picker renders from this rather than hardcoding a list, so a
 * model can only appear in the UI by being registered here.
 *
 * With `country` **and** `type`, the type's config also carries `recommended`:
 * the best available forecast for that (country, type) pair over the rolling
 * accuracy window, across both our ML models and the ENTSO-E series
 * (`recommendedModelService.ts`, ABL-469). The registry half of the response is
 * byte-identical either way — `recommended` is an additive sibling key, so a
 * client that does not ask for it, or one on older code, sees exactly what it
 * saw before.
 *
 * **`country` requires `type`, and that is a 400 rather than a convenience.**
 * Ranking one pair costs ~35 ms; ranking a country across all nine registered
 * types would put ~25 accuracy queries behind one request to answer eight
 * questions the caller did not ask. The picker only ever needs the active
 * tab's type, so the endpoint asks for it.
 */
router.get(
  '/models',
  cacheMiddleware(TTL.LONG),
  (req: Request<object, unknown, unknown, { type?: string; country?: string }>, res) => {
    const { type, country } = req.query;

    if (country && !type) {
      throw new AppError(
        'A recommendation is per (country, forecast type): pass `type` alongside `country`.',
        400,
        'MISSING_FORECAST_TYPE',
      );
    }

    if (type) {
      const cfg = getTypeConfig(type);
      if (!cfg) {
        throw new AppError(`Unknown forecast type: ${type}`, 400, 'UNKNOWN_FORECAST_TYPE');
      }
      const recommended = country
        ? getRecommendedModel(country, type as ForecastType)
        : undefined;
      res.json({ success: true, data: { [type]: { ...cfg, ...(recommended ? { recommended } : {}) } } });
      return;
    }

    res.json({ success: true, data: FORECAST_MODELS });
  },
);

// GET /api/forecasts - Get forecast data with filters
// Query params: country, type, start, end, granularity, horizon (optional: 1 for D+1, 2 for D+2)
router.get('/', cacheMiddleware(TTL.MEDIUM), (req: Request<object, unknown, unknown, ForecastQuery>, res) => {
  const { country, type, start, end, granularity = 'hourly', horizon, model } = req.query;

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

  const series = forecastService.getForecastSeries(
    country, type, startDate, endDate, granularity, horizonDays, model
  );

  res.json({
    success: true,
    data: series.data,
    meta: {
      count: series.data.length,
      timeRange: { start: startDate, end: endDate },
      granularity,
      forecastType: type,
      horizon: horizonDays,
      // Which model actually served — or, on a withheld series, which model
      // produced the rows being held back. A fallback must be visible, not
      // passed off as the production model.
      model: series.model,
      modelRequested: model ?? null,
      // Present on every response, and `'comparable'` is the overwhelming
      // majority answer. Unlike `/api/cross-country/metrics`, which returns up
      // to 272 entries and where stamping a verdict on each would have cost
      // the payload diff that verified ABL-493, this response is one series —
      // so the verdict is cheap here, and always naming it means a client
      // reading `basis` never has to distinguish "comparable" from "the server
      // predates the rule".
      basis: series.basis,
      basisNote: series.basisNote,
      // Rows we hold and did not serve. Non-zero is the only thing that
      // distinguishes a withheld series from a country that has no forecast,
      // and those are different claims.
      withheldPoints: series.withheldPoints,
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

  const { forecasts, actuals, basis, basisNote, withheldPoints } =
    forecastService.getForecastWithActuals(country, type, startDate, endDate);

  res.json({
    success: true,
    // `data`'s shape is unchanged: the verdict rides in `meta` beside the
    // other statements about the response, not grafted into the payload a
    // consumer parses.
    data: { forecasts, actuals },
    meta: {
      timeRange: { start: startDate, end: endDate },
      forecastType: type,
      basis,
      basisNote,
      withheldPoints,
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

  const series = forecastService.getMultiHorizonForecastData(country, type, startDate, endDate);

  res.json({
    success: true,
    data: series.data,
    meta: {
      count: series.data.length,
      timeRange: { start: startDate, end: endDate },
      forecastType: type,
      basis: series.basis,
      basisNote: series.basisNote,
      withheldPoints: series.withheldPoints,
    },
  });
});

export default router;
