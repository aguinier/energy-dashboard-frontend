import type { TimePreset } from '@/types';

// Window label per `timePreset` value — the field `useDashboardOverview()`
// (client/src/hooks/useDashboardData.ts) now actually fetches on (via
// `getDateRangeForPreset(timePreset, timeOffset)`, the same source every
// other hook already used), and therefore the field whose value truthfully
// describes the window `overview.avgPrice`, `overview.renewablePercentage`,
// and `overview.peakDemand` were computed over.
//
// This used to be keyed off the legacy `timeRange` enum instead, because
// `useDashboardOverview` fetched on `timeRange` while most of the page read
// `timePreset` — and `setTimePreset` (dashboardStore.ts) collapsed every
// non-historical preset (today, thisWeek, next24h, next48h, next7d, next1d)
// down to `timeRange: '7d'`. A qualifier keyed off `timePreset` back then
// could claim a window (e.g. "next 24h") that the server never actually
// computed the number over — see Task 8's Critical finding. Now that the
// fetch itself reads `timePreset`/`timeOffset` directly, `timeRange` no
// longer exists (removed from the store — see migrate.ts) and there is only
// one field left to key off: this one. Typing this as `Record<TimePreset,
// string>` rather than `Record<string, string>` keeps the lookup exhaustive
// over every value `TimePreset` can actually hold, so it cannot silently go
// stale if `TimePreset` grows.
export const WINDOW_LABEL: Record<TimePreset, string> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  today: 'today',
  thisWeek: 'this week',
  next1d: 'next day',
  next24h: 'next 24h',
  next48h: 'next 48h',
  next7d: 'next 7d',
};

/** Resolve the display label for a `timePreset` value (falls back to the raw value for anything unrecognized). */
export function getWindowLabel(timePreset: string): string {
  return WINDOW_LABEL[timePreset as TimePreset] ?? timePreset;
}
