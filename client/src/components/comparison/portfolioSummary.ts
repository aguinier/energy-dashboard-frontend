import type { CrossCountryMetrics } from '@/types';

/**
 * Portfolio-wide accuracy cannot be averaged: its series use different units
 * and cover different countries. These are coverage facts only, scoped to the
 * metric currently being inspected.
 */
export function summarizePortfolio(
  data: CrossCountryMetrics,
  metric: 'wape' | 'mae' | 'rmse',
) {
  const countries = new Set<string>();
  const forecastTypes = new Set<string>();
  let measuredSeries = 0;
  let pairedObservations = 0;

  for (const [country, byType] of Object.entries(data)) {
    for (const [forecastType, entry] of Object.entries(byType)) {
      const value = entry[metric];
      if (value === null || !Number.isFinite(value)) continue;

      countries.add(country);
      forecastTypes.add(forecastType);
      measuredSeries += 1;
      pairedObservations += entry.dataPoints;
    }
  }

  return { countries: countries.size, forecastTypes: forecastTypes.size, measuredSeries, pairedObservations };
}
