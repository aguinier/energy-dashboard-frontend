/**
 * "This model emitted a series, and the series is numerically zero."
 *
 * A flat line at 0 MW under a hairline p10-p90 band does not read as missing
 * data - it reads as an unusually *confident* forecast, which is the exact
 * opposite of the truth. That is worse than drawing nothing, so it is caught
 * here rather than left to a chart component.
 *
 * The live case is GR's net position (ABL-25). Measured read-only against the
 * replica on 2026-08-06: 168 `chronos-2-V010` rows for
 * `country_code='GR', forecast_type='net_position'`, every median between
 * 2.3e-11 and 4.6e-7 MW, and **not one exactly 0.0** - so no `= 0` guard
 * catches them. The stored band collapses with it (p10 min -3.5e-6 MW, p90 max
 * 0.0038 MW). GR is the only degenerate series in the table.
 */

/**
 * Below this many MW, a whole series is zero rather than small.
 *
 * Sized from measurement, not taste (all figures 2026-08-06, over every
 * `forecast_type='net_position'` row):
 *
 * - The worst *genuine* single-day window - the narrowest window any preset
 *   asks for - is SI on 2026-07-29, peaking at **16.7 MW**. So 1 MW sits an
 *   order of magnitude below the quietest real day.
 * - GR's largest value across its entire series is **4.6e-7 MW**, six orders
 *   of magnitude below the floor.
 *
 * Individual points in genuine series do go far lower (ES has one at 0.0094
 * MW), which is why the rule is on the series *maximum* and never on a single
 * point: a real net position crosses zero, and suppressing it there would
 * delete the interesting part of the chart.
 */
export const DEGENERATE_FORECAST_MAX_ABS_MW = 1;

/**
 * Why `forecast` holds what it does. Deliberately parallel to
 * `MLAccuracyCoverage` in mlForecastService - same idea, that an empty result
 * has to say *which* kind of empty it is.
 */
export type NetPositionForecastCoverage = 'served' | 'no_forecast' | 'degenerate_zero';

/** Just the magnitude-bearing fields of a forecast point. */
export interface ForecastMagnitudeRow {
  p50: number;
  p10?: number | null;
  p90?: number | null;
}

/**
 * Discriminated on purpose: `max_abs_mw` is `null` exactly when there were no
 * rows to measure, and the union makes that unrepresentable any other way. A
 * caller narrowing to a measured state gets a `number` without a `?? 0`
 * fallback - and a `0` fallback is precisely the "absent read as measured"
 * mistake this module exists to stop.
 */
export type ForecastSeriesQuality =
  | { coverage: 'no_forecast'; points: 0; max_abs_mw: null }
  | {
      coverage: 'served' | 'degenerate_zero';
      /** Rows examined - the count that would have been drawn. */
      points: number;
      /** Largest |value| over every median and stored quantile in the series, MW. */
      max_abs_mw: number;
    };

/**
 * Classify a forecast series by its own magnitude.
 *
 * The band is included in the maximum on purpose, and it makes the rule
 * *stricter*: a forecast whose median hugs zero but whose p10-p90 spans
 * thousands of MW is a real statement ("could go either way, hard"), and
 * including the quantiles keeps it served. Only a series where the median AND
 * the band are all inside the floor is degenerate.
 *
 * Non-finite values contribute nothing to the maximum. `forecasts.forecast_value`
 * is `REAL NOT NULL`, so `p50` is always a real number in practice; `p10`/`p90`
 * are null when the deployment has no `forecast_quantiles` table, and a
 * median-only series is judged on its median alone.
 */
export function classifyForecastSeries(
  rows: ForecastMagnitudeRow[],
  thresholdMw: number = DEGENERATE_FORECAST_MAX_ABS_MW
): ForecastSeriesQuality {
  if (rows.length === 0) {
    return { coverage: 'no_forecast', points: 0, max_abs_mw: null };
  }

  let maxAbs = 0;
  for (const row of rows) {
    for (const value of [row.p50, row.p10, row.p90]) {
      if (value == null || !Number.isFinite(value)) continue;
      const abs = Math.abs(value);
      if (abs > maxAbs) maxAbs = abs;
    }
  }

  return {
    coverage: maxAbs < thresholdMw ? 'degenerate_zero' : 'served',
    points: rows.length,
    max_abs_mw: maxAbs,
  };
}
