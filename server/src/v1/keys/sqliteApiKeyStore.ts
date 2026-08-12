import Database, { type Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';
import {
  MAX_LIVE_KEYS_PER_ACCOUNT,
  isKeyLive,
  type AccountPlan,
  type AccountRecord,
  type ApiKeyAdminStore,
  type ApiKeyDirectory,
  type ApiKeyLookup,
  type ApiKeyRecord,
  type IssueKeyInput,
  type IssuedKey,
} from './apiKeyStore.js';
import { mintApiKey, newRecordId, type KeyEnvironment } from './keyFormat.js';

/**
 * Where key records live: **a second SQLite file, not the shared energy
 * database.**
 *
 * This was the one scoping decision ABL-300 left to this issue to make and
 * state, so the reasoning is here rather than only in the PR.
 *
 * The energy database is 376 GiB, is owned by the sibling `energy-data-
 * gathering` module, and is opened **readonly** by this server
 * (`config/database.ts:12`) precisely because writing to it is not ours to do.
 * Putting accounts and keys in it would mean adding a write path to a file
 * whose writer is somebody else's ingest process — new tables in a schema we do
 * not own, write transactions contending with bulk ingest on the same file
 * lock, and a billing record whose lifetime is now coupled to their migration
 * schedule. It would also undo ABL-304's cleanest property: the public process
 * currently holds *no* write handle on energy data, and the graph test proves
 * it.
 *
 * A separate file at `API_KEYS_DB_PATH` costs nothing and buys all of that
 * back. It is small (a few thousand rows at any plausible customer count), its
 * write volume is a handful of rows per week, and it is ours to migrate. The
 * two databases share no lock, no backup schedule and no owner.
 *
 * Creating tables in *this* file is not a violation of the "never touch schema
 * or migrations" boundary: that boundary is about the energy database and the
 * ingest pipeline that owns it. This file is new, is written by nothing else,
 * and nothing reads it but the public API.
 *
 * ABL-301 adds `usage_events` and `usage_rollup` to this same file, per
 * ABL-293 §2c. They are deliberately **not** created here — a table nobody
 * writes is a table nobody maintains, and metering is that issue's to design.
 *
 * ## Readonly for serving, read-write for the CLI
 *
 * {@link openApiKeyDirectory} opens the file readonly and returns only
 * `findByPrefix`; {@link openApiKeyAdminStore} opens it read-write and is used
 * by `keysCli.ts` alone. So the process that answers requests cannot alter a
 * key record even if a future edit tried to — the handle it holds will not let
 * it. That distinction survives ABL-301 opening its own write handle for the
 * usage tables, because that handle is a different one.
 */

/** Paths that must never be the key store, whatever `API_KEYS_DB_PATH` says. */
function energyDatabasePaths(env: NodeJS.ProcessEnv): string[] {
  // The literal default in `config/database.ts:8` is included alongside
  // whatever ENERGY_DB_PATH holds, because the guard has to hold in a process
  // where ENERGY_DB_PATH is unset — which is exactly the process that would
  // fall back to that literal.
  return [env.ENERGY_DB_PATH, '/data/energy_dashboard.db'].filter(
    (p): p is string => typeof p === 'string' && p !== ''
  );
}

/** Compare paths the way the filesystem would. Windows is case-insensitive; POSIX is not. */
function samePath(a: string, b: string): boolean {
  const normalise = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalise(a) === normalise(b);
}

/**
 * Resolve the configured path, refusing the energy database.
 *
 * Required rather than defaulted. A default would put a credentials file
 * somewhere nobody chose — most likely beside the energy database, which is the
 * one directory this module exists to stay out of. A process that has not been
 * told where its key store is has not been configured, and saying so at startup
 * is cheaper than discovering it later.
 */
export function resolveApiKeysDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.API_KEYS_DB_PATH ?? '').trim();
  if (configured === '') {
    throw new Error(
      'API_KEYS_DB_PATH is not set. The /v1 key store is its own SQLite file and has no ' +
        'default: it must never be the shared energy database, which this server opens ' +
        'readonly and does not own. Set it to a path of your choosing (see server/.env.example).'
    );
  }

  for (const energyPath of energyDatabasePaths(env)) {
    if (samePath(configured, energyPath)) {
      throw new Error(
        'API_KEYS_DB_PATH points at the shared energy database. Key and account records must ' +
          'live in their own file: that database is 376 GiB, is owned by energy-data-gathering, ' +
          'and is opened readonly here. Choose a different path.'
      );
    }
  }

  return path.resolve(configured);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  plan        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  disabled_at TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  key_env        TEXT NOT NULL,
  -- The non-secret handle. UNIQUE because it is the lookup key, and a duplicate
  -- would make verification ambiguous rather than merely untidy.
  key_prefix     TEXT NOT NULL UNIQUE,
  -- Hex SHA-256 of the secret segment, and the only representation of a key
  -- that exists at rest. Nothing here is reversible and nothing keeps a hint;
  -- see the module header for why that is a day-one decision.
  secret_sha256  TEXT NOT NULL,
  label          TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT,
  revoked_at     TEXT,
  revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys(account_id);
