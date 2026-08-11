import { useQuery } from '@tanstack/react-query';
import { useDashboardStore } from '@/store/dashboardStore';
import { fetchNetPosition } from '@/services/api';
import { REFRESH_INTERVALS } from '@/lib/constants';
import { getDateRangeForPreset } from './useDashboardData';
import { useModelSelection } from './useForecastModels';
import type { NetPositionResponse } from '@/types';

/**
 * Net position for the selected country and time window.
 *
 * The window is extended to now+3d so the D+2 forecast is inside the queried
 * range even on the short presets - otherwise the forecast would be fetched
 * and then fall off the end of the chart.
 */
export function useNetPositionData(): {
  data: NetPositionResponse | undefined;
  isLoading: boolean;
  isError: boolean;
} {
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const timePreset = useDashboardStore((s) => s.timePreset);
  const timeOffset = useDashboardStore((s) => s.timeOffset);

  // The picker is the single source of truth for which model this chart
  // shows (ABL-177) - `requestModelId` is only set once the user actually
  // pinned an entry, so leaving it off here still lets the server's ladder
  // pick a served model, same as every other forecast tab.
  const { requestModelId } = useModelSelection('net_position');

  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);
  const extendedEnd = new Date(
    Math.max(end.getTime(), Date.now() + 3 * 24 * 60 * 60 * 1000),
  );

  const query = useQuery({
    queryKey: ['net-position', selectedCountry, timePreset, timeOffset, requestModelId],
    queryFn: () =>
      fetchNetPosition({
        country: selectedCountry,
        start: start.toISOString(),
        end: extendedEnd.toISOString(),
        model: requestModelId,
      }),
    staleTime: REFRESH_INTERVALS.dashboard,
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
