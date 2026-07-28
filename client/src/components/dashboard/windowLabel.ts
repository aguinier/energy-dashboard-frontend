import type { TimeRange } from '@/types';

// Window label per `timeRange` value — the field `useDashboardOverview()`
// (client/src/hooks/useDashboardData.ts) actually fetches on, and therefore
// the field whose value truthfully describes the window `overview.avgPrice`,
// `overview.renewablePercentage`, and `overview.peakDemand` were computed
// over.
//
// This is deliberately keyed off `timeRange`, NOT the finer-grained
// `timePreset`. `setTimePreset` (dashboardStore.ts) only mirrors the five
// historical presets into `timeRange` 1:1; every other preset (today,
// thisWeek, next24h, next48h, next7d, next1d) collapses `timeRange` to '7d'.
// A qualifier keyed off `timePreset` could claim a window (e.g. "next 24h")
// that the server never computed the number over — see Task 8 Critical
// finding. Typing this as `Record<TimeRange, string>` rather than
// `Record<string, string>` also makes the lookup exhaustive over every value
// `timeRange` can actually hold, so it cannot silently go stale if
// `TimeRange` grows.
export const WINDOW_LABEL: Record<TimeRange, string> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
  '1y': '1y',
};

/** Resolve the display label for a `timeRange` value (falls back to the raw value for anything unrecognized). */
export function getWindowLabel(timeRange: string): string {
  return WINDOW_LABEL[timeRange as TimeRange] ?? timeRange;
}
