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
 * Primary forecast type per country-view tab. The model picker renders the
 * registry entry for whichever tab is active, so the models offered always
 * match the data on screen.
 *
 * Keys are tab *ids*, read off the `TabsTrigger` elements in
 * `CountryDashboardView.tsx:106-110` — they do not match the visible labels.
 * `renewables` renders as "Generation" and `analytics` renders as "Forecast
 * accuracy". Both ids are live: `analytics` outlived the analytics dashboard
 * that `ebdb5ab` removed, because the accuracy tab reuses the id.
 *
 * `analytics` is read: `ForecastTab` calls `useActiveForecastType()` to pick
 * which type's registered models the "Compare forecast models" panel compares
 * (`ForecastTab.tsx`, `ModelComparisonPanel.tsx`). It is not read by
 * `ModelPicker`, which `TABS_WITH_MODEL_PICKER` (`CountryDashboardView.tsx:56`)
 * still keeps off that tab.
 *
 * `renewables` remains unread for the same reason — the Generation tab renders
 * actuals only and gets no picker. Keep it anyway: adding a forecast overlay
 * there puts it back in that set, and a missing key falls through to
 * `?? 'load'` (`useForecastModels.ts:74`) — the Generation tab would then offer
 * load models for solar data, which is the wrong-number-under-a-plausible-label
 * failure this dashboard exists to avoid.
 *
 * `wind-onshore`/`wind-offshore` (ABL-235) are two top-level tabs rather than
 * subtabs of `renewables`, specifically so this same generic keying serves
 * them with zero new plumbing — each is read by `ModelPicker` exactly like
 * `price`/`load`.
 */
export const TAB_FORECAST_TYPE: Record<string, string> = {
  price: 'price',
  load: 'load',
  renewables: 'solar',
  'wind-onshore': 'wind_onshore',
  'wind-offshore': 'wind_offshore',
  'net-position': 'net_position',
  analytics: 'load',
};
