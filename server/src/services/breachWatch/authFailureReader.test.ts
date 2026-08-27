import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openApiKeyAdminStore } from '../../v1/keys/sqliteApiKeyStore.js';
import { openUsageStore } from '../../v1/usage/sqliteUsageStore.js';
import { isUnavailable, openAuthFailureReader } from './authFailureReader.js';
import { detectBreachSignals, PROVISIONAL_MIN_PREFIXES_PER_ORIGIN } from './signals.js';
import type { AuthFailureEvent } from '../../v1/security/authFailureStore.js';

/**
 * The reader against a **real SQLite file**, because everything else about this
 * feature is faked.
 *
 * `signals.test.ts` and `breachWatchScheduler.test.ts` prove the judgement and
 * the wiring with the database replaced. That is the right way to test those, and
 * it leaves exactly one thing unproven: whether the watcher can open the file
 * `/v1` actually writes and get rows out of it. That gap is where a detector that
 * cannot fire would live — the failure ABL-578 says reads as coverage — so it is
 * closed here rather than at three in the morning.
 *
 * The readonly-DDL case below is not defensive padding. `createAuthFailureStore`
 * applies its schema with `CREATE TABLE IF NOT EXISTS`, and SQLite tolerates that
 * on a readonly connection **only when the table already exists**; against a
 * fresh file it raises "attempt to write a readonly database". Verified against a
 * real handle rather than reasoned about.
 */

const tmpRoots: string[] = [];

function tmpDbPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'able-breachwatch-'));
  tmpRoots.push(root);
  return path.join(root, 'api_keys.db');
}

afterAll(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

/** A key store with the `/v1` tables applied, exactly as the public process leaves it. */
function seedStore(failures: readonly AuthFailureEvent[] = []): string {
  const dbPath = tmpDbPath();
  const env = { API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv;

  const keys = openApiKeyAdminStore(env);
  const accountId = keys.createAccount({ name: 'Acme Energy', plan: 'developer' }).id;
  keys.issueKey({
    accountId,
    label: 'prod ETL',
    environment: 'live',
    contactEmail: 'ops@acme.example',
  });
  keys.close();

  // Opening the usage store is what applies both the usage schema and, through
  // it, `auth_failures` — the same call `publicIndex.ts` makes at boot.
  const usage = openUsageStore({ env });
  if (failures.length > 0) usage.writeAuthFailures(failures);
  usage.close();

  return dbPath;
}

function failure(overrides: Partial<AuthFailureEvent> = {}): AuthFailureEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    receivedAt: '2026-08-26T02:00:00.000Z',
    errorCode: 'key_invalid',
    status: 401,
    presentedPrefix: 'a1b2c3d4',
    keyEnvironment: 'live',
    secretVerified: false,
    accountId: null,
    keyId: null,
    routeTemplate: '/v1/prices',
    method: 'GET',
    clientIp: '203.0.113.77',
    userAgent: 'curl/8.0',
    ...overrides,
  };
}

