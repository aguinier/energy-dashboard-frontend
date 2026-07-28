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
 */
export function horizonDayLabel(minHorizonHours: number): string {
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

/**
 * `generated_at` -> "D+N" lookup, for tagging individual chart points with
 * the provenance of whichever vintage won for that timestamp.
 */
export function dayLabelByVintage(
  vintages: NetPositionForecastVintage[] | undefined,
): Map<string, string> {
  return new Map((vintages ?? []).map((v) => [v.generated_at, horizonDayLabel(v.horizon_hours_min)]));
}
