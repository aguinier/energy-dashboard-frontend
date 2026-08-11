import { Router } from 'express';
import { getNetPosition } from '../services/netPositionService.js';

const router = Router();

/**
 * GET /net-position/:countryCode?start=&end=&model=
 *
 * Day-ahead net position (MW, positive = exporter) together with the latest
 * model forecast vintage. Returned as one payload because it is visually one
 * chart - splitting it would give the client two loading states for one
 * picture.
 *
 * The band arrives nested per forecast row (p10/p50/p90) rather than as a
 * parallel array, so the client never joins two lists by timestamp.
 *
 * `model` is the registry id the picker pinned (`ModelPicker.tsx`). Omitted,
 * `getNetPositionForecast` resolves the type's production model
 * (`resolveModelName`, `forecastModels.ts`) - the same leniency `resolveModel`
 * gives every other forecast type, so a stale bookmark still draws a series
 * instead of an empty chart.
 */
router.get('/:countryCode', (req, res) => {
  try {
    const { countryCode } = req.params;
    const { start, end, model } = req.query as { start?: string; end?: string; model?: string };

    if (!start || !end) {
      res.status(400).json({
        success: false,
        error: 'start and end query parameters are required',
      });
      return;
    }

    const data = getNetPosition(countryCode, start, end, undefined, model);

    res.json({
      success: true,
      data,
      meta: {
        count: data.actual.length + data.forecast.length,
        timeRange: { start, end },
      },
    });
  } catch (error) {
    console.error('Error fetching net position:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch net position',
    });
  }
});

export default router;