describe('openAuthFailureReader against a real store', () => {
  it('opens the file /v1 writes and returns its rows', () => {
    const dbPath = seedStore([
      failure({ presentedPrefix: 'aaaa1111' }),
      failure({ presentedPrefix: 'bbbb2222' }),
    ]);

    const reader = openAuthFailureReader({ API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv);
    expect(isUnavailable(reader)).toBe(false);
    if (isUnavailable(reader)) return;

    const window = { since: '2026-08-26T00:00:00.000Z', until: '2026-08-27T00:00:00.000Z' };
    const byOrigin = reader.store.failuresByOrigin(window);

    expect(byOrigin).toHaveLength(1);
    expect(byOrigin[0].clientIp).toBe('203.0.113.77');
    expect(byOrigin[0].failures).toBe(2);
    expect(byOrigin[0].distinctPrefixes).toBe(2);

    // The other two reads the watcher makes must also answer, not throw.
    expect(reader.store.secretHolderFailures(window)).toEqual([]);
    expect(reader.store.keyOrigins()).toEqual([]);

    reader.close();
  });

  it('end to end: enumeration written by /v1 is detected through the real reader', () => {
    // The positive control with nothing faked between the write and the verdict.
    const prefixes = Array.from({ length: 40 }, (_, i) => `pre${String(i).padStart(5, '0')}`);
    const dbPath = seedStore(prefixes.map((presentedPrefix) => failure({ presentedPrefix })));

    const reader = openAuthFailureReader({ API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv);
    if (isUnavailable(reader)) throw new Error(reader.reason);

    const window = { since: '2026-08-26T00:00:00.000Z', until: '2026-08-27T00:00:00.000Z' };
    const findings = detectBreachSignals({
      window,
      byOrigin: reader.store.failuresByOrigin(window),
      secretHolderRows: reader.store.secretHolderFailures(window),
      keyOriginRows: reader.store.keyOrigins(),
      originLookbackSince: '2026-07-28T00:00:00.000Z',
      minPrefixesPerOrigin: PROVISIONAL_MIN_PREFIXES_PER_ORIGIN,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].signal).toBe('S3');
    expect(findings[0].subject).toBe('203.0.113.77');
    expect(findings[0].magnitude).toBe(40);

    reader.close();
  });

  it('holds a genuinely readonly handle', () => {
    // The watcher reads what the serving process decided. It must not be able to
    // alter a key, a usage row or an auth-failure record even by mistake.
    const dbPath = seedStore([failure()]);
    const reader = openAuthFailureReader({ API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv);
    if (isUnavailable(reader)) throw new Error(reader.reason);

    expect(() =>
      reader.store.writeAuthFailures([failure({ eventId: 'evt-write-attempt' })])
    ).toThrow(/readonly/i);

    reader.close();
  });
});

describe('degradations, against real files', () => {
  it('says there is nothing to watch when no key store is configured', () => {
    // The ordinary state of every dev checkout: /v1 is not running here, so there
    // are no auth-failure tables anywhere. Not an error and never an alarm.
    const result = openAuthFailureReader({} as NodeJS.ProcessEnv);
    expect(isUnavailable(result)).toBe(true);
    if (!isUnavailable(result)) return;
    expect(result.reason).toContain('no /v1 key store is configured');
  });

  it('says so when the file does not exist', () => {
    const result = openAuthFailureReader({
      API_KEYS_DB_PATH: path.join(os.tmpdir(), 'no-such-able-keys.db'),
    } as NodeJS.ProcessEnv);
    expect(isUnavailable(result)).toBe(true);
  });

  it('reports a key store whose /v1 tables have never been created, without throwing', () => {
    // A file created by `npm run keys` on a deployment where the public process
    // has never started. The readonly `CREATE TABLE IF NOT EXISTS` would raise
    // "attempt to write a readonly database" here, which is a confusing error for
    // a condition that is simply "nothing has been recorded yet".
    const dbPath = tmpDbPath();
    const keys = openApiKeyAdminStore({ API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv);
    keys.close();

    const result = openAuthFailureReader({ API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv);
    expect(isUnavailable(result)).toBe(true);
    if (!isUnavailable(result)) return;
    expect(result.reason).toContain('auth_failures');
    expect(result.reason).toContain('Nothing to watch yet');
  });

  it('does not leave a handle open on the unavailable paths', () => {
    // A scheduler that leaks a SQLite handle every 15 minutes is its own outage.
    const dbPath = tmpDbPath();
    const keys = openApiKeyAdminStore({ API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv);
    keys.close();

    for (let i = 0; i < 50; i += 1) {
      openAuthFailureReader({ API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv);
    }

    // If the handles above were still open, this exclusive lock would fail.
    const exclusive = new Database(dbPath);
    exclusive.pragma('locking_mode = EXCLUSIVE');
    expect(() => exclusive.exec('BEGIN EXCLUSIVE; COMMIT;')).not.toThrow();
    exclusive.close();
  });
});
