import { useQuery } from '@tanstack/react-query';
import { fetchGridDay } from '@/services/api';
import type { GridDay } from '@/types';

/**
 * The Living Grid's single read.
 *
 * One request covers the whole view: every zone, every stream, every hour of
 * the day. Scrubbing the timeline re-indexes what is already here rather than
 * asking again, so the only refetch is the five-minute poll below catching a
 * newly published hour.
 *
 * That poll has to be explicit. `staleTime` only marks the cache stale, it
 * never goes and asks; the app disables `refetchOnWindowFocus` globally, and
 * this view mounts once and stays mounted. Without an interval a tab left open
 * shows the hour it was opened at for as long as it is open — including the
 * header clock and the "Live" chip, which would both be quietly lying.
 * `refetchIntervalInBackground` stays off so a forgotten tab is not a
 * standing load on a single-threaded API.
 */
export function useGridDay(date?: string) {
  return useQuery<GridDay>({
    queryKey: ['grid-day', date ?? 'today'],
    queryFn: () => fetchGridDay(date),
    staleTime: 5 * 60 * 1000,
    // A named past date is finished and cannot gain an hour, so only the
    // rolling "today" query is worth polling.
    refetchInterval: date ? false : 5 * 60 * 1000,
    refetchIntervalInBackground: false,
  });
}
