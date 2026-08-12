import { describe, it, expect } from 'vitest';
import {
  deriveDiskState,
  deriveFreshnessState,
  deriveEnvironmentState,
  deriveSideState,
  DISK_WARN_RATIO,
  DISK_ERROR_RATIO,
} from './opsStatusThresholds.js';
import type { OpsStatus } from '../services/opsStatusService.js';
import type { SideStatus } from '../services/peerOpsStatus.js';

/**
 * Pure — `opsStatusThresholds.ts` imports only *types* from
 * `opsStatusService.js`/`peerOpsStatus.js`, which erase at compile time, so
 * nothing here pulls in `config/database.js` and this suite runs regardless of
 * whether `better-sqlite3` is ABI-compatible with the running Node (CLAUDE.md,
 * "NODE_MODULE_VERSION mismatch"). Ported from the client's
 * `lib/opsStatusThresholds.test.ts`, which ABL-292 deleted along with the
 * client copy of the derivation.
 */

const disk = (usedBytes: number, totalBytes: number) => ({ totalBytes, freeBytes: totalBytes - usedBytes, usedBytes });

describe('deriveDiskState', () => {
  it('is unknown when disk usage could not be measured', () => {
    expect(deriveDiskState(null)).toBe('unknown');
  });

  it('is ok well under the warn threshold', () => {
    expect(deriveDiskState(disk(50, 100))).toBe('ok');
  });

  it('is ok just below the warn threshold', () => {
    expect(deriveDiskState(disk(74_999, 100_000))).toBe('ok');
  });

  it('is warn at exactly the 75% threshold', () => {
    expect(deriveDiskState(disk(75, 100))).toBe('warn');
  });

  it('is warn just below the error threshold', () => {
    expect(deriveDiskState(disk(89_999, 100_000))).toBe('warn');
  });

  it('is error at exactly the 90% threshold', () => {
    expect(deriveDiskState(disk(90, 100))).toBe('error');
  });

  it('is error above the error threshold', () => {
    expect(deriveDiskState(disk(99, 100))).toBe('error');
  });

  it('is unknown rather than dividing by zero when totalBytes is 0', () => {
    expect(deriveDiskState(disk(0, 0))).toBe('unknown');
  });

  /**
   * The live acceptance reading that made ABL-292 high priority: 85.11% is
   * genuinely warn, not error, and this asserts the relocation did not quietly
   * change which side of the line it falls on. Under 5 points of headroom
   * against a DB growing ~3 GB/day (ABL-163), so if a future re-tuning moves
   * `DISK_ERROR_RATIO` below 0.8511 this test is the one that should object.
   */
  it('reads the live acceptance disk figure (85.11%) as warn, not error', () => {
    expect(deriveDiskState(disk(8511, 10_000))).toBe('warn');
  });

  it('holds the relocated threshold values — ABL-292 moved them, it did not re-tune them', () => {
    expect(DISK_WARN_RATIO).toBe(0.75);
    expect(DISK_ERROR_RATIO).toBe(0.9);
  });
});

describe('deriveFreshnessState', () => {
  it('maps stale to warn — the one actionable verdict', () => {
    expect(deriveFreshnessState('stale')).toBe('warn');
  });

  it('maps live to ok', () => {
    expect(deriveFreshnessState('live')).toBe('ok');
  });

  it('maps ended to unknown, not ok — a terminal non-alarm is not evidence of health', () => {
    expect(deriveFreshnessState('ended')).toBe('unknown');
  });

  it('maps none to unknown', () => {
    expect(deriveFreshnessState('none')).toBe('unknown');
  });
});

const SAMPLE_STATUS: OpsStatus = {
  timestamp: '2026-08-11T20:00:00.000Z',
  provenance: { commit: 'abc123', runtime: 'container', db_path: '/data/energy_dashboard.db' },
  host: { platform: 'linux', disk: disk(50, 100), cpuLoad: { load1: 0.1, load5: 0.2, load15: 0.3 } },
  process: { uptimeSeconds: 100, memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 1 } },
  freshness: { status: 'live', countriesChecked: 7, streamsChecked: 35, counts: { live: 35, stale: 0, ended: 0, none: 0 }, staleCountries: [] },
};

