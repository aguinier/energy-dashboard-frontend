import { Router } from 'express';
import {
  getCoreNetPositionMap,
  getCoreNetPositionSeries,
} from '../services/coreNetPositionService.js';

const router = Router();

/**
 * The Core CCR net position read path (ABL-230 ingest, ABL-234 client shape).
 *
 * ABL-230 shipped a deliberately provisional single route returning a bare
 * `{ points }`, on the note that the follow-up UI issue owned the real
 * contract and should revise it. This is that revision. Two things changed,
 * both driven by what the toggle actually needs:
 *
 * - An empty array now arrives with a REASON. `out_of_core` (the zone is not
 *   one of the 12 Core zones — no such figure exists), `not_captured` (the
 *   JAO capture has never run in this deployment), and `no_data` (a Core zone
 *   with nothing in this window) are three different claims, and the map has
 *   to render the first one differently from the other two. Returning `[]`
 *   for all three would have pushed that judgement into the client, which
 *   would then have had to hardcode its own copy of the 12-zone list to
 *   recover it. See `CoreNetPositionCoverage`.
 * - A `/map` route, so the choropleth has one request per window instead of
 *   12 per-country ones.
 *
 * These are additive: `/net-position` and `/dashboard/map` are untouched, so
 * the all-coupled-borders default view issues exactly the queries it did
 * before this change.
 *
 * Positive = net EXPORTER within the Core flow-based domain only. That is a
 * different quantity from `/net-position`'s all-SDAC-borders figure, not a
 * correction of it — see `coreNetPositionService.ts`, and do not describe the
 * difference as "AC vs DC" anywhere.
 */

/**
 * GET /core-net-position/map?start=&end=
 *
 * Declared before `/:countryCode` on purpose: Express matches in order, and
 * `'map'` is a perfectly good country-code-shaped string.
 */
router.get('/map', (req, res) => {
  try {
    const { start, end } = req.query as { start?: string; end?: string };
    if (!start || !end) {
      res.status(400).json({
        success: false,
        error: 'start and end query parameters are required',
      });
      return;
    }

    const data = getCoreNetPositionMap(start, end);

    res.json({
      success: true,
      data,
      meta: { count: data.length, unit: 'MW', timeRange: { start, end } },
    });
  } catch (error) {
    console.error('Error fetching Core net position map:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch Core net position map' });
  }
});

/** GET /core-net-position/:countryCode?start=&end= */
router.get('/:countryCode', (req, res) => {
  try {
    const { countryCode } = req.params;
    const { start, end } = req.query as { start?: string; end?: string };

    if (!start || !end) {
      res.status(400).json({
        success: false,
        error: 'start and end query parameters are required',
      });
      return;
    }

    const series = getCoreNetPositionSeries(countryCode, start, end);

    res.json({
      success: true,
      data: series,
      meta: {
        count: series.actual.length,
        unit: 'MW',
        timeRange: { start, end },
      },
    });
  } catch (error) {
    console.error('Error fetching Core net position:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch Core net position' });
  }
});

export default router;
