import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { requireApiKey } from '../auth/apiKeyAuth.js';
import { publicErrorHandler, publicNotFoundHandler } from '../publicErrors.js';
import { createMemoryApiKeyDirectory, withSecret } from '../keys/memoryApiKeyDirectory.js';
import { mintApiKey, KEY_SECRET_LENGTH } from '../keys/keyFormat.js';
import { createAuthFailureRecorder } from './authFailureRecorder.js';
import { openApiKeyAdminStore } from '../keys/sqliteApiKeyStore.js';
import { openUsageStore } from '../usage/sqliteUsageStore.js';
import { requestFingerprint, type RetentionPolicy, type UsageAdminStore, type UsageEvent } from '../usage/usageStore.js';
import type { AuthFailureEvent } from './authFailureStore.js';

/**
 * `auth_failures` against a real SQLite file, because every claim here is a
 * claim about the database.
 *
 * The four that matter most, roughly in the order somebody would check them
 * after an incident:
 *
 * 1. **The file cannot hold a presented secret.** Asserted against the file's
 *    *bytes* rather than against the schema, the way `sqliteApiKeyStore.test.ts`
 *    asserts the same thing for the key store — a column list can be read
 *    carefully and still be wrong about what ends up on disk.
 * 2. **Retention covers this table on the same boundaries as `usage_events`,
 *    in the same pass.** Missing this turns a detection feature into a
 *    privacy-notice violation, which is a worse outcome than not building it.
 * 3. **`usage:stats`'s compliance figure counts it.** A check that silently
 *    stopped covering a table full of addresses would still print COMPLIANT.
 * 4. **The S3/S4 groupings return the shapes they claim**, including the
 *    three-valued-logic trap that would otherwise manufacture the most alarming
 *    verdict on the page from a scrubbed address.
 *
 * Temp files rather than `:memory:`, for the reason `sqliteUsageStore.test.ts`
 * gives: WAL mode, `fileMustExist` and the key-store check are all properties of
 * a file on disk.
 */

const tmpRoots: string[] = [];

function tmpDbPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'able-authfail-'));
  tmpRoots.push(root);
  return path.join(root, 'api_keys.db');
}

