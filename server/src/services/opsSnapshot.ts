import type { CombinedOpsStatus } from './combinedOpsStatusService.js';
import type { SideStatus } from './peerOpsStatus.js';
import type { FreshnessStatus } from '../types/index.js';

/**
 * The narrow, storable projection of one `/api/ops/status/combined` reading
 * (ABL-288). Snapshots are appended forever-ish, so this deliberately keeps
 * the handful of fields a trend is drawn from and drops the rest — the stale
 * country list, per-stream counts, heap detail — which are useful live and
 * pure weight in a history file.
 *
 * Every field is `| null`, and `null` here means "this reading did not
 * contain it": the side was unreachable, or the host could not measure the
 * metric (`disk` on a path that vanished, `cpuLoad` on Windows). It never
 * means zero. A snapshot of an unreachable side is still stored — a gap in
 * reachability is exactly the thing a history view should show — with its
 * metrics null so nothing downstream can average a down side in as 0.
 */
export interface OpsSideSnapshot {
  reachable: boolean;
  latencyMs: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  rssBytes: number | null;
  uptimeSeconds: number | null;
  freshnessStatus: FreshnessStatus | null;
  staleCountryCount: number | null;
  commit: string | null;
}

export interface OpsSnapshot {
  /** ISO-8601 UTC instant the reading was taken. */
  t: string;
  local: OpsSideSnapshot;
  peer: OpsSideSnapshot;
}

const UNREACHABLE: Omit<OpsSideSnapshot, 'latencyMs'> = {
  reachable: false,
  diskUsedBytes: null,
  diskTotalBytes: null,
  rssBytes: null,
  uptimeSeconds: null,
  freshnessStatus: null,
  staleCountryCount: null,
  commit: null,
};

function toSideSnapshot(side: SideStatus): OpsSideSnapshot {
  if (!side.reachable) return { ...UNREACHABLE, latencyMs: side.latencyMs };

  const { status } = side;
  // ABL-657: a rollup the side could not measure stores as `null`, not as its
  // empty shape. `'none'` with `staleCountryCount: 0` would draw on the trend
  // as a clean fleet at the exact moments the database was unreadable — the
  // "did not contain it, never zero" rule above, applied to the one section
  // that can now come back unmeasured while the side itself answers.
  const measured = status.freshness.unmeasured === undefined;
  return {
    reachable: true,
    latencyMs: side.latencyMs,
    diskUsedBytes: status.host.disk?.usedBytes ?? null,
    diskTotalBytes: status.host.disk?.totalBytes ?? null,
    rssBytes: status.process.memory.rssBytes,
    uptimeSeconds: status.process.uptimeSeconds,
    freshnessStatus: measured ? status.freshness.status : null,
    staleCountryCount: measured ? status.freshness.staleCountries.length : null,
    commit: status.provenance.commit,
  };
}

/** Pure: the storable projection of one combined reading. */
export function toOpsSnapshot(combined: CombinedOpsStatus): OpsSnapshot {
  return {
    t: combined.timestamp,
    local: toSideSnapshot(combined.local),
    peer: toSideSnapshot(combined.peer),
  };
}

/**
 * Disk used-percent for one side of one snapshot, or `null` when that side
 * reported no disk at that moment.
 *
 * `totalBytes <= 0` is `null`, not `0%` — a filesystem that reports zero total
 * bytes was not measured, and a division by it would render an environment as
 * comfortably empty. Same rule as `deriveDiskState`
 * (`server/src/lib/opsStatusThresholds.ts:115`), which reports `'unknown'` for
 * the same input.
 */
export function diskPercent(side: OpsSideSnapshot): number | null {
  if (side.diskUsedBytes === null || side.diskTotalBytes === null) return null;
  if (side.diskTotalBytes <= 0) return null;
  return (side.diskUsedBytes / side.diskTotalBytes) * 100;
}
