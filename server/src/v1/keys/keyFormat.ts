import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The API key itself: how one is shaped, minted, parsed and verified.
 *
 * Pure and storage-free on purpose — nothing here opens a database, so the
 * format can be exercised exhaustively in `keyFormat.test.ts` without a file,
 * and so the request path's verification logic is testable separately from the
 * store that feeds it (ABL-293 §2b).
 *
 * ## The shape
 *
 * `able_<env>_<prefix>_<secret>` — for example
 * `able_live_7f3a9c21_xR4k…`. Four segments, `_`-separated, and each one earns
 * its place:
 *
 * - **`able`** is a fixed namespace, so a key found loose in a log, a support
 *   ticket or a GitHub push is attributable to us at a glance. It is also what
 *   makes the format greppable, which is the entire mechanism behind secret
 *   scanning.
 * - **`env`** is `live` or `test`. It is the segment a human reads before
 *   pasting a key into a chat window, and it is checked against the stored row
 *   at verification time (`apiKeyAuth.ts`) rather than being decoration.
 * - **`prefix`** is 8 base62 characters, stored in clear and unique. This is
 *   the non-secret handle: what logs record, what support asks for, what the
 *   CLI lists. Without one, every support conversation trains a customer to
 *   paste the whole key into a ticket — and that habit outlives any schema we
 *   might fix later.
 * - **`secret`** is the only part that is secret, and the only part nobody can
 *   read back after creation.
 *
 * ## Why SHA-256 at rest and not bcrypt or argon2
 *
 * This is the opposite of the usual advice, so it is written down rather than
 * left to look like an oversight. A slow KDF exists to buy time against
 * brute force on a *low-entropy human password*. This secret is
 * {@link KEY_SECRET_LENGTH} base62 characters drawn from a CSPRNG — about 256
 * bits, the same strength as 32 random bytes. There is no dictionary, no
 * pattern and no plausible search. What a KDF would add instead is tens of
 * milliseconds of hashing on the critical path of **every authenticated
 * request**, which on a per-request-billed API is a cost with no matching
 * benefit. SHA-256 is the right primitive precisely because the input is
 * already uniform.
 *
 * The same reasoning is why there is no per-key salt: salting defends against
 * precomputation across a *corpus* of guessable inputs, and a 256-bit random
 * string has nothing to precompute.
 */

/** The fixed first segment. See the namespace note above. */
export const KEY_NAMESPACE = 'able';

/** Deployment environments a key can be minted for. */
export const KEY_ENVIRONMENTS = ['live', 'test'] as const;
export type KeyEnvironment = (typeof KEY_ENVIRONMENTS)[number];

/** Characters of the non-secret handle. 62^8 ≈ 2.2e14, so collisions are a retry, not a design. */
export const KEY_PREFIX_LENGTH = 8;

/**
 * Characters of the secret half.
 *
 * 43 base62 characters carry 43 × log2(62) ≈ 256 bits. The secret is generated
 * *as characters* rather than as 32 bytes rendered into base62: converting
 * bytes to a base that is not a power of two is a bignum operation with a
 * modulo-bias trap in every naive implementation, and it buys nothing here —
 * drawing each character uniformly is both simpler and exactly as strong.
 */
export const KEY_SECRET_LENGTH = 43;

/**
 * Base62, deliberately with no `-`, `_`, `+`, `/` or `=`.
 *
 * The separator is `_`, so the alphabet must exclude it or parsing becomes
 * ambiguous. Excluding the rest means a key survives being a URL path segment,
 * a shell word, a CSV cell and a JSON string with no escaping anywhere — every
 * one of which is a place a customer will eventually put it.
 */
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** The largest multiple of 62 that fits in a byte; bytes at or above it are redrawn. */
const BASE62_REJECT_AT = 248;

/**
 * `length` characters drawn uniformly from {@link BASE62}.
 *
 * Rejection sampling rather than `byte % 62`, which would make the first six
 * characters of the alphabet ~1.6% likelier than the rest. That bias is
 * harmless at this entropy and would still be wrong to write: the next person
 * to copy this function may use it for something shorter.
 */
