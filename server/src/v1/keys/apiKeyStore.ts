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
  /**
   * Where a notice about this key's subscriber is sent — the **account contact**
   * ToS §9.3 names (ABL-528).
   *
   * §9.3 commits us to publishing a material model change "through the changelog
   * and to the account contact". Until this field existed, half of that
   * two-channel notice resolved to nothing: there was no address anywhere in
   * `v1/billing` or `v1/keys`, so the obligation had no way to be met and no way
   * to be seen failing.
   *
   * **Required at issuance, nullable in the type**, and the asymmetry is the
   * point. {@link IssueKeyInput.contactEmail} is a required `string`, so no
   * caller can mint a contactless key — that is a compile error and, in
   * `sqliteApiKeyStore.ts`, a runtime refusal too. `null` is reachable only by a
   * row written *before* the column existed, and it is kept expressible rather
   * than backfilled with a placeholder: a fabricated address is one we cannot
   * deliver to wearing the costume of one we can, which is this repository's
   * defining defect applied to a contractual notice. `accountContacts.ts`
   * reports such a row as **unreachable**, by name, and never as "nobody to
   * notify".
   *
   * It is not a secret and is printed by the listing commands. It is personal
   * data — see `../usage/PRIVACY-AND-RETENTION.md` §6.
   */
  contactEmail: string | null;
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
  /**
   * The account contact for this key. **Required, deliberately not optional.**
   *
   * Typed `string` rather than `string | null` so that forgetting it is a
   * compile error at every call site rather than a row nobody can be notified
   * about. See {@link ApiKeyRecord.contactEmail}.
   */
  contactEmail: string;
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
  rotateKey(input: {
    keyId: string;
    label?: string;
    /**
     * Carried forward from the key being retired when omitted — a rotation is
     * the same subscriber with a new secret, so it is the same contact.
     *
     * It must be supplied when the retiring key predates the contact column and
     * has none, because the replacement is a fresh key and minting a contactless
     * one is refused however it is reached. That makes rotation the migration
     * path for the rows in {@link ApiKeyRecord.contactEmail}'s `null` case.
     */
    contactEmail?: string;
    overlapDays: number;
  }): {
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

/**
 * The sentence a contactless mint is refused with.
 *
 * A constant rather than an inline string because two call sites raise it — the
 * CLI, where an operator reads it, and the store, which is the thing that would
 * actually create the row — and the reason has to be identical in both. It is
 * modelled on `scripts/backfillModelGuard.ts`: state what is refused, then state
 * the consequence that makes the refusal worth the friction, so nobody has to
 * guess whether it is a formality.
 */
export const CONTACT_REQUIRED_MESSAGE =
  'Refusing to mint a key with no account contact. ToS §9.3 commits us to publishing a ' +
  'material model change through the changelog AND to the account contact, so a key with no ' +
  'contact is a subscriber we have promised to notify and cannot reach — and nobody finds out ' +
  'until a model changes. Pass --contact <email>.';

/**
 * The longest address SMTP has to carry, RFC 5321 §4.5.3.1.3.
 *
 * A bound at all, because this string is written to a database and printed to a
 * terminal, and an unbounded field is how a paste accident becomes a row.
 */
const MAX_CONTACT_EMAIL_LENGTH = 254;

/**
 * Is this shaped like an address somebody could be reached at?
 *
 * **A typo-catcher, not a proof of validity, and the distinction is worth
 * stating because it decides how strict this should be.** Whether an address
 * receives mail is only ever established by sending to it, which is ABL-529's
 * job and does not exist yet; nothing here can know. So the rule is the weakest
 * one that still catches the mistakes an operator actually makes at a
 * terminal — a missing `@`, a shell-mangled value, an account id pasted into
 * the wrong flag — and it deliberately stops there. The elaborate RFC 5322
 * regexes reject addresses that work, which would be a refusal we could not
 * justify to the person holding the address.
 */
export function isPlausibleContactEmail(value: string): boolean {
  if (value.length === 0 || value.length > MAX_CONTACT_EMAIL_LENGTH) return false;
  // Whitespace anywhere means the value was quoted wrong or two were passed as
  // one; either way it is not one address.
  if (/\s/.test(value)) return false;

  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;

  const domain = value.slice(at + 1);
  if (domain.startsWith('.') || domain.endsWith('.')) return false;
  // A dot with at least two characters after it. Not a TLD list — that would be
  // a second thing to keep true — just enough that `--contact acct_7f3a` and
  // `--contact ops@localhost` are caught rather than stored.
  return /\.[^.]{2,}$/.test(domain);
}

/**
 * Trim and check, or throw the refusal.
 *
 * Returns the trimmed address **exactly as given otherwise** — no lowercasing.
 * The local part of an address is case-sensitive by specification even though
 * almost no provider treats it that way, so silently rewriting what a person
 * typed risks changing where a notice goes in order to make a comparison
 * tidier. `accountContacts.ts` handles the tidiness at compare time instead,
 * where getting it wrong costs a duplicate line rather than a lost notice.
 */
export function requireContactEmail(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();
  if (value === '') throw new Error(CONTACT_REQUIRED_MESSAGE);
  if (!isPlausibleContactEmail(value)) {
    throw new Error(
      `'${value}' does not look like an email address, so it cannot be the account contact. ` +
        CONTACT_REQUIRED_MESSAGE
    );
  }
  return value;
}
