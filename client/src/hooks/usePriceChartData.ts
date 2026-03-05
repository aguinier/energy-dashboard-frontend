import { useQueries } from '@tanstack/react-query';
import { useDashboardStore } from '@/store/dashboardStore';
import {
  fetchPriceData,
  fetchForecastData,
  fetchForecastComparison,
} from '@/services/api';
import { REFRESH_INTERVALS } from '@/lib/constants';
import {
  getDateRangeForPreset,
  getGranularityForPreset,
  getMLForecastDateRange,
} from './useDashboardData';
import type {
  PriceDataPoint,
  ForecastDataPoint,
  ForecastComparisonData,
} from '@/types';

export interface PriceChartData {
  // Actual price data
  priceData: PriceDataPoint[] | undefined;
  isLoadingPrice: boolean;

  // ML forecast data
  forecastData: ForecastDataPoint[] | undefined;
  isLoadingForecast: boolean;

  // ML comparison data
  comparisonData: ForecastComparisonData | undefined;
  isLoadingComparison: boolean;

  // Aggregate loading state
  isLoading: boolean;
  isError: boolean;
}

/**
 * Batched hook for PriceChart that fetches all data in parallel.
 * PriceChart doesn't have TSO forecasts (ENTSO-E doesn't provide price forecasts).
 */
export function usePriceChartData(): PriceChartData {
  // Use selective store subscriptions to minimize re-renders
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const timePreset = useDashboardStore((s) => s.timePreset);
  const timeOffset = useDashboardStore((s) => s.timeOffset);
  const showForecast = useDashboardStore((s) => s.showForecast);
  const showComparisonMode = useDashboardStore((s) => s.showComparisonMode);

  // Calculate date ranges
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);
  const granularity = getGranularityForPreset(timePreset);

  // ML forecast date range (window start to max(window end, now+48h))
  const { start: mlForecastStart, end: mlForecastEnd } = getMLForecastDateRange(start, end, 48);

  const queries = useQueries({
    queries: [
      // Query 0: Actual price data (always fetched)
      {
        queryKey: ['prices', selectedCountry, timePreset, timeOffset, granularity],
        queryFn: () =>
          fetchPriceData({
            country: selectedCountry,
            start: start.toISOString(),
            end: end.toISOString(),
            granularity,
          }),
        staleTime: REFRESH_INTERVALS.dashboard,
      },
      // Query 1: ML forecast data
      {
        queryKey: ['forecast', selectedCountry, 'price', timePreset, timeOffset, granularity],
        queryFn: () =>
          fetchForecastData({
            country: selectedCountry,
            type: 'price',
            start: mlForecastStart,
            end: mlForecastEnd,
            granularity,
          }),
        enabled: showForecast,
        staleTime: REFRESH_INTERVALS.dashboard,
      },
      // Query 2: ML forecast comparison
      {
        queryKey: ['forecast', 'comparison', selectedCountry, 'price', timePreset, timeOffset],
        queryFn: () =>
          fetchForecastComparison({
            country: selectedCountry,
            type: 'price',
            start: start.toISOString(),
            end: end.toISOString(),
          }),
        enabled: showForecast && showComparisonMode,
        staleTime: REFRESH_INTERVALS.dashboard,
      },
    ],
  });

  const [priceQuery, forecastQuery, comparisonQuery] = queries;

  return {
    // Actual price data
    priceData: priceQuery.data,
    isLoadingPrice: priceQuery.isLoading,

    // ML forecast data
    forecastData: forecastQuery.data,
    isLoadingForecast: forecastQuery.isLoading,

    // ML comparison data
    comparisonData: comparisonQuery.data,
    isLoadingComparison: comparisonQuery.isLoading,

    // Aggregate states
    isLoading: priceQuery.isLoading, // Only consider primary data loading
    isError: queries.some((q) => q.isError),
  };
}
