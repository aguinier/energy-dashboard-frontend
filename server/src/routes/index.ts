import { Router } from 'express';
import countriesRouter from './countries.js';
import loadRouter from './load.js';
import pricesRouter from './prices.js';
import renewablesRouter from './renewables.js';
import dashboardRouter from './dashboard.js';
import forecastRouter from './forecast.js';
import tsoForecastRouter from './tsoForecast.js';
import dataFreshnessRouter from './dataFreshness.js';
import forecastComparisonRouter from './forecastComparison.js';
import crossCountryComparisonRouter from './crossCountryComparison.js';

const router = Router();

// Mount all routes
router.use('/countries', countriesRouter);
router.use('/load', loadRouter);
router.use('/prices', pricesRouter);
router.use('/renewables', renewablesRouter);
router.use('/dashboard', dashboardRouter);
router.use('/forecasts', forecastRouter);
router.use('/tso-forecast', tsoForecastRouter);
router.use('/data-freshness', dataFreshnessRouter);
router.use('/forecast-comparison', forecastComparisonRouter);
router.use('/cross-country', crossCountryComparisonRouter);

// Health check endpoint
router.get('/health', (_req, res) => {
  res.json({
    success: true,
    data: {
      status: 'healthy',
      timestamp: new Date().toISOString(),
    },
  });
});

export default router;
