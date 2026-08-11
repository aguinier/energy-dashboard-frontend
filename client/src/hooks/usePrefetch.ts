import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import {
  fetchPriceData,
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

      // Use combined endpoint to fetch overview + load in one request.
      // This is faster than two separate requests, and the server always
      // returns both fields together — but only `loadData` still has a
      // client-side reader (useLoadChartData's ['load', …] key) since
      // AbleStatRow, the only consumer of the overview half, was removed
      // (ABL-221). `result.overview` is fetched and discarded rather than
      // seeded into a cache nothing looks up.
      queryClient.prefetchQuery({
        queryKey: ['dashboard', 'initial', countryCode, timePreset, timeOffset, granularity],
        queryFn: async () => {
          const result = await fetchInitialCountryData({
            country: countryCode,
            start: start.toISOString(),
            end: end.toISOString(),
            granularity,
          });

          // Populate the load cache so LoadTab's normal hook
          // (useLoadChartData's ['load', country, timePreset, timeOffset,
          // granularity] key) can use it.
          queryClient.setQueryData(
            ['load', countryCode, timePreset, timeOffset, granularity],
            result.loadData
          );

          return result;
        },
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

      // The Generation tab's own trend (['generation','series',…]) is
      // deliberately NOT prefetched on hover — it is a second full-window
      // query for a tab the user may never open, and the tab has its own
      // loading state. (A ['renewables',…] prefetch used to run here too,
      // warming AbleStatRow's renewable stat; both the query and the
      // component it warmed are gone — ABL-221.)
    },
    [queryClient, timePreset, timeOffset]
  );

  return prefetch;
}
