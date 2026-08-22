import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openApiKeyAdminStore } from '../keys/sqliteApiKeyStore.js';
import { openUsageStore } from './sqliteUsageStore.js';
import { createUsageMeter } from './usageMeter.js';
import { startUsageMaintenance, type UsageMaintenanceTimer } from './usageMaintenance.js';
import { shutDownUsage } from './usageShutdown.js';
import { createTestAuthFailureRecorder } from '../security/memoryAuthFailureSink.js';
import { requestFingerprint, type UsageAdminStore, type UsageEvent } from './usageStore.js';

/**
 * "A clean shutdown loses nothing", as a checked property.
 *
 * This claim is made in `usageMeter.ts`, in `CLAUDE.md` and in the deployment
 * note, and until this file existed nothing tested it: the sequence lived inline
 * in `publicIndex.ts`, which opens databases and binds a port at import time and
 * so cannot be imported by a test at all.
 *
 * It is worth the file because the claim is what makes the buffering design
 * acceptable. Buffering trades "an fsync on every authenticated request" for
 * "up to one flush interval lost on a hard kill" — and that trade is only good
 * if the *frequent* way this process dies, a deploy, loses nothing. If the
 * shutdown sequence is wrong, every restart quietly under-bills and the only
 * symptom is an invoice slightly smaller than it should be, which nobody
 * reports.
 */

const tmpRoots: string[] = [];

function tmpDbPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'able-shutdown-'));
  tmpRoots.push(root);
  return path.join(root, 'api_keys.db');
}

afterAll(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  dbPath: string;
  store: UsageAdminStore;
  meter: ReturnType<typeof createUsageMeter>;
  authFailureRecorder: ReturnType<typeof createTestAuthFailureRecorder>['recorder'];
  authFailureSink: ReturnType<typeof createTestAuthFailureRecorder>['sink'];
  maintenance: UsageMaintenanceTimer;
  accountId: string;
  keyId: string;
}

function fixture(): Fixture {
  const dbPath = tmpDbPath();
  const keys = openApiKeyAdminStore({ API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv);
  const accountId = keys.createAccount({ name: 'Acme Energy', plan: 'developer' }).id;
  const keyId = keys.issueKey({ accountId, label: 'prod', contactEmail: 'ops@acme.example', environment: 'live' }).record.id;
  keys.close();

  const store = openUsageStore({ env: { API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv });
  // `flushIntervalMs: 0` so nothing is written by a timer. Everything that
  // reaches the file in these cases got there because the shutdown put it there,
  // which is the only way the assertions mean what they say.
  const meter = createUsageMeter({ sink: store, flushIntervalMs: 0 });
  const maintenance = startUsageMaintenance({
    store,
    rollUpIntervalMs: 3_600_000,
    fullPassIntervalMs: 3_600_000,
    now: () => new Date('2026-09-15T00:00:00Z'),
    log: () => {},
  });

  // The auth-failure recorder is flushed by the same sequence (ABL-530), so it
  // is part of the fixture rather than passed ad hoc: a shutdown that flushed the
  // meter and not this one would lose exactly the records this table exists for,
  // and it would lose them on a deploy.
  const { recorder: authFailureRecorder, sink: authFailureSink } = createTestAuthFailureRecorder();

  return { dbPath, store, meter, authFailureRecorder, authFailureSink, maintenance, accountId, keyId };
}

const ROUTE = '/v1/observations/:series';

function event(f: Fixture, n: number): UsageEvent {
  return {
    requestId: `req_${n}`,
    receivedAt: '2026-08-15T12:00:00.000Z',
    accountId: f.accountId,
    keyId: f.keyId,
    method: 'GET',
    routeTemplate: ROUTE,
    queryParams: 'country=BE',
    status: 200,
    rowCount: 10,
    responseBytes: 1_000,
    durationMs: 5,
    billable: true,
    idempotencyKey: null,
    fingerprint: requestFingerprint('GET', ROUTE, 'country=BE'),
    clientIp: '192.0.2.10',
    userAgent: 'able-sdk/1.0',
  };
}

/** Read the file after the store has been closed, as a restarted process would. */
function onDisk(dbPath: string): { events: number; rollupBillable: number } {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      events: (db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number }).n,
      rollupBillable:
        (
          db.prepare('SELECT COALESCE(SUM(billable_requests), 0) AS n FROM usage_rollup').get() as {
            n: number;
          }
        ).n,
    };
  } finally {
    db.close();
  }
}

