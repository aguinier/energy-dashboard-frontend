import { useQuery } from '@tanstack/react-query';
import { fetchOpsStatusHistory } from '@/services/api';

/** A week of history is what the page charts by default; the server clamps it to retention. */
export const OPS_HISTORY_WINDOW_HOURS = 7 * 24;

/**
 * Stored ops snapshots for the `/ops-status` history section (ABL-288).
 *
 * Polled far less often than `useOpsStatus`: snapshots are captured every
 * ~15 minutes server-side, so a 30-second poll would re-fetch the same file
 * sixty times per new point. Five minutes keeps the section current within a
 * capture interval without that.
 */
export function useOpsStatusHistory(hours: number = OPS_HISTORY_WINDOW_HOURS) {
  return useQuery({
    queryKey: ['ops-status', 'history', hours],
    queryFn: () => fetchOpsStatusHistory(hours),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    // An empty history and an unwritable store are normal response shapes
    // here, reported inside `storage` — retry only covers a real failure of
    // this request.
    retry: 1,
  });
}
