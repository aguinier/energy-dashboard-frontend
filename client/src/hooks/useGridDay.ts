import { keepPreviousData, useQuery } from '@tanstack/react-query';
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
 *
 * `placeholderData` is what makes the day arrows usable. A changed `date`
 * changes the query key, which without it leaves the query pending — and the
 * view answers pending with a full-screen splash, so every press would blank
 * the whole app and make the map element rebuild its paths from nothing on the
 * way back. Holding the previous day on screen keeps the status `success`;
 * `isPlaceholderData` then marks the beat where the footer's date has moved
 * and the map has not, which the footer dims rather than hides.
 */
export function useGridDay(date?: string) {
  return useQuery<GridDay>({
    queryKey: ['grid-day', date ?? 'today'],
    queryFn: () => fetchGridDay(date),
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
    // Only the rolling "today" query is worth polling. Not because a named day
    // cannot change — a future one gains the day-ahead auction mid-afternoon —
    // but because the poll exists to keep the CLOCK honest: the header, the
    // Live chip, a newly published hour on the day in progress. A pinned day
    // has no clock to keep, `staleTime` already refetches on any revisit, and
    // Live is one press away.
    refetchInterval: date ? false : 5 * 60 * 1000,
    refetchIntervalInBackground: false,
  });
}
