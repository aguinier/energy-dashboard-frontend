import { useQuery } from '@tanstack/react-query';
import { fetchOpsStatus } from '@/services/api';

/**
 * Data source for the internal `/ops-status` page (ABL-238). Polls rather
 * than fetching once — this is a live "is it up right now" view, not a chart
 * a trader reads a static window of.
 */
export function useOpsStatus() {
  return useQuery({
    queryKey: ['ops-status', 'combined'],
    queryFn: fetchOpsStatus,
    staleTime: 15000,
    refetchInterval: 30000,
    // A degraded peer/local side is a normal, expected response shape here
    // (`reachable: false`), not a thrown error — retry only covers an actual
    // network/5xx failure of this page's own request.
    retry: 1,
  });
}