`;

/*
 * No `last_used_at`, on purpose.
 *
 * It is the obvious column to want and it would cost a write on every
 * authenticated request — an fsync on the critical path of the whole API, to
 * maintain a field accurate to the second that nobody needs to the day.
 * ABL-293 §2c makes the same argument about metering and answers it with a
 * buffered append; once ABL-301 lands, "when was this key last used" is a
 * `MAX(received_at)` over `usage_events` and this column would be a second,
 * worse copy of it. An unused column invites someone to start filling it, so
 * there is not one.
 */

function readAccount(row: Record<string, unknown>): AccountRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    plan: row.plan as AccountPlan,
    createdAt: row.created_at as string,
    disabledAt: (row.disabled_at as string | null) ?? null,
  };
}

function readKey(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    environment: row.key_env as KeyEnvironment,
    prefix: row.key_prefix as string,
    secretSha256: row.secret_sha256 as string,
    label: row.label as string,
    createdAt: row.created_at as string,
    expiresAt: (row.expires_at as string | null) ?? null,
    revokedAt: (row.revoked_at as string | null) ?? null,
    revokedReason: (row.revoked_reason as string | null) ?? null,
  };
}

/** The one query the request path makes. Joined so auth needs a single round trip. */
const LOOKUP_SQL = `
  SELECT k.id            AS k_id,
         k.account_id    AS k_account_id,
         k.key_env       AS k_key_env,
         k.key_prefix    AS k_key_prefix,
         k.secret_sha256 AS k_secret_sha256,
         k.label         AS k_label,
         k.created_at    AS k_created_at,
         k.expires_at    AS k_expires_at,
         k.revoked_at    AS k_revoked_at,
         k.revoked_reason AS k_revoked_reason,
         a.id            AS a_id,
         a.name          AS a_name,
         a.plan          AS a_plan,
         a.created_at    AS a_created_at,
         a.disabled_at   AS a_disabled_at
    FROM api_keys k
    JOIN accounts a ON a.id = k.account_id
   WHERE k.key_prefix = ?
