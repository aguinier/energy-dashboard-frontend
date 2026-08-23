import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isRetryableCollision,
  openApiKeyAdminStore,
  openApiKeyDirectory,
  resolveApiKeysDbPath,
} from './sqliteApiKeyStore.js';
import { MAX_LIVE_KEYS_PER_ACCOUNT, resolveKeyState, type ApiKeyAdminStore } from './apiKeyStore.js';
import { collectAccountContacts } from './accountContacts.js';
import { hashKeySecret, parseApiKey } from './keyFormat.js';

/**
 * The real store against a real SQLite file.
 *
 * A fake cannot say anything true about SQLite, and the three claims worth the
 * most here are claims about the file: that no raw key is ever in it, that it
 * is never the energy database, and that the serving handle cannot write to it.
 * Each of those is tested by inspecting the file rather than by asking the
 * store to describe itself.
 *
 * Temp directories rather than `:memory:` because WAL mode, `fileMustExist`
 * and the path guard are all properties of a file on disk — an in-memory
 * database would make every one of those assertions vacuous.
 */

const tmpRoots: string[] = [];

/**
 * The ToS §9.3 account contact every issued key needs (ABL-528).
 *
 * A constant rather than a literal per call, so the cases that are *about* the
 * contact stand out from the ~30 that merely have to supply one.
 */
const TEST_CONTACT = 'ops@acme.example';

function tmpDbPath(name = 'api_keys.db'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'able-keys-'));
  tmpRoots.push(root);
  return path.join(root, name);
}

