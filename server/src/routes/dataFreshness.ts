import { Router } from 'express';
import { getDataFreshness } from '../services/dataFreshnessService.js';
import { AppError } from '../middleware/errorHandler.js';

const router = Router();

/**
 * GET /data-freshness/:countryCode
 *
 * Per stream: the newest usable timestamp we hold, its signed age in hours, and
 * whether that is `live`, `stale`, `ended` or `none`.
 *
 * It used to return the five bare timestamps and nothing else, which left every
 * caller to invent its own idea of "too old" — and the only caller did not
 * invent one at all, so the header pulsed green beside a five-year-old
 * timestamp for GB. The verdict belongs here, next to the schedule and the
 * measurements that justify it (`services/freshness.ts`).
 */
router.get('/:countryCode', (req, res) => {
  const { countryCode } = req.params;

  if (!countryCode) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  res.json({ success: true, data: getDataFreshness(countryCode) });
});

export default router;
