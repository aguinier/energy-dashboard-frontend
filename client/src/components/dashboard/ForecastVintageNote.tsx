import { useMemo } from 'react';
import { describeForecastVintage } from './forecastVintage';
import type { ForecastDataPoint } from '@/types';

interface ForecastVintageNoteProps {
  /**
   * The ML forecast points the chart is drawing — not a separate
   * `/forecasts/latest` request. Pass `undefined` when no ML line is on the
   * chart (the picker is on a TSO model, or the forecast is switched off) and
   * nothing renders.
   */
  points: ForecastDataPoint[] | undefined;
  /**
   * The same clip the chart applies, when it applies one. The forecast fetch
   * is deliberately wider than the "Today" canvas, so without this the note
   * would report a run whose points are entirely off-screen.
   */
  chartWindow?: { start: Date; end: Date };
}

/**
 * Forecast vintage, under the chart that draws it: when the run that produced
 * this line was generated, and which model and version produced it
 * (ABL-285, under the Board's ABL-284).
 *
 * Renders as a footnote in the same register as `NetPositionTab`'s per-run
 * provenance row rather than as a coloured pill — this is provenance, not an
 * alarm, and net position already answers the same question this way.
 *
 * Both halves of the claim are visible: the relative age is what a reader
 * actually wants ("is this stale?"), and the absolute UTC stamp beside it is
 * what makes the relative age checkable. `title` carries the full-precision
 * form and, when several runs are on screen, the oldest one too.
 *
 * The vintage line is deliberately absent from the multi-model selection views
 * (`LoadSelectionView` and friends): those normalise every checked model down
 * to `{timestamp, value}` before charting, and a TSO entry has no
 * `generated_at` at all — TSO provenance is its own question and its own
 * issue. One note under N differently-aged lines would be the row-zero defect
 * this component exists to avoid.
 */
export function ForecastVintageNote({ points, chartWindow }: ForecastVintageNoteProps) {
  const vintage = useMemo(
    () => describeForecastVintage(points, { window: chartWindow }),
    [points, chartWindow],
  );

  if (!vintage) return null;

  return (
    <p className="mt-2 font-mono-num text-micro text-ink-muted" title={vintage.detail}>
      {vintage.summary}
    </p>
  );
}
