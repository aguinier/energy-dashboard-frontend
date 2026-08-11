import { useDashboardStore } from '@/store/dashboardStore';
import type { ForecastGap, SelectionGap } from '@/lib/forecastGap';

interface ForecastGapNoticeProps {
  /** Single-select gap (Load/Price/net position's "Default" or one-pin state). */
  gap?: ForecastGap | null;
  /**
   * Multi-select gaps (ABL-204) — one row per explicitly-checked model with
   * no rows for this window. Takes precedence over `gap` when non-empty;
   * callers pass at most one of the two depending on which mode the picker
   * is in.
   */
  gaps?: SelectionGap[];
  forecastType: string;
}

/**
 * Footnote under a chart whose forecast overlay came back empty, saying why.
 *
 * Renders under the chart rather than over it: the actuals are still real and
 * still worth showing. When a pin is the cause, the escape hatch is right here
 * — the picker's "Default" entry does the same thing, but a user who has just
 * hit the blank overlay is looking at the chart, not at the dropdown.
 *
 * The multi-select case (`gaps`) needs its own escape hatch per model, not
 * one for the whole notice — unlike a single pin, unchecking one model leaves
 * the others exactly as they were. This is the same ABL-16 property applied
 * per model: a gap has to stay reachable, not just visible.
 */
export function ForecastGapNotice({ gap, gaps, forecastType }: ForecastGapNoticeProps) {
  const clearSelectedModel = useDashboardStore((s) => s.clearSelectedModel);
  const toggleSelectedModel = useDashboardStore((s) => s.toggleSelectedModel);

  if (gaps && gaps.length > 0) {
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
