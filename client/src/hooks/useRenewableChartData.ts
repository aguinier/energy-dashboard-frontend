import { useQueries } from '@tanstack/react-query';
import { useDashboardStore } from '@/store/dashboardStore';
import {
  fetchRenewableData,
  fetchForecastData,
  fetchTSOGenerationForecast,
} from '@/services/api';
import { REFRESH_INTERVALS } from '@/lib/constants';
import {
  getDateRangeForPreset,
  getGranularityForPreset,
  getMLForecastDateRange,
} from './useDashboardData';
import type {
  RenewableDataPoint,
  ForecastDataPoint,
  TSOGenerationForecastDataPoint,
} from '@/types';

// Helper to extend date range for forecast overlay
function getTSOForecastDateRange(
  startDate: Date,
  endDate: Date,
  futureDays: number = 7
): { start: string; end: string } {
  const extendedEnd = new Date(Math.max(endDate.getTime(), Date.now() + futureDays * 24 * 60 * 60 * 1000));
  return { start: startDate.toISOString(), end: extendedEnd.toISOString() };
}

export interface RenewableChartData {
  // Actual renewable data
  renewableData: RenewableDataPoint[] | undefined;
  isLoadingRenewable: boolean;

  // ML forecast data for each type
  solarForecast: ForecastDataPoint[] | undefined;
  windOnshoreForecast: ForecastDataPoint[] | undefined;
  windOffshoreForecast: ForecastDataPoint[] | undefined;
  hydroForecast: ForecastDataPoint[] | undefined;
  biomassForecast: ForecastDataPoint[] | undefined;

  // TSO generation forecast
  tsoGenerationForecast: TSOGenerationForecastDataPoint[] | undefined;
  isLoadingTSOForecast: boolean;

  // Aggregate loading state
  isLoading: boolean;
  isError: boolean;
}

/**
 * Batched hook for RenewableMixChart that fetches all data in parallel.
 * This replaces 7 separate useQuery hooks with a single useQueries call,
 * significantly reducing load time when forecasts are enabled.
 */
export function useRenewableChartData(): RenewableChartData {
  // Use selective store subscriptions to minimize re-renders
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const timePreset = useDashboardStore((s) => s.timePreset);
  const timeOffset = useDashboardStore((s) => s.timeOffset);
  const showForecast = useDashboardStore((s) => s.showForecast);
  const showTSOForecast = useDashboardStore((s) => s.showTSOForecast);

  // Calculate date ranges
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);
  const granularity = getGranularityForPreset(timePreset);
  const { start: tsoStart, end: tsoEnd } = getTSOForecastDateRange(start, end, 7);

  // ML forecast date range (window start to max(window end, now+48h))
  const { start: mlForecastStart, end: mlForecastEnd } = getMLForecastDateRange(start, end, 48);

  const queries = useQueries({
    queries: [
      // Query 0: Actual renewable data (always fetched)
      {
        queryKey: ['renewables', selectedCountry, timePreset, timeOffset, granularity],
        queryFn: () =>
          fetchRenewableData({
            country: selectedCountry,
            start: start.toISOString(),
            end: end.toISOString(),
            granularity,
          }),
        staleTime: REFRESH_INTERVALS.dashboard,
      },
      // Query 1: ML solar forecast
      {
        queryKey: ['forecast', selectedCountry, 'solar', timePreset, timeOffset, granularity],
        queryFn: () =>
          fetchForecastData({
            country: selectedCountry,
            type: 'solar',
            start: mlForecastStart,
            end: mlForecastEnd,
            granularity,
          }),
        enabled: showForecast,
        staleTime: REFRESH_INTERVALS.dashboard,
      },
      // Query 2: ML wind_onshore forecast
      {
        queryKey: ['forecast', selectedCountry, 'wind_onshore', timePreset, timeOffset, granularity],
        queryFn: () =>
          fetchForecastData({
            country: selectedCountry,
            type: 'wind_onshore',
            start: mlForecastStart,
            end: mlForecastEnd,
            granularity,
          }),
        enabled: showForecast,
        staleTime: REFRESH_INTERVALS.dashboard,
      },
      // Query 3: ML wind_offshore forecast
      {
        queryKey: ['forecast', selectedCountry, 'wind_offshore', timePreset, timeOffset, granularity],
        queryFn: () =>
          fetchForecastData({
            country: selectedCountry,
            type: 'wind_offshore',
            start: mlForecastStart,
            end: mlForecastEnd,
            granularity,
          }),
        enabled: showForecast,
        staleTime: REFRESH_INTERVALS.dashboard,
      },
      // Query 4: ML hydro_total forecast
      {
        queryKey: ['forecast', selectedCountry, 'hydro_total', timePreset, timeOffset, granularity],
        queryFn: () =>
          fetchForecastData({
            country: selectedCountry,
            type: 'hydro_total',
            start: mlForecastStart,
            end: mlForecastEnd,
            granularity,
          }),
        enabled: showForecast,
        staleTime: REFRESH_INTERVALS.dashboard,
      },
      // Query 5: ML biomass forecast
      {
        queryKey: ['forecast', selectedCountry, 'biomass', timePreset, timeOffset, granularity],
        queryFn: () =>
          fetchForecastData({
            country: selectedCountry,
            type: 'biomass',
            start: mlForecastStart,
            end: mlForecastEnd,
            granularity,
          }),
        enabled: showForecast,
        staleTime: REFRESH_INTERVALS.dashboard,
      },
      // Query 6: TSO generation forecast (solar + wind)
      {
        queryKey: ['tso-forecast', 'generation', selectedCountry, timePreset, timeOffset, granularity],
        queryFn: () =>
          fetchTSOGenerationForecast({
            countryCode: selectedCountry,
            start: tsoStart,
            end: tsoEnd,
            granularity,
          }),
        enabled: showTSOForecast,
        staleTime: REFRESH_INTERVALS.dashboard,
      },
    ],
  });

  const [
    renewableQuery,
    solarQuery,
    windOnshoreQuery,
    windOffshoreQuery,
    hydroQuery,
    biomassQuery,
    tsoGenQuery,
  ] = queries;

  return {
    // Actual renewable data
    renewableData: renewableQuery.data,
    isLoadingRenewable: renewableQuery.isLoading,

    // ML forecast data
    solarForecast: solarQuery.data,
    windOnshoreForecast: windOnshoreQuery.data,
    windOffshoreForecast: windOffshoreQuery.data,
    hydroForecast: hydroQuery.data,
    biomassForecast: biomassQuery.data,

    // TSO generation forecast
    tsoGenerationForecast: tsoGenQuery.data,
    isLoadingTSOForecast: tsoGenQuery.isLoading,

    // Aggregate states
    isLoading: renewableQuery.isLoading, // Only consider primary data loading
    isError: queries.some((q) => q.isError),
  };
}