describe('a clean shutdown loses nothing', () => {
  it('flushes buffered events, and aggregates them, in that order', () => {
    const f = fixture();

    // A meter holding five events that no timer has written — the state a
    // process is in when a deploy signals it. `flush` does what the real one
    // does: hand the buffer to the sink.
    const buffered = [1, 2, 3, 4, 5].map((n) => event(f, n));
    const order: string[] = [];
    const meter = {
      ...f.meter,
      flush() {
        order.push('flush');
        f.store.writeEvents(buffered);
      },
      close() {
        order.push('close');
      },
    };

    expect(onDisk(f.dbPath).events).toBe(0);

    shutDownUsage({
      meter,
      authFailureRecorder: f.authFailureRecorder,
      maintenance: {
        stop: () => order.push('stop'),
        runNow: () => {
          order.push('runNow');
          return f.maintenance.runNow();
        },
      },
      store: f.store,
      log: () => {},
    });

    // Nothing was written before the flush, so every row on disk is one the
    // shutdown saved.
    const disk = onDisk(f.dbPath);
    expect(disk.events).toBe(5);

    // And the aggregate includes them, which only holds because the pass ran
    // *after* the flush. A pass that ran first would leave the last events
    // unaggregated until the next start — invisible, and exactly the kind of
    // ordering mistake that survives every other test in this directory.
    expect(disk.rollupBillable).toBe(5);
    expect(order).toEqual(['flush', 'close', 'stop', 'runNow']);
  });

  it('aggregates what the flush just wrote, not merely what was already there', () => {
    const f = fixture();

    // Two waves: one already rolled up, one that only the shutdown will see.
    f.store.writeEvents([event(f, 1), event(f, 2)]);
    f.store.rollUp();
    expect(onDisk(f.dbPath).rollupBillable).toBe(2);

    f.store.writeEvents([event(f, 3), event(f, 4), event(f, 5)]);

    shutDownUsage({
      meter: f.meter,
      authFailureRecorder: f.authFailureRecorder,
      maintenance: f.maintenance,
      store: f.store,
      log: () => {},
    });

    expect(onDisk(f.dbPath).rollupBillable).toBe(5);
  });

  it('reports how much it rolled up, so a deploy log says what was saved', () => {
    const f = fixture();
    f.store.writeEvents([event(f, 1), event(f, 2)]);
    const lines: string[] = [];

    shutDownUsage({
      meter: f.meter,
      authFailureRecorder: f.authFailureRecorder,
      maintenance: f.maintenance,
      store: f.store,
      log: (line) => lines.push(line),
    });

    expect(lines.join('\n')).toMatch(/rolled up 2 final events/);
  });

  it('says nothing when there was nothing to save', () => {
    const f = fixture();
    const lines: string[] = [];

    shutDownUsage({
      meter: f.meter,
      authFailureRecorder: f.authFailureRecorder,
      maintenance: f.maintenance,
      store: f.store,
      log: (line) => lines.push(line),
    });

    expect(lines).toEqual([]);
  });
});

describe('a shutdown that goes wrong still shuts down', () => {
  it('closes the store even when the final pass throws', () => {
    const f = fixture();
    f.store.writeEvents([event(f, 1)]);
    const steps: string[] = [];

    const exploding: UsageMaintenanceTimer = {
      runNow() {
        throw new Error('database is locked');
      },
      stop() {
        steps.push('stop');
      },
    };

    shutDownUsage({
      meter: f.meter,
      authFailureRecorder: f.authFailureRecorder,
      maintenance: exploding,
      store: f.store,
      log: () => {},
      onError: (step) => steps.push(`error:${step}`),
    });

    expect(steps[0]).toBe('stop');
    expect(steps[1]).toMatch(/^error:the final maintenance pass/);
    // The point of the guard: the events are already durable, so a failed pass
    // is not worth blocking an exit for — and the store must still be closed, or
    // a `-wal` file is left behind on every failed shutdown.
    expect(onDisk(f.dbPath).events).toBe(1);
    // The store really is closed: a write through it now fails. Asserted as a
    // refused write rather than as `close()` throwing on a second call, because
    // `better-sqlite3` makes `close()` idempotent and that assertion would pass
    // against a store that was never closed at all.
    expect(() => f.store.writeEvents([event(f, 2)])).toThrow(/not open/i);
  });

  it('still runs the aggregation pass when the meter throws on flush', () => {
    const f = fixture();
    f.store.writeEvents([event(f, 1)]);
    const steps: string[] = [];

    const brokenMeter = {
      ...f.meter,
      flush() {
        throw new Error('flush exploded');
      },
    };

    shutDownUsage({
      meter: brokenMeter,
      authFailureRecorder: f.authFailureRecorder,
      maintenance: f.maintenance,
      store: f.store,
      log: () => {},
      onError: (step) => steps.push(step),
    });

    expect(steps).toEqual(['flush']);
    // Whatever *did* reach the store still gets aggregated. Each step is guarded
    // separately for exactly this: one broken step must not skip the rest.
    expect(onDisk(f.dbPath).rollupBillable).toBe(1);
  });
});
