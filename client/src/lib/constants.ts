import type { TimePreset } from '@/types';

// UNBUILT DESIGN SPEC — not wired to anything. This describes a categorised
// time picker (quick access / historical / around now / forecast) that was
// designed and never built; the shipped control is `RangeSegment.tsx`, five
// hardcoded buttons. Kept deliberately (ABL-4) as the record of that design
// while the product decision is with the CEO — it is the only place the
// intended shape is written down.
//
// Do not read it as a description of the code. It is NOT typed as
// `TimePreset[]` and does not track that union: `90d` and `1y` below are no
// longer `TimePreset` values at all (removed in ABL-4 — see
// `client/src/types/index.ts:115`), and `today`/`thisWeek`/`next1d`/`next48h`
// are valid `TimePreset` values that no control can currently set. Wiring any
// of this up means re-adding the missing union members and durations, not just
// rendering this object.
export const TIME_PRESETS = {
  // Quick access presets (shown in main bar)
  quickAccess: [
    { value: '7d', label: 'Last 7d', anchor: 'past' },
    { value: 'today', label: 'Today', anchor: 'now' },
    { value: 'next1d', label: 'Next Day', anchor: 'future' },
    { value: 'next7d', label: 'Next 7d', anchor: 'future' },
  ],
  // Historical presets (backward-looking)
  historical: [
    { value: '24h', label: 'Last 24h' },
    { value: '7d', label: 'Last 7d' },
    { value: '30d', label: 'Last 30d' },
    { value: '90d', label: 'Last 90d' },
    { value: '1y', label: 'Last year' },
  ],
  // Around now presets (centered on current time)
  aroundNow: [
    { value: 'today', label: 'Today (±12h)' },
    { value: 'thisWeek', label: 'This week' },
  ],
  // Forecast presets (forward-looking)
  forecast: [
    { value: 'next24h', label: 'Next 24h' },
    { value: 'next48h', label: 'Next 48h' },
    { value: 'next7d', label: 'Next 7d' },
  ],
} as const;

// Window duration in hours per `TimePreset`, used by `shiftTimeWindow` to move
// the window by half its length. One entry per `TimePreset` value and no more —
// `90d`/`1y` were dropped from both together (ABL-4) so the union and this map
// cannot disagree about which presets exist.
export const PRESET_DURATIONS_HOURS: Record<TimePreset, number> = {
  '24h': 24,
  '7d': 168,
  '30d': 720,
  'today': 24,
  'thisWeek': 168,
  'next1d': 24,
  'next24h': 24,
  'next48h': 48,
  'next7d': 168,
};

// The single source of truth for map metric copy. `unit` is the unit the map
// actually renders — EuropeMap divides load by 1000, so it is GW, not MW.
// `legendLabel` is what the legend says where it needs a different claim from
// the button: net position is a window average, not an instantaneous value.
// Every entry carries one so consumers can read it off the union unconditionally.
export const MAP_METRICS = [
  { value: 'price', label: 'Day-ahead price', unit: '€/MWh', legendLabel: 'Day-ahead price' },
  { value: 'renewable_pct', label: 'Renewable share', unit: '%', legendLabel: 'Renewable share' },
  { value: 'load', label: 'Electricity load', unit: 'GW', legendLabel: 'Electricity load' },
  { value: 'net_position', label: 'Net position', unit: 'MW', legendLabel: 'Avg net position' },
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
 */
export const TAB_FORECAST_TYPE: Record<string, string> = {
  price: 'price',
  load: 'load',
  renewables: 'solar',
  'net-position': 'net_position',
  analytics: 'load',
};
