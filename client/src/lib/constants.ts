import type { TimePreset } from '@/types';

// How far one click of `shiftTimeWindow` (store/dashboardStore.ts) moves the
// window, per preset. Replaces the old `PRESET_DURATIONS_HOURS`, which stored
// the window *length* and let the store derive a step of half of it — that
// derivation was wrong for the two day-aligned presets and is the reason the
// step is stated explicitly here instead:
//
//   - Continuous presets step by half their length, so consecutive windows
//     overlap and a feature near a boundary stays visible while browsing.
//   - `today` and `next1d` are Brussels market days, not "now ± N hours"
//     (lib/timezone.ts). Half of 24h would have re-derived the *same* calendar
//     day about half the time — a click that redraws an identical chart while
//     the caption claims a different day. They step one whole day, which
//     `getDateRangeForPreset` applies as calendar arithmetic rather than as an
//     hour offset (see `wholeDays`, hooks/useDashboardData.ts).
//
// Typed `Record<TimePreset, number>` so a preset added to the union without a
// step here is named by the compiler rather than silently inheriting one.
export const PRESET_SHIFT_HOURS: Record<TimePreset, number> = {
  '24h': 12,
  '7d': 84,
  '30d': 360,
  'today': 24,      // one Brussels market day
  'thisWeek': 84,
  'next1d': 24,     // one Brussels market day
  'next24h': 12,
  'next48h': 24,
  'next7d': 84,
};

// The single source of truth for map metric copy. `unit` is the unit the map
// actually renders — EuropeMap divides load by 1000, so it is GW, not MW.
// `legendLabel` is what the legend says where it needs a different claim from
// the button: net position is a window average, not an instantaneous value,
// and (ABL-222) it is drawn over every ENTSO-E-coupled border, not the
// narrower Core-region figure of the same name — see `netPositionScope.ts`
// for the full disclosure rendered alongside this label.
// Every entry carries one so consumers can read it off the union unconditionally.
export const MAP_METRICS = [
  { value: 'price', label: 'Day-ahead price', unit: '€/MWh', legendLabel: 'Day-ahead price' },
  { value: 'renewable_pct', label: 'Renewable share', unit: '%', legendLabel: 'Renewable share' },
  { value: 'load', label: 'Electricity load', unit: 'GW', legendLabel: 'Electricity load' },
  { value: 'net_position', label: 'Net position', unit: 'MW', legendLabel: 'Avg net position, all coupled borders' },
] as const;

export const API_BASE_URL = '/api';

export const DEFAULT_COUNTRY = 'DE'; // Germany as default

// Refresh intervals in milliseconds
export const REFRESH_INTERVALS = {
  realtime: 60000,     // 1 minute
  dashboard: 300000,   // 5 minutes
  map: 600000,         // 10 minutes
} as const;

/**
 * Figure anchor id (`Figure.tsx`'s `anchorId`, rendered as `id="figure-<id>"`
 * in `CountryDocumentView.tsx`) that carries a given forecast type's measured
 * accuracy. Read by `goToCountry` (`store/dashboardStore.ts`) to resolve
 * "scroll to the figure for the forecast type just clicked" when a reader
 * lands on the country page from the Forecast quality view
 * (`ComparisonHeatmap.tsx`, `ComparisonLeaderboard.tsx`, `ComparisonMap.tsx`,
 * `CountryRanking.tsx`) — Task 9b, replacing the tab view's `activeChartTab`
 * that this document has no equivalent of (every figure is on screen, or
 * lazily mounted, at once; there is no single "current" one).
 *
 * A forecast type absent here (`renewable`, `hydro_total`, `biomass` — the
 * cross-country portfolio measures more types than this document renders
 * figures for) has no matching figure. `goToCountry` leaves `pendingScrollAnchor`
 * unset in that case, and lands the reader at the page's natural top rather
 * than scrolling to nothing.
 */
export const FORECAST_TYPE_FIGURE_ANCHOR: Record<string, string> = {
  load: 'load',
  price: 'price',
  solar: 'generation',
  wind_onshore: 'wind-onshore',
  wind_offshore: 'wind-offshore',
  net_position: 'net-position',
};
