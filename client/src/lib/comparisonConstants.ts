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

// `getStatusLabel` lived here — it turned a WAPE into "Excellent" / "Good" /
// "Needs Improvement" against `METRIC_THRESHOLDS`. Removed under ABL-19 along
// with those thresholds: on real data it returned "Needs Improvement" for all
// 24 countries at once, spanning 9.9% to 76.8% WAPE, which is a verdict the
// numbers never earned. `ComparisonLeaderboard` now shows an exact rank within
// the forecast type instead. See `components/comparison/accuracyScale.ts`.
