import { useDashboardStore } from '@/store/dashboardStore';
import type { SelectionGap } from '@/lib/forecastGap';

interface ForecastGapNoticeProps {
  /**
   * Multi-select gaps (ABL-204) — one row per explicitly-checked model with
   * no rows for this window.
   */
  gaps: SelectionGap[];
  forecastType: string;
}

/**
 * Footnote under a chart whose forecast comparison came back empty for one or
 * more of the explicitly-checked models, saying why.
 *
 * Renders under the chart rather than over it: the actuals are still real and
 * still worth showing. Needs its own escape hatch per model, not one for the
 * whole notice — unchecking one model leaves the others exactly as they were.
 * This is the same ABL-16 property ("a gap has to stay reachable, not just
 * visible") applied per model.
 *
 * ABL-221 removed the single-select counterpart (the "Default" view's
 * one-pin footnote) as confusing; this multi-select case is unrelated —
 * it only ever renders once a user has explicitly checked more than one
 * model to compare.
 */
export function ForecastGapNotice({ gaps, forecastType }: ForecastGapNoticeProps) {
  const toggleSelectedModel = useDashboardStore((s) => s.toggleSelectedModel);

  if (gaps.length === 0) return null;

  return (
    <div className="mt-2.5 flex flex-col gap-1">
      {gaps.map((g) => (
        <div key={g.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-ink-muted">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: g.color }} />
          <span>{g.message}</span>
          <button
            onClick={() => toggleSelectedModel(forecastType, g.id)}
            className="cursor-pointer rounded-md border border-border bg-card px-1.5 py-px text-micro text-foreground hover:bg-secondary"
          >
            Remove from comparison
          </button>
        </div>
      ))}
    </div>
  );
}