function reachable(overrides: Partial<OpsStatus> = {}): SideStatus {
  return { reachable: true, latencyMs: 10, status: { ...SAMPLE_STATUS, ...overrides } };
}

describe('deriveEnvironmentState', () => {
  it('is error when unreachable outside the sync blackout window', () => {
    const side: SideStatus = { reachable: false, latencyMs: null, error: 'connection refused' };
    expect(deriveEnvironmentState(side, false)).toBe('error');
  });

  it('is warn, not error, when unreachable during the known sync blackout window', () => {
    const side: SideStatus = { reachable: false, latencyMs: null, error: 'DATABASE_ERROR' };
    expect(deriveEnvironmentState(side, true)).toBe('warn');
  });

  it('is ok when reachable with healthy disk and live freshness', () => {
    expect(deriveEnvironmentState(reachable(), false)).toBe('ok');
  });

  it('is warn when reachable but disk usage crosses the warn threshold', () => {
    const side = reachable({ host: { platform: 'linux', disk: disk(80, 100), cpuLoad: null } });
    expect(deriveEnvironmentState(side, false)).toBe('warn');
  });

  it('worst-wins: an error disk state outranks a warn freshness state', () => {
    const side = reachable({
      host: { platform: 'linux', disk: disk(95, 100), cpuLoad: null },
      freshness: { status: 'stale', countriesChecked: 7, streamsChecked: 35, counts: { live: 30, stale: 5, ended: 0, none: 0 }, staleCountries: ['GB'] },
    });
    expect(deriveEnvironmentState(side, false)).toBe('error');
  });

  it('is unknown, not ok, when reachable but every metric is unmeasured', () => {
    const side = reachable({
      host: { platform: 'win32', disk: null, cpuLoad: null },
      freshness: { status: 'none', countriesChecked: 0, streamsChecked: 0, counts: { live: 0, stale: 0, ended: 0, none: 0 }, staleCountries: [] },
    });
    expect(deriveEnvironmentState(side, false)).toBe('unknown');
  });

  it('a blackout never softens a *reachable* side — the downgrade only covers unreachability', () => {
    const side = reachable({ host: { platform: 'linux', disk: disk(95, 100), cpuLoad: null } });
    expect(deriveEnvironmentState(side, true)).toBe('error');
  });
});

describe('deriveSideState', () => {
  it('reports each KPI alongside the worst-wins environment verdict', () => {
    const side = reachable({
      host: { platform: 'linux', disk: disk(76, 100), cpuLoad: null },
      freshness: { status: 'live', countriesChecked: 7, streamsChecked: 35, counts: { live: 35, stale: 0, ended: 0, none: 0 }, staleCountries: [] },
    });

    expect(deriveSideState(side, false)).toEqual({ environment: 'warn', disk: 'warn', freshness: 'ok' });
  });

  it('reports unknown per KPI for an unreachable side — a peer that timed out has no measured disk', () => {
    const side: SideStatus = { reachable: false, latencyMs: 5001, error: 'timed out after 5000ms' };

    expect(deriveSideState(side, false)).toEqual({ environment: 'error', disk: 'unknown', freshness: 'unknown' });
  });

  it('keeps the per-KPI unknowns while the environment softens to warn inside the blackout window', () => {
    const side: SideStatus = { reachable: false, latencyMs: null, error: 'SQLITE_BUSY: database is locked' };

    expect(deriveSideState(side, true)).toEqual({ environment: 'warn', disk: 'unknown', freshness: 'unknown' });
  });

  it('does not let a stale-freshness warn leak into the disk verdict, or vice versa', () => {
    const side = reachable({
      host: { platform: 'linux', disk: disk(10, 100), cpuLoad: null },
      freshness: { status: 'stale', countriesChecked: 7, streamsChecked: 35, counts: { live: 30, stale: 5, ended: 0, none: 0 }, staleCountries: ['GB'] },
    });

    expect(deriveSideState(side, false)).toEqual({ environment: 'warn', disk: 'ok', freshness: 'warn' });
  });
});
