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

// ============================================================================
// Shifted windows
// ============================================================================
//
// Every label above describes a window anchored to *now*: "7d" means the last
// seven days, "next 24h" the next twenty-four. That is only true while
// `timeOffset` is 0. Once the navigation arrows can move the window (ABL-12
// wired `shiftTimeWindow` to a control; before that `timeOffset` was
// structurally always 0), a shifted window carries none of those claims — a
// `24h` window moved back three days is not "the last 24h", and captioning it
// that way states a window the fetch did not use. That is the same defect
// class as the old `timeRange`/`timePreset` split this module was written to
// close, arriving by a different route.
//
// So a shifted window drops the preset name entirely and states its own
// bounds. There is no wording that keeps "24h" honest here, and a qualifier
// the reader has to mentally offset is worse than an explicit date.
//
// Formatted in the *viewer's* timezone, matching the chart axes and tooltips
// (`toLocaleTimeString`, lib/chartTicks.ts). Brussels would be the market's
// zone but not the one the numbers beside it are drawn in, so a
// Brussels-formatted caption over a locally-formatted axis would disagree
// with itself.
//
// The tab view (`CountryDashboardView.tsx`, deleted in Task 9b) additionally
// stated this in a standalone "times in <zone>" caption beside its control
// bar; the country document that replaced it (`CountryDocumentView.tsx`)
// carries no equivalent caption today. Noted here rather than silently
// dropped, since it is the one piece of that page this module's own comment
// used to point at.

function localDay(d: Date): string {
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function localTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * State a window's own bounds, to the precision it actually has.
 *
 * Day-granularity only when the window really is whole days in the viewer's
 * zone — a Brussels market day reads as 00:00-23:59 for a Brussels viewer but
 * 23:00-22:59 for a Lisbon one, and the Lisbon viewer is shown the times,
 * because for them the window genuinely does straddle two dates.
 */
export function formatWindowRange(start: Date, end: Date): string {
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return 'unknown window';

  const wholeDays =
    start.getHours() === 0 &&
    start.getMinutes() === 0 &&
    end.getHours() === 23 &&
    end.getMinutes() === 59;

  if (wholeDays) {
    const from = localDay(start);
    const to = localDay(end);
    return from === to ? from : `${from} – ${to}`;
  }

  return `${localDay(start)} ${localTime(start)} – ${localDay(end)} ${localTime(end)}`;
}

/**
 * The caption for the window a number was computed over.
 *
 * At the live position this is the preset's name, unchanged. Shifted, it is
 * the window's own bounds — `range` must be the same `getDateRangeForPreset`
 * result the fetch used, not a second window derived some other way.
 */
export function describeWindow(
  timePreset: string,
  timeOffset: number,
  range: { start: Date; end: Date },
): string {
  if (timeOffset === 0) return getWindowLabel(timePreset);
  return formatWindowRange(range.start, range.end);
}
