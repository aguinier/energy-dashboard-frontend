import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  describeBreachWatchSchedulerStart,
  resolveBreachWatchIntervalMs,
  resolveBreachWatchSettings,
  runBreachWatchCheck,
  shouldScheduleBreachWatch,
  type BreachWatchSource,
} from './breachWatchScheduler.js';
import type { IncidentChannel, OpenedIncident } from './breachWatch/incidentChannel.js';
import type { Incident } from './breachWatch/incidentReport.js';
import type {
  KeyOriginRow,
  OriginFailureRow,
  SecretHolderFailureRow,
} from '../v1/security/authFailureStore.js';

/**
 * The whole path, end to end, with the database and the network replaced and
 * nothing else.
 *
 * `signals.test.ts` proves the detector's controls in isolation. This file proves
 * the thing ABL-578 actually asked for: that a synthesised failure pattern
 * reaches a correctly-shaped incident, that ordinary traffic reaches nobody, and
 * that a sustained attack produces **one** issue rather than one per tick.
 *
 * The store is faked rather than fixtured because the SQL underneath is ABL-530's
 * and is already covered by `sqliteAuthFailureStore.test.ts` (691 lines of it).
 * What is untested until this file exists is the wiring: window arithmetic,
 * idempotency, the delivery-failure rule, and the degradations.
 */

const SILENT = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };

