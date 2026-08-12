import { Router } from 'express';
import { getDataFreshness } from '../services/dataFreshnessService.js';
import { getIngestFreshness } from '../services/ingestFreshnessService.js';
import { AppError } from '../middleware/errorHandler.js';

const router = Router();

/**
 * GET /data-freshness/:countryCode/ingest
 *
 * Per stream: when the ingest last ran for this country (`lastChecked`) and
 * when a run last brought a row back (`lastStoredRows`). ABL-295.
 *
 * A SEPARATE question from the route below, which is why it is a separate
 * route rather than more fields on that response. That one asks *how old is the
 * newest row we hold* and reads the data tables; this one asks *when did we last
 * go and look* and reads `data_ingestion_log`. A stream can be stale there and
 * checked-minutes-ago here — GB load is exactly that — and merging the two into
 * one verdict is how you get a confident answer to a question nobody asked.
 *
 * The two timestamps stay separate all the way to the screen. Measured
 * 2026-08-12, 14 of 36 zones have never had a `net_position` pass bring a row
 * while every one of them was checked during the 00:30 UTC pass, so collapsing
 * them would put a fresh-looking timestamp beside a series we have never
 * received.
 *
 * Declared before `/:countryCode` for legibility; Express would match correctly
 * either way, since that pattern spans a single path segment.
 */
router.get('/:countryCode/ingest', (req, res) => {
  const { countryCode } = req.params;

  if (!countryCode) {
    throw new AppError('Country code is required', 400, 'MISSING_COUNTRY');
  }

  res.json({ success: true, data: getIngestFreshness(countryCode) });
});

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
