import path from 'node:path';
import { getHealthProvenance, type HealthProvenance } from '../lib/healthProvenance.js';
import { getAllCountries } from './countryService.js';
import { getDataFreshness } from './dataFreshnessService.js';
import { computeFreshnessRollup, type FreshnessRollup } from './freshnessRollup.js';
import { getDiskUsage, getCpuLoad, type DiskUsage, type CpuLoad } from './hostMetrics.js';

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
  };
  process: ProcessMetrics;
  freshness: FreshnessRollup;
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
 * This is the one piece of this endpoint that touches the database, and is
 * therefore the one expected to fail during the twice-daily DB sync's
 * write-lock blackout (WORKFLOWS.md, "Acceptance blackout during Stage 2",
 * ABL-220 — ~07:00 and ~16:30 local, 4-14+ min). A 500 for the whole request
 * in that window is the documented, expected behaviour, not a defect here.
 */
function getFleetFreshness(now: Date) {
  const byCountry: Record<string, ReturnType<typeof getDataFreshness>> = {};
  for (const { country_code } of getAllCountries()) {
    byCountry[country_code] = getDataFreshness(country_code, now);
  }
  return computeFreshnessRollup(byCountry);
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
 * Every field under `host` is best-effort: `disk` and `cpuLoad` are `null`
 * when this process cannot measure them (see `hostMetrics.ts`), never a
 * fabricated number.
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
    },
    process: getProcessMetrics(),
    freshness: getFleetFreshness(now),
  };
}