export function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    // Over-draw so the common case is a single syscall: at a ~3% rejection
    // rate, 1.25× the shortfall is comfortably enough almost every time.
    for (const byte of randomBytes(Math.ceil((length - out.length) * 1.25) + 8)) {
      if (byte >= BASE62_REJECT_AT) continue;
      out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

const BASE62_RE = /^[0-9A-Za-z]+$/;

export interface ParsedApiKey {
  environment: KeyEnvironment;
  prefix: string;
  secret: string;
}

/** Render the four segments back into the string a customer holds. */
export function formatApiKey({ environment, prefix, secret }: ParsedApiKey): string {
  return `${KEY_NAMESPACE}_${environment}_${prefix}_${secret}`;
}

/**
 * Read a presented key, or `null` if it is not one.
 *
 * Strict about every segment — namespace, environment, both lengths and both
 * alphabets — because a malformed key is answered with a *different* status
 * code than a wrong one (`key_malformed` vs `key_invalid`), and that
 * distinction is only useful to the caller if "malformed" really does mean
 * "this cannot be a key", never "this is a key I mistyped one character of".
 *
 * Returns `null` rather than throwing: a parse failure here is ordinary caller
 * input on a public surface, and it happens on the request path.
 */
export function parseApiKey(raw: string): ParsedApiKey | null {
  const segments = raw.split('_');
  if (segments.length !== 4) return null;

  const [namespace, environment, prefix, secret] = segments;
  if (namespace !== KEY_NAMESPACE) return null;
  if (!(KEY_ENVIRONMENTS as readonly string[]).includes(environment)) return null;
  if (prefix.length !== KEY_PREFIX_LENGTH || !BASE62_RE.test(prefix)) return null;
  if (secret.length !== KEY_SECRET_LENGTH || !BASE62_RE.test(secret)) return null;

  return { environment: environment as KeyEnvironment, prefix, secret };
}

/** Lowercase hex SHA-256 of the secret segment. The only form of a key we ever persist. */
export function hashKeySecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** 32 zero bytes — the stand-in compared against when there is nothing real to compare. */
const ZERO_DIGEST = Buffer.alloc(32);

/**
 * Constant-time "is this the secret behind that hash".
 *
 * `timingSafeEqual` rather than `===`, which is the actual bug in
 * `middleware/writeAuth.ts:27`: string comparison returns on the first
 * differing byte, so the time it takes leaks how long a shared prefix the
 * guess had. That is a real oracle against a *short* secret; it is not much of
 * one against 256 bits, but the correct primitive costs nothing and this is the
 * function the next person will copy.
 *
 * A stored hash that is not 32 bytes of hex — a truncated row, a hand-edited
 * database — compares against {@link ZERO_DIGEST} and fails, rather than
 * throwing out of the request path on a length mismatch.
 */
export function secretMatchesHash(secret: string, expectedHashHex: string): boolean {
  const expected = /^[0-9a-f]{64}$/i.test(expectedHashHex)
    ? Buffer.from(expectedHashHex, 'hex')
    : ZERO_DIGEST;
  return timingSafeEqual(Buffer.from(hashKeySecret(secret), 'hex'), expected);
}

/**
 * Burn one comparison against a value that cannot match.
 *
 * Called when the prefix matched no row, so that "no such key" and "wrong
 * secret" take the same shape of work. Without it, an unknown prefix returns
 * measurably sooner than a known one, which turns the *non-secret* prefix into
 * an enumeration oracle — cheap to close, and awkward to add later once
 * something depends on the fast path.
 */
export function burnSecretComparison(secret: string): void {
  secretMatchesHash(secret, ZERO_DIGEST.toString('hex'));
}

export interface MintedApiKey {
  /** The full key string. Returned to a human exactly once, at creation, and never stored. */
  key: string;
  environment: KeyEnvironment;
  /** The non-secret handle, stored in clear. */
  prefix: string;
  /** What goes in the `secret_sha256` column. */
  secretSha256: string;
}

/**
 * Mint a new key.
 *
 * Note what this returns and what a caller is expected to do with it: `key` is
 * the only copy that will ever exist, and the store persists `prefix` and
 * `secretSha256`. The raw key is unrecoverable from the moment this function
 * returns — by construction, not by policy.
 */
export function mintApiKey(environment: KeyEnvironment): MintedApiKey {
  const prefix = randomBase62(KEY_PREFIX_LENGTH);
  const secret = randomBase62(KEY_SECRET_LENGTH);
  return {
    key: formatApiKey({ environment, prefix, secret }),
    environment,
    prefix,
    secretSha256: hashKeySecret(secret),
  };
}

/**
 * Identifiers for account and key rows: `acct_…` / `key_…`.
 *
 * Prefixed and random rather than an autoincrementing integer. These appear in
 * CLI output, in support threads and — once ABL-301 lands — in usage records
 * that outlive the key they name, so a value that is self-describing when read
 * out of context is worth the twelve characters. Sequential ids would also
 * publish how many customers we have to anyone who ever sees two of them.
 */
export function newRecordId(kind: 'acct' | 'key'): string {
  return `${kind}_${randomBase62(12)}`;
}

/**
 * What the `Authorization` header turned out to be.
 *
 * Three outcomes, not two, because the API answers them differently: a caller
 * who sent no header gets `key_missing` and a caller who sent
 * `Authorization: Basic …` gets `key_malformed`. Collapsing those into one
 * "unauthorized" is what makes an integration take an afternoon instead of a
 * minute — the two mistakes have completely different fixes.
 */
export type BearerRead =
  | { kind: 'absent' }
  | { kind: 'malformed' }
  | { kind: 'token'; token: string };

/**
 * Read a bearer token out of an `Authorization` header value.
 *
 * The scheme is matched case-insensitively per RFC 7235 §2.1. The token is
 * required to be a single non-whitespace run: a value with an internal space is
 * malformed rather than silently truncated, because silently truncating is how
 * a caller who pasted `Bearer able_live_… # prod` gets `key_invalid` and spends
 * an hour looking at the wrong thing.
 */
export function readBearerToken(header: string | undefined): BearerRead {
  const value = (header ?? '').trim();
  if (value === '') return { kind: 'absent' };

  const match = /^Bearer[ \t]+(\S+)$/i.exec(value);
  return match ? { kind: 'token', token: match[1] } : { kind: 'malformed' };
}
