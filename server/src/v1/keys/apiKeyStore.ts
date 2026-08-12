import type { KeyEnvironment } from './keyFormat.js';

/**
 * What a key record is, and the two capabilities over it.
 *
 * Types and pure functions only — no import here reaches a database driver, so
 * `publicApp.ts` can name these in `import type` positions without putting
 * `better-sqlite3` in its graph. `sqliteApiKeyStore.ts` is the implementation
 * and is reached only from the entrypoint and the CLI.
 *
 * ## Why two interfaces and not one
 *
 * The request path needs exactly one operation: *given this prefix, what row?*
 * It never creates, rotates or revokes. Splitting {@link ApiKeyDirectory} out
 * from {@link ApiKeyAdminStore} means the object `createPublicApp` accepts is
 * typed such that issuing a key is not an available method — the same argument
 * ABL-304 makes about `routes/index.js`, one layer down. Absent capability
 * beats unused capability.
 *
 * `sqliteApiKeyStore.ts` carries that through to runtime by opening the file
 * **readonly** for the directory and read-write only for the admin store, so
 * the serving process holds no writable handle on the key records at all — not
 * a check that returns false, an operating-system-level one.
 */

/**
 * Plan names from the ABL-291 brief §1.2 tier table.
 *
 * Stored on the account and carried onto the authenticated principal so
 * ABL-302 has something to read. **Nothing in ABL-300 enforces it.** This issue
 * authenticates and identifies a caller; it does not meter one and does not
 * gate one. A `plan` here is an attribute of the caller, not a permission.
 */
export const ACCOUNT_PLANS = ['explorer', 'developer', 'professional', 'enterprise'] as const;
export type AccountPlan = (typeof ACCOUNT_PLANS)[number];

export interface AccountRecord {
  /** `acct_…`. */
  id: string;
  name: string;
  plan: AccountPlan;
  /** ISO 8601 UTC, always `Date#toISOString()`. */
  createdAt: string;
  /**
   * Account-level off switch, distinct from revoking each key.
   *
   * Non-payment or an offboarding suspends the account without destroying the
   * keys, so restoring service is one column rather than a reissue for every
   * key the customer has deployed.
   */
  disabledAt: string | null;
}

export interface ApiKeyRecord {
  /** `key_…`. Stable for the row's whole life, including after revocation. */
  id: string;
  accountId: string;
  /**
   * The `env` segment this key was minted with, checked against the presented
   * key at verification. Recorded so the segment is a fact about the row rather
   * than an unverified claim in the string.
   */
  environment: KeyEnvironment;
  /** The non-secret handle, in clear, unique across the store. */
  prefix: string;
  /** Hex SHA-256 of the secret segment. There is no column holding the key itself. */
  secretSha256: string;
  /** Free text a human chose: "prod backfill", "grafana". Never the key. */
  label: string;
  createdAt: string;
  /**
   * Optional deadline, the mechanism behind zero-downtime rotation: the old key
   * keeps working until the customer has deployed the new one.
   */
  expiresAt: string | null;
  /**
   * Soft revocation. The row is never deleted — ABL-301's usage records will
   * point at `id`, and a billing history whose foreign key dangles is a dispute
   * we cannot answer.
   */
  revokedAt: string | null;
  revokedReason: string | null;
}

/** A key and the account it belongs to, resolved together. */
export interface ApiKeyLookup {
  key: ApiKeyRecord;
  account: AccountRecord;
}

/**
 * The read capability, and all the request path is given.
 *
 * Lookup is by the *non-secret* prefix on purpose: the secret is never a query
 * parameter, never an index key and never leaves the process it was presented
 * to. The caller compares hashes itself, in constant time
 * (`keyFormat.secretMatchesHash`).
 */
export interface ApiKeyDirectory {
  findByPrefix(prefix: string): ApiKeyLookup | null;
  close(): void;
}

export interface IssueKeyInput {
  accountId: string;
  label: string;
  environment: KeyEnvironment;
  /** Absolute deadline, or `null` for a key that does not expire on its own. */
  expiresAt?: string | null;
}

/** What issuance hands back — the one and only time the raw key exists. */
export interface IssuedKey {
  record: ApiKeyRecord;
  /**
   * The full key string.
   *
   * Print it, hand it over, and drop it. It is not stored, not logged and not
   * recoverable; a customer who loses it rotates.
   */
  key: string;
}

/**
 * The write capability. Held by the keys CLI and by nothing that serves a
 * request.
 */
export interface ApiKeyAdminStore extends ApiKeyDirectory {
  createAccount(input: { name: string; plan: AccountPlan }): AccountRecord;
  listAccounts(): AccountRecord[];
  getAccount(id: string): AccountRecord | null;
  setAccountDisabled(id: string, disabled: boolean): AccountRecord;

  issueKey(input: IssueKeyInput): IssuedKey;
  /**
   * Replace a key with a fresh one, atomically.
   *
   * One operation rather than "issue, then remember to retire the old one",
   * because the sequence has two failure states and both are quiet: a new key
   * with the old never retired leaves a credential live that everyone believes
   * is gone, and an old key retired with no replacement is an outage.
   *
   * `overlapDays > 0` sets a deadline on the outgoing key so the customer can
   * deploy the new one before the old stops — the create-new-then-revoke-old
   * shape ABL-293 §2b asks for. `overlapDays: 0` revokes it immediately, which
   * is what a suspected leak wants.
   */
  rotateKey(input: { keyId: string; label?: string; overlapDays: number }): {
    issued: IssuedKey;
    retired: ApiKeyRecord;
  };
  listKeys(accountId?: string): ApiKeyRecord[];
  getKey(id: string): ApiKeyRecord | null;
  revokeKey(id: string, reason: string | null): ApiKeyRecord;
  /** Set or clear a key's deadline, independently of a rotation. */
  setKeyExpiry(id: string, expiresAt: string | null): ApiKeyRecord;
}

/**
 * How many keys an account may hold live at once.
 *
 * Five is the ABL-293 §2b figure, and the reason for any cap is that an
 * unbounded key list is one nobody audits: the point of rotation is that old
 * credentials stop existing, and a customer who can mint a sixth forever never
 * has to retire the first. It bounds the prefix-lookup fan-out too, though at
 * this size that is a rounding error rather than a reason.
 *
 * A rotation with an overlap window counts both keys, so an account sitting at
 * the cap must revoke or expire one before it can roll. That is the intended
 * friction and the CLI says so by name rather than failing on a constraint.
 */
export const MAX_LIVE_KEYS_PER_ACCOUNT = 5;

/**
 * Why a key is not usable, or `'active'`.
 *
 * Pure and clock-injected so every branch is testable without waiting.
 */
export type KeyState = 'active' | 'revoked' | 'expired';

export function resolveKeyState(key: ApiKeyRecord, now: Date): KeyState {
  // Revocation outranks expiry when both are true. They answer different
  // questions — "somebody turned this off" against "this ran out" — and the
  // first is the one a customer needs to hear, because it means a person
  // decided something rather than a date passed.
  if (key.revokedAt !== null) return 'revoked';

  if (key.expiresAt !== null) {
    const deadline = Date.parse(key.expiresAt);
    // An unparseable deadline is treated as expired. The safe direction for a
    // corrupt credential row is "stops working", never "works forever".
    if (Number.isNaN(deadline) || deadline <= now.getTime()) return 'expired';
  }

  return 'active';
}

/** Live means usable now: neither revoked nor past its deadline. */
export function isKeyLive(key: ApiKeyRecord, now: Date): boolean {
  return resolveKeyState(key, now) === 'active';
}
