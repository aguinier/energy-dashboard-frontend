import { AccuracyBadge } from './AccuracyBadge';
import type { AccuracyBadgeInput } from './accuracyBadgeState';

/**
 * The footnote for a figure whose badge and residual strip are always scored
 * against the TSO's own day-ahead publication (load, wind onshore, wind
 * offshore) — regardless of what the figure's own `ModelPicker` currently has
 * resolved. Both the badge (`useTrailingAccuracySummary`) and the residual
 * strip fetch the TSO series directly, deliberately bypassing the picker
 * (see the doc comments on those fetches in `CountryDocumentView.tsx`).
 *
 * When the picker resolves to an able-ml forecast — a user's pin, or a
 * silent ABL-469 auto-selection with no user action at all — the chart's own
 * "dashed = able-ml forecast" label and this footnote's old unconditional
 * "not an able model" text would both be on screen at once, saying opposite
 * things about the same figure (final-review-9, finding 1). `includesMl`
 * must come from the SAME resolved selection the chart's label is built
 * from (`useDrawnForecastSummary`), so the two can never disagree: this
 * component only renders the disambiguating copy, it does not decide when to.
 */
export function TsoAccuracyFootnote({
  metrics,
  window,
  includesMl,
}: {
  metrics: AccuracyBadgeInput | undefined;
  window: string;
  includesMl: boolean;
}) {
  return (
    <>
      <AccuracyBadge metrics={metrics} window={window} />
      {includesMl ? (
        <span>
          The dashed line above is able-ml&rsquo;s own forecast — the badge and
          residuals here are still measured against the TSO&rsquo;s day-ahead
          publication, not the line drawn.
        </span>
      ) : (
        <span>Forecast is the TSO&rsquo;s own day-ahead publication, not an able model.</span>
      )}
    </>
  );
}
