import { useQueries } from '@tanstack/react-query';
import { useDashboardStore } from '@/store/dashboardStore';
import { fetchRenewableData } from '@/services/api';
import { REFRESH_INTERVALS } from '@/lib/constants';
import { getDateRangeForPreset, getGranularityForPreset } from './useDashboardData';
import type { RenewableDataPoint } from '@/types';

export interface RenewableChartData {
  // Actual renewable data
  renewableData: RenewableDataPoint[] | undefined;
  isLoadingRenewable: boolean;

  // Aggregate loading state
  isLoading: boolean;
  isError: boolean;
}

/**
 * Batched hook for GenerationTab that fetches the actuals series.
 *
 * Used to also fire five ML forecast queries (solar, wind_onshore,
 * wind_offshore, hydro_total, biomass) plus a TSO generation-forecast query,
 * but GenerationTab renders `adaptRenewableMixSeries(renewableData)`, which
 * takes actuals only — nothing ever consumed the forecast results. Removed in
 * Task 24; see that task's brief for the grep that confirmed it. Overlaying a
 * forecast on the stacked mix chart remains unbuilt — that's a feature, not a
 * remediation.
 */
export function useRenewableChartData(): RenewableChartData {
  // Use selective store subscriptions to minimize re-renders
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const timePreset = useDashboardStore((s) => s.timePreset);
  const timeOffset = useDashboardStore((s) => s.timeOffset);

  // Calculate date ranges
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);
  const granularity = getGranularityForPreset(timePreset);

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
    ],
  });

  const [renewableQuery] = queries;

  return {
    // Actual renewable data
    renewableData: renewableQuery.data,
    isLoadingRenewable: renewableQuery.isLoading,

    // Aggregate states
    isLoading: renewableQuery.isLoading, // Only consider primary data loading
    isError: queries.some((q) => q.isError),
  };
}