`;

function readLookup(row: Record<string, unknown>): ApiKeyLookup {
  const unprefix = (p: string) =>
    Object.fromEntries(
      Object.entries(row)
        .filter(([column]) => column.startsWith(p))
        .map(([column, value]) => [column.slice(p.length), value])
    );
  return { key: readKey(unprefix('k_')), account: readAccount(unprefix('a_')) };
}

function makeDirectory(db: DatabaseType): ApiKeyDirectory {
  const lookup = db.prepare(LOOKUP_SQL);
  return {
    findByPrefix(prefix) {
      const row = lookup.get(prefix) as Record<string, unknown> | undefined;
      return row ? readLookup(row) : null;
    },
    close() {
      db.close();
    },
  };
}

/**
 * Open the key store for serving: readonly, and the file must already exist.
 *
 * `fileMustExist` rather than creating an empty database. A missing file here
 * means the deployment was pointed somewhere wrong or the store was never
 * seeded — and an empty store silently rejects every customer's key with
 * `key_invalid`, which is the single most confusing way this could fail. Better
 * to refuse to start and say which command creates one.
 */
export function openApiKeyDirectory(env: NodeJS.ProcessEnv = process.env): ApiKeyDirectory {
  const dbPath = resolveApiKeysDbPath(env);
  let db: DatabaseType;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new Error(
      `Cannot open the /v1 key store at ${dbPath}: ${(err as Error).message}. ` +
        'Create it with `npm run keys -- accounts:create --name "..." --plan explorer` ' +
        'in server/, which opens the same path read-write and applies the schema.'
    );
  }

  const hasSchema = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'")
    .get();
  if (!hasSchema) {
    db.close();
    throw new Error(
      `The file at ${dbPath} has no api_keys table, so it is not a /v1 key store. ` +
        'Check API_KEYS_DB_PATH.'
    );
  }

  return makeDirectory(db);
}

/**
 * Open the key store for administration: read-write, creating and migrating the
 * file if needed.
 *
 * Reached only from `keysCli.ts`. `publicAppGraph.test.ts` asserts that the
 * serving entrypoint does not import it.
 */
export function openApiKeyAdminStore(env: NodeJS.ProcessEnv = process.env): ApiKeyAdminStore {
  const db = new Database(resolveApiKeysDbPath(env));
  // WAL so a reader (the serving process) is never blocked by the CLI writing,
  // and vice versa. This file's writer is the CLI and only the CLI, so
  // contention is theoretical — but a key store that locks out authentication
  // while somebody issues a key would be a bad surprise to have designed in.
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  const directory = makeDirectory(db);
  const nowIso = () => new Date().toISOString();

  const selectAccount = db.prepare('SELECT * FROM accounts WHERE id = ?');
  const selectKey = db.prepare('SELECT * FROM api_keys WHERE id = ?');

  function getAccount(id: string): AccountRecord | null {
    const row = selectAccount.get(id) as Record<string, unknown> | undefined;
    return row ? readAccount(row) : null;
  }

  function getKey(id: string): ApiKeyRecord | null {
    const row = selectKey.get(id) as Record<string, unknown> | undefined;
    return row ? readKey(row) : null;
  }

  /** Re-read after a write, so callers always see what was actually stored. */
  function requireKey(id: string): ApiKeyRecord {
    const key = getKey(id);
    if (!key) throw new Error(`No such key: ${id}`);
    return key;
  }

  function listKeys(accountId?: string): ApiKeyRecord[] {
    const rows = accountId
      ? db.prepare('SELECT * FROM api_keys WHERE account_id = ? ORDER BY created_at, id').all(accountId)
      : db.prepare('SELECT * FROM api_keys ORDER BY created_at, id').all();
    return (rows as Record<string, unknown>[]).map(readKey);
  }

  /**
   * Refuse if the account is already at the cap.
   *
   * `exemptKeyId` is how a zero-overlap rotation is allowed to proceed from a
   * full account: the key being retired in the same transaction does not count
   * against the account it is leaving.
   */
  function assertKeySlotAvailable(accountId: string, exemptKeyId?: string): void {
    const now = new Date();
    const live = listKeys(accountId).filter((k) => k.id !== exemptKeyId && isKeyLive(k, now));
    if (live.length < MAX_LIVE_KEYS_PER_ACCOUNT) return;
    throw new Error(
      `Account ${accountId} already holds ${live.length} live keys, the maximum is ` +
        `${MAX_LIVE_KEYS_PER_ACCOUNT}. Revoke one (keys:revoke) or let one expire first. ` +
        'A rotation with an overlap window counts both keys while they overlap.'
    );
  }

  const insertKey = db.prepare(
    `INSERT INTO api_keys
       (id, account_id, key_env, key_prefix, secret_sha256, label, created_at,
        expires_at, revoked_at, revoked_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
  );

  /**
   * Mint and insert, retrying the `UNIQUE(key_prefix)` constraint.
   *
   * At 62^8 a collision is vanishingly unlikely, but the recovery is one more
   * draw and the alternative is a customer-visible 500 at the least convenient
   * moment. Assumes the caller has already checked the cap.
   */
  function insertMintedKey(input: Required<Omit<IssueKeyInput, 'expiresAt'>> & { expiresAt: string | null }): IssuedKey {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const minted = mintApiKey(input.environment);
      const record: ApiKeyRecord = {
        id: newRecordId('key'),
        accountId: input.accountId,
        environment: input.environment,
        prefix: minted.prefix,
        secretSha256: minted.secretSha256,
        label: input.label,
        createdAt: nowIso(),
        expiresAt: input.expiresAt,
        revokedAt: null,
        revokedReason: null,
      };
      try {
        insertKey.run(
          record.id,
          record.accountId,
          record.environment,
          record.prefix,
          record.secretSha256,
          record.label,
          record.createdAt,
          record.expiresAt
        );
        return { record, key: minted.key };
      } catch (err) {
        if (!String((err as Error).message).includes('UNIQUE')) throw err;
      }
    }
    throw new Error('Could not mint a unique key prefix after 5 attempts.');
  }

  return {
    ...directory,

    createAccount({ name, plan }) {
      const account: AccountRecord = {
        id: newRecordId('acct'),
        name,
        plan,
        createdAt: nowIso(),
        disabledAt: null,
      };
      db.prepare(
        'INSERT INTO accounts (id, name, plan, created_at, disabled_at) VALUES (?, ?, ?, ?, NULL)'
      ).run(account.id, account.name, account.plan, account.createdAt);
      return account;
    },

    listAccounts() {
      return (db.prepare('SELECT * FROM accounts ORDER BY created_at, id').all() as Record<
        string,
        unknown
      >[]).map(readAccount);
    },

    getAccount,

    setAccountDisabled(id, disabled) {
      const account = getAccount(id);
      if (!account) throw new Error(`No such account: ${id}`);
      db.prepare('UPDATE accounts SET disabled_at = ? WHERE id = ?').run(
        disabled ? nowIso() : null,
        id
      );
      return getAccount(id) as AccountRecord;
    },

    issueKey({ accountId, label, environment, expiresAt = null }: IssueKeyInput): IssuedKey {
      if (!getAccount(accountId)) throw new Error(`No such account: ${accountId}`);
      assertKeySlotAvailable(accountId);
      return insertMintedKey({ accountId, label, environment, expiresAt });
    },

    rotateKey({ keyId, label, overlapDays }) {
      const retiring = requireKey(keyId);

      // One transaction, because the half-states are both bad in a way that is
      // hard to notice: a new key with the old one never retired leaves a
      // credential live that everybody believes is gone, and an old key retired
      // with no replacement issued is an outage. better-sqlite3 runs this
      // synchronously, so there is no interleaving to reason about.
      const rotate = db.transaction((): { issued: IssuedKey; retired: ApiKeyRecord } => {
        // With no overlap the old key stops working now, so it frees its slot
        // in the same breath; with an overlap it stays live and counts.
        if (overlapDays <= 0) {
          db.prepare('UPDATE api_keys SET revoked_at = ?, revoked_reason = ? WHERE id = ?').run(
            nowIso(),
            'rotated',
            keyId
          );
        } else {
          const deadline = new Date(Date.now() + overlapDays * 86_400_000).toISOString();
          db.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run(deadline, keyId);
        }

        assertKeySlotAvailable(retiring.accountId, overlapDays <= 0 ? keyId : undefined);

        const issued = insertMintedKey({
          accountId: retiring.accountId,
          // A rotation is the same credential with a new secret, so the label
          // carries over unless the operator renames it. Losing "grafana" on
          // rotation is how a key list becomes five rows called "new key".
          label: label ?? retiring.label,
          environment: retiring.environment,
          expiresAt: null,
        });
        return { issued, retired: requireKey(keyId) };
      });

      return rotate();
    },

    listKeys,

    getKey,

    revokeKey(id, reason) {
      const key = requireKey(id);
      // Idempotent: revoking an already-revoked key keeps the first timestamp
      // and reason. The first revocation is the one that answers "when did this
      // stop working", and a second call should not overwrite the audit trail.
      if (key.revokedAt !== null) return key;
      db.prepare('UPDATE api_keys SET revoked_at = ?, revoked_reason = ? WHERE id = ?').run(
        nowIso(),
        reason,
        id
      );
      return requireKey(id);
    },

    setKeyExpiry(id, expiresAt) {
      requireKey(id);
      db.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run(expiresAt, id);
      return requireKey(id);
    },
  };
}
