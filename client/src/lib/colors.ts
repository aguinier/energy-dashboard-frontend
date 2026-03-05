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

export const METRIC_THRESHOLDS: Record<string, { excellent: number; good: number }> = {
  load: { excellent: 3, good: 5 },
  price: { excellent: 12, good: 18 },
  renewable: { excellent: 20, good: 30 },
  solar: { excellent: 20, good: 30 },
  wind_onshore: { excellent: 20, good: 30 },
  wind_offshore: { excellent: 20, good: 30 },
  hydro_total: { excellent: 20, good: 30 },
  biomass: { excellent: 20, good: 30 },
};

/**
 * Get a discrete color for a MAPE value based on forecast type thresholds.
 * Green if excellent, yellow if good, red otherwise.
 */
export function getMetricColor(mape: number, forecastType: string): string {
  const thresholds = METRIC_THRESHOLDS[forecastType] || METRIC_THRESHOLDS.load;
  if (mape < thresholds.excellent) return '#22C55E';
  if (mape < thresholds.good) return '#F59E0B';
  return '#EF4444';
}

/**
 * Get an HSL-interpolated color for smooth choropleth maps.
 * Smoothly transitions green -> yellow -> red based on MAPE thresholds.
 */
export function getMetricColorHSL(mape: number, forecastType: string): string {
  const thresholds = METRIC_THRESHOLDS[forecastType] || METRIC_THRESHOLDS.load;
  const maxVal = thresholds.good * 1.5; // Red zone starts at 1.5x the "good" threshold

  // Clamp between 0 and maxVal
  const clamped = Math.max(0, Math.min(mape, maxVal));
  // Normalize to 0..1 range
  const normalized = clamped / maxVal;
  // Hue: 120 (green) -> 60 (yellow) -> 0 (red)
  const hue = 120 - normalized * 120;
  return `hsl(${hue}, 75%, 45%)`;
}

/**
 * Append an alpha channel to a hex color string.
 * @param hex - 6-digit hex color (e.g. '#22C55E')
 * @param opacity - 0..1 opacity value
 */
export function withOpacity(hex: string, opacity: number): string {
  const alpha = Math.round(opacity * 255).toString(16).padStart(2, '0');
  return hex + alpha;
}
