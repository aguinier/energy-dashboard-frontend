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
 * One truthful portfolio row per forecast type. The metrics API omits a type
 * when it has no forecast/actual pairs at all, while WAPE is null when paired
 * actuals sum to zero. Those are different facts and must not become 0%.
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
      coverage: wapes.length > 0 ? 'measured' : entries.length > 0 ? 'unmeasurable' : 'unavailable',
      pairedCountries: entries.length,
      measuredCountries: wapes.length,
      minWape: wapes.length > 0 ? Math.min(...wapes) : null,
      maxWape: wapes.length > 0 ? Math.max(...wapes) : null,
    };
  });
}
