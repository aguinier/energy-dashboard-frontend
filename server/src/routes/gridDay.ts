import { Router } from 'express';
import { getGridDay } from '../services/gridDayService.js';
import { currentHourInGridTimezone, todayInGridTimezone } from '../services/livingGrid/brusselsDay.js';
import { cacheMiddleware, TTL } from '../middleware/cache.js';
import { isDatabaseLocked } from '../services/livingGrid/dbLock.js';

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
// Every response carries wall-clock facts that move under a fixed URL: the
// date at Brussels midnight, `currentHour` at every hour boundary — each
// inside one five-minute TTL. Folding them into the cache key means a 23:58
// payload cannot answer an 00:01 request with yesterday labelled `isToday`,
// and the Live button cannot land a reader an hour behind the clock it claims
// to follow.
//
// This applies to a dated request too, which it did not have to before
// `meta.today` existed: a dated payload now carries the anchor the day control
// measures its reach from, so a cached one crossing midnight would disable the
// forward arrow a day early. The TTL is five minutes either way, so keying
// unconditionally costs nothing and only rules out the boundary-crossing read.
const todayCacheKey = (): string =>
  `${todayInGridTimezone()}:${currentHourInGridTimezone()}`;

router.get('/day', cacheMiddleware(TTL.MEDIUM, todayCacheKey), (req, res) => {
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
    // On a workstation the replica is locked to every reader twice a day while
    // `able-db-sync` rebuilds it inside one transaction — planned maintenance,
    // not a fault, and it clears by itself. Saying so lets the client offer a
    // retry instead of presenting a scheduled 30-minute window as a breakage.
    if (isDatabaseLocked(error)) {
      res.status(503)
        .set('Retry-After', '120')
        .json({
          success: false,
          error: 'The database is being refreshed. This is scheduled and clears on its own.',
        });
      return;
    }
    console.error('Error building Living Grid day:', error);
    res.status(500).json({ success: false, error: 'Failed to build grid day' });
  }
});

export default router;
