import { useQueries } from '@tanstack/react-query';
import { useDashboardStore } from '@/store/dashboardStore';
import { fetchNetPosition } from '@/services/api';
import { REFRESH_INTERVALS } from '@/lib/constants';
import { getDateRangeForPreset } from './useDashboardData';
import { useMultiModelSelection } from './useForecastModels';
import { netPositionModelColor } from '@/components/dashboard/netPositionModelColors';
import type { NetPositionResponse } from '@/types';

export interface NetPositionModelQuery {
  id: string;
  label: string;
  color: string;
  data: NetPositionResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Two shapes, matching the picker's two states (ABL-203):
 *
 * - `default`: nothing pinned (or the overlay is switched off). One unpinned
 *   query, same as every forecast tab without a multi-select picker — the
 *   server's candidate ladder picks whichever registered model has data for
 *   this country, and `data.meta.model_name` names it after the fact.
 * - `selection`: one or more models explicitly checked. One query per model,
 *   each pinned, so a model with no coverage for this country comes back
 *   empty rather than silently substituting another model's rows.
 */
export type NetPositionQueryResult =
  | { mode: 'default'; data: NetPositionResponse | undefined; isLoading: boolean; isError: boolean }
  | { mode: 'selection'; entries: NetPositionModelQuery[]; isLoading: boolean; isError: boolean };

/**
 * Net position for the selected country and time window, fanned out one
 * query per model the picker has checked.
 *
 * The window is extended to now+3d so the D+2 forecast is inside the queried
 * range even on the short presets - otherwise the forecast would be fetched
 * and then fall off the end of the chart.
 */
export function useNetPositionData(): NetPositionQueryResult {
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const timePreset = useDashboardStore((s) => s.timePreset);
  const timeOffset = useDashboardStore((s) => s.timeOffset);

  // `selectedIds` is empty both for "Default" and for the overlay switched
  // off (`resolveMultiSelection` collapses hidden to no selection) - either
  // way that's the single unpinned query below.
  const { models, selectedIds } = useMultiModelSelection('net_position');

  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);
  const extendedEnd = new Date(Math.max(end.getTime(), Date.now() + 3 * 24 * 60 * 60 * 1000));
  const startIso = start.toISOString();
  const endIso = extendedEnd.toISOString();

  // One query per checked model; `undefined` (Default) fans out to exactly
  // one unpinned query. A single `useQueries` call for both states, so the
  // number of queries can change across renders as the user checks/unchecks
  // boxes without disturbing hook order — `useQueries` is built for exactly
  // this, unlike calling `useQuery` a variable number of times.
  const queryIds: Array<string | undefined> = selectedIds.length > 0 ? selectedIds : [undefined];

  const queries = useQueries({
    queries: queryIds.map((id) => ({
      queryKey: ['net-position', selectedCountry, timePreset, timeOffset, id],
      queryFn: () =>
        fetchNetPosition({
          country: selectedCountry,
          start: startIso,
          end: endIso,
          model: id,
        }),
      staleTime: REFRESH_INTERVALS.dashboard,
    })),
  });

  if (selectedIds.length === 0) {
    const q = queries[0];
    return { mode: 'default', data: q.data, isLoading: q.isLoading, isError: q.isError };
  }

  const entries: NetPositionModelQuery[] = selectedIds.map((id, i) => ({
    id,
    label: models.find((m) => m.id === id)?.label ?? id,
    color: netPositionModelColor(id),
    data: queries[i].data,
    isLoading: queries[i].isLoading,
    isError: queries[i].isError,
  }));

  return {
    mode: 'selection',
    entries,
    isLoading: entries.some((e) => e.isLoading),
    isError: entries.some((e) => e.isError),
  };
}
