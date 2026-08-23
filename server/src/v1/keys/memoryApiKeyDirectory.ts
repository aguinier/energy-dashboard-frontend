import type { AccountRecord, ApiKeyDirectory, ApiKeyLookup, ApiKeyRecord } from './apiKeyStore.js';
import { hashKeySecret, mintApiKey, parseApiKey, type KeyEnvironment } from './keyFormat.js';

/**
 * An {@link ApiKeyDirectory} backed by a `Map`. **Tests only.**
 *
 * It exists so the auth stack can be exercised without a file: `apiKeyAuth.ts`
 * has branches for a revoked key, an expired key, a disabled account and a row
 * whose stored hash is corrupt, and reaching all of them through the real
 * SQLite store would mean writing rows a real store would refuse to create.
 * The store's own behaviour — the cap, rotation, the readonly/read-write split
 * — is tested against the real thing in `sqliteApiKeyStore.test.ts`, because a
 * fake cannot say anything true about SQLite.
 *
 * It is not a deployment target and nothing on the serving path imports it:
 * `publicAppGraph.test.ts` asserts by name that `publicIndex.ts` cannot reach
 * this module, so "test-only" is a checked property rather than a comment.
 */

export interface MemoryKeySeed {
  /** Defaults to a fresh `acct_…`-shaped id. */
  accountId?: string;
  accountName?: string;
  plan?: AccountRecord['plan'];
  /** Set to disable the account, exactly as the `disabled_at` column would. */
  accountDisabledAt?: string | null;
  environment?: KeyEnvironment;
  label?: string;
  /**
   * The ToS §9.3 account contact.
   *
   * Defaults to a plausible address, so the ordinary seed matches what the real
   * store would have written. Set it to `null` for the one row shape the real
   * store cannot produce and this fake exists to supply: a key issued **before**
   * the contact column existed (ABL-528). `accountContacts.ts` has to report
   * that row as unreachable, and there is no other way to construct it — a
   * migrated SQLite file has the column, and every write path through it
   * refuses to leave the column empty.
   */
  contactEmail?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  revokedReason?: string | null;
  /**
   * Override the stored hash, for the corrupt-row case.
   *
   * Left unset, the seed mints a real key and stores a real SHA-256 of it, so
   * the happy path under test is the same computation production runs.
   */
  secretSha256?: string;
}

export interface SeededKey {
  /** The full key string a caller would present. */
  key: string;
  record: ApiKeyRecord;
  account: AccountRecord;
}

/**
 * Build a directory from seeds, returning both the directory and the raw keys.
 *
 * Returning the key strings is the whole point: a test needs the plaintext to
 * put in a header, and production never has it after issuance.
 */
export function createMemoryApiKeyDirectory(seeds: MemoryKeySeed[] = []): {
  directory: ApiKeyDirectory;
  keys: SeededKey[];
} {
  const byPrefix = new Map<string, ApiKeyLookup>();
  const keys: SeededKey[] = [];
  let counter = 0;

  for (const seed of seeds) {
    counter += 1;
    const environment = seed.environment ?? 'live';
    const minted = mintApiKey(environment);
    const accountId = seed.accountId ?? `acct_memory${String(counter).padStart(6, '0')}`;

    const account: AccountRecord = {
      id: accountId,
      name: seed.accountName ?? `Account ${counter}`,
      plan: seed.plan ?? 'developer',
      createdAt: '2026-01-01T00:00:00.000Z',
      disabledAt: seed.accountDisabledAt ?? null,
    };

    const record: ApiKeyRecord = {
      id: `key_memory${String(counter).padStart(6, '0')}`,
      accountId,
      environment,
      prefix: minted.prefix,
      secretSha256: seed.secretSha256 ?? minted.secretSha256,
      label: seed.label ?? `key ${counter}`,
      // `undefined` means "not specified", which gets the default; an explicit
      // `null` means "this row predates the column" and must survive as null.
      // `??` alone would collapse the two.
      contactEmail:
        seed.contactEmail === undefined ? `ops${counter}@memory.example` : seed.contactEmail,
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: seed.expiresAt ?? null,
      revokedAt: seed.revokedAt ?? null,
      revokedReason: seed.revokedReason ?? null,
    };

    byPrefix.set(record.prefix, { key: record, account });
    keys.push({ key: minted.key, record, account });
  }

  return {
    directory: {
      findByPrefix: (prefix) => byPrefix.get(prefix) ?? null,
      close: () => {},
    },
    keys,
  };
}

/**
 * Re-render a seeded key with one segment replaced.
 *
 * For the "right prefix, wrong secret" case, which is the only way to reach the
 * hash-mismatch branch on purpose — a randomly generated wrong key would almost
 * certainly miss the prefix lookup instead and exercise a different branch.
 */
export function withSecret(key: string, secret: string): string {
  const parsed = parseApiKey(key);
  if (!parsed) throw new Error(`not a key: ${key}`);
  return `able_${parsed.environment}_${parsed.prefix}_${secret}`;
}

/** The hash a directory would hold for `secret`. Exported so tests can assert the column. */
export const hashFor = hashKeySecret;
