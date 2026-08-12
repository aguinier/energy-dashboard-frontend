import { describe, it, expect } from 'vitest';
import { deriveDiskState, deriveFreshnessState, deriveEnvironmentState } from './opsStatusThresholds';
import type { OpsSideStatus, OpsStatus } from '@/types';

const disk = (usedBytes: number, totalBytes: number) => ({ totalBytes, freeBytes: totalBytes - usedBytes, usedBytes });

describe('deriveDiskState', () => {
  it('is unknown when disk usage could not be measured', () => {
    expect(deriveDiskState(null)).toBe('unknown');
  });

  it('is ok well under the warn threshold', () => {
    expect(deriveDiskState(disk(50, 100))).toBe('ok');
  });

  it('is warn at exactly the 75% threshold', () => {
    expect(deriveDiskState(disk(75, 100))).toBe('warn');
  });

  it('is error at exactly the 90% threshold', () => {
    expect(deriveDiskState(disk(90, 100))).toBe('error');
  });

  it('is unknown rather than dividing by zero when totalBytes is 0', () => {
    expect(deriveDiskState(disk(0, 0))).toBe('unknown');
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

function reachable(overrides: Partial<OpsStatus> = {}): OpsSideStatus {
  return { reachable: true, latencyMs: 10, status: { ...SAMPLE_STATUS, ...overrides } };
}

describe('deriveEnvironmentState', () => {
  it('is error when unreachable outside the sync blackout window', () => {
    const side: OpsSideStatus = { reachable: false, latencyMs: null, error: 'connection refused' };
    expect(deriveEnvironmentState(side, false)).toBe('error');
  });

  it('is warn, not error, when unreachable during the known sync blackout window', () => {
    const side: OpsSideStatus = { reachable: false, latencyMs: null, error: 'DATABASE_ERROR' };
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
});
