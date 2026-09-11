import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  captureOpsSnapshot,
  describeSnapshotSchedulerStart,
  startOpsSnapshotScheduler,
} from './opsSnapshotScheduler.js';
import type { OpsSnapshotConfig } from './opsSnapshotStore.js';
import type { CombinedOpsStatus } from './combinedOpsStatusService.js';
import type { OpsStatus } from './opsStatusService.js';

const CONFIG: OpsSnapshotConfig = {
  path: '/data/ops-status-snapshots.jsonl',
  enabled: true,
  disabledReason: null,
  designation: ['COMMIT_SHA', 'OPS_PEER_URL'],
  retentionDays: 14,
  intervalMinutes: 15,
};

const NOW = new Date('2026-08-15T00:00:00.000Z');

function status(): OpsStatus {
  return {
    timestamp: NOW.toISOString(),
    provenance: { commit: 'abc1234', runtime: 'container', db_path: '/data/energy_dashboard.db' },
    host: {
      platform: 'linux',
      disk: { totalBytes: 1000, freeBytes: 200, usedBytes: 800 },
      cpuLoad: null,
    },
    process: {
      uptimeSeconds: 60,
      memory: { rssBytes: 100, heapUsedBytes: 60, heapTotalBytes: 80, externalBytes: 5 },
    },
    freshness: {
      status: 'live',
      countriesChecked: 7,
      streamsChecked: 35,
      counts: { live: 35, stale: 0, ended: 0, none: 0 },
      staleCountries: [],
    },
    visitors: { countingSince: NOW.toISOString(), day: '2026-08-15', today: { page: 0, api: 0, asset: 0, automated: 0 }, window: { page: 0, api: 0, asset: 0, automated: 0 }, windowDaysCovered: 1, windowComplete: false, distinctClientsToday: 0 },
  };
}

