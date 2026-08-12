import { useQuery } from '@tanstack/react-query';
import { useDashboardStore } from '@/store/dashboardStore';
import { fetchCoreNetPosition, fetchCoreNetPositionMap } from '@/services/api';
import { REFRESH_INTERVALS } from '@/lib/constants';
import { getDateRangeForPreset, MAP_WINDOW_PRESET } from './useDashboardData';

/**
 * Core CCR net position for the selected country and window (ABL-234).
 *
 * Deliberately NOT folded into `useNetPositionData`. That hook fans out one
 * query per checked forecast model; this one has no forecast half at all —
 * nothing in this dashboard forecasts the Core figure — so a shared hook would
 * have to carry a permanently-empty model dimension and the tab would have to
 * remember which of its two shapes it was holding. Two hooks, one per
 * quantity, keeps the "which number is this" question answerable by reading
 * the call site.
 *
 * The window is NOT extended past `end` the way `useNetPositionData` extends
 * it to now+3d: that extension exists solely so a D+2 forecast lands inside
 * the queried range, and there is no Core forecast to make room for. Asking
 * for three days past the end of a published-actuals series would just return
 * nothing and imply the series had stopped.
 */
export function useCoreNetPositionData() {
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const timePreset = useDashboardStore((s) => s.timePreset);
  const timeOffset = useDashboardStore((s) => s.timeOffset);
  const scope = useDashboardStore((s) => s.netPositionScope);

  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);

  return useQuery({
    queryKey: ['core-net-position', selectedCountry, timePreset, timeOffset],
    queryFn: () =>
      fetchCoreNetPosition({
        country: selectedCountry,
        start: start.toISOString(),
        end: end.toISOString(),
      }),
    // Only fetched while the Core view is actually selected. The all-coupled
    // view is the default and must issue exactly the requests it did before
    // this feature existed.
    enabled: scope === 'core',
    staleTime: REFRESH_INTERVALS.dashboard,
  });
}

/**
 * Window-average Core net position for the choropleth.
 *
 * Uses `MAP_WINDOW_PRESET` — the map's own fixed 7-day window, not the country
 * page's live selection — so the two scopes are averaged over the same span
 * and the toggle changes one thing rather than two.
 */
export function useCoreNetPositionMap(enabled: boolean) {
  const { start, end } = getDateRangeForPreset(MAP_WINDOW_PRESET, 0);

  return useQuery({
    queryKey: ['core-net-position', 'map'],
    queryFn: () =>
      fetchCoreNetPositionMap({ start: start.toISOString(), end: end.toISOString() }),
    enabled,
    staleTime: REFRESH_INTERVALS.map,
    refetchOnWindowFocus: false,
  });
}
