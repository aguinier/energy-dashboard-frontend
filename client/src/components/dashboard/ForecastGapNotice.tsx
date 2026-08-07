import { useDashboardStore } from '@/store/dashboardStore';
import type { ForecastGap } from '@/lib/forecastGap';

interface ForecastGapNoticeProps {
  gap: ForecastGap | null;
  forecastType: string;
}

/**
 * Footnote under a chart whose forecast overlay came back empty, saying why.
 *
 * Renders under the chart rather than over it: the actuals are still real and
 * still worth showing. When a pin is the cause, the escape hatch is right here
 * — the picker's "Default" entry does the same thing, but a user who has just
 * hit the blank overlay is looking at the chart, not at the dropdown.
 */
export function ForecastGapNotice({ gap, forecastType }: ForecastGapNoticeProps) {
  const clearSelectedModel = useDashboardStore((s) => s.clearSelectedModel);
  if (!gap) return null;

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-ink-muted">
      <span>{gap.message}</span>
      {gap.clearable && (
        <button
          onClick={() => clearSelectedModel(forecastType)}
          className="cursor-pointer rounded-md border border-border bg-card px-1.5 py-px text-micro text-foreground hover:bg-secondary"
        >
          Use the best available model
        </button>
      )}
    </div>
  );
}
