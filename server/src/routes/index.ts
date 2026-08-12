import { Router } from 'express';
import { getHealthProvenance } from '../lib/healthProvenance.js';
import countriesRouter from './countries.js';
import loadRouter from './load.js';
import pricesRouter from './prices.js';
import renewablesRouter from './renewables.js';
import generationRouter from './generation.js';
import dashboardRouter from './dashboard.js';
import forecastRouter from './forecast.js';
import tsoForecastRouter from './tsoForecast.js';
import dataFreshnessRouter from './dataFreshness.js';
import forecastComparisonRouter from './forecastComparison.js';
import crossCountryComparisonRouter from './crossCountryComparison.js';
import weatherRouter from './weather.js';
import netPositionRouter from './netPosition.js';
import netPositionIngestRouter from './netPositionIngest.js';
import opsStatusRouter from './opsStatus.js';

const router = Router();

// Mount all routes
router.use('/countries', countriesRouter);
router.use('/load', loadRouter);
router.use('/prices', pricesRouter);
router.use('/renewables', renewablesRouter);
router.use('/generation', generationRouter);
router.use('/dashboard', dashboardRouter);
router.use('/forecasts', forecastRouter);
// Write path for the workstation's Chronos net-position run. Mounted under the
// same /forecasts prefix, before nothing else claims POST /net-position.
router.use('/forecasts', netPositionIngestRouter);
router.use('/net-position', netPositionRouter);
router.use('/tso-forecast', tsoForecastRouter);
router.use('/data-freshness', dataFreshnessRouter);
router.use('/forecast-comparison', forecastComparisonRouter);
router.use('/cross-country', crossCountryComparisonRouter);
router.use('/weather', weatherRouter);
router.use('/ops', opsStatusRouter);

// Health check endpoint — includes provenance fields so an acceptance check can
// prove it reached the container rather than a stray dev process on the same port.
// `runtime` is 'container' only when NODE_ENV=production (set in the Dockerfile ENV),
// `commit` is the SHA baked in at image build via COMMIT_SHA build-arg, and
// `db_path` is ENERGY_DB_PATH (/data/… inside the container, a local path on dev).
router.get('/health', (_req, res) => {
  res.json({
    success: true,
    data: {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      ...getHealthProvenance(),
    },
  });
});

export default router;
