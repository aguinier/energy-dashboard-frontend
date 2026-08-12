import { Router } from 'express';
import { getCoreNetPosition } from '../services/coreNetPositionService.js';

const router = Router();

/**
 * GET /core-net-position/:countryCode?start=&end=
 *
 * Deliberately minimal and provisional (ABL-230) — a read path good enough
 * to exercise the ingest end to end, not the client-facing contract. The
 * shape a toggle UI actually needs (units, alongside the existing
 * `/net-position` payload or standalone, how a Core-less country like GB
 * should respond, ...) is owned by the follow-up UI issue, which should
 * revise or replace this route rather than treat it as fixed.
 *
 * Returns the Core CCR net position (MW, positive = net exporter WITHIN the
 * Core flow-based domain only — see `coreNetPositionService.ts` for how this
 * differs from `/net-position`'s all-SDAC-borders figure). A country with no
 * Core coverage (e.g. GB, CH — never in Core CCR) returns an empty array,
 * never a fabricated point.
 */
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

    const points = getCoreNetPosition(countryCode, start, end);

    res.json({
      success: true,
      data: { points },
      meta: {
        count: points.length,
        timeRange: { start, end },
      },
    });
  } catch (error) {
    console.error('Error fetching Core net position:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch Core net position',
    });
  }
});

export default router;