function secretHolder(overrides: Partial<SecretHolderFailureRow> = {}): SecretHolderFailureRow {
  return {
    keyId: 'key_live_001',
    accountId: 'acct_001',
    presentedPrefix: 'a1b2c3d4',
    errorCode: 'key_revoked',
    clientIp: '203.0.113.9',
    failures: 4,
    firstAt: '2026-08-26T02:00:00.000Z',
    lastAt: '2026-08-26T02:40:00.000Z',
    originServedRequests: 0,
    usageHistoryFrom: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

interface Rows {
  byOrigin?: OriginFailureRow[];
  secretHolderRows?: SecretHolderFailureRow[];
  keyOriginRows?: KeyOriginRow[];
}

/** A store that returns exactly what it is given, and records the window it was asked for. */
function fakeSource(rows: Rows = {}) {
  const seen: Array<{ since: string; until: string; lookback: string }> = [];
  let closed = 0;
  const source: BreachWatchSource = {
    read(window, originLookbackSince) {
      seen.push({ ...window, lookback: originLookbackSince });
      return {
        byOrigin: rows.byOrigin ?? [],
        secretHolderRows: rows.secretHolderRows ?? [],
        keyOriginRows: rows.keyOriginRows ?? [],
      };
    },
    close: () => {
      closed += 1;
    },
  };
  return { source, seen, closed: () => closed };
}

/** A channel that records every incident and hands back an id, like the real one. */
function recordingChannel() {
  const opened: Incident[] = [];
  const updates: Array<{ issueId: string; body: string }> = [];
  let next = 0;
  const channel: IncidentChannel = {
    name: 'recording',
    async open(incident): Promise<OpenedIncident> {
      opened.push(incident);
      next += 1;
      return { issueId: `issue-${next}`, reference: `ABL-90${next}` };
    },
    async update(issueId, body) {
      updates.push({ issueId, body });
    },
  };
  return { channel, opened, updates };
}

describe('scheduler decisions are pure and fail safe', () => {
  it('is opt-out, not opt-in — alerting that ships disabled is not monitoring', () => {
    expect(shouldScheduleBreachWatch({})).toBe(true);
    expect(shouldScheduleBreachWatch({ BREACH_WATCH_ENABLED: 'false' })).toBe(false);
    expect(shouldScheduleBreachWatch({ BREACH_WATCH_ENABLED: '0' })).toBe(false);
  });

  it('falls back to the default interval rather than spinning on a typo', () => {
    // A typo in a deployment env must not turn the monitor into the incident.
    expect(resolveBreachWatchIntervalMs({ BREACH_WATCH_INTERVAL_MINUTES: 'soon' })).toBe(15 * 60_000);
    expect(resolveBreachWatchIntervalMs({ BREACH_WATCH_INTERVAL_MINUTES: '0' })).toBe(15 * 60_000);
    expect(resolveBreachWatchIntervalMs({ BREACH_WATCH_INTERVAL_MINUTES: '5' })).toBe(5 * 60_000);
  });

  it('defaults the windows to the same figures the security:* commands use', () => {
    // So an alarm and a hand-run report cannot disagree about the same instant.
    const settings = resolveBreachWatchSettings({});
    expect(settings.windowHours).toBe(24);
    expect(settings.originLookbackDays).toBe(30);
    expect(settings.minPrefixesPerOrigin).toBe(10);
  });

  it('says at boot when the mandated channel is not configured', () => {
    const decision = describeBreachWatchSchedulerStart({});
    expect(decision.enabled).toBe(true);
    expect(decision.channelName).toBe('logging');
    expect(decision.reason).toContain('LOGGED ONLY');
  });

  it('says at boot when it is configured', () => {
    const decision = describeBreachWatchSchedulerStart({
      PAPERCLIP_API_KEY: 'k',
      PAPERCLIP_API_URL: 'http://h:3100',
      PAPERCLIP_COMPANY_ID: 'c',
      ENERGY_DB_PATH: '/data/energy_dashboard.db',
    });
    expect(decision.channelName).toBe('paperclip');
    expect(decision.reason).toContain('priority:high');
  });
});

describe('positive control — a synthesised attack produces a correctly-shaped incident', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breach-watch-e2e-'));
    env = { BREACH_WATCH_STATE_PATH: path.join(dir, 'state.json') };
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('opens one priority:high incident carrying the ABL-578 triage set', async () => {
    const { source } = fakeSource({ secretHolderRows: [secretHolder()] });
    const { channel, opened } = recordingChannel();

    const result = await runBreachWatchCheck({
      openSource: () => source,
      channel,
      env,
      now: new Date('2026-08-27T00:00:00.000Z'),
      logger: SILENT,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.opened).toEqual(['ABL-901']);
    expect(opened).toHaveLength(1);

    const incident = opened[0];
    expect(incident.title).toContain('INCIDENT: S4');
    expect(incident.description).toContain('key_live_001');   // the key id
    expect(incident.description).toContain('4 matching record(s)'); // the counts
    expect(incident.description).toContain('2026-08-26T00:00:00.000Z'); // the window
    expect(incident.description).toContain('breach-procedure');
    // Never a full key, on any surface.
    expect(/able_[a-z]+_[A-Za-z0-9]+_[A-Za-z0-9]/.test(
      `${incident.title}${incident.description}${incident.detail}`
    )).toBe(false);
  });

  it('reads the window the settings describe, and closes the handle', () => {
    const { source, seen, closed } = fakeSource();
    return runBreachWatchCheck({
      openSource: () => source,
      channel: recordingChannel().channel,
      env: { ...env, BREACH_WATCH_WINDOW_HOURS: '6', BREACH_WATCH_ORIGIN_LOOKBACK_DAYS: '10' },
      now: new Date('2026-08-27T00:00:00.000Z'),
      logger: SILENT,
    }).then(() => {
      expect(seen[0].since).toBe('2026-08-26T18:00:00.000Z');
      expect(seen[0].until).toBe('2026-08-27T00:00:00.000Z');
      expect(seen[0].lookback).toBe('2026-08-17T00:00:00.000Z');
      // A leaked SQLite handle every 15 minutes is its own outage.
      expect(closed()).toBe(1);
    });
  });

  it('opens one incident per subject when several signals trip at once', async () => {
    const { source } = fakeSource({
      secretHolderRows: [secretHolder()],
      byOrigin: [
        {
          clientIp: '203.0.113.77',
          failures: 940,
          distinctPrefixes: 940,
          errorCodes: 'key_invalid',
          secretVerifiedFailures: 0,
          firstAt: '2026-08-26T01:00:00.000Z',
          lastAt: '2026-08-26T01:30:00.000Z',
        },
      ],
    });
    const { channel, opened } = recordingChannel();

    await runBreachWatchCheck({
      openSource: () => source,
      channel,
      env,
      now: new Date('2026-08-27T00:00:00.000Z'),
      logger: SILENT,
    });

    expect(opened.map((i) => i.title.slice(0, 16))).toEqual(['INCIDENT: S4 — a', 'INCIDENT: S3 — 2']);
    // The provisional one is marked as such; the other is not.
    expect(opened[0].description).not.toContain('PROVISIONAL');
    expect(opened[1].description).toContain('PROVISIONAL');
  });
});

describe('negative control — ordinary traffic wakes nobody', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breach-watch-neg-'));
    env = { BREACH_WATCH_STATE_PATH: path.join(dir, 'state.json') };
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a busy day of typos and one customer with a stale key opens nothing', async () => {
    const { source } = fakeSource({
      byOrigin: [
        // Someone mistyping their secret all afternoon: volume, one prefix.
        {
          clientIp: '198.51.100.7',
          failures: 412,
          distinctPrefixes: 1,
          errorCodes: 'key_invalid',
          secretVerifiedFailures: 0,
          firstAt: '2026-08-26T09:00:00.000Z',
          lastAt: '2026-08-26T17:00:00.000Z',
        },
        // A misconfigured client retrying a rotated key forever.
        {
          clientIp: '198.51.100.9',
          failures: 8_640,
          distinctPrefixes: 1,
          errorCodes: 'key_invalid',
          secretVerifiedFailures: 0,
          firstAt: '2026-08-26T00:00:00.000Z',
          lastAt: '2026-08-26T23:59:00.000Z',
        },
        // A scanner that found the port: no prefix parsed at all.
        {
          clientIp: '203.0.113.200',
          failures: 60,
          distinctPrefixes: 0,
          errorCodes: 'key_missing,key_malformed',
          secretVerifiedFailures: 0,
          firstAt: '2026-08-26T04:00:00.000Z',
          lastAt: '2026-08-26T04:02:00.000Z',
        },
      ],
      // A revoked key presented from the address it has always been served from.
      secretHolderRows: [secretHolder({ originServedRequests: 4_211 })],
      // A key shared across a steady fleet, and a customer redeploying.
      keyOriginRows: [
        { keyId: 'key_live_002', accountId: 'acct_002', clientIp: '192.0.2.10', requests: 900, firstAt: '2026-06-01T00:00:00.000Z', lastAt: '2026-08-26T23:00:00.000Z' },
        { keyId: 'key_live_002', accountId: 'acct_002', clientIp: '192.0.2.11', requests: 880, firstAt: '2026-06-01T00:00:00.000Z', lastAt: '2026-08-26T23:00:00.000Z' },
        { keyId: 'key_live_003', accountId: 'acct_003', clientIp: '192.0.2.20', requests: 400, firstAt: '2026-06-01T00:00:00.000Z', lastAt: '2026-08-10T00:00:00.000Z' },
        { keyId: 'key_live_003', accountId: 'acct_003', clientIp: '192.0.2.21', requests: 500, firstAt: '2026-08-11T00:00:00.000Z', lastAt: '2026-08-26T23:00:00.000Z' },
      ],
    });
    const { channel, opened, updates } = recordingChannel();

    const result = await runBreachWatchCheck({
      openSource: () => source,
      channel,
      env,
      now: new Date('2026-08-27T00:00:00.000Z'),
      logger: SILENT,
    });

    expect(result.findings).toEqual([]);
    expect(opened).toEqual([]);
    expect(updates).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('idempotency — one open incident per window, updated not duplicated', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breach-watch-idem-'));
    env = { BREACH_WATCH_STATE_PATH: path.join(dir, 'state.json') };
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function tick(rows: Rows, now: string, channel: IncidentChannel) {
    return runBreachWatchCheck({
      openSource: () => fakeSource(rows).source,
      channel,
      env,
      now: new Date(now),
      logger: SILENT,
    });
  }

  it('a sustained attack opens ONE issue across many ticks', async () => {
    const { channel, opened, updates } = recordingChannel();
    const rows = { secretHolderRows: [secretHolder()] };

    await tick(rows, '2026-08-27T00:00:00.000Z', channel);
    await tick(rows, '2026-08-27T00:15:00.000Z', channel);
    const third = await tick(rows, '2026-08-27T00:30:00.000Z', channel);

    expect(opened).toHaveLength(1);
    expect(updates).toHaveLength(0);
    expect(third.suppressed).toEqual(['s4:key_live_001']);
  });

  it('an unchanged count stays silent even past the update interval', async () => {
    const { channel, updates } = recordingChannel();
    const rows = { secretHolderRows: [secretHolder({ failures: 4 })] };

    await tick(rows, '2026-08-27T00:00:00.000Z', channel);
    await tick(rows, '2026-08-27T12:00:00.000Z', channel);

    expect(updates).toHaveLength(0);
  });

  it('a growing attack is commented on, not re-filed, once the interval elapses', async () => {
    const { channel, opened, updates } = recordingChannel();

    await tick({ secretHolderRows: [secretHolder({ failures: 4 })] }, '2026-08-27T00:00:00.000Z', channel);
    // Grown, but only 15 minutes later: too soon to comment again.
    await tick({ secretHolderRows: [secretHolder({ failures: 40 })] }, '2026-08-27T00:15:00.000Z', channel);
    expect(updates).toHaveLength(0);

    // Grown, and past the 6h update interval.
    await tick({ secretHolderRows: [secretHolder({ failures: 900 })] }, '2026-08-27T07:00:00.000Z', channel);

    expect(opened).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].issueId).toBe('issue-1');
    expect(updates[0].body).toContain('from 4 to 900');
  });

  it('a lapsed window opens a fresh incident — a new attack is not the old one', async () => {
    const { channel, opened } = recordingChannel();
    const rows = { secretHolderRows: [secretHolder()] };

    await tick(rows, '2026-08-27T00:00:00.000Z', channel);
    // Past the 24h incident window.
    await tick(rows, '2026-08-28T01:00:00.000Z', channel);

    expect(opened).toHaveLength(2);
  });

  it('records nothing when delivery failed, so the next tick retries', async () => {
    // The rule `runOpsAlertCheck` follows, for the same reason: recording a
    // delivery nobody received would mark the subject "already reported" and the
    // attack would never be mentioned again.
    let attempts = 0;
    const channel: IncidentChannel = {
      name: 'flaky',
      async open(incident) {
        attempts += 1;
        if (attempts === 1) throw new Error('control plane down');
        return { issueId: 'issue-1', reference: 'ABL-901' };
      },
      async update() {},
    };
    const rows = { secretHolderRows: [secretHolder()] };

    const first = await tick(rows, '2026-08-27T00:00:00.000Z', channel);
    expect(first.opened).toEqual([]);
    expect(first.warnings.join(' ')).toContain('NOBODY HAS BEEN TOLD');

    const second = await tick(rows, '2026-08-27T00:15:00.000Z', channel);
    expect(second.opened).toEqual(['ABL-901']);
  });
});

describe('degradations — never a crash, never a false alarm', () => {
  it('reports "nothing to watch" rather than alarming when /v1 is not configured', async () => {
    // The ordinary state of every dev checkout and of any deployment not running
    // /v1. An alarm here would fire on *not having an API*.
    const result = await runBreachWatchCheck({
      openSource: () => ({ reason: 'no /v1 key store is configured in this process' }),
      env: {},
      logger: SILENT,
    });

    expect(result.unavailable).toContain('no /v1 key store');
    expect(result.findings).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('collects a read failure as a warning and keeps ticking', async () => {
    const source: BreachWatchSource = {
      read() {
        throw new Error('database is locked');
      },
      close() {},
    };

    const result = await runBreachWatchCheck({
      openSource: () => source,
      env: {},
      logger: SILENT,
    });

    expect(result.warnings.join(' ')).toContain('database is locked');
    expect(result.findings).toEqual([]);
  });

  it('does not reject when opening the store throws', async () => {
    await expect(
      runBreachWatchCheck({
        openSource: () => {
          throw new Error('unexpected');
        },
        env: {},
        logger: SILENT,
      })
    ).resolves.toMatchObject({ findings: [] });
  });
});
