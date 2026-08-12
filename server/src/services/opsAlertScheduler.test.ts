import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  shouldScheduleOpsAlerts,
  resolveOpsAlertIntervalMs,
  describeOpsAlertSchedulerStart,
  runOpsAlertCheck,
} from './opsAlertScheduler.js';
import type { AlertChannel } from './opsAlertChannel.js';
import type { CombinedOpsStatus } from './combinedOpsStatusService.js';
import type { SideStatus } from './peerOpsStatus.js';
import type { OpsStatus } from './opsStatusService.js';
import type { AlertNotification } from '../lib/opsAlertEngine.js';
import { deriveSideState, deriveCommitDriftState } from '../lib/opsStatusThresholds.js';

const NOW = new Date('2026-08-12T12:36:00.000Z');

function opsStatus(
  overrides: { usedBytes?: number; totalBytes?: number; freshness?: 'live' | 'stale'; staleCountries?: string[] } = {},
): OpsStatus {
  const { usedBytes = 100, totalBytes = 1000, freshness = 'live', staleCountries = [] } = overrides;
  return {
    timestamp: NOW.toISOString(),
    provenance: { commit: 'abc1234', runtime: 'container', db_path: '/data/energy_dashboard.db' },
    host: {
      platform: 'linux',
      disk: { usedBytes, totalBytes, freeBytes: totalBytes - usedBytes },
      cpuLoad: null,
      network: null,
    },
    process: { uptimeSeconds: 1, memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 1 } },
    freshness: {
      status: freshness,
      countriesChecked: 3,
      streamsChecked: 12,
      counts: { live: 8, stale: staleCountries.length, ended: 0, none: 0 },
      staleCountries,
    },
  } as OpsStatus;
}

function combined(local: SideStatus, peer: SideStatus, blackoutActive = false): CombinedOpsStatus {
  return {
    timestamp: NOW.toISOString(),
    local,
    peer,
    peerConfigured: true,
    syncBlackout: { active: blackoutActive, label: blackoutActive ? 'evening DB sync' : null },
    derived: {
      local: deriveSideState(local, blackoutActive),
      peer: deriveSideState(peer, blackoutActive),
      commitDrift: deriveCommitDriftState(local, peer),
    },
  } as CombinedOpsStatus;
}

function reachable(status: OpsStatus): SideStatus {
  return { reachable: true, latencyMs: 3, status };
}

function collectingChannel() {
  const delivered: AlertNotification[][] = [];
  const channel: AlertChannel = {
    name: 'test',
    deliver: async (notifications) => {
      delivered.push(notifications);
    },
  };
  return { channel, delivered };
}

const silentLogger = { warn: () => {}, error: () => {}, log: () => {} };

describe('shouldScheduleOpsAlerts', () => {
  it('is on by default — alerting that ships disabled is not monitoring', () => {
    expect(shouldScheduleOpsAlerts({})).toBe(true);
  });

  it.each(['false', 'FALSE', '0', ' false '])('is off for OPS_ALERTS_ENABLED=%s', (value) => {
    expect(shouldScheduleOpsAlerts({ OPS_ALERTS_ENABLED: value })).toBe(false);
  });

  it.each(['true', '1', 'yes'])('stays on for OPS_ALERTS_ENABLED=%s', (value) => {
    expect(shouldScheduleOpsAlerts({ OPS_ALERTS_ENABLED: value })).toBe(true);
  });
});

describe('resolveOpsAlertIntervalMs', () => {
  it('defaults to 5 minutes', () => {
    expect(resolveOpsAlertIntervalMs({})).toBe(5 * 60 * 1000);
  });

  it('honours an explicit interval', () => {
    expect(resolveOpsAlertIntervalMs({ OPS_ALERT_INTERVAL_MINUTES: '15' })).toBe(15 * 60 * 1000);
  });

  it.each(['0', '-5', 'soon', '', '0.001'])(
    'falls back to the default for %s rather than spinning the check',
    (value) => {
      expect(resolveOpsAlertIntervalMs({ OPS_ALERT_INTERVAL_MINUTES: value })).toBe(5 * 60 * 1000);
    },
  );
});

describe('describeOpsAlertSchedulerStart', () => {
  it('reports the interval and the state path when enabled', () => {
    const decision = describeOpsAlertSchedulerStart({
      ENERGY_DB_PATH: '/data/energy_dashboard.db',
      OPS_ALERT_INTERVAL_MINUTES: '10',
    });
    expect(decision.enabled).toBe(true);
    expect(decision.reason).toContain('every 10m');
    expect(decision.reason).toContain(path.join('/data', 'ops-alert-state.json'));
  });

  it('names the reason when disabled', () => {
    const decision = describeOpsAlertSchedulerStart({ OPS_ALERTS_ENABLED: 'false' });
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe('OPS_ALERTS_ENABLED is false');
  });
});