afterAll(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

let dbPath: string;
let store: UsageAdminStore;
let accountId: string;
let keyId: string;
let sequence = 0;

function open(policy?: Partial<RetentionPolicy>): void {
  dbPath = tmpDbPath();
  const keys = openApiKeyAdminStore({ API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv);
  accountId = keys.createAccount({ name: 'Acme Energy', plan: 'developer' }).id;
  // `contactEmail` is required since ABL-528 — a contactless mint is refused at
  // runtime, and this call site is in a test file, which `tsconfig.json`
  // excludes from `tsc`, so the type could not say so here.
  keyId = keys.issueKey({
    accountId,
    label: 'prod ETL',
    environment: 'live',
    contactEmail: 'ops@acme.example',
  }).record.id;
  keys.close();

  store = openUsageStore({
    env: { API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv,
    policy: { piiDays: 90, eventMonths: 13, monthCloseGraceDays: 2, ...policy },
  });
}

beforeEach(() => {
  sequence = 0;
  open();
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // Some cases close it themselves to read the file directly.
  }
});

const NOW = new Date('2026-08-22T00:00:00.000Z');
const DAY = 86_400_000;
const at = (offsetDays: number): string => new Date(NOW.getTime() + offsetDays * DAY).toISOString();

function failure(over: Partial<AuthFailureEvent> = {}): AuthFailureEvent {
  sequence += 1;
  return {
    eventId: `af_${sequence}`,
    receivedAt: at(-1),
    errorCode: 'key_invalid',
    status: 401,
    presentedPrefix: '7f3a9c21',
    keyEnvironment: 'live',
    secretVerified: false,
    accountId: null,
    keyId: null,
    routeTemplate: '/v1/observations/load',
    method: 'GET',
    clientIp: '198.51.100.7',
    userAgent: 'curl/8.4.0',
    ...over,
  };
}

const ROUTE = '/v1/observations/load';

function served(over: Partial<UsageEvent> = {}): UsageEvent {
  sequence += 1;
  return {
    requestId: `req_${sequence}`,
    receivedAt: at(-30),
    accountId,
    keyId,
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
    ...over,
  };
}

/**
 * Read the file directly, as a forensic examiner or a leaked-file attacker
 * would.
 *
 * The `-wal` sibling is read when it is there and is gone once the store closes
 * cleanly — reading both covers either outcome, and reading neither would let
 * this assertion pass against bytes that were still in the log.
 */
function rawBytes(): string {
  store.close();
  const wal = `${dbPath}-wal`;
  return (
    fs.readFileSync(dbPath, 'latin1') +
    (fs.existsSync(wal) ? fs.readFileSync(wal, 'latin1') : '')
  );
}

/**
 * Read the file through a second, readonly handle and close it again.
 *
 * Closing matters on Windows: a handle left open keeps the temp directory
 * locked, and `afterAll`'s cleanup then fails with `EPERM` *after* every
 * assertion has passed — a red suite whose failure names no test.
 */
function readDirect<T>(read: (db: Database.Database) => T): T {
  const db = new Database(dbPath, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

describe('the file cannot hold a presented secret', () => {
  it('has no column that could', () => {
    const columns = readDirect((db) =>
      (
        db.prepare("SELECT name FROM pragma_table_info('auth_failures')").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name)
    );

    expect(columns).toEqual([
      'id',
      'event_id',
      'received_at',
      'error_code',
      'status',
      'presented_prefix',
      'key_environment',
      'secret_verified',
      'account_id',
      'key_id',
      'route_template',
      'method',
      'client_ip',
      'user_agent',
      'pii_scrubbed_at',
    ]);
    // Pinned as an exact list, so a column added here is a reviewed diff. The
    // one that must never appear is any form of the secret — hashed, truncated
    // or whole. A store of attempted secrets is a second credential store,
    // filled from the open internet, with none of the protections the real one
    // has.
    expect(columns.join(' ')).not.toMatch(/secret(?!_verified)|hash|token|password|authorization/i);
  });

  it('a secret presented to the real gate does not reach the bytes on disk', async () => {
    // End to end rather than against the store's API, because the store's API has
    // no parameter that could carry a secret and asserting that proves only what
    // the type already says. What is worth proving is the whole path: a real
    // `Authorization` header, through the real gate, through the real recorder,
    // into the real file — and then the file read as a forensic examiner or
    // somebody holding a leaked copy would read it.
    //
    // Against the bytes rather than against the schema, the way
    // `sqliteApiKeyStore.test.ts` checks the key store, and for the same reason:
    // a column list can be read carefully and still be wrong about what ends up
    // on disk.
    const recorder = createAuthFailureRecorder({ sink: store, flushIntervalMs: 0 });
    const directory = createMemoryApiKeyDirectory([{}]);
    const app = express();
    app.use('/v1', requireApiKey({ directory: directory.directory, recorder }));
    app.use(publicNotFoundHandler);
    app.use(publicErrorHandler);

    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');

    const issued = directory.keys[0];
    const forged = mintApiKey('live');
    try {
      // Three refusals: a wrong secret against a real prefix, an unissued key,
      // and a revoked-shaped guess. All three carry a secret in the header.
      for (const key of [
        withSecret(issued.key, 'Z'.repeat(KEY_SECRET_LENGTH)),
        forged.key,
        issued.key.slice(0, -3) + 'aaa',
      ]) {
        const res = await fetch(`http://127.0.0.1:${address.port}/v1/observations/load`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        expect(res.status).toBe(401);
      }
      recorder.close();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }

    const bytes = rawBytes();

    // The non-secret handle *is* there — it is the one column that separates
    // enumeration from a customer with a stale key.
    expect(bytes).toContain(issued.record.prefix);
    expect(bytes).toContain(forged.prefix);
    // The secret halves are not, in any form. Note the whole key is checked too:
    // a well-meaning "record what they sent, for support" would put it here.
    for (const secret of [
      'Z'.repeat(KEY_SECRET_LENGTH),
      forged.key.split('_')[3],
      issued.key.split('_')[3],
      forged.key,
      issued.key,
    ]) {
      expect(bytes).not.toContain(secret);
    }
  });
});

describe('writing', () => {
  it('round-trips every field, including the boolean', () => {
    store.writeAuthFailures([
      failure({ secretVerified: true, accountId, keyId, errorCode: 'key_revoked' }),
    ]);

    const rows = store.secretHolderFailures({ since: at(-7), until: at(1) });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ keyId, accountId, errorCode: 'key_revoked' });
  });

  it('a replayed batch inserts nothing the second time', () => {
    // `UNIQUE(event_id)` + `ON CONFLICT DO NOTHING`. Without it this module would
    // have to choose between losing a record and duplicating one — and a
    // duplicated refusal inflates an enumeration count somebody acts on.
    const batch = [failure(), failure()];

    expect(store.writeAuthFailures(batch)).toEqual({ inserted: 2, alreadyPresent: 0 });
    expect(store.writeAuthFailures(batch)).toEqual({ inserted: 0, alreadyPresent: 2 });
  });

  it('a malformed row raises rather than vanishing', () => {
    // `ON CONFLICT(event_id) DO NOTHING` rather than `INSERT OR IGNORE`, which
    // would swallow the NOT NULL violation too and count it as `alreadyPresent`
    // — a discarded security record reported as a benign retry.
    expect(() =>
      store.writeAuthFailures([failure({ errorCode: null as unknown as string })])
    ).toThrow(/NOT NULL/i);
  });

  it('writes nothing for an empty batch', () => {
    expect(store.writeAuthFailures([])).toEqual({ inserted: 0, alreadyPresent: 0 });
  });
});

describe('retention — the same job, the same boundaries', () => {
  it('scrubs the address and user agent past the personal-data window', () => {
    store.writeAuthFailures([failure({ receivedAt: at(-91) }), failure({ receivedAt: at(-1) })]);

    const outcome = store.applyRetention(NOW);

    expect(outcome.authFailures.scrubbed).toBe(1);
    const rows = store.failuresByOrigin({ since: at(-200), until: at(1) });
    expect(new Set(rows.map((row) => row.clientIp))).toEqual(new Set([null, '198.51.100.7']));
  });

  it('records that it scrubbed, so "no address because removed" stays distinguishable', () => {
    store.writeAuthFailures([failure({ receivedAt: at(-91) }), failure({ receivedAt: at(-91), clientIp: null, userAgent: null })]);
    store.applyRetention(NOW);
    store.close();

    const rows = readDirect(
      (db) =>
        db.prepare('SELECT pii_scrubbed_at FROM auth_failures ORDER BY id').all() as Array<{
          pii_scrubbed_at: string | null;
        }>
    );

    // Only the row that *had* something to clear is stamped. A row that never
    // carried an address is not "scrubbed", and marking it so would turn the
    // column into "this row is past the boundary" — which is the one thing it
    // must not mean, since its whole job is to keep "no address because we
    // deleted it" apart from "no address was recorded".
    expect(rows.map((row) => row.pii_scrubbed_at !== null)).toEqual([true, false]);
  });

  it('counts only the records it actually cleared', () => {
    // What the maintenance log prints. "Scrubbed 2 auth-failure records" should
    // mean two addresses were removed, not two rows were visited.
    store.writeAuthFailures([
      failure({ receivedAt: at(-91) }),
      failure({ receivedAt: at(-91), clientIp: null, userAgent: null }),
    ]);

    expect(store.applyRetention(NOW).authFailures.scrubbed).toBe(1);
  });

  it('deletes the de-identified record past the event window', () => {
    store.writeAuthFailures([failure({ receivedAt: at(-400) }), failure({ receivedAt: at(-1) })]);

    expect(store.applyRetention(NOW).authFailures.deleted).toBe(1);
    expect(store.stats(NOW).authFailures.records).toBe(1);
  });

  it('deletes unconditionally, where usage_events waits for the rollup watermark', () => {
    // The difference is the point rather than an oversight. That gate exists
    // because an un-aggregated event deleted at 13 months is a request
    // permanently missing from an invoice. Nothing aggregates this table and
    // nothing is invoiced from it, so there is no watermark to gate on — a gate
    // here would be a condition that is always true, which reads to the next
    // maintainer as protection that is not there.
    store.writeEvents([served({ receivedAt: at(-400) })]);
    store.writeAuthFailures([failure({ receivedAt: at(-400) })]);

    const outcome = store.applyRetention(NOW);

    expect(outcome.keptPendingRollup).toBe(1);
    expect(outcome.deleted).toBe(0);
    expect(outcome.authFailures.deleted).toBe(1);
  });

  it('is idempotent — a second pass scrubs and deletes nothing more', () => {
    store.writeAuthFailures([failure({ receivedAt: at(-91) })]);

    store.applyRetention(NOW);
    expect(store.applyRetention(NOW).authFailures).toEqual({ scrubbed: 0, deleted: 0 });
  });

  it('runs in the same transaction as the usage half, so a pass cannot half-commit', () => {
    // `usage:stats` reports one compliance figure across both tables. A pass
    // that committed one and failed the other would print a non-zero total with
    // no failed job to point at.
    store.writeEvents([served({ receivedAt: at(-91) })]);
    store.writeAuthFailures([failure({ receivedAt: at(-91) })]);

    const outcome = store.applyRetention(NOW);

    expect(outcome.scrubbed).toBe(1);
    expect(outcome.authFailures.scrubbed).toBe(1);
    expect(store.stats(NOW).unscrubbedPastPii).toBe(0);
  });
});

describe('the compliance figure counts this table', () => {
  it('adds an unscrubbed auth failure to unscrubbedPastPii', () => {
    // The check the issue calls out in terms: miss this and `usage:stats` keeps
    // printing COMPLIANT while a second table fills up with addresses, and the
    // check has silently stopped meaning what it says.
    store.writeAuthFailures([failure({ receivedAt: at(-91) })]);

    const stats = store.stats(NOW);

    expect(stats.unscrubbedPastPii).toBe(1);
    expect(stats.unscrubbedPastPiiByTable).toEqual({ usageEvents: 0, authFailures: 1 });
  });

  it('sums both tables, and names which one', () => {
    store.writeEvents([served({ receivedAt: at(-91) })]);
    store.writeAuthFailures([failure({ receivedAt: at(-91) }), failure({ receivedAt: at(-92) })]);

    const stats = store.stats(NOW);

    expect(stats.unscrubbedPastPii).toBe(3);
    expect(stats.unscrubbedPastPiiByTable).toEqual({ usageEvents: 1, authFailures: 2 });
  });

  it('does not count a row that never held an address as unscrubbed', () => {
    // Counting `pii_scrubbed_at IS NULL` instead would make a clean store read
    // as non-compliant, which is the fastest way to get a compliance check
    // ignored.
    store.writeAuthFailures([failure({ receivedAt: at(-91), clientIp: null, userAgent: null })]);

    expect(store.stats(NOW).unscrubbedPastPii).toBe(0);
  });

  it('counts refusals and the ones that proved a secret', () => {
    store.writeAuthFailures([
      failure(),
      failure({ secretVerified: true, accountId, keyId, errorCode: 'key_revoked' }),
    ]);

    expect(store.stats(NOW).authFailures).toMatchObject({
      records: 2,
      secretVerifiedRecords: 1,
      oldestAt: at(-1),
      newestAt: at(-1),
    });
  });
});

describe('a subject access request covers this table too', () => {
  it('exports the refusals that carry this account’s key', () => {
    // The same miss as leaving the table out of the retention job, one procedure
    // over: a SAR answered from `usage_events` alone while a second table held
    // the subject's addresses would be incomplete.
    store.writeAuthFailures([
      failure({ secretVerified: true, accountId, keyId, errorCode: 'key_revoked' }),
    ]);

    const exported = store.exportAccount(accountId);

    expect(exported.authFailures).toHaveLength(1);
    expect(exported.authFailures[0]).toMatchObject({
      error_code: 'key_revoked',
      client_ip: '198.51.100.7',
    });
  });

  it('does not attribute a refusal that named no key', () => {
    // Most rows in this table have no `account_id`: a prefix guess names nobody.
    // Attributing one would put a stranger's address in a subscriber's file.
    store.writeAuthFailures([failure(), failure({ clientIp: '203.0.113.5' })]);

    expect(store.exportAccount(accountId).authFailures).toEqual([]);
  });

  it('still hands out no key secret', () => {
    store.writeAuthFailures([failure({ secretVerified: true, accountId, keyId })]);

    expect(JSON.stringify(store.exportAccount(accountId))).not.toContain('secret_sha256');
  });
});

describe('S3 — the two groupings', () => {
  beforeEach(() => {
    store.writeAuthFailures([
      // One address walking the prefix space.
      ...Array.from({ length: 5 }, (_, i) =>
        failure({ clientIp: '203.0.113.5', presentedPrefix: `guess${i}` })
      ),
      // One prefix tried from several addresses.
      failure({ clientIp: '198.51.100.1', presentedPrefix: 'leaked01' }),
      failure({ clientIp: '198.51.100.2', presentedPrefix: 'leaked01' }),
      failure({ clientIp: '198.51.100.3', presentedPrefix: 'leaked01' }),
      // A caller who sent no key at all.
      failure({ clientIp: '192.0.2.99', presentedPrefix: null, errorCode: 'key_missing' }),
    ]);
  });

  it('puts the address with the most distinct prefixes first', () => {
    const rows = store.failuresByOrigin({ since: at(-7), until: at(1) });

    expect(rows[0]).toMatchObject({ clientIp: '203.0.113.5', failures: 5, distinctPrefixes: 5 });
  });

  it('puts the prefix tried from the most addresses first', () => {
    const rows = store.failuresByPrefix({ since: at(-7), until: at(1) });

    expect(rows[0]).toMatchObject({ presentedPrefix: 'leaked01', distinctOrigins: 3 });
  });

  it('excludes a prefixless refusal from the prefix grouping, but counts it by origin', () => {
    // Otherwise a scanner that never sends a key collapses into one NULL row at
    // the top of a table ordered by distinct origins, burying the finding.
    expect(
      store.failuresByPrefix({ since: at(-7), until: at(1) }).map((row) => row.presentedPrefix)
    ).not.toContain(null);
    expect(
      store.failuresByOrigin({ since: at(-7), until: at(1) }).map((row) => row.clientIp)
    ).toContain('192.0.2.99');
  });

  it('honours the window at both ends', () => {
    store.writeAuthFailures([failure({ receivedAt: at(-30), clientIp: '10.0.0.1' })]);

    const inside = store.failuresByOrigin({ since: at(-40), until: at(1) });
    const outside = store.failuresByOrigin({ since: at(-7), until: at(1) });

    expect(inside.map((row) => row.clientIp)).toContain('10.0.0.1');
    expect(outside.map((row) => row.clientIp)).not.toContain('10.0.0.1');
  });

  it('reports the distinct error codes so the shape is readable without a second query', () => {
    const rows = store.failuresByOrigin({ since: at(-7), until: at(1) });
    const scanner = rows.find((row) => row.clientIp === '192.0.2.99');

    expect(scanner?.errorCodes).toBe('key_missing');
  });
});

describe('S4 — refusals by a caller who held a real secret', () => {
  it('returns only the rows where the secret had already matched', () => {
    store.writeAuthFailures([
      failure(),
      failure({ secretVerified: true, accountId, keyId, errorCode: 'key_revoked' }),
    ]);

    const rows = store.secretHolderFailures({ since: at(-7), until: at(1) });

    expect(rows).toHaveLength(1);
    expect(rows[0].errorCode).toBe('key_revoked');
  });

  it('counts how often that key was served from the same address', () => {
    store.writeEvents([served({ clientIp: '192.0.2.10' }), served({ clientIp: '192.0.2.10' })]);
    store.writeAuthFailures([
      failure({ secretVerified: true, accountId, keyId, clientIp: '192.0.2.10' }),
      failure({ secretVerified: true, accountId, keyId, clientIp: '203.0.113.9' }),
    ]);

    const rows = store.secretHolderFailures({ since: at(-7), until: at(1) });
    const byIp = new Map(rows.map((row) => [row.clientIp, row]));

    expect(byIp.get('192.0.2.10')?.originServedRequests).toBe(2);
    // The finding: a real secret, from an address this key has never been served
    // from.
    expect(byIp.get('203.0.113.9')?.originServedRequests).toBe(0);
    expect(byIp.get('203.0.113.9')?.usageHistoryFrom).toBe(at(-30));
  });

  it('returns null rather than 0 when the refusal’s own address was scrubbed', () => {
    // **The three-valued-logic trap.** `u.client_ip = f.client_ip` with a NULL on
    // either side is not true, so a plain `COUNT(*)` returns 0 — byte-identical
    // to "never served from here", which is the most alarming verdict on the
    // page, manufactured out of a row we deleted ourselves.
    store.writeEvents([served({ clientIp: '192.0.2.10' })]);
    store.writeAuthFailures([
      failure({ secretVerified: true, accountId, keyId, clientIp: null, receivedAt: at(-1) }),
    ]);

    const [row] = store.secretHolderFailures({ since: at(-7), until: at(1) });

    expect(row.clientIp).toBeNull();
    expect(row.originServedRequests).toBeNull();
  });

  it('returns a null history horizon for a key with no addressed traffic at all', () => {
    store.writeAuthFailures([failure({ secretVerified: true, accountId, keyId })]);

    expect(store.secretHolderFailures({ since: at(-7), until: at(1) })[0].usageHistoryFrom).toBeNull();
  });

  it('groups per key, code and address so a repeat is a count rather than N rows', () => {
    store.writeAuthFailures([
      failure({ secretVerified: true, accountId, keyId, clientIp: '203.0.113.9', receivedAt: at(-3) }),
      failure({ secretVerified: true, accountId, keyId, clientIp: '203.0.113.9', receivedAt: at(-1) }),
    ]);

    const [row] = store.secretHolderFailures({ since: at(-7), until: at(1) });

    expect(row.failures).toBe(2);
    expect(row.firstAt).toBe(at(-3));
    expect(row.lastAt).toBe(at(-1));
  });
});

describe('S2 — key origins from usage_events', () => {
  it('returns every addressed origin, over all retained history rather than a window', () => {
    // Unwindowed on purpose: a windowed query cannot answer "has this key ever
    // been used from here before", because every origin looks new if you only
    // fetch the last week.
    store.writeEvents([
      served({ clientIp: '192.0.2.10', receivedAt: at(-80) }),
      served({ clientIp: '192.0.2.10', receivedAt: at(-1) }),
      served({ clientIp: '198.51.100.7', receivedAt: at(-2) }),
    ]);

    const rows = store.keyOrigins();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      clientIp: '192.0.2.10',
      requests: 2,
      firstAt: at(-80),
      lastAt: at(-1),
    });
  });

  it('excludes rows whose address was scrubbed, rather than grouping them under null', () => {
    store.writeEvents([served({ clientIp: null, receivedAt: at(-200) })]);

    expect(store.keyOrigins()).toEqual([]);
  });

  it('filters to one key when asked', () => {
    const keys = openApiKeyAdminStore({ API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv);
    const otherKeyId = keys.issueKey({
      accountId,
      label: 'other',
      environment: 'live',
      contactEmail: 'ops@acme.example',
    }).record.id;
    keys.close();

    store.writeEvents([served(), served({ keyId: otherKeyId, clientIp: '203.0.113.1' })]);

    expect(store.keyOrigins(keyId).map((row) => row.keyId)).toEqual([keyId]);
    expect(store.keyOrigins()).toHaveLength(2);
  });
});

describe('S5 — fingerprint breadth against a key’s own baseline', () => {
  it('splits the two windows at recent.since, without overlapping them', () => {
    // Overlapping would dilute a genuine widening with the very traffic being
    // asked about, which is the direction that hides the signal.
    store.writeEvents([
      // Baseline: one shape, many requests.
      ...Array.from({ length: 6 }, () => served({ receivedAt: at(-20) })),
      // Recent: three shapes.
      served({ receivedAt: at(-1), queryParams: 'country=DE', fingerprint: 'fp-de' }),
      served({ receivedAt: at(-1), queryParams: 'country=FR', fingerprint: 'fp-fr' }),
      served({ receivedAt: at(-1), queryParams: 'country=IT', fingerprint: 'fp-it' }),
    ]);

    const [row] = store.keyFingerprintBreadth(
      { since: at(-7), until: at(1) },
      at(-30)
    );

    expect(row).toMatchObject({
      keyId,
      recentFingerprints: 3,
      recentRequests: 3,
      baselineFingerprints: 1,
      baselineRequests: 6,
    });
  });

  it('drops a key with nothing in the recent window', () => {
    // A key that has gone quiet is a different question, and one this report has
    // no opinion about.
    store.writeEvents([served({ receivedAt: at(-20) })]);

    expect(store.keyFingerprintBreadth({ since: at(-7), until: at(1) }, at(-30))).toEqual([]);
  });

  it('reports zero baseline for a key whose first traffic is inside the recent window', () => {
    store.writeEvents([served({ receivedAt: at(-1) })]);

    const [row] = store.keyFingerprintBreadth({ since: at(-7), until: at(1) }, at(-30));

    expect(row.baselineRequests).toBe(0);
    expect(row.baselineFingerprints).toBe(0);
  });
});
