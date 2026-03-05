import { METRIC_THRESHOLDS } from './colors';

// Forecast type display config
export const FORECAST_TYPE_CONFIG: Record<string, { label: string; shortLabel: string; unit: string }> = {
  load:          { label: 'Load',           shortLabel: 'Load',  unit: 'MW' },
  price:         { label: 'Price',          shortLabel: 'Price', unit: 'EUR/MWh' },
  renewable:     { label: 'Renewable',      shortLabel: 'Ren.',  unit: 'MW' },
  solar:         { label: 'Solar',          shortLabel: 'Solar', unit: 'MW' },
  wind_onshore:  { label: 'Wind Onshore',   shortLabel: 'Wind',  unit: 'MW' },
  wind_offshore: { label: 'Wind Offshore',  shortLabel: 'W.Off', unit: 'MW' },
  hydro_total:   { label: 'Hydro Total',    shortLabel: 'Hydro', unit: 'MW' },
  biomass:       { label: 'Biomass',        shortLabel: 'Bio',   unit: 'MW' },
};

// Canonical ordering
export const FORECAST_TYPE_ORDER = [
  'load', 'price', 'renewable', 'solar',
  'wind_onshore', 'wind_offshore', 'hydro_total', 'biomass',
] as const;

export function sortForecastTypes(types: string[]): string[] {
  return [...types].sort((a, b) => {
    const ai = FORECAST_TYPE_ORDER.indexOf(a as typeof FORECAST_TYPE_ORDER[number]);
    const bi = FORECAST_TYPE_ORDER.indexOf(b as typeof FORECAST_TYPE_ORDER[number]);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

// Filter bar options (includes 'all')
export const FORECAST_TYPE_FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  ...FORECAST_TYPE_ORDER.map((t) => ({
    value: t,
    label: FORECAST_TYPE_CONFIG[t].shortLabel,
  })),
];

// Map selector options (no 'all' — map needs a single type)
export const FORECAST_TYPE_MAP_OPTIONS = FORECAST_TYPE_ORDER.map((t) => ({
  value: t,
  label: FORECAST_TYPE_CONFIG[t].shortLabel,
}));

// Status badge helper
export function getStatusLabel(
  mape: number,
  forecastType: string,
): { label: string; level: 'excellent' | 'good' | 'poor' } {
  const thresholds = METRIC_THRESHOLDS[forecastType] || METRIC_THRESHOLDS.load;
  if (mape < thresholds.excellent) return { label: 'Excellent', level: 'excellent' };
  if (mape < thresholds.good) return { label: 'Good', level: 'good' };
  return { label: 'Needs Improvement', level: 'poor' };
}