const combined: CombinedOpsStatus = {
  timestamp: NOW.toISOString(),
  local: { reachable: true, latencyMs: 3, status: status() },
  peer: { reachable: false, latencyMs: null, error: 'OPS_PEER_URL is not configured' },
  peerConfigured: false,
  syncBlackout: { active: false, label: null },
  derived: {
    local: { environment: 'ok', disk: 'ok', freshness: 'ok' },
    peer: { environment: 'unknown', disk: 'unknown', freshness: 'unknown' },
    commitDrift: 'ok',
  },
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('describeSnapshotSchedulerStart', () => {
  it('names the path, cadence, retention and what designated this process when on', () => {
    const decision = describeSnapshotSchedulerStart(CONFIG);

    expect(decision.enabled).toBe(true);
    expect(decision.reason).toContain('every 15m');
    expect(decision.reason).toContain(CONFIG.path);
    expect(decision.reason).toContain('14d');
    expect(decision.reason).toContain('designated by COMMIT_SHA, OPS_PEER_URL');
  });

  it('credits the explicit opt-in when there is no designation to name', () => {
    const decision = describeSnapshotSchedulerStart({ ...CONFIG, designation: [] });

    expect(decision.reason).toContain('OPS_SNAPSHOT_ENABLED is on');
  });

  it('says why it is off rather than starting silently', () => {
    const decision = describeSnapshotSchedulerStart({ ...CONFIG, enabled: false, disabledReason: 'env' });

    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain('OPS_SNAPSHOT_ENABLED');
  });

  // ABL-736: on a dev checkout this line is the only notice the developer gets,
  // so it has to read as a decision with a way out, not as a fault — and it has
  // to name the shared file it declined to write.
  it('tells an undesignated process which file it declined and both ways to opt in', () => {
    const decision = describeSnapshotSchedulerStart({
      ...CONFIG,
      enabled: false,
      disabledReason: 'undesignated',
      designation: [],
    });

    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain('not a designated collector');
    expect(decision.reason).toContain(CONFIG.path);
    expect(decision.reason).toContain('OPS_SNAPSHOT_PATH');
    expect(decision.reason).toContain('OPS_SNAPSHOT_ENABLED=true');
  });
});

describe('captureOpsSnapshot', () => {
  it('maps the combined reading and hands it to the store', async () => {
    const append = vi.fn().mockReturnValue({ written: true, pruned: 0, error: null });

    const result = await captureOpsSnapshot(CONFIG, NOW, {
      getCombined: async () => combined,
      append,
    });

    expect(result.error).toBeNull();
    expect(result.snapshot?.local.diskUsedBytes).toBe(800);
    // An unconfigured peer is still stored — as a gap, not as zeros.
    expect(result.snapshot?.peer.reachable).toBe(false);
    expect(result.snapshot?.peer.diskUsedBytes).toBeNull();
    expect(append).toHaveBeenCalledWith(result.snapshot, CONFIG, NOW);
  });

  it('returns the error instead of rejecting when the status read throws (e.g. a locked DB)', async () => {
    const append = vi.fn();

    const result = await captureOpsSnapshot(CONFIG, NOW, {
      getCombined: async () => {
        throw new Error('SQLITE_BUSY: database is locked');
      },
      append,
    });

    expect(result.error).toContain('SQLITE_BUSY');
    expect(result.snapshot).toBeNull();
    expect(append).not.toHaveBeenCalled();
  });

  it('surfaces a store failure as the capture error', async () => {
    const result = await captureOpsSnapshot(CONFIG, NOW, {
      getCombined: async () => combined,
      append: () => ({ written: false, pruned: 0, error: 'EROFS: read-only file system' }),
    });

    expect(result.error).toContain('EROFS');
  });
});

describe('startOpsSnapshotScheduler', () => {
  it('does not start, and returns null, when capture is switched off', () => {
    const capture = vi.fn();

    const handle = startOpsSnapshotScheduler(
      { COMMIT_SHA: 'b755f606', OPS_SNAPSHOT_ENABLED: 'false' } as NodeJS.ProcessEnv,
      { capture },
    );

    expect(handle).toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });

  // ABL-736. The immediate `tick()` is what made this expensive: ~20 worktree
  // dev servers each captured on startup and every 15m thereafter, into the one
  // file their shared ENERGY_DB_PATH resolves to.
  it('does not capture even once from a worktree dev server that names no environment', () => {
    const capture = vi.fn();

    const handle = startOpsSnapshotScheduler(
      { ENERGY_DB_PATH: 'C:/Code/able/data/energy_dashboard.db' } as NodeJS.ProcessEnv,
      { capture },
    );

    expect(handle).toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });

  it('still captures for a deployed lane with nothing set beyond what its deployment already sets', () => {
    const capture = vi.fn().mockResolvedValue({ snapshot: null, append: null, error: null });

    const handle = startOpsSnapshotScheduler(
      {
        ENERGY_DB_PATH: '/data/energy_dashboard.db',
        COMMIT_SHA: 'b755f606',
        OPS_PEER_URL: 'http://192.168.86.36:3001',
      } as NodeJS.ProcessEnv,
      { capture },
    );

    expect(handle).not.toBeNull();
    expect(capture).toHaveBeenCalledTimes(1);
    handle?.stop();
  });

  it('captures immediately and then on the configured interval', async () => {
    vi.useFakeTimers();
    const capture = vi.fn().mockResolvedValue({ snapshot: null, append: null, error: null });

    const handle = startOpsSnapshotScheduler(
      { OPS_SNAPSHOT_INTERVAL_MINUTES: '5', OPS_SNAPSHOT_PATH: CONFIG.path } as NodeJS.ProcessEnv,
      { capture },
    );

    expect(capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(capture).toHaveBeenCalledTimes(2);

    handle?.stop();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('skips a tick rather than overlapping when the previous capture is still running', async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const capture = vi.fn().mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ snapshot: null, append: null, error: null }); }),
    );

    const handle = startOpsSnapshotScheduler(
      { OPS_SNAPSHOT_INTERVAL_MINUTES: '1', OPS_SNAPSHOT_PATH: CONFIG.path } as NodeJS.ProcessEnv,
      { capture },
    );

    expect(capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(capture).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(capture).toHaveBeenCalledTimes(2);

    handle?.stop();
  });

  it('keeps running after a failed capture — a monitoring gap, never a crashed process', async () => {
    vi.useFakeTimers();
    const capture = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ snapshot: null, append: null, error: null });

    const handle = startOpsSnapshotScheduler(
      { OPS_SNAPSHOT_INTERVAL_MINUTES: '1', OPS_SNAPSHOT_PATH: CONFIG.path } as NodeJS.ProcessEnv,
      { capture },
    );

    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(capture).toHaveBeenCalledTimes(2);
    handle?.stop();
  });
});
