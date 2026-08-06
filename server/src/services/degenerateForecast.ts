/**
 * "This series exists, and it is numerically zero."
 *
 * A flat line at 0 MW does not read as missing data - it reads as a *measured*
 * zero, which is the exact opposite of the truth. That is worse than drawing
 * nothing, so it is caught here rather than left to a chart component.
 *
 * Two live cases, both on GR's net position, and they are separate defects with
 * the same signature:
 *
 * - **The forecast** (ABL-25). Measured read-only against the replica on
 *   2026-08-06: 168 `chronos-2-V010` rows for
 *   `country_code='GR', forecast_type='net_position'`, every median between
 *   2.3e-11 and 4.6e-7 MW, and **not one exactly 0.0** - so no `= 0` guard
 *   catches them. The stored band collapses with it (p10 min -3.5e-6 MW, p90
 *   max 0.0038 MW).
 * - **The actuals** (ABL-35). Every `net_position` row GR has published since
 *   2025-10-01 is exactly `0.0` - 192 of 192, written by 7 independent fetch
 *   batches between 2026-02 and 2026-07. Unlike the forecast these *are* exact
 *   zeros, and they are provably false: joining those same hours to GR's own
 *   `crossborder_flows` gives a median net physical export of **1,142 MW**
 *   (max 1,657; 187 of 192 hours above 100 MW). Greece was moving better than a
 *   gigawatt across its borders while the table said its net position was zero.
 *
 * The rule below is deliberately one rule for both. What makes a series
 * unusable is a property of the numbers, not of which table they came from.
 */

/**
 * Below this many MW, a whole series is zero rather than small.
 *
 * Sized from measurement, not taste. Both series types were measured
 * independently and agree with room to spare (all figures 2026-08-06, against
 * the replica):
 *
 * - **Forecasts**, over every `forecast_type='net_position'` row: the worst
 *   *genuine* single-day window - the narrowest window any preset asks for -
 *   is SI on 2026-07-29, peaking at **16.7 MW**. GR's largest value across its
 *   entire series is **4.6e-7 MW**.
 * - **Actuals**, over all 26,882 country-days in `net_position` with >= 20
 *   hours: exactly **9** are degenerate (8 GR days plus IE 2026-03-14), and
 *   every one of them has a daily max of exactly `0.000000` MW. The next
 *   quietest day in the whole table is IE 2023-09-01 at **92.3 MW**. Every
 *   threshold between 0.5 and 50 MW selects that same set of 9, so 1 MW is not
 *   a tuned edge - it sits in a two-order-of-magnitude empty band.
 *
 * Individual points in genuine series do go far lower (a forecast median at
 * 0.0094 MW for ES), which is why the rule is on the series *maximum* and never
 * on a single point: a real net position crosses zero, and suppressing it there
 * would delete the interesting part of the chart.
 */
export const DEGENERATE_SERIES_MAX_ABS_MW = 1;

/**
 * Why `forecast` holds what it does. Deliberately parallel to
 * `MLAccuracyCoverage` in mlForecastService - same idea, that an empty result
 * has to say *which* kind of empty it is.
 */
export type NetPositionForecastCoverage = 'served' | 'no_forecast' | 'degenerate_zero';

/**
 * Why `actual` holds what it does. Same three-way shape as the forecast
 * coverage above, and for the same reason: "no rows were published" and "rows
 * were published and are unusable" are different answers, and a bare empty
 * array cannot tell them apart.
 */
export type NetPositionActualCoverage = 'served' | 'no_actuals' | 'degenerate_zero';

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
export type SeriesQuality<Empty extends string> =
  | { coverage: Empty; points: 0; max_abs_mw: null }
  | {
      coverage: 'served' | 'degenerate_zero';
      /** Rows examined - the count that would have been drawn. */
      points: number;
      /** Largest |value| over every number in the series, MW. */
      max_abs_mw: number;
    };

export type ForecastSeriesQuality = SeriesQuality<'no_forecast'>;
export type ActualSeriesQuality = SeriesQuality<'no_actuals'>;

/**
 * Largest finite |value| in the list, or 0 for an empty one.
 *
 * `null`/`undefined`/NaN contribute nothing rather than counting as zero. That
 * distinction only ever makes the result larger or equal, so it can never turn
 * a real series degenerate - it stops an absent quantile from being read as a
 * measured 0.
 */
function maxAbsFinite(values: readonly (number | null | undefined)[]): number {
  let maxAbs = 0;
  for (const value of values) {
    if (value == null || !Number.isFinite(value)) continue;
    const abs = Math.abs(value);
    if (abs > maxAbs) maxAbs = abs;
  }
  return maxAbs;
}

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
  rows: readonly ForecastMagnitudeRow[],
  thresholdMw: number = DEGENERATE_SERIES_MAX_ABS_MW
): ForecastSeriesQuality {
  if (rows.length === 0) {
    return { coverage: 'no_forecast', points: 0, max_abs_mw: null };
  }

  const maxAbs = maxAbsFinite(rows.flatMap((row) => [row.p50, row.p10, row.p90]));

  return {
    coverage: maxAbs < thresholdMw ? 'degenerate_zero' : 'served',
    points: rows.length,
    max_abs_mw: maxAbs,
  };
}

/**
 * Classify an actuals series by its own magnitude.
 *
 * Same rule and same threshold as the forecast above, applied to the one value
 * an actual carries. It is still the series maximum and never a single point,
 * for the same reason: a real net position crosses zero several times a day,
 * and a per-row `=== 0` filter would punch holes in a genuine chart while
 * leaving GR's flat line looking like a shorter genuine chart.
 *
 * `net_position.net_position_mw` is `REAL NOT NULL`, so a null here means a
 * caller mapped something wrong rather than a stored gap; it is skipped rather
 * than counted as a zero, which is the conservative direction (it can only
 * raise the maximum, never lower it).
 */
export function classifyActualSeries(
  values: readonly (number | null | undefined)[],
  thresholdMw: number = DEGENERATE_SERIES_MAX_ABS_MW
): ActualSeriesQuality {
  if (values.length === 0) {
    return { coverage: 'no_actuals', points: 0, max_abs_mw: null };
  }

  const maxAbs = maxAbsFinite(values);

  return {
    coverage: maxAbs < thresholdMw ? 'degenerate_zero' : 'served',
    points: values.length,
    max_abs_mw: maxAbs,
  };
}
