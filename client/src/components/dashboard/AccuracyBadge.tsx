import { accuracyBadgeState, type AccuracyBadgeInput } from './accuracyBadgeState';

interface Props {
  metrics: AccuracyBadgeInput | undefined;
  /** Human phrasing of the measurement window, e.g. "30 days". */
  window: string;
  minPoints?: number;
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/**
 * The accuracy claim attached to one figure.
 *
 * `absent` renders nothing: a figure nobody forecasts (net position) says so in
 * its prose footnote, and a badge reading "no data" there would imply a
 * forecast was expected and missing.
 */
export function AccuracyBadge({ metrics, window, minPoints }: Props) {
  const state = accuracyBadgeState(metrics, minPoints);

  if (state.kind === 'absent') return null;

  if (state.kind === 'measured') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-sm border border-accent
                       bg-accent px-2 py-0.5 text-micro font-medium text-primary">
        <CheckIcon />
        WAPE {state.wape.toFixed(2)}% over {window}
        <span className="font-normal text-ink-muted">
          ({state.dataPoints.toLocaleString('en-GB')} points)
        </span>
      </span>
    );
  }

  if (state.kind === 'withheld') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-sm border border-border
                       bg-secondary px-2 py-0.5 text-micro text-ink-dim">
        Error measures withheld — forecast and actuals are published on
        different bases, so their difference is definitional, not forecast error
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-sm border border-border
                     bg-secondary px-2 py-0.5 text-micro text-ink-muted">
      Not measurable in this window
    </span>
  );
}
