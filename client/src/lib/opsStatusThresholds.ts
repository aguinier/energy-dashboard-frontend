import type { DiskUsage, FreshnessStatus, OpsSideStatus } from '@/types';

/**
 * Simple threshold-based visual state for the ABL-238 status page. Kept to
 * the two metrics with a defensible, universal threshold — disk usage ratio
 * and the existing freshness severity ranking (`freshnessRollup.ts`) — rather
 * than inventing a CPU-load or memory threshold with no known capacity to
 * measure against on this host. `ended`/`none` freshness and a missing disk
 * reading are `'unknown'`, not `'ok'`: this codebase's rule is that an
 * unmeasured metric must never render as a clean bill of health.
 */
export type ThresholdState = 'ok' | 'warn' | 'error' | 'unknown';

const DISK_WARN_RATIO = 0.75;
const DISK_ERROR_RATIO = 0.9;

export function deriveDiskState(disk: DiskUsage | null): ThresholdState {
  if (disk === null || disk.totalBytes <= 0) return 'unknown';
  const ratio = disk.usedBytes / disk.totalBytes;
  if (ratio >= DISK_ERROR_RATIO) return 'error';
  if (ratio >= DISK_WARN_RATIO) return 'warn';
  return 'ok';
}

/**
 * `stale` is the only one of the four freshness verdicts that names an
 * actionable problem (see `freshnessRollup.ts`'s `SEVERITY` ranking, which
 * this mirrors) — `ended`/`none` are documented non-alarm verdicts, so they
 * read `'unknown'` here rather than `'ok'` (a country we've never held data
 * for is not evidence the environment is healthy) or `'warn'` (it is not an
 * alarm either).
 */
export function deriveFreshnessState(status: FreshnessStatus): ThresholdState {
  if (status === 'stale') return 'warn';
  if (status === 'live') return 'ok';
  return 'unknown';
}

/** Worst-wins, but "unknown" never outranks a real "ok" — only an all-unknown input reports unknown. */
function worstOf(states: ThresholdState[]): ThresholdState {
  if (states.includes('error')) return 'error';
  if (states.includes('warn')) return 'warn';
  if (states.every((s) => s === 'unknown')) return 'unknown';
  return 'ok';
}

/**
 * One environment's overall badge state. An unreachable side is `'error'` —
 * unless `blackoutActive`, in which case it is downgraded to `'warn'`: the
 * known ABL-220 DB-sync lock window, not a genuine outage (see
 * `syncBlackoutWindow.ts`). A reachable side combines disk usage and the
 * fleet-wide freshness verdict, worst-wins.
 */
export function deriveEnvironmentState(side: OpsSideStatus, blackoutActive: boolean): ThresholdState {
  if (!side.reachable) return blackoutActive ? 'warn' : 'error';
  return worstOf([
    deriveDiskState(side.status.host.disk),
    deriveFreshnessState(side.status.freshness.status),
  ]);
}
