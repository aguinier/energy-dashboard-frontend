import { useQuery } from '@tanstack/react-query';
import { fetchGridDay } from '@/services/api';
import type { GridDay } from '@/types';

/**
 * The Living Grid's single read.
 *
 * One request covers the whole view: every zone, every stream, every hour of
 * the day. Scrubbing the timeline re-indexes what is already here rather than
 * asking again, so the only refetch is the five-minute staleness window
 * catching a newly published hour.
 */
export function useGridDay(date?: string) {
  return useQuery<GridDay>({
    queryKey: ['grid-day', date ?? 'today'],
    queryFn: () => fetchGridDay(date),
    staleTime: 5 * 60 * 1000,
  });
}
