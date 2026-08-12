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

/** Cumulative byte counters for one interface, as read from `/proc/net/dev`. */
export interface NetworkCounters {
  name: string;
  rxBytes: number;
  txBytes: number;
}

/** One read of every interface's counters, stamped with a monotonic clock. */
export interface NetworkSample {
  /** Monotonic milliseconds (`performance.now()`), NOT wall clock — see `getNetworkThroughput`. */
  atMs: number;
  counters: NetworkCounters[];
}

export interface NetworkInterfaceThroughput {
  name: string;
  /** Always a real reading: bytes since the interface came up. */
  rxBytes: number;
  txBytes: number;
  /** `null` until a second sample exists to difference against, or if the counter reset. */
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
  /** The window the rates are averaged over. `null` exactly when both rates are unavailable for lack of a window. */
  sampleWindowMs: number | null;
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

const PROC_NET_DEV = '/proc/net/dev';

/**
 * Parses `/proc/net/dev` into per-interface cumulative byte counters.
 *
 * Two traps this handles, both of which would otherwise produce a plausible
 * wrong number rather than an obvious failure:
 *
 * - **The colon can abut its value.** The kernel formats the name in a fixed
 *   16-char field, so a wide counter runs straight into the colon
 *   (`eth0:123456789012`). Splitting the line on whitespace therefore loses the
 *   first field on exactly the busiest interfaces. Split on the first `:`.
 * - **Field 9, not field 2, is transmit.** Receive occupies 8 columns
 *   (bytes/packets/errs/drop/fifo/frame/compressed/multicast) before transmit
 *   bytes begins.
 *
 * Loopback is dropped: `lo` counts this process talking to itself, which is
 * not the network load anyone means. No link-state filter is applied — this
 * file has no up/down field, and inferring "down" from zero counters would
 * silently drop a real interface that is merely idle.
 */
export function parseProcNetDev(contents: string): NetworkCounters[] {
  const counters: NetworkCounters[] = [];

  for (const line of contents.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue; // the two header lines carry no colon

    const name = line.slice(0, colon).trim();
    if (!name || name === 'lo') continue;

    const fields = line.slice(colon + 1).trim().split(/\s+/);
    if (fields.length < 9) continue;

    const rxBytes = Number(fields[0]);
    const txBytes = Number(fields[8]);
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue;
    if (rxBytes < 0 || txBytes < 0) continue;

    counters.push({ name, rxBytes, txBytes });
  }

  return counters;
}

/**
 * Differences two samples into per-interface rates.
 *
 * Cumulative counters pass through untouched — they are a real reading on the
 * first call and every call after. The *rates* are the derived part, and they
 * come back `null` rather than guessed in the three cases where the delta does
 * not mean what it appears to:
 *
 * - **No previous sample** (first call after boot), or an interface that only
 *   appeared in this sample — nothing to difference against.
 * - **A non-positive window.** Two reads inside the same millisecond would
 *   divide by zero and report `Infinity` bytes/sec.
 * - **A counter that went backwards.** An interface bounce, a container
 *   restart or a 32-bit counter wrap resets it to near zero; the bytes actually
 *   moved in the window are then unknowable, and a negative rate — or the
 *   enormous positive one a wrap-correction would invent — is worse than
 *   admitting that.
 *
 * `sampleWindowMs` is the exact divisor used, not an approximation of it, so a
 * consumer can always see what window a rate is averaged over.
 */
export function computeNetworkThroughput(
  current: NetworkSample,
  previous: NetworkSample | null,
): NetworkInterfaceThroughput[] {
  const priorByName = new Map((previous?.counters ?? []).map((c) => [c.name, c]));
  const elapsedMs = previous ? Math.round(current.atMs - previous.atMs) : 0;
  const haveWindow = previous !== null && elapsedMs > 0;

  return current.counters.map(({ name, rxBytes, txBytes }) => {
    const prior = priorByName.get(name);
    if (!haveWindow || !prior) {
      return { name, rxBytes, txBytes, rxBytesPerSec: null, txBytesPerSec: null, sampleWindowMs: null };
    }

    const seconds = elapsedMs / 1000;
    return {
      name,
      rxBytes,
      txBytes,
      rxBytesPerSec: perSecond(rxBytes - prior.rxBytes, seconds),
      txBytesPerSec: perSecond(txBytes - prior.txBytes, seconds),
      sampleWindowMs: elapsedMs,
    };
  });
}

/** A zero delta is a measured zero — a genuinely idle interface — and stays `0`, not `null`. */
function perSecond(deltaBytes: number, seconds: number): number | null {
  if (deltaBytes < 0) return null;
  return deltaBytes / seconds;
}

export interface NetworkSamplerState {
  previous: NetworkSample | null;
}

/**
 * Process-lifetime sample state. Held here rather than passed in so successive
 * `/api/ops/status` requests difference against each other; the ~30s poll of
 * the ops page is what supplies the second sample.
 */
const defaultSamplerState: NetworkSamplerState = { previous: null };

/**
 * Per-interface throughput, or `null` where the platform cannot supply it.
 *
 * Linux-only by construction: `/proc/net/dev` is the only counter source, and
 * `os.networkInterfaces()` is no substitute — it reports addresses, never
 * bytes. The Windows acceptance host therefore gets `null`, the same honest
 * gap `getCpuLoad()` reports for `os.loadavg()`, rather than a zeroed shape
 * that would render as a quiet network.
 *
 * The clock is `performance.now()`, deliberately not `Date.now()`: this
 * divides a byte delta by an elapsed time, and an NTP step or a DST-adjacent
 * wall-clock correction between two samples would otherwise scale every rate
 * on the page by an arbitrary factor, or make the window negative.
 */
export function getNetworkThroughput(
  platform: NodeJS.Platform = process.platform,
  readProcNetDev: () => string = () => fs.readFileSync(PROC_NET_DEV, 'utf8'),
  nowMs: () => number = () => performance.now(),
  state: NetworkSamplerState = defaultSamplerState,
): NetworkInterfaceThroughput[] | null {
  if (platform !== 'linux') return null;

  let contents: string;
  try {
    contents = readProcNetDev();
  } catch {
    return null;
  }

  const current: NetworkSample = { atMs: nowMs(), counters: parseProcNetDev(contents) };
  const previous = state.previous;
  state.previous = current;

  return computeNetworkThroughput(current, previous);
}
