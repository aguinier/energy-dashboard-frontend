import fs from 'node:fs';
import os from 'node:os';

/**
 * Host-level resource metrics for the ops KPI endpoint (ABL-237).
 *
 * Every value here is best-effort: a metric this process cannot measure comes
 * back `null`, never a fabricated number. `os.loadavg()` is the concrete case
 * that forced this shape — it is Linux/macOS-only and silently returns
 * `[0, 0, 0]` on Windows, which would read as "completely idle" rather than
 * "not measured" on the Windows acceptance host.
 */

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

export interface CpuLoad {
  load1: number;
  load5: number;
  load15: number;
}

interface StatfsResult {
  bsize: number;
  blocks: number;
  bfree: number;
}

/**
 * Disk usage for the filesystem holding `targetPath`.
 *
 * `fs.statfsSync` (stable since Node 18.15/19.6) wraps `statvfs` on
 * Linux/macOS and `GetDiskFreeSpaceEx` on Windows, so one code path covers
 * both the prod container and the Windows acceptance host with no platform
 * branch and no third-party dependency.
 *
 * Returns `null` on any failure — path does not exist, permission denied,
 * platform quirk — rather than throwing. This endpoint reports degraded
 * metrics; it does not 500 the whole payload because one of several is
 * unavailable.
 */
export function getDiskUsage(
  targetPath: string,
  statfs: (p: string) => StatfsResult = (p) => fs.statfsSync(p),
): DiskUsage | null {
  try {
    const stats = statfs(targetPath);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bfree * stats.bsize;
    return { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes };
  } catch {
    return null;
  }
}

/**
 * 1/5/15-minute load averages, or `null` where the platform cannot supply
 * them.
 *
 * `os.loadavg()` returns `[0, 0, 0]` on every Windows process, unconditionally
 * — that is "not implemented here", not "load is zero". Reporting that triple
 * as a real reading would be exactly the kind of fabricated number this
 * codebase has repeatedly shipped and had to walk back, so Windows gets
 * `null` instead of an invented equivalent.
 */
export function getCpuLoad(
  platform: NodeJS.Platform = process.platform,
  loadavg: () => number[] = () => os.loadavg(),
): CpuLoad | null {
  if (platform === 'win32') return null;
  const [load1, load5, load15] = loadavg();
  return { load1, load5, load15 };
}
