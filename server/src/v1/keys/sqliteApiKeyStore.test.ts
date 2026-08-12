import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openApiKeyAdminStore, openApiKeyDirectory, resolveApiKeysDbPath } from './sqliteApiKeyStore.js';
import { MAX_LIVE_KEYS_PER_ACCOUNT, resolveKeyState, type ApiKeyAdminStore } from './apiKeyStore.js';
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
    const { key, record } = store.issueKey({ accountId, label: 'prod ETL', environment: 'live' });
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
    store.issueKey({ accountId, label: 'x', environment: 'live' });
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
  });

  it('has no last_used_at, which would be a write on every request', () => {
    expect(bytesOnDisk()).not.toContain('last_used_at');
  });
});

describe('issuing', () => {
  it('returns a parseable key whose hash is what was stored', () => {
    const { key, record } = store.issueKey({ accountId, label: 'prod ETL', environment: 'live' });
    const parsed = parseApiKey(key);

    expect(parsed?.prefix).toBe(record.prefix);
    expect(record.secretSha256).toBe(hashKeySecret(parsed?.secret as string));
    expect(record.label).toBe('prod ETL');
    expect(record.expiresAt).toBeNull();
    expect(record.revokedAt).toBeNull();
  });

  it('finds the key it just issued, joined to its account', () => {
    const { key } = store.issueKey({ accountId, label: 'k', environment: 'live' });
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
      store.issueKey({ accountId, label: `k${i}`, environment: 'live' })
    );
    expect(new Set(issued.map((i) => i.key)).size).toBe(4);
    expect(new Set(issued.map((i) => i.record.prefix)).size).toBe(4);
    expect(new Set(issued.map((i) => i.record.id)).size).toBe(4);
  });

  it('refuses an unknown account rather than orphaning a key', () => {
    expect(() => store.issueKey({ accountId: 'acct_nope', label: 'k', environment: 'live' })).toThrow(
      /No such account/
    );
  });

  it(`caps an account at ${MAX_LIVE_KEYS_PER_ACCOUNT} live keys`, () => {
    for (let i = 0; i < MAX_LIVE_KEYS_PER_ACCOUNT; i += 1) {
      store.issueKey({ accountId, label: `k${i}`, environment: 'live' });
    }
    expect(() => store.issueKey({ accountId, label: 'one too many', environment: 'live' })).toThrow(
      /maximum is 5/
    );
  });

  it('counts only live keys against the cap', () => {
    const keys = Array.from({ length: MAX_LIVE_KEYS_PER_ACCOUNT }, (_, i) =>
      store.issueKey({ accountId, label: `k${i}`, environment: 'live' })
    );
    store.revokeKey(keys[0].record.id, 'making room');

    expect(() => store.issueKey({ accountId, label: 'replacement', environment: 'live' })).not.toThrow();
  });

  it('counts an expired key as free capacity too', () => {
    for (let i = 0; i < MAX_LIVE_KEYS_PER_ACCOUNT - 1; i += 1) {
      store.issueKey({ accountId, label: `k${i}`, environment: 'live' });
    }
    store.issueKey({
      accountId,
      label: 'already expired',
      environment: 'live',
      expiresAt: '2020-01-01T00:00:00.000Z',
    });

    expect(() => store.issueKey({ accountId, label: 'fits', environment: 'live' })).not.toThrow();
  });

  it('caps per account, not globally', () => {
    const other = store.createAccount({ name: 'Beta Energy', plan: 'explorer' }).id;
    for (let i = 0; i < MAX_LIVE_KEYS_PER_ACCOUNT; i += 1) {
      store.issueKey({ accountId, label: `k${i}`, environment: 'live' });
    }
    expect(() => store.issueKey({ accountId: other, label: 'first', environment: 'live' })).not.toThrow();
  });
});

describe('revoking', () => {
  it('is soft: the row survives so usage history keeps a real key to point at', () => {
    const { record } = store.issueKey({ accountId, label: 'k', environment: 'live' });
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
    const { key, record } = store.issueKey({ accountId, label: 'k', environment: 'live' });
    store.revokeKey(record.id, null);

    const found = store.findByPrefix(parseApiKey(key)?.prefix as string);
    expect(found).not.toBeNull();
    expect(resolveKeyState(found!.key, new Date())).toBe('revoked');
  });

  it('is idempotent and keeps the first timestamp', () => {
    const { record } = store.issueKey({ accountId, label: 'k', environment: 'live' });
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
    const original = store.issueKey({ accountId, label: 'grafana', environment: 'live' });
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
    const original = store.issueKey({ accountId, label: 'k', environment: 'live' });
    const { issued } = store.rotateKey({ keyId: original.record.id, overlapDays: 7 });
    const now = new Date();

    for (const key of [original.key, issued.key]) {
      const found = store.findByPrefix(parseApiKey(key)?.prefix as string);
      expect(resolveKeyState(found!.key, now)).toBe('active');
    }
  });

  it('revokes the old one immediately at zero overlap, which is what a leak wants', () => {
    const original = store.issueKey({ accountId, label: 'k', environment: 'live' });
    const { retired } = store.rotateKey({ keyId: original.record.id, overlapDays: 0 });

    expect(retired.revokedAt).not.toBeNull();
    expect(retired.revokedReason).toBe('rotated');
    expect(resolveKeyState(retired, new Date())).toBe('revoked');
  });

  it('can rotate a full account at zero overlap, because the outgoing key frees its slot', () => {
    const keys = Array.from({ length: MAX_LIVE_KEYS_PER_ACCOUNT }, (_, i) =>
      store.issueKey({ accountId, label: `k${i}`, environment: 'live' })
    );
    expect(() => store.rotateKey({ keyId: keys[0].record.id, overlapDays: 0 })).not.toThrow();
    expect(store.listKeys(accountId).filter((k) => resolveKeyState(k, new Date()) === 'active')).toHaveLength(
      MAX_LIVE_KEYS_PER_ACCOUNT
    );
  });

  it('refuses to rotate a full account with an overlap, and leaves it untouched', () => {
    const keys = Array.from({ length: MAX_LIVE_KEYS_PER_ACCOUNT }, (_, i) =>
      store.issueKey({ accountId, label: `k${i}`, environment: 'live' })
    );
    expect(() => store.rotateKey({ keyId: keys[0].record.id, overlapDays: 7 })).toThrow(/maximum is 5/);

    // The transaction rolled back: the outgoing key did not quietly acquire a
    // deadline on the way to a failure. A half-applied rotation would give the
    // customer an expiry nobody told them about.
    expect(store.getKey(keys[0].record.id)?.expiresAt).toBeNull();
    expect(store.listKeys(accountId)).toHaveLength(MAX_LIVE_KEYS_PER_ACCOUNT);
  });

  it('carries the environment over and accepts a new label', () => {
    const original = store.issueKey({ accountId, label: 'old', environment: 'test' });
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
    const { record } = store.issueKey({ accountId, label: 'k', environment: 'live' });

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
    const { key } = store.issueKey({ accountId, label: 'k', environment: 'live' });
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
