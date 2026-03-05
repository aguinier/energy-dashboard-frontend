import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import {
  fetchDashboardOverview,
  fetchPriceData,
  fetchRenewableData,
  fetchCountries,
  fetchInitialCountryData,
} from '@/services/api';
import { getDateRangeForPreset, getGranularityForPreset } from './useDashboardData';
import { useDashboardStore } from '@/store/dashboardStore';
import { REFRESH_INTERVALS } from '@/lib/constants';

/**
 * Hook to prefetch country data before navigating to country view.
 * This reduces perceived load time by starting API calls immediately on click/hover.
 * 
 * Uses a combined endpoint to fetch overview + load data in a single request,
 * then populates individual query caches for component compatibility.
 */
export function usePrefetchCountry() {
  const queryClient = useQueryClient();
  const timePreset = useDashboardStore((s) => s.timePreset);
  const timeRange = useDashboardStore((s) => s.timeRange);
  const timeOffset = useDashboardStore((s) => s.timeOffset);

  const prefetch = useCallback(
    (countryCode: string) => {
      const { start, end } = getDateRangeForPreset(timePreset, timeOffset);
      const granularity = getGranularityForPreset(timePreset);

      // Prefetch countries list (usually cached, but ensure it's ready)
      queryClient.prefetchQuery({
        queryKey: ['countries'],
        queryFn: fetchCountries,
        staleTime: 3600000, // 1 hour
      });

      // Use combined endpoint to fetch overview + load in one request
      // This is faster than two separate requests
      queryClient.prefetchQuery({
        queryKey: ['dashboard', 'initial', countryCode, timeRange, timePreset, timeOffset, granularity],
        queryFn: async () => {
          const result = await fetchInitialCountryData({
            country: countryCode,
            timeRange,
            start: start.toISOString(),
            end: end.toISOString(),
            granularity,
          });
          
          // Populate individual caches so components can use their normal hooks
          queryClient.setQueryData(
            ['dashboard', 'overview', countryCode, timeRange],
            result.overview
          );
          queryClient.setQueryData(
            ['load', countryCode, timePreset, timeOffset, granularity],
            result.loadData
          );
          
          return result;
        },
        staleTime: REFRESH_INTERVALS.dashboard,
      });

      // Also prefetch overview separately as a fallback (in case combined fails)
      queryClient.prefetchQuery({
        queryKey: ['dashboard', 'overview', countryCode, timeRange],
        queryFn: () => fetchDashboardOverview({ country: countryCode, timeRange }),
        staleTime: REFRESH_INTERVALS.dashboard,
      });

      // Prefetch price and renewable data for other tabs (lower priority)
      queryClient.prefetchQuery({
        queryKey: ['prices', countryCode, timePreset, timeOffset, granularity],
        queryFn: () =>
          fetchPriceData({
            country: countryCode,
            start: start.toISOString(),
            end: end.toISOString(),
            granularity,
          }),
        staleTime: REFRESH_INTERVALS.dashboard,
      });

      queryClient.prefetchQuery({
        queryKey: ['renewables', countryCode, timePreset, timeOffset, granularity],
        queryFn: () =>
          fetchRenewableData({
            country: countryCode,
            start: start.toISOString(),
            end: end.toISOString(),
            granularity,
          }),
        staleTime: REFRESH_INTERVALS.dashboard,
      });
    },
    [queryClient, timePreset, timeRange, timeOffset]
  );

  return prefetch;
}