describe('runOpsAlertCheck — end to end against a real state file', () => {
  let dir: string;
  let statePath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-alert-'));
    statePath = path.join(dir, 'ops-alert-state.json');
    env = { OPS_ALERT_STATE_PATH: statePath };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fires once on the live 2026-08-12 breach, then goes silent — the whole point of the issue', () => {
    // Acceptance disk at 85.11% (warn) and freshness stale on both lanes, with
    // no prior state: exactly the world the engine boots into.
    const acceptance = opsStatus({
      usedBytes: 1_701_490_991_104,
      totalBytes: 1_999_203_463_168,
      freshness: 'stale',
      staleCountries: ['AL', 'CH', 'MK'],
    });
    const prod = opsStatus({ freshness: 'stale', staleCountries: ['AL', 'CH', 'MK'] });
    const status = combined(reachable(acceptance), reachable(prod));

    return runOpsAlertCheck({
      getStatus: async () => status,
      env,
      now: NOW,
      logger: silentLogger,
      channel: collectingChannel().channel,
    }).then(async (first) => {
      expect(first.notifications.map((n) => [n.key, n.kind, n.severity])).toEqual([
        ['local:disk', 'breach', 'warn'],
        ['local:freshness', 'breach', 'warn'],
        ['peer:freshness', 'breach', 'warn'],
      ]);
      expect(fs.existsSync(statePath)).toBe(true);

      const second = await runOpsAlertCheck({
        getStatus: async () => status,
        env,
        now: NOW,
        logger: silentLogger,
      });
      expect(second.notifications).toEqual([]);
    });
  });

  it('persists across a process restart — the record is read from the file, not from memory', async () => {
    const status = combined(reachable(opsStatus({ usedBytes: 950 })), reachable(opsStatus()));
    const first = await runOpsAlertCheck({ getStatus: async () => status, env, now: NOW, logger: silentLogger });
    expect(first.notifications).toHaveLength(1);

    // A fresh call shares nothing but the file on disk.
    const stored = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(stored.entries).toContainEqual({
      key: 'local:disk',
      state: 'error',
      firedAt: NOW.toISOString(),
    });

    const afterRestart = await runOpsAlertCheck({
      getStatus: async () => status,
      env,
      now: new Date('2026-08-12T13:36:00.000Z'),
      logger: silentLogger,
    });
    expect(afterRestart.notifications).toEqual([]);
  });

  it('fires a recovery when the disk drains, then stays quiet', async () => {
    const breached = combined(reachable(opsStatus({ usedBytes: 950 })), reachable(opsStatus()));
    const healthy = combined(reachable(opsStatus({ usedBytes: 100 })), reachable(opsStatus()));

    await runOpsAlertCheck({ getStatus: async () => breached, env, now: NOW, logger: silentLogger });
    const recovered = await runOpsAlertCheck({
      getStatus: async () => healthy,
      env,
      now: NOW,
      logger: silentLogger,
    });
    expect(recovered.notifications).toHaveLength(1);
    expect(recovered.notifications[0]).toMatchObject({ key: 'local:disk', kind: 'recovery', severity: 'info' });

    const quiet = await runOpsAlertCheck({
      getStatus: async () => healthy,
      env,
      now: NOW,
      logger: silentLogger,
    });
    expect(quiet.notifications).toEqual([]);
  });

  it('does not report the twice-daily write-lock window as an outage', async () => {
    const blackout = combined(
      { reachable: false, latencyMs: 12, error: 'database is locked' },
      reachable(opsStatus()),
      true,
    );
    const result = await runOpsAlertCheck({
      getStatus: async () => blackout,
      env,
      now: NOW,
      logger: silentLogger,
    });

    expect(result.blackoutActive).toBe(true);
    expect(result.notifications.map((n) => n.key)).not.toContain('local:reachability');
    expect(result.notifications.map((n) => n.key)).not.toContain('local:freshness');
  });

  it('delivers the notifications to the channel', async () => {
    const { channel, delivered } = collectingChannel();
    await runOpsAlertCheck({
      getStatus: async () => combined(reachable(opsStatus({ usedBytes: 950 })), reachable(opsStatus())),
      env,
      now: NOW,
      logger: silentLogger,
      channel,
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0][0]).toMatchObject({ kpi: 'disk', state: 'error' });
  });

  it('does not record a transition nobody received when delivery fails', async () => {
    // The alternative — persisting anyway — marks the breach "already reported"
    // and it would never be mentioned again.
    const status = combined(reachable(opsStatus({ usedBytes: 950 })), reachable(opsStatus()));
    const failing: AlertChannel = {
      name: 'failing',
      deliver: async () => {
        throw new Error('app password revoked');
      },
    };

    const failed = await runOpsAlertCheck({
      getStatus: async () => status,
      env,
      now: NOW,
      logger: silentLogger,
      channel: failing,
    });
    expect(failed.warnings.join(' ')).toContain('app password revoked');
    expect(fs.existsSync(statePath)).toBe(false);

    // Next tick, with a working channel, still reports the breach.
    const retried = await runOpsAlertCheck({
      getStatus: async () => status,
      env,
      now: NOW,
      logger: silentLogger,
    });
    expect(retried.notifications).toHaveLength(1);
  });

  it('survives a status read that throws, without erasing what it last reported', async () => {
    const status = combined(reachable(opsStatus({ usedBytes: 950 })), reachable(opsStatus()));
    await runOpsAlertCheck({ getStatus: async () => status, env, now: NOW, logger: silentLogger });
    const before = fs.readFileSync(statePath, 'utf8');

    const result = await runOpsAlertCheck({
      getStatus: async () => {
        throw new Error('unexpected');
      },
      env,
      now: NOW,
      logger: silentLogger,
    });

    expect(result.notifications).toEqual([]);
    expect(result.warnings.join(' ')).toContain('could not read combined status');
    expect(fs.readFileSync(statePath, 'utf8')).toBe(before);
  });

  it('starts from no memory rather than throwing when the state file is corrupt', async () => {
    fs.writeFileSync(statePath, '{"version":1,"entr', 'utf8');
    const result = await runOpsAlertCheck({
      getStatus: async () => combined(reachable(opsStatus({ usedBytes: 950 })), reachable(opsStatus())),
      env,
      now: NOW,
      logger: silentLogger,
    });

    expect(result.warnings.join(' ')).toContain('could not parse');
    expect(result.notifications).toHaveLength(1);
  });
});
