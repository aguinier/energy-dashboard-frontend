import type { NetPositionForecastVintage } from '@/types';

/**
 * "D+N" label for a forecast run, derived from `horizon_hours` rather than
 * hardcoded — so a future D+1 run (Chronos only emits D+2 today) labels
 * itself correctly with no code change here.
 *
 * Takes the vintage's MINIMUM horizon (its first target hour — the target
 * day's 00:00), not any single point's own horizon. One run always targets
 * one calendar day as a 24-hour block, but a D+2 run's horizon spans roughly
 * 40–64h, straddling the 48h mark — labelling per-point off raw
 * `horizon_hours` would split one day's forecast across "D+2" and "D+3" near
 * that boundary even though every point in the block targets the same day.
 *
 * `ceil` (not `floor`) so a run generated exactly at midnight and targeting
 * the next midnight (horizon = 24h exactly) reads as D+1, not D+2 — it is
 * genuinely only one day out.
 *
 * `minHorizonHours` is null when every row in the vintage had a null
 * `horizon_hours` (the column has no NOT NULL constraint, and nothing at the
 * ingest HTTP boundary enforces it). That must resolve to an honest "D+?",
 * not silently fall through arithmetic — `null / 24` coerces to `0` in JS,
 * which would previously label an unknown-horizon vintage as D+1.
 */
export function horizonDayLabel(minHorizonHours: number | null): string {
  if (minHorizonHours == null) return 'D+?';
  const days = Math.max(1, Math.ceil(minHorizonHours / 24));
  return `D+${days}`;
}

export interface VintageSummary {
  generated_at: string;
  dayLabel: string;
  target_count: number;
  first_target: string;
  last_target: string;
}

/** Newest-first, human-summarizable view of each forecast run present. */
export function summarizeVintages(
  vintages: NetPositionForecastVintage[] | undefined,
): VintageSummary[] {
  return (vintages ?? []).map((v) => ({
    generated_at: v.generated_at,
    dayLabel: horizonDayLabel(v.horizon_hours_min),
    target_count: v.target_count,
    first_target: v.first_target,
    last_target: v.last_target,
  }));
}

/** How many runs the provenance row lists before collapsing the rest. */
export const MAX_VINTAGE_ROWS = 5;

export interface CappedVintages {
  shown: VintageSummary[];
  /** Runs omitted from `shown`. 0 when everything fits. */
  hiddenCount: number;
}

/**
 * Cap the per-run provenance list so a wide window does not stack dozens of
 * rows under the chart.
 *
 * One run lands per day and is kept indefinitely, and the chart lists every
 * run whose target day falls inside the visible window. That is bounded — the
 * query is limited to the window — but the bound is the window itself: ~4 rows
 * on the 24h preset, ~33 on 30d once the job has been running a month.
 *
 * Nothing is lost by collapsing: each point carries its own run in its
 * tooltip, and this row is a summary rather than the source of truth.
 *
 * Collapsing only kicks in past `max + 1`, because turning a single extra row
 * into a "+1 more" row saves no space and just costs the reader a click.
 */
export function capVintages(
  summaries: VintageSummary[],
  max: number = MAX_VINTAGE_ROWS,
): CappedVintages {
  if (summaries.length <= max + 1) return { shown: summaries, hiddenCount: 0 };
  return { shown: summaries.slice(0, max), hiddenCount: summaries.length - max };
}

/**
 * `generated_at` -> "D+N" lookup, for tagging individual chart points with
 * the provenance of whichever vintage won for that timestamp.
 */
export function dayLabelByVintage(
  vintages: NetPositionForecastVintage[] | undefined,
): Map<string, string> {
  return new Map((vintages ?? []).map((v) => [v.generated_at, horizonDayLabel(v.horizon_hours_min)]));
}
