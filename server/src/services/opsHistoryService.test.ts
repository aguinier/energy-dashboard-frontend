import { describe, it, expect } from 'vitest';
import { getOpsStatusHistory, resolveWindowHours, toDiskPoints } from './opsHistoryService.js';
import type { OpsSnapshot, OpsSideSnapshot } from './opsSnapshot.js';
import type { OpsSnapshotConfig } from './opsSnapshotStore.js';

const CONFIG: OpsSnapshotConfig = {
  path: '/data/ops-status-snapshots.jsonl',
  enabled: true,
  retentionDays: 14,
  intervalMinutes: 15,
};

const NOW = new Date('2026-08-15T00:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function side(overrides: Partial<OpsSideSnapshot> = {}): OpsSideSnapshot {
  return {
    reachable: true,
    latencyMs: 5,
    diskUsedBytes: 800,
    diskTotalBytes: 1000,
    rssBytes: 100,
    uptimeSeconds: 60,
    freshnessStatus: 'live',
    staleCountryCount: 0,
    commit: 'abc1234',
    ...overrides,
  };
}

/** `count` snapshots ending at NOW, `everyHours` apart, local disk rising `perDay` points/day. */
function rampingHistory(count: number, everyHours: number, perDay: number, startPercent = 80): OpsSnapshot[] {
  return Array.from({ length: count }, (_, i) => {
    const hoursBack = (count - 1 - i) * everyHours;
    const percent = startPercent + (perDay * i * everyHours) / 24;
    return {
      t: new Date(NOW.getTime() - hoursBack * HOUR_MS).toISOString(),
      local: side({ diskUsedBytes: Math.round(percent * 10), diskTotalBytes: 1000 }),
      peer: side({ diskUsedBytes: 500, diskTotalBytes: 1000 }),
    };
  });
}

function readStub(snapshots: OpsSnapshot[], error: string | null = null, skippedLines = 0) {
  return () => ({ snapshots, skippedLines, error });
}

describe('resolveWindowHours', () => {
  it('defaults to 7 days', () => {
    expect(resolveWindowHours(undefined, 14)).toBe(168);
  });

  it('clamps the request to what is actually retained, and the echoed label with it', () => {
    expect(resolveWindowHours(90 * 24, 14)).toBe(336);
  });

  it('clamps the default too, when retention is shorter than a week', () => {
    expect(resolveWindowHours(undefined, 2)).toBe(48);
  });

  it('falls back to the default on a nonsense request rather than returning nothing', () => {
    expect(resolveWindowHours(Number.NaN, 14)).toBe(168);
    expect(resolveWindowHours(-5, 14)).toBe(168);
  });
});

describe('toDiskPoints', () => {
  it('skips snapshots where that side reported no disk instead of plotting them as zero', () => {
    const snapshots: OpsSnapshot[] = [
      { t: '2026-08-14T00:00:00.000Z', local: side(), peer: side() },
      {
        t: '2026-08-14T01:00:00.000Z',
        local: side({ reachable: false, diskUsedBytes: null, diskTotalBytes: null }),
        peer: side(),
      },
    ];

    const points = toDiskPoints(snapshots, 'local');

    expect(points).toHaveLength(1);
    expect(points[0].percent).toBe(80);
  });
});

describe('getOpsStatusHistory', () => {
  it('returns the snapshots inside the window and drops older ones', () => {
    const inWindow = { t: '2026-08-14T00:00:00.000Z', local: side(), peer: side() };
    const older = { t: '2026-08-01T00:00:00.000Z', local: side(), peer: side() };

    const history = getOpsStatusHistory(NOW, 24, { config: CONFIG, read: readStub([older, inWindow]) });

    expect(history.snapshots.map((s) => s.t)).toEqual(['2026-08-14T00:00:00.000Z']);
    expect(history.windowHours).toBe(24);
    // The count of everything held, not just the window — the page says
    // "24h of 61 stored snapshots" rather than implying 61 is all there is.
    expect(history.storage.storedSnapshots).toBe(2);
  });

  it('projects disk headroom for each side from the windowed snapshots', () => {
    const history = getOpsStatusHistory(NOW, 168, {
      config: CONFIG,
      read: readStub(rampingHistory(13, 6, 1)),
    });

    expect(history.headroom.local.reason).toBe('ok');
    expect(history.headroom.local.days).toBeCloseTo(7, 0);
    // The peer's disk is pinned at 50% in this fixture — flat, so no countdown.
    expect(history.headroom.peer.reason).toBe('not_rising');
    expect(history.headroom.peer.days).toBeNull();
  });

  it('reports an empty history with no error when nothing has been captured yet', () => {
    const history = getOpsStatusHistory(NOW, undefined, { config: CONFIG, read: readStub([]) });

    expect(history.snapshots).toEqual([]);
    expect(history.storage.error).toBeNull();
    expect(history.headroom.local).toEqual({
      thresholdPercent: 90,
      days: null,
      reason: 'no_readings',
      basis: null,
    });
  });

  it('surfaces a store read failure so the page can say why it is blank', () => {
    const history = getOpsStatusHistory(NOW, undefined, {
      config: CONFIG,
      read: readStub([], 'EACCES: permission denied'),
    });

    expect(history.storage.error).toBe('EACCES: permission denied');
    expect(history.snapshots).toEqual([]);
  });

  it('reports capture being switched off distinctly from an empty file', () => {
    const history = getOpsStatusHistory(NOW, undefined, {
      config: { ...CONFIG, enabled: false },
      read: readStub([]),
    });

    expect(history.storage.captureEnabled).toBe(false);
    expect(history.storage.error).toBeNull();
  });

  it('reports damaged lines it skipped rather than hiding the loss', () => {
    const history = getOpsStatusHistory(NOW, undefined, {
      config: CONFIG,
      read: readStub([], null, 3),
    });

    expect(history.storage.skippedLines).toBe(3);
  });
});
