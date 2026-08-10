// Energy source colors
export const ENERGY_COLORS = {
  solar: '#FCD34D',
  wind_onshore: '#60A5FA',
  wind_offshore: '#3B82F6',
  hydro: '#2DD4BF',
  biomass: '#22C55E',
  geothermal: '#F97316',
  other: '#9CA3AF',
} as const;

// Price gradient colors
export const PRICE_COLORS = {
  low: '#22C55E',
  medium: '#F59E0B',
  high: '#EF4444',
  negative: '#8B5CF6', // Purple for negative prices
} as const;

// Country comparison colors (for multi-line charts)
export const COUNTRY_COLORS = [
  '#3B82F6', // Blue
  '#EF4444', // Red
  '#22C55E', // Green
  '#F59E0B', // Amber
  '#8B5CF6', // Purple
] as const;

// Chart gradient definitions
export const CHART_GRADIENTS = {
  load: {
    id: 'loadGradient',
    colors: ['#3B82F6', '#1D4ED8'],
  },
  price: {
    id: 'priceGradient',
    colors: ['#22C55E', '#EF4444'],
  },
  renewable: {
    id: 'renewableGradient',
    colors: ['#22C55E', '#10B981'],
  },
} as const;

// Map choropleth scales
export function getLoadColorScale(value: number, min: number, max: number): string {
  const normalized = (value - min) / (max - min);
  // Blue scale: lighter for lower, darker for higher
  const hue = 220;
  const saturation = 80;
  const lightness = 85 - (normalized * 50); // 85% to 35%
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

export function getPriceColorScale(value: number, min: number, max: number): string {
  const normalized = (value - min) / (max - min);

  // Handle negative prices
  if (value < 0) {
    return PRICE_COLORS.negative;
  }

  // Green -> Yellow -> Red
  if (normalized < 0.5) {
    // Green to Yellow
    const hue = 120 - (normalized * 2 * 60); // 120 to 60
    return `hsl(${hue}, 70%, 50%)`;
  } else {
    // Yellow to Red
    const hue = 60 - ((normalized - 0.5) * 2 * 60); // 60 to 0
    return `hsl(${hue}, 70%, 50%)`;
  }
}

export function getRenewableColorScale(percentage: number): string {
  // 0% = red, 50% = yellow, 100% = green
  const hue = percentage * 1.2; // 0 to 120 (red to green)
  return `hsl(${hue}, 70%, 45%)`;
}

// Recharts color helpers
export function getRenewableChartColors() {
  return Object.entries(ENERGY_COLORS).map(([name, color]) => ({
    dataKey: name,
    fill: color,
    stroke: color,
  }));
}

// ============================================================================
// Cross-Country Comparison Metric Thresholds
// ============================================================================
//
// `METRIC_THRESHOLDS`, `getMetricColor` and `getMetricColorHSL` used to live
// here: fixed per-type "excellent"/"good" WAPE cutoffs driving a green/amber/
// red scale. They were removed under ABL-19. Two reasons, in order:
//
//  - The cutoffs (load 3%/5%, price 12%/18%) were never calibrated against
//    measured accuracy, and the real data does not reach them — over the
//    default 30-day window on 2026-08-05, 21 of 24 load cells and 23 of 24
//    price cells were the same red, so the colour carried no information and
//    the leaderboard graded every country "Needs Improvement" at once.
//  - Green-vs-red is the one pair a red-green colour blind viewer cannot
//    separate, and `EuropeMap` had already settled the house scale away from
//    it (see `lib/dataScale.ts`).
//
// Their replacement (`components/comparison/accuracyScale.ts`, ranking within
// one forecast type's own observed spread on the shared teal -> amber ->
// terracotta ramp) is gone too, along with the rest of the cross-country
// comparison page it coloured — ABL-158 removed the Forecast quality view
// entirely. Nothing here renders a WAPE colour any more.

/**
 * Append an alpha channel to a hex color string.
 * @param hex - 6-digit hex color (e.g. '#22C55E')
 * @param opacity - 0..1 opacity value
 */
export function withOpacity(hex: string, opacity: number): string {
  const alpha = Math.round(opacity * 255).toString(16).padStart(2, '0');
  return hex + alpha;
}
