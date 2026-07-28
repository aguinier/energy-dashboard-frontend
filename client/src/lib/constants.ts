// Legacy time ranges (kept for backward compatibility)
export const TIME_RANGES = [
  { value: '24h', label: '24 Hours' },
  { value: '7d', label: '7 Days' },
  { value: '30d', label: '30 Days' },
  { value: '90d', label: '90 Days' },
  { value: '1y', label: '1 Year' },
] as const;

// New categorized time presets
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

// Preset duration in hours (for navigation arrows)
export const PRESET_DURATIONS_HOURS: Record<string, number> = {
  '24h': 24,
  '7d': 168,
  '30d': 720,
  '90d': 2160,
  '1y': 8760,
  'today': 24,
  'thisWeek': 168,
  'next1d': 24,
  'next24h': 24,
  'next48h': 48,
  'next7d': 168,
};

export const GRANULARITIES = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
] as const;

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

export const ANIMATION_DURATION = {
  fast: 200,
  normal: 300,
  slow: 500,
  chart: 1500,
} as const;

export const API_BASE_URL = '/api';

export const DEFAULT_COUNTRY = 'DE'; // Germany as default

export const MAJOR_COUNTRIES = [
  'DE', // Germany
  'FR', // France
  'IT', // Italy
  'ES', // Spain
  'GB', // United Kingdom
  'PL', // Poland
  'NL', // Netherlands
  'BE', // Belgium
  'AT', // Austria
  'CH', // Switzerland
] as const;

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
 */
export const TAB_FORECAST_TYPE: Record<string, string> = {
  price: 'price',
  load: 'load',
  renewables: 'solar',
  'net-position': 'net_position',
  analytics: 'load',
};
