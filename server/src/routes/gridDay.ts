import { Router } from 'express';
import { getGridDay } from '../services/gridDayService.js';
import { todayInGridTimezone } from '../services/livingGrid/brusselsDay.js';
import { cacheMiddleware, TTL } from '../middleware/cache.js';

const router = Router();

/**
 * GET /grid/day?date=YYYY-MM-DD
 *
 * The Living Grid's single read: every stream it renders, for every zone, for
 * one Europe/Brussels calendar day. `date` defaults to today there.
 *
 * Cached for five minutes. Nothing behind it moves faster than hourly — the
 * day-ahead streams land once a day, flows about an hour after the fact — so
 * the TTL is bounded by how soon a newly published hour should appear rather
 * than by how often the numbers change.
 */
router.get('/day', cacheMiddleware(TTL.MEDIUM), (req, res) => {
  const { date } = req.query as { date?: string };
  const requested = date ?? todayInGridTimezone();

  try {
    const { data, meta } = getGridDay(requested);
    res.json({ success: true, data, meta });
  } catch (error) {
    if (error instanceof RangeError) {
      res.status(400).json({
        success: false,
        error: 'date must be a valid YYYY-MM-DD calendar date',
      });
      return;
    }
    console.error('Error building Living Grid day:', error);
    res.status(500).json({ success: false, error: 'Failed to build grid day' });
  }
});

export default router;
