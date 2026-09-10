import path from 'node:path';
import { getHealthProvenance, type HealthProvenance } from '../lib/healthProvenance.js';
import { getAllCountries } from './countryService.js';
import { getDataFreshness } from './dataFreshnessService.js';
import {
  computeFreshnessRollup,
  unmeasuredFreshnessRollup,
  type FreshnessRollup,
} from './freshnessRollup.js';
import {
  getDiskUsage,
  getCpuLoad,
  getNetworkThroughput,
  type DiskUsage,
  type CpuLoad,
  type NetworkInterfaceThroughput,
} from './hostMetrics.js';
import { visitorCounters, type VisitorCounters } from './visitorCounters.js';

export interface ProcessMetrics {
  uptimeSeconds: number;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
  };
}

export interface OpsStatus {
  timestamp: string;
  provenance: HealthProvenance;
  host: {
    platform: NodeJS.Platform;
    disk: DiskUsage | null;
    cpuLoad: CpuLoad | null;
    /**
     * Per-interface throughput (ABL-290). `null` where the platform has no
     * counters to read (anything but Linux — see `hostMetrics.ts`).
     *
     * Optional, not just nullable: a peer environment on a build that predates
     * this field sends a `host` object without the key at all, and the combined
     * view must render that as "not reported", never as zero traffic.
     */
    network?: NetworkInterfaceThroughput[] | null;
  };
  process: ProcessMetrics;
  freshness: FreshnessRollup;
  /**
   * Per-lane request counts for this process (ABL-289). In-memory and reset by
   * a restart — `countingSince` is part of the payload precisely so no reader
   * can mistake it for an all-time total. Older peer builds predate this field,
   * so the client types it optional.
   */
  visitors: VisitorCounters;
}

function getProcessMetrics(): ProcessMetrics {
  const mem = process.memoryUsage();
  return {
    uptimeSeconds: process.uptime(),
    memory: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
    },
  };
}

/**
 * Fleet-wide freshness, reusing the exact per-country classification
 * `GET /api/data-freshness/:cc` already serves (`dataFreshnessService.ts`)
 * rather than re-implementing the staleness rules.
 *
 * This is the one piece of this endpoint that touches the database — and it no
 * longer takes the whole endpoint down with it (ABL-657). A failed read comes
 * back as `unmeasuredFreshnessRollup(reason)`: one section that says why it is
 * blank, in an endpoint where `disk`, `cpuLoad` and `network` already answer an
 * honest `null` when this host cannot measure them.
 *
 * WHY THIS USED TO THROW, AND WHY THAT WAS THE BUG
 *
 * `/api/ops/status` is what the peer poll (`peerOpsStatus.ts`) and the alert
 * engine's local read both call, and `reachable` is decided by whether that
 * call answers. So while the twice-daily replica sync held its write lock, one
 * unreadable KPI made a *live, answering* process report as an unreachable
 * environment, and the reachability alert flapped `ok -> error -> ok` twice a
 * day (ABL-634: 172 errors in six days). Reachability now measures
 * reachability; a database it cannot read is reported as the freshness verdict
 * it actually is (`lib/opsStatusThresholds.ts` — `error`, softened to `warn`
 * inside the known sync window, never `ok`).
 *
 * Deliberately catches everything, not a matched SQLite code. Under an
 * exclusive host-side writer the container's readonly handle raises
 * `SQLITE_READONLY_ROLLBACK` ("attempt to write a readonly database" — the
 * bind mount hides the writer's lock, so SQLite reads the journal as hot and
 * tries to roll it back), a workstation raises `SQLITE_BUSY`, and neither is a
 * list worth keeping current: the honest answer for any failure here is the
 * same, and the message is carried through verbatim.
 */
function getFleetFreshness(now: Date): FreshnessRollup {
  try {
    const byCountry: Record<string, ReturnType<typeof getDataFreshness>> = {};
    for (const { country_code } of getAllCountries()) {
      byCountry[country_code] = getDataFreshness(country_code, now);
    }
    return computeFreshnessRollup(byCountry);
  } catch (err) {
    return unmeasuredFreshnessRollup(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Host + process KPIs for the acceptance/prod status dashboard (ABL-236),
 * built for ABL-237.
 *
 * `provenance` reuses `getHealthProvenance()` — the same commit/runtime/db_path
 * `/api/health` reports — rather than duplicating that logic, and its
 * `db_path` also doubles as the directory `disk` reports usage for: on prod
 * that is `/data`, the mounted DB volume; on a dev checkout, wherever the
 * local replica lives.
 *
 * Every field under `host` is best-effort: `disk`, `cpuLoad` and `network` are
 * `null` when this process cannot measure them (see `hostMetrics.ts`), never a
 * fabricated number.
 *
 * `network` is additionally the one field whose *rates* need two readings —
 * the ops page's ~30s poll supplies the second — so its `bytesPerSec` fields
 * are `null` on the first request after a restart while the cumulative counters
 * beside them are real from the first call.
 *
 * `visitors` (ABL-289) is the one section that is not a reading of the host: it
 * is what `middleware/requestCounter.ts` has tallied since this process
 * started, split so the constant health/peer polling does not read as visits.
 * It carries its own `countingSince` — a restart zeroes it, and the payload
 * has to say so rather than let a reader assume an all-time count.
 *
 * **Does not throw** (ABL-657). Every section is a best-effort reading or an
 * explicit "not measured", including `freshness` — see `getFleetFreshness`.
 * `combinedOpsStatusService.ts` still wraps the call, because a `catch` that
 * exists to make a promise about the future is not a promise this function can
 * make alone.
 */
export function getOpsStatus(now: Date = new Date()): OpsStatus {
  const provenance = getHealthProvenance();

  return {
    timestamp: now.toISOString(),
    provenance,
    host: {
      platform: process.platform,
      disk: getDiskUsage(path.dirname(provenance.db_path)),
      cpuLoad: getCpuLoad(),
      network: getNetworkThroughput(),
    },
    process: getProcessMetrics(),
    freshness: getFleetFreshness(now),
    visitors: visitorCounters.snapshot(now),
  };
}
