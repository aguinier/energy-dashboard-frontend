import { describe, it, expect } from 'vitest';
import { diskPercent, toOpsSnapshot } from './opsSnapshot.js';
import type { CombinedOpsStatus } from './combinedOpsStatusService.js';
import type { OpsStatus } from './opsStatusService.js';

function status(overrides: Partial<OpsStatus> = {}): OpsStatus {
  return {
    timestamp: '2026-08-12T10:00:00.000Z',
    provenance: { commit: 'abc1234def', runtime: 'container', db_path: '/data/energy_dashboard.db' },
    host: {
      platform: 'linux',
      disk: { totalBytes: 1000, freeBytes: 200, usedBytes: 800 },
      cpuLoad: { load1: 0.5, load5: 0.4, load15: 0.3 },
    },
    process: {
      uptimeSeconds: 3600,
      memory: { rssBytes: 150, heapUsedBytes: 90, heapTotalBytes: 120, externalBytes: 10 },
    },
    freshness: {
      status: 'stale',
      countriesChecked: 7,
      streamsChecked: 35,
      counts: { live: 30, stale: 5, ended: 0, none: 0 },
      staleCountries: ['BE', 'DE'],
    },
    visitors: { countingSince: '2026-08-12T00:00:00.000Z', day: '2026-08-12', today: { page: 0, api: 0, asset: 0, automated: 0 }, window: { page: 0, api: 0, asset: 0, automated: 0 }, windowDaysCovered: 1, windowComplete: false, distinctClientsToday: 0 },
    ...overrides,
  };
}

function combined(overrides: Partial<CombinedOpsStatus> = {}): CombinedOpsStatus {
  return {
    timestamp: '2026-08-12T10:00:00.000Z',
    local: { reachable: true, latencyMs: 12, status: status() },
    peer: { reachable: true, latencyMs: 40, status: status() },
    peerConfigured: true,
    syncBlackout: { active: false, label: null },
    derived: {
      local: { environment: 'ok', disk: 'warn', freshness: 'warn' },
      peer: { environment: 'ok', disk: 'warn', freshness: 'warn' },
      commitDrift: 'ok',
    },
    ...overrides,
  };
}

describe('toOpsSnapshot', () => {
  it('keeps only the fields a trend is drawn from', () => {
    const snapshot = toOpsSnapshot(combined());

    expect(snapshot.t).toBe('2026-08-12T10:00:00.000Z');
    expect(snapshot.local).toEqual({
      reachable: true,
      latencyMs: 12,
      diskUsedBytes: 800,
      diskTotalBytes: 1000,
      rssBytes: 150,
      uptimeSeconds: 3600,
      freshnessStatus: 'stale',
      staleCountryCount: 2,
      commit: 'abc1234def',
    });
  });

  it('stores an unreachable side as a reachability gap with null metrics, never zeros', () => {
    const snapshot = toOpsSnapshot(
      combined({ peer: { reachable: false, latencyMs: 5000, error: 'timed out after 5000ms' } }),
    );

    expect(snapshot.peer).toEqual({
      reachable: false,
      latencyMs: 5000,
      diskUsedBytes: null,
      diskTotalBytes: null,
      rssBytes: null,
      uptimeSeconds: null,
      freshnessStatus: null,
      staleCountryCount: null,
      commit: null,
    });
  });

  it('records a host that could not measure its disk as null, not as an empty disk', () => {
    const noDisk = status({ host: { platform: 'win32', disk: null, cpuLoad: null } });
    const snapshot = toOpsSnapshot(combined({ local: { reachable: true, latencyMs: 3, status: noDisk } }));

    expect(snapshot.local.diskUsedBytes).toBeNull();
    expect(snapshot.local.diskTotalBytes).toBeNull();
    // Everything the host COULD measure is still recorded.
    expect(snapshot.local.rssBytes).toBe(150);
  });

  it('records a measured zero as zero — staleCountryCount 0 is a reading, not a gap', () => {
    const clean = status({
      freshness: {
        status: 'live',
        countriesChecked: 7,
        streamsChecked: 35,
        counts: { live: 35, stale: 0, ended: 0, none: 0 },
        staleCountries: [],
      },
    });
    const snapshot = toOpsSnapshot(combined({ local: { reachable: true, latencyMs: 3, status: clean } }));

    expect(snapshot.local.staleCountryCount).toBe(0);
    expect(snapshot.local.freshnessStatus).toBe('live');
  });
});

describe('diskPercent', () => {
  const side = { ...toOpsSnapshot(combined()).local };

  it('computes used percent from a real reading', () => {
    expect(diskPercent(side)).toBe(80);
  });

  it('is null when the side reported no disk', () => {
    expect(diskPercent({ ...side, diskUsedBytes: null, diskTotalBytes: null })).toBeNull();
  });

  it('is null — not 0% — when total bytes is zero, which is an unmeasured filesystem', () => {
    expect(diskPercent({ ...side, diskUsedBytes: 0, diskTotalBytes: 0 })).toBeNull();
  });
});