afterAll(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

let dbPath: string;
let store: ApiKeyAdminStore;
let accountId: string;

beforeEach(() => {
  dbPath = tmpDbPath();
  store = openApiKeyAdminStore({ API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv);
  accountId = store.createAccount({ name: 'Acme Energy', plan: 'developer' }).id;
});

afterEach(() => {
  closeStore();
});

function closeStore(): void {
  try {
    store.close();
  } catch {
    // Already closed by the test itself. `close()` is the teardown for every
    // case, so it has to tolerate having happened already.
  }
}

/**
 * Everything this store has put on disk, as one searchable string.
 *
 * Closes first, and reads the `-wal` and `-shm` sidecars as well as the main
 * file. In WAL mode a recent write lives in `-wal` until a checkpoint, so
 * reading only `api_keys.db` would make every `not.toContain` assertion below
 * pass against a file the data had simply not reached yet — a test that proves
 * nothing while looking like it proves the most important thing here.
 */
function bytesOnDisk(): string {
  closeStore();
  return ['', '-wal', '-shm']
    .map((suffix) =>
      fs.existsSync(dbPath + suffix) ? fs.readFileSync(dbPath + suffix).toString('binary') : ''
    )
    .join('\n');
}

describe('resolveApiKeysDbPath', () => {
  it('requires the path — a credentials file must not land somewhere nobody chose', () => {
    expect(() => resolveApiKeysDbPath({} as NodeJS.ProcessEnv)).toThrow(/API_KEYS_DB_PATH is not set/);
    expect(() => resolveApiKeysDbPath({ API_KEYS_DB_PATH: '   ' } as NodeJS.ProcessEnv)).toThrow(
      /not set/
    );
  });

  it('refuses the configured energy database', () => {
    // The single most consequential guard in this file. Pointing the key store
    // at the 376 GiB database owned by energy-data-gathering would add a write
    // path contending with ingest, in a schema that is not ours.
    expect(() =>
      resolveApiKeysDbPath({
        API_KEYS_DB_PATH: 'C:/Code/able/data/energy_dashboard.db',
        ENERGY_DB_PATH: 'C:/Code/able/data/energy_dashboard.db',
      } as NodeJS.ProcessEnv)
    ).toThrow(/shared energy database/);
  });

  it("refuses config/database.ts's literal default even when ENERGY_DB_PATH is unset", () => {
    // The guard has to hold in a process where ENERGY_DB_PATH is absent —
    // which is exactly the process that would fall back to that literal.
    expect(() =>
      resolveApiKeysDbPath({ API_KEYS_DB_PATH: '/data/energy_dashboard.db' } as NodeJS.ProcessEnv)
    ).toThrow(/shared energy database/);
  });

  it('sees through a relative path or an extra separator', () => {
    expect(() =>
      resolveApiKeysDbPath({
        API_KEYS_DB_PATH: '/data/./nested/../energy_dashboard.db',
      } as NodeJS.ProcessEnv)
    ).toThrow(/shared energy database/);
  });

  it('allows a different file in the same directory', () => {
    // `.env.example` already puts ops snapshots beside the database, so the
    // guard is deliberately about the file, not the directory.
    const resolved = resolveApiKeysDbPath({
      API_KEYS_DB_PATH: '/data/api_keys.db',
      ENERGY_DB_PATH: '/data/energy_dashboard.db',
    } as NodeJS.ProcessEnv);
    expect(resolved).toContain('api_keys.db');
  });

  it.runIf(process.platform === 'win32')('compares case-insensitively on Windows', () => {
    expect(() =>
      resolveApiKeysDbPath({
        API_KEYS_DB_PATH: 'C:/CODE/ABLE/DATA/ENERGY_DASHBOARD.DB',
        ENERGY_DB_PATH: 'C:/Code/able/data/energy_dashboard.db',
      } as NodeJS.ProcessEnv)
    ).toThrow(/shared energy database/);
  });
});

describe('what reaches the disk', () => {
  it('never writes the raw key into the database file', () => {
    // The claim ABL-293 §2b calls a day-one decision, asserted against the
    // bytes rather than against the schema: once a key exists in clear it
    // exists in every backup and every debug dump, and no later migration can
    // recover those copies.
    const { key, record } = store.issueKey({ accountId, label: 'prod ETL', contactEmail: TEST_CONTACT, environment: 'live' });
    const secret = parseApiKey(key)?.secret as string;
    const bytes = bytesOnDisk();

    expect(bytes).not.toContain(key);
    expect(bytes).not.toContain(secret);
    // The non-secret halves *are* there — otherwise this test would also pass
    // against a file the data had never reached.
    expect(bytes).toContain(record.prefix);
    expect(bytes).toContain(hashKeySecret(secret));
  });

  it('has no column that could hold a key', () => {
    // Read the schema back off the disk, so this describes what was created
    // rather than restating the SQL literal. SQLite keeps the `CREATE TABLE`
    // text verbatim in `sqlite_master`, comments included — which is why the
    // schema comment in `sqliteApiKeyStore.ts` does not name these either. It
    // caught exactly that on the first run.
    store.issueKey({ accountId, label: 'x', contactEmail: TEST_CONTACT, environment: 'live' });
    const bytes = bytesOnDisk();

    for (const forbidden of ['raw_key', 'encrypted_key', 'key_hint', 'last_four', 'secret_plain']) {
      expect(bytes).not.toContain(forbidden);
    }
    expect(bytes).toContain('secret_sha256');
  });

  it('creates none of ABL-301\u2019s metering tables', () => {
    // Scope fence. `usage_events`/`usage_rollup` belong in this same file per
    // ABL-293 §2c, but they are that issue's to design — a table nobody writes
    // is a table nobody maintains.
    const bytes = bytesOnDisk();
    expect(bytes).not.toContain('usage_events');
    expect(bytes).not.toContain('usage_rollup');
    expect(bytes).not.toContain('usage_month_close');
  });

  it('has no last_used_at, which would be a write on every request', () => {
    expect(bytesOnDisk()).not.toContain('last_used_at');
  });
});

describe('issuing', () => {
  it('returns a parseable key whose hash is what was stored', () => {
    const { key, record } = store.issueKey({ accountId, label: 'prod ETL', contactEmail: TEST_CONTACT, environment: 'live' });
    const parsed = parseApiKey(key);

    expect(parsed?.prefix).toBe(record.prefix);
    expect(record.secretSha256).toBe(hashKeySecret(parsed?.secret as string));
    expect(record.label).toBe('prod ETL');
    expect(record.expiresAt).toBeNull();
    expect(record.revokedAt).toBeNull();
  });

  it('finds the key it just issued, joined to its account', () => {
    const { key } = store.issueKey({ accountId, label: 'k', contactEmail: TEST_CONTACT, environment: 'live' });
    const found = store.findByPrefix(parseApiKey(key)?.prefix as string);

    expect(found?.account.id).toBe(accountId);
    expect(found?.account.name).toBe('Acme Energy');
    expect(found?.account.plan).toBe('developer');
    expect(found?.key.environment).toBe('live');
  });

  it('returns null for a prefix nobody holds', () => {
    expect(store.findByPrefix('zzzzzzzz')).toBeNull();
  });

  it('mints distinct keys and prefixes every time', () => {
    const issued = Array.from({ length: 4 }, (_, i) =>
      store.issueKey({ accountId, label: `k${i}`, contactEmail: TEST_CONTACT, environment: 'live' })
    );
    expect(new Set(issued.map((i) => i.key)).size).toBe(4);
    expect(new Set(issued.map((i) => i.record.prefix)).size).toBe(4);
    expect(new Set(issued.map((i) => i.record.id)).size).toBe(4);
  });

  it('refuses an unknown account rather than orphaning a key', () => {
    expect(() => store.issueKey({ accountId: 'acct_nope', label: 'k', contactEmail: TEST_CONTACT, environment: 'live' })).toThrow(
      /No such account/
    );
  });

  it(`caps an account at ${MAX_LIVE_KEYS_PER_ACCOUNT} live keys`, () => {
    for (let i = 0; i < MAX_LIVE_KEYS_PER_ACCOUNT; i += 1) {
      store.issueKey({ accountId, label: `k${i}`, contactEmail: TEST_CONTACT, environment: 'live' });
    }
    expect(() => store.issueKey({ accountId, label: 'one too many', contactEmail: TEST_CONTACT, environment: 'live' })).toThrow(
      /maximum is 5/
    );
  });

  it('counts only live keys against the cap', () => {
    const keys = Array.from({ length: MAX_LIVE_KEYS_PER_ACCOUNT }, (_, i) =>
      store.issueKey({ accountId, label: `k${i}`, contactEmail: TEST_CONTACT, environment: 'live' })
    );
    store.revokeKey(keys[0].record.id, 'making room');

    expect(() => store.issueKey({ accountId, label: 'replacement', contactEmail: TEST_CONTACT, environment: 'live' })).not.toThrow();
  });

  it('counts an expired key as free capacity too', () => {
    for (let i = 0; i < MAX_LIVE_KEYS_PER_ACCOUNT - 1; i += 1) {
      store.issueKey({ accountId, label: `k${i}`, contactEmail: TEST_CONTACT, environment: 'live' });
    }
    store.issueKey({
      accountId,
      label: 'already expired',
      contactEmail: TEST_CONTACT,
      environment: 'live',
      expiresAt: '2020-01-01T00:00:00.000Z',
    });

    expect(() => store.issueKey({ accountId, label: 'fits', contactEmail: TEST_CONTACT, environment: 'live' })).not.toThrow();
  });

  it('caps per account, not globally', () => {
    const other = store.createAccount({ name: 'Beta Energy', plan: 'explorer' }).id;
    for (let i = 0; i < MAX_LIVE_KEYS_PER_ACCOUNT; i += 1) {
      store.issueKey({ accountId, label: `k${i}`, contactEmail: TEST_CONTACT, environment: 'live' });
    }
    expect(() => store.issueKey({ accountId: other, label: 'first', contactEmail: TEST_CONTACT, environment: 'live' })).not.toThrow();
  });
});

describe('revoking', () => {
  it('is soft: the row survives so usage history keeps a real key to point at', () => {
    const { record } = store.issueKey({ accountId, label: 'k', contactEmail: TEST_CONTACT, environment: 'live' });
    const revoked = store.revokeKey(record.id, 'leaked in a support ticket');

    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.revokedReason).toBe('leaked in a support ticket');
    expect(store.getKey(record.id)).not.toBeNull();
    expect(store.listKeys(accountId).map((k) => k.id)).toContain(record.id);
  });

  it('still resolves through findByPrefix, so auth can answer key_revoked', () => {
    // A revoked key that vanished from lookup would answer `key_invalid`, and
    // the customer who revoked it would have no way to tell "I did that" from
    // "this was never a key".
    const { key, record } = store.issueKey({ accountId, label: 'k', contactEmail: TEST_CONTACT, environment: 'live' });
    store.revokeKey(record.id, null);

    const found = store.findByPrefix(parseApiKey(key)?.prefix as string);
    expect(found).not.toBeNull();
    expect(resolveKeyState(found!.key, new Date())).toBe('revoked');
  });

  it('is idempotent and keeps the first timestamp', () => {
    const { record } = store.issueKey({ accountId, label: 'k', contactEmail: TEST_CONTACT, environment: 'live' });
    const first = store.revokeKey(record.id, 'first reason');
    const second = store.revokeKey(record.id, 'second reason');

    expect(second.revokedAt).toBe(first.revokedAt);
    expect(second.revokedReason).toBe('first reason');
  });

  it('refuses an unknown key id', () => {
    expect(() => store.revokeKey('key_nope', null)).toThrow(/No such key/);
  });
});

describe('rotating', () => {
  it('issues a new key and gives the old one a deadline', () => {
    const original = store.issueKey({ accountId, label: 'grafana', contactEmail: TEST_CONTACT, environment: 'live' });
    const { issued, retired } = store.rotateKey({ keyId: original.record.id, overlapDays: 7 });

    expect(issued.key).not.toBe(original.key);
    expect(issued.record.accountId).toBe(accountId);
    // The label carries over: losing "grafana" on every rotation is how a key
    // list becomes five rows called "new key".
    expect(issued.record.label).toBe('grafana');
    expect(retired.expiresAt).not.toBeNull();
    expect(resolveKeyState(retired, new Date())).toBe('active');
    expect(resolveKeyState(retired, new Date(Date.now() + 8 * 86_400_000))).toBe('expired');
  });

  it('keeps both keys working during the overlap — that is the whole point', () => {
    const original = store.issueKey({ accountId, label: 'k', contactEmail: TEST_CONTACT, environment: 'live' });
    const { issued } = store.rotateKey({ keyId: original.record.id, overlapDays: 7 });
    const now = new Date();

    for (const key of [original.key, issued.key]) {
      const found = store.findByPrefix(parseApiKey(key)?.prefix as string);
      expect(resolveKeyState(found!.key, now)).toBe('active');
    }
  });

  it('revokes the old one immediately at zero overlap, which is what a leak wants', () => {
    const original = store.issueKey({ accountId, label: 'k', contactEmail: TEST_CONTACT, environment: 'live' });
    const { retired } = store.rotateKey({ keyId: original.record.id, overlapDays: 0 });

    expect(retired.revokedAt).not.toBeNull();
    expect(retired.revokedReason).toBe('rotated');
    expect(resolveKeyState(retired, new Date())).toBe('revoked');
  });

  it('can rotate a full account at zero overlap, because the outgoing key frees its slot', () => {
    const keys = Array.from({ length: MAX_LIVE_KEYS_PER_ACCOUNT }, (_, i) =>
      store.issueKey({ accountId, label: `k${i}`, contactEmail: TEST_CONTACT, environment: 'live' })
    );
    expect(() => store.rotateKey({ keyId: keys[0].record.id, overlapDays: 0 })).not.toThrow();
    expect(store.listKeys(accountId).filter((k) => resolveKeyState(k, new Date()) === 'active')).toHaveLength(
      MAX_LIVE_KEYS_PER_ACCOUNT
    );
  });

  it('refuses to rotate a full account with an overlap, and leaves it untouched', () => {
    const keys = Array.from({ length: MAX_LIVE_KEYS_PER_ACCOUNT }, (_, i) =>
      store.issueKey({ accountId, label: `k${i}`, contactEmail: TEST_CONTACT, environment: 'live' })
    );
    expect(() => store.rotateKey({ keyId: keys[0].record.id, overlapDays: 7 })).toThrow(/maximum is 5/);

    // The transaction rolled back: the outgoing key did not quietly acquire a
    // deadline on the way to a failure. A half-applied rotation would give the
    // customer an expiry nobody told them about.
    expect(store.getKey(keys[0].record.id)?.expiresAt).toBeNull();
    expect(store.listKeys(accountId)).toHaveLength(MAX_LIVE_KEYS_PER_ACCOUNT);
  });

  it('carries the environment over and accepts a new label', () => {
    const original = store.issueKey({ accountId, label: 'old', contactEmail: TEST_CONTACT, environment: 'test' });
    const { issued } = store.rotateKey({
      keyId: original.record.id,
      label: 'renamed',
      overlapDays: 1,
    });

    expect(issued.record.environment).toBe('test');
    expect(issued.key.startsWith('able_test_')).toBe(true);
    expect(issued.record.label).toBe('renamed');
  });
});

describe('accounts', () => {
  it('disables and re-enables without touching the keys', () => {
    const { record } = store.issueKey({ accountId, label: 'k', contactEmail: TEST_CONTACT, environment: 'live' });

    const disabled = store.setAccountDisabled(accountId, true);
    expect(disabled.disabledAt).not.toBeNull();
    // The lever for non-payment: service stops, credentials survive, and
    // restoring is one column rather than a reissue for every deployed key.
    expect(store.getKey(record.id)?.revokedAt).toBeNull();

    expect(store.setAccountDisabled(accountId, false).disabledAt).toBeNull();
  });

  it('lists accounts and refuses an unknown one', () => {
    store.createAccount({ name: 'Beta', plan: 'enterprise' });
    expect(store.listAccounts().map((a) => a.name).sort()).toEqual(['Acme Energy', 'Beta']);
    expect(() => store.setAccountDisabled('acct_nope', true)).toThrow(/No such account/);
  });
});

describe('the serving handle', () => {
  it('reads what the CLI wrote', () => {
    const { key } = store.issueKey({ accountId, label: 'k', contactEmail: TEST_CONTACT, environment: 'live' });
    store.close();

    const directory = openApiKeyDirectory({ API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv);
    try {
      const found = directory.findByPrefix(parseApiKey(key)?.prefix as string);
      expect(found?.account.name).toBe('Acme Energy');
    } finally {
      directory.close();
    }
  });

  it('offers no way to issue, rotate or revoke', () => {
    // The runtime half of the type-level split: `ApiKeyDirectory` has two
    // members, and the object really does have only those two.
    store.close();
    const directory = openApiKeyDirectory({ API_KEYS_DB_PATH: dbPath } as NodeJS.ProcessEnv);
    try {
      expect(Object.keys(directory).sort()).toEqual(['close', 'findByPrefix']);
      for (const method of ['issueKey', 'rotateKey', 'revokeKey', 'createAccount']) {
        expect(directory).not.toHaveProperty(method);
      }
    } finally {
      directory.close();
    }
  });

  it('refuses to start on a missing file, and does not create one', () => {
    // An empty store silently rejects every customer's key with `key_invalid`,
    // which is the most confusing way this could fail. Better to refuse to
    // start and name the command that seeds one.
    const missing = tmpDbPath('nope.db');
    expect(() => openApiKeyDirectory({ API_KEYS_DB_PATH: missing } as NodeJS.ProcessEnv)).toThrow(
      /Cannot open the \/v1 key store/
    );
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('names the seeding command in the failure, so the message is actionable', () => {
    const missing = tmpDbPath('nope.db');
    expect(() => openApiKeyDirectory({ API_KEYS_DB_PATH: missing } as NodeJS.ProcessEnv)).toThrow(
      /npm run keys/
    );
  });

  it('refuses a file that is not a key store', () => {
    const wrong = tmpDbPath('not-a-store.db');
    fs.writeFileSync(wrong, '');
    expect(() => openApiKeyDirectory({ API_KEYS_DB_PATH: wrong } as NodeJS.ProcessEnv)).toThrow(
      /no api_keys table/
    );
  });

  it('inherits the energy-database guard', () => {
    expect(() =>
      openApiKeyDirectory({ API_KEYS_DB_PATH: '/data/energy_dashboard.db' } as NodeJS.ProcessEnv)
    ).toThrow(/shared energy database/);
  });
});

describe('isRetryableCollision — which insert failures are worth another draw', () => {
  /**
   * The two codes, taken from SQLite rather than assumed.
   *
   * This is the empirical half of the ABL-300 review's carry-over. The obvious
   * `code === 'SQLITE_CONSTRAINT_UNIQUE'` is **narrower** than the message match
   * it replaced, because a `PRIMARY KEY` collision reports a different code —
   * and `insertMintedKey` draws a fresh `id` as well as a fresh prefix, so both
   * are retryable and only one of them is `_UNIQUE`. Getting that wrong turns a
   * recoverable collision into a customer-visible 500.
   */
  function errorCodeFor(sql: string): string {
    const db = new Database(tmpDbPath('codes.db'));
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, prefix TEXT UNIQUE)');
    db.prepare("INSERT INTO t (id, prefix) VALUES ('a', 'p')").run();
    try {
      db.prepare(sql).run();
      throw new Error('expected a constraint violation');
    } catch (err) {
      return (err as { code?: string }).code ?? '(no code)';
    } finally {
      db.close();
    }
  }

  it('a PRIMARY KEY collision reports SQLITE_CONSTRAINT_PRIMARYKEY', () => {
    expect(errorCodeFor("INSERT INTO t (id, prefix) VALUES ('a', 'q')")).toBe(
      'SQLITE_CONSTRAINT_PRIMARYKEY'
    );
  });

  it('a UNIQUE collision reports SQLITE_CONSTRAINT_UNIQUE', () => {
    expect(errorCodeFor("INSERT INTO t (id, prefix) VALUES ('b', 'p')")).toBe(
      'SQLITE_CONSTRAINT_UNIQUE'
    );
  });

  it('retries on both, so an id collision is not a 500', () => {
    expect(isRetryableCollision({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' })).toBe(true);
    expect(isRetryableCollision({ code: 'SQLITE_CONSTRAINT_UNIQUE' })).toBe(true);
  });

  it('does not swallow anything else', () => {
    // Matching on the code rather than on the message is defence against a
    // library wording change — but a code match that was too *broad* would be
    // worse than the message match it replaced, because it would retry five
    // times against a failure that was never going to succeed and then report
    // the wrong cause.
    expect(isRetryableCollision({ code: 'SQLITE_CONSTRAINT_NOTNULL' })).toBe(false);
    expect(isRetryableCollision({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })).toBe(false);
    expect(isRetryableCollision({ code: 'SQLITE_READONLY' })).toBe(false);
    expect(isRetryableCollision(new Error('UNIQUE constraint failed: t.prefix'))).toBe(false);
    expect(isRetryableCollision(null)).toBe(false);
    expect(isRetryableCollision(undefined)).toBe(false);
  });

  it('still issues a key, which is the behaviour all of the above protects', () => {
    // The retry loop itself is not directly reachable without forcing a
    // collision, so this is the end-to-end check that the refactor did not break
    // the ordinary path.
    expect(store.issueKey({ accountId, label: 'after the hardening', contactEmail: TEST_CONTACT, environment: 'live' }).key)
      .toMatch(/^able_live_/);
  });
});

/**
 * The account contact ToS §9.3 promises to notify (ABL-528).
 *
 * Two claims here and a third in the block below, which is the one that needed
 * a real file to make: that a store written *before* this column exists keeps
 * working, migrates when the CLI next opens it, and reports its old rows as
 * unreachable rather than as nobody.
 */
describe('the account contact', () => {
  it('stores the address on the key and hands it back', () => {
    const { record } = store.issueKey({
      accountId,
      label: 'prod ETL',
      contactEmail: '  Ops@Acme.example ',
      environment: 'live',
    });

    // Trimmed, and otherwise byte-for-byte what the operator gave: the local
    // part of an address is case-sensitive by specification.
    expect(record.contactEmail).toBe('Ops@Acme.example');
    expect(store.getKey(record.id)?.contactEmail).toBe('Ops@Acme.example');
  });

  it('refuses to mint without one, whatever route reaches the store', () => {
    // The type already makes omission a compile error. This is the runtime
    // half, for the value that arrives from a flag, a JSON payload or a cast —
    // the paths a type cannot see. The casts below are how the test reaches
    // them, and are the only reason this case can exist.
    for (const contactEmail of ['', '   ', 'acct_7f3a9c21']) {
      expect(() => store.issueKey({ accountId, label: 'k', contactEmail, environment: 'live' })).toThrow(
        /§9\.3/
      );
    }
    expect(() =>
      store.issueKey({ accountId, label: 'k', environment: 'live' } as unknown as Parameters<
        typeof store.issueKey
      >[0])
    ).toThrow(/§9\.3/);

    // And nothing was written on the way to refusing.
    expect(store.listKeys(accountId)).toEqual([]);
  });

  it('carries the contact through a rotation, because it is the same subscriber', () => {
    const { record } = store.issueKey({
      accountId,
      label: 'grafana',
      contactEmail: 'ops@acme.example',
      environment: 'live',
    });

    const { issued } = store.rotateKey({ keyId: record.id, overlapDays: 7 });
    expect(issued.record.contactEmail).toBe('ops@acme.example');
  });

  it('lets a rotation change the contact', () => {
    const { record } = store.issueKey({
      accountId,
      label: 'grafana',
      contactEmail: 'ops@acme.example',
      environment: 'live',
    });

    const { issued } = store.rotateKey({
      keyId: record.id,
      contactEmail: 'newops@acme.example',
      overlapDays: 0,
    });
    expect(issued.record.contactEmail).toBe('newops@acme.example');
  });

  it('guards rotation as well as issuance', () => {
    // `issueKey` and `rotateKey` are two doors into one room. A guard on each
    // door is a guard somebody forgets to add to the third, so both funnel
    // through `insertMintedKey` and the refusal lives there.
    const { record } = store.issueKey({
      accountId,
      label: 'k',
      contactEmail: 'ops@acme.example',
      environment: 'live',
    });
    expect(() =>
      store.rotateKey({ keyId: record.id, contactEmail: 'not-an-address', overlapDays: 7 })
    ).toThrow(/does not look like an email address/);
  });
});

describe('a store written before the contact column existed', () => {
  /**
   * Build the pre-ABL-528 file by hand.
   *
   * The DDL is the `api_keys` schema as it stood at ABL-300, copied verbatim
   * with the column simply absent — which is the only way to produce this
   * state, because every write path through the current store refuses to leave
   * it empty. Migrating this file is the behaviour under test, so the fixture
   * has to be the genuine old shape rather than a current file with a column
   * dropped out of it.
   */
  function legacyStore(): { path: string; keyId: string; prefix: string } {
    const legacyPath = tmpDbPath('legacy.db');
    const db = new Database(legacyPath);
    db.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL,
        created_at TEXT NOT NULL, disabled_at TEXT
      );
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        key_env TEXT NOT NULL,
        key_prefix TEXT NOT NULL UNIQUE,
        secret_sha256 TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT, revoked_at TEXT, revoked_reason TEXT
      );
      INSERT INTO accounts VALUES
        ('acct_legacy', 'Legacy Energy', 'developer', '2026-01-01T00:00:00.000Z', NULL);
      INSERT INTO api_keys VALUES
        ('key_legacy', 'acct_legacy', 'live', 'legacy00', 'deadbeef', 'prod ETL',
         '2026-01-01T00:00:00.000Z', NULL, NULL, NULL);
    `);
    db.close();
    return { path: legacyPath, keyId: 'key_legacy', prefix: 'legacy00' };
  }

  const AT = new Date('2026-08-22T12:00:00.000Z');

  it('migrates the column in, without disturbing the row', () => {
    const legacy = legacyStore();
    const migrated = openApiKeyAdminStore({ API_KEYS_DB_PATH: legacy.path } as NodeJS.ProcessEnv);
    try {
      // `CREATE TABLE IF NOT EXISTS` is idempotent and therefore silently does
      // nothing to a table that already exists. This is the first migration
      // this file has needed, and the assertion that it actually ran.
      const key = migrated.getKey(legacy.keyId);
      expect(key?.label).toBe('prod ETL');
      expect(key?.contactEmail).toBeNull();
    } finally {
      migrated.close();
    }
  });

  it('leaves the row null rather than backfilling a placeholder', () => {
    // The stated disposition. A placeholder is an address a notice would be
    // "sent" to and silently lost — one we cannot deliver to wearing the
    // costume of one we can. An absence is recoverable because it is visible;
    // a fabricated address is not, because nothing afterwards can tell it from
    // a real one.
    const legacy = legacyStore();
    const migrated = openApiKeyAdminStore({ API_KEYS_DB_PATH: legacy.path } as NodeJS.ProcessEnv);
    try {
      const set = collectAccountContacts(migrated.listKeys(), AT);

      expect(set.recipients).toEqual([]);
      expect(set.liveKeys).toBe(1);
      expect(set.unreachable).toEqual([
        {
          keyId: 'key_legacy',
          accountId: 'acct_legacy',
          label: 'prod ETL',
          reason: 'no_contact_recorded',
        },
      ]);
    } finally {
      migrated.close();
    }
  });

  it('gives the old key an address by rotating it, which is the migration path', () => {
    const legacy = legacyStore();
    const migrated = openApiKeyAdminStore({ API_KEYS_DB_PATH: legacy.path } as NodeJS.ProcessEnv);
    try {
      // Rotating without one is refused: the replacement is a fresh key, and
      // minting a contactless key is refused however it is reached.
      expect(() => migrated.rotateKey({ keyId: legacy.keyId, overlapDays: 7 })).toThrow(/§9\.3/);
      // And the refusal landed before the retiring key was touched, so a usage
      // mistake never leaves a credential half-rotated.
      expect(migrated.getKey(legacy.keyId)?.expiresAt).toBeNull();

      const { issued } = migrated.rotateKey({
        keyId: legacy.keyId,
        contactEmail: 'ops@legacy.example',
        overlapDays: 7,
      });
      expect(issued.record.contactEmail).toBe('ops@legacy.example');

      const set = collectAccountContacts(migrated.listKeys(), AT);
      expect(set.recipients.map((r) => r.email)).toEqual(['ops@legacy.example']);
      // The old key is live through its overlap and still unreachable, which is
      // correct rather than untidy — and is why the report counts keys and not
      // accounts.
      expect(set.unreachable.map((u) => u.keyId)).toEqual([legacy.keyId]);
    } finally {
      migrated.close();
    }
  });

  it('still authenticates through a readonly handle, un-migrated', () => {
    // The serving handle is opened readonly and *cannot* run the migration, so
    // naming a column that is not there would fail at `prepare` — a server
    // pointed at a pre-ABL-528 file refusing every customer over a notice
    // address that no authentication path reads. It degrades to `null` instead.
    const legacy = legacyStore();
    const directory = openApiKeyDirectory({ API_KEYS_DB_PATH: legacy.path } as NodeJS.ProcessEnv);
    try {
      const found = directory.findByPrefix(legacy.prefix);
      expect(found?.account.name).toBe('Legacy Energy');
      expect(found?.key.contactEmail).toBeNull();
    } finally {
      directory.close();
    }
  });
});
