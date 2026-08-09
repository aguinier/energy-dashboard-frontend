import type { CrossCountryMetrics } from '@/types';
import { FORECAST_TYPE_CONFIG, PORTFOLIO_FORECAST_TYPE_ORDER } from '@/lib/comparisonConstants';

export type PortfolioCoverage = 'measured' | 'unmeasurable' | 'unavailable';

export interface PortfolioRow {
  type: string;
  label: string;
  coverage: PortfolioCoverage;
  pairedCountries: number;
  measuredCountries: number;
  minWape: number | null;
  maxWape: number | null;
}

/**
 * One row for every supported forecast variable. A missing type has no
 * returned forecast/actual measure; null WAPE has paired data but zero total
 * actuals. Neither case is a 0% score.
 */
export function buildPortfolioRows(data: CrossCountryMetrics): PortfolioRow[] {
  return PORTFOLIO_FORECAST_TYPE_ORDER.map((type) => {
    const entries = Object.values(data)
      .map((byType) => byType[type])
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    const wapes = entries
      .map((entry) => entry.wape)
      .filter((wape): wape is number => wape !== null && Number.isFinite(wape));

    return {
      type,
      label: FORECAST_TYPE_CONFIG[type]?.label ?? type,
      coverage: wapes.length ? 'measured' : entries.length ? 'unmeasurable' : 'unavailable',
      pairedCountries: entries.length,
      measuredCountries: wapes.length,
      minWape: wapes.length ? Math.min(...wapes) : null,
      maxWape: wapes.length ? Math.max(...wapes) : null,
    };
  });
}

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
