import type { Request, RequestHandler, Response } from 'express';
import { PublicApiError } from '../publicErrors.js';
import {
  burnSecretComparison,
  parseApiKey,
  readBearerToken,
  secretMatchesHash,
} from '../keys/keyFormat.js';
import { resolveKeyState, type AccountPlan, type ApiKeyDirectory } from '../keys/apiKeyStore.js';
import type { AuthFailureRecorder } from '../security/authFailureRecorder.js';

/**
 * The `/v1` gate: turn `Authorization: Bearer <key>` into an identified caller,
 * or refuse the request.
 *
 * This replaces `middleware/writeAuth.ts` for the public surface — it does not
 * modify it. That middleware keeps gating the two ingest `POST`s on the private
 * app and is untouched by this issue; ABL-293 §2b's finding is that it *cannot*
 * be the public mechanism, for reasons that are structural rather than a matter
 * of hardening:
 *
 * - It is **one shared secret** compared with `!==` against
 *   `process.env.HELIO_WRITE_TOKEN` (`middleware/writeAuth.ts:15,27`). One
 *   secret for every caller means no identity, so no attribution, so nothing
 *   ABL-301 could meter and nothing anyone could invoice.
 * - There is **no revocation** short of rotating the one secret, which breaks
 *   every caller at once.
 * - `!==` on a secret is a **timing oracle**; {@link secretMatchesHash} uses
 *   `crypto.timingSafeEqual`.
 * - Its own comment says it is LAN-only (`middleware/writeAuth.ts:11-12`).
 *
 * ## What it does not do
 *
 * It does not count anything (ABL-301), does not enforce a plan quota or a rate
 * limit (ABL-302), and does not serve a resource (ABL-303). It answers exactly
 * one question — *who is this?* — and attaches the answer. The `plan` it
 * carries is an attribute of the caller, not a permission; nothing here reads
 * it. Keeping that line sharp is what lets the stack ABL-293 §2c specifies
 * (auth → meter → rate-limit → cache → handler) be assembled from independent
 * pieces rather than negotiated.
 *
 * ## The one thing ABL-530 added, and why it had to be here
 *
 * Every refusal is now recorded, through the `refuse()` helper inside the
 * middleware. This is the only place it could go: the meter is mounted *behind*
 * this gate, so it never sees a refused request, and `usage_events` could not
 * have held one anyway — `account_id` and `key_id` are `NOT NULL`.
 *
 * Nothing about the **response** changed. Each refusal returns the same
 * `PublicApiError` it did before, `key_invalid` still answers every pre-secret
 * failure, the unknown-prefix comparison is still burned, and the recorder does
 * no I/O and cannot throw. The distinction between a known and an unknown prefix
 * is recorded *internally* and is not observable from outside — which is the
 * whole point, because that distinction is the difference between a
 * credential-stuffing campaign and a customer with a stale key, and until this
 * issue the two were the same undifferentiated 401 counter that nobody was even
 * capturing (ABL-524 §1.2, §1.3).
 */

/** Who the caller turned out to be. Everything downstream reads this and never the header. */
export interface ApiPrincipal {
  accountId: string;
  accountName: string;
  /** Carried for ABL-302 to enforce. Nothing in ABL-300 branches on it. */
  plan: AccountPlan;
  keyId: string;
  /** The non-secret handle — safe to log, and the thing support will ask for. */
  keyPrefix: string;
  environment: string;
}

/**
 * Where the principal is parked on the response.
 *
 * A symbol on `res.locals` rather than a property bolted onto `Request` through
 * a global `declare module` augmentation. A global augmentation would add an
 * optional `req.apiKey` to *every* Express request in the repository, including
 * all 52 handlers on the private app that have no such thing — an optional
 * field that is always `undefined` in most of the codebase is a type that lies.
 * A symbol also cannot collide with a key some other middleware picks.
 */
const PRINCIPAL = Symbol.for('able.v1.apiPrincipal');

/**
 * Read the authenticated caller, or throw.
 *
 * Deliberately not `getApiPrincipal(): ApiPrincipal | undefined`. Every
 * consumer of this — the meter, the quota check, a handler wanting an account
 * id — is code that must not run on an unauthenticated request, and an
 * `undefined` that is merely *unlikely* is one `?.` away from a request that
 * gets metered to nobody or served for free. Throwing means a route mounted on
 * the wrong side of the gate fails loudly the first time it is exercised
 * instead of silently doing the wrong thing.
 */
export function requireApiPrincipal(res: Response): ApiPrincipal {
  const principal = (res.locals as Record<symbol, unknown>)[PRINCIPAL] as ApiPrincipal | undefined;
  if (!principal) {
    throw new Error(
      'No API principal on this response: a /v1 route is mounted ahead of requireApiKey(). ' +
        'Every route under /v1 except the discovery root must sit behind the gate.'
    );
  }
  return principal;
}

/** Present, for code that legitimately wants to branch on "was this authenticated". */
export function peekApiPrincipal(res: Response): ApiPrincipal | undefined {
  return (res.locals as Record<symbol, unknown>)[PRINCIPAL] as ApiPrincipal | undefined;
}

/**
 * The failure codes this gate can produce, each a distinct `error.code` on a
 * 401 (or 403).
 *
 * ## Why these are distinguished, and why that is not an information leak
 *
 * The usual objection to `key_revoked` being distinct from `key_invalid` is
 * that it confirms a key once existed. Look at where the branch sits: revoked,
 * expired and disabled are only ever reached **after** the presented secret has
 * matched the stored hash. Someone who gets that far already holds the key —
 * telling them it was revoked discloses nothing they could not deduce, and
 * saves the customer who *is* that person a support ticket. An attacker
 * guessing keys never sees anything but `key_invalid`, because that is the only
 * branch reachable without the secret.
 *
 * The one distinction made *before* the secret is checked is
 * `key_missing`/`key_malformed`, and neither is about a particular key: they
 * describe the header the caller sent. Collapsing them into one
 * "unauthorized" is what turns a five-second fix into an afternoon.
 */
export const AUTH_ERROR_CODES = {
  missing: 'key_missing',
  malformed: 'key_malformed',
  invalid: 'key_invalid',
  revoked: 'key_revoked',
  expired: 'key_expired',
  accountDisabled: 'account_disabled',
} as const;

/**
 * Messages written for a customer to read.
 *
 * They reach the wire because they are constructed as `PublicApiError`, which
 * is the only path through `publicErrorHandler` that keeps a message
 * (`publicErrors.ts:118`). Every one is a constant: nothing here interpolates
 * the presented key, the prefix, an account name or a path, so this file cannot
 * become the reflected-input hole the error contract was inverted to close —
 * and a 401 body is the single most likely thing a customer pastes into a
 * public issue tracker.
 */
const AUTH_ERRORS: Record<string, { status: number; message: string }> = {
  [AUTH_ERROR_CODES.missing]: {
    status: 401,
    message: 'This endpoint requires an API key. Send it as: Authorization: Bearer able_live_...',
  },
  [AUTH_ERROR_CODES.malformed]: {
    status: 401,
    message:
      'The Authorization header could not be read as an API key. The expected form is ' +
      'Authorization: Bearer able_live_<prefix>_<secret>.',
  },
  [AUTH_ERROR_CODES.invalid]: { status: 401, message: 'This API key is not valid.' },
  [AUTH_ERROR_CODES.revoked]: {
    status: 401,
    message: 'This API key has been revoked. Issue a new one to continue.',
  },
  [AUTH_ERROR_CODES.expired]: {
    status: 401,
    message: 'This API key has expired. Issue a new one to continue.',
  },
  [AUTH_ERROR_CODES.accountDisabled]: {
    status: 403,
    message: 'This account is not currently active. Please contact support.',
  },
};

function authError(code: string): PublicApiError {
  const { status, message } = AUTH_ERRORS[code];
  return new PublicApiError(status, code, message);
}

export interface RequireApiKeyOptions {
  directory: ApiKeyDirectory;
  /**
   * Where refusals are recorded (ABL-530).
   *
   * **Required, with no default**, matching the four capabilities
   * `createPublicApp` requires for the same reason: an app composed without one
   * is an API on which a credential-stuffing campaign leaves no trace, and that
   * is not a state anybody would choose deliberately, so there is no way to
   * spell it. It was the *actual* state until this issue — not by anyone's
   * decision, but because a billing meter mounted behind the gate cannot see a
   * request the gate refused.
   *
   * Injected as a type, so the module that serves requests still names only the
   * shape of a recorder and `publicIndex.ts` decides what backs it — the same
   * arrangement that keeps `better-sqlite3` out of `publicApp.ts`'s graph.
   */
  recorder: AuthFailureRecorder;
  /** Injectable clock, so the expiry branch is testable without waiting for one. */
  now?: () => Date;
}

/**
 * Build the gate.
 *
 * A factory over an injected {@link ApiKeyDirectory} rather than a module-level
 * middleware that opens its own database. That is what keeps `better-sqlite3`
 * out of `publicApp.ts`'s import graph — the composition names the *shape* of a
 * key store, and the entrypoint decides which one — and it is what lets
 * `apiKeyAuth.test.ts` drive every branch against a directory it constructs by
 * hand, including rows no real store would produce.
 */
/**
 * What the gate knows about the caller at the point it refuses.
 *
 * Everything defaults to "nothing known", which is the honest state for a
 * pre-secret refusal: an unknown prefix names no key, so there is no account and
 * no key id to record, and `secretVerified` is false because no secret has been
 * proven.
 */
type RefusalIdentity = {
  presentedPrefix?: string | null;
  keyEnvironment?: string | null;
  secretVerified?: boolean;
  accountId?: string | null;
  keyId?: string | null;
};

export function requireApiKey({
  directory,
  recorder,
  now = () => new Date(),
}: RequireApiKeyOptions): RequestHandler {
  return function apiKeyAuth(req: Request, res: Response, next): void {
    // RFC 6750 §3: a 401 from a bearer-authenticated resource carries a
    // challenge. Set before any branch so every refusal below has it, and with
    // no `error_description`, which the RFC allows to be free text and would be
    // a second place for a message to reach the wire unscrubbed.
    res.setHeader('WWW-Authenticate', 'Bearer realm="able-v1"');

    /**
     * Build the refusal **and** record it, in one call (ABL-530).
     *
     * Every `return next(...)` below goes through this, which is the whole
     * mechanism: there is exactly one place a refusal is constructed, so a
     * branch added later is recorded whether or not its author thought about
     * detection — the same property the mount order gives authentication for a
     * route added to `v1/routes/index.ts`. The alternative shapes were a
     * middleware ahead of the gate or a hook on `res.on('close')`, and both lose
     * the two facts that make the record worth having: by the time the response
     * closes, six distinct causes have been flattened into one status and one
     * constant message, and `secretVerified` is not recoverable from either.
     *
     * **It does not change the response.** The `PublicApiError` returned is
     * exactly the one `authError` built before this issue — same status, same
     * constant message, same code — and `recorder.record` does no I/O and cannot
     * throw. See `authFailureRecorder.ts` for why that is what keeps the
     * known-prefix and unknown-prefix branches indistinguishable from outside.
     */
    function refuse(code: string, identity: RefusalIdentity = {}): PublicApiError {
      const error = authError(code);
      recorder.record(req, {
        errorCode: code,
        status: error.status,
        presentedPrefix: identity.presentedPrefix ?? null,
        keyEnvironment: identity.keyEnvironment ?? null,
        secretVerified: identity.secretVerified ?? false,
        accountId: identity.accountId ?? null,
        keyId: identity.keyId ?? null,
      });
      return error;
    }

    const bearer = readBearerToken(req.header('authorization'));
    if (bearer.kind === 'absent') return next(refuse(AUTH_ERROR_CODES.missing));
    if (bearer.kind === 'malformed') return next(refuse(AUTH_ERROR_CODES.malformed));

    const presented = parseApiKey(bearer.token);
    // No prefix recorded here on purpose: the token did not parse, so there is
    // no field of it we have identified as the non-secret handle. Recording
    // "whatever the caller sent, truncated to 32 characters" would be recording
    // a fragment of something that might have been a secret, which is the one
    // thing this record must never hold.
    if (!presented) return next(refuse(AUTH_ERROR_CODES.malformed));

    // From here on the prefix is known to be the non-secret handle, and it is
    // recorded on **every** remaining branch — including the unknown-prefix one
    // immediately below. That symmetry is not cosmetic: a field gathered on one
    // branch and not the other is work done on one branch and not the other,
    // which is the timing difference the comparison burn exists to prevent.
    const presentedIdentity: RefusalIdentity = {
      presentedPrefix: presented.prefix,
      keyEnvironment: presented.environment,
    };

    const found = directory.findByPrefix(presented.prefix);
    if (!found) {
      // Burn a comparison so an unknown prefix costs what a known one costs.
      // Without this the *non-secret* prefix becomes an enumeration oracle:
      // "does this prefix exist" would be answerable by timing alone, which
      // turns the support handle into a target list.
      burnSecretComparison(presented.secret);
      return next(refuse(AUTH_ERROR_CODES.invalid, presentedIdentity));
    }

    const { key, account } = found;

    // Note what is *not* passed here: the key and account ids, even though the
    // prefix matched a row and we hold both. The secret has not been proven, so
    // the caller has demonstrated nothing about this key — recording it as
    // theirs would make the S4 query ("who presented a real secret") answer with
    // people who guessed a prefix.
    if (!secretMatchesHash(presented.secret, key.secretSha256)) {
      return next(refuse(AUTH_ERROR_CODES.invalid, presentedIdentity));
    }

    // Everything past this point has proven possession of the secret. That is
    // what makes the specific codes below safe to disclose (see the note on
    // AUTH_ERROR_CODES) and it is what `secretVerified` records: there is no
    // guessing path to any refusal from here down, so anyone who triggers one
    // holds a real key (ABL-524 §2 S4).
    const verified: RefusalIdentity = {
      ...presentedIdentity,
      secretVerified: true,
      accountId: account.id,
      keyId: key.id,
    };

    // The environment segment is checked against the row, not merely parsed.
    // Otherwise `able_test_…` and `able_live_…` differ only in a string nobody
    // reads, and the segment that exists to stop somebody shipping a test key
    // to production would be decoration. A mismatch is `key_invalid` rather
    // than its own code: the prefix and secret matched, so this is a row whose
    // environment was changed underneath a live key, which is not a state a
    // customer can act on.
    //
    // It is recorded with `secretVerified: true`, and this is the branch that
    // makes that a column rather than something derivable from `error_code`:
    // `key_invalid` is produced on both sides of the secret check, so the code
    // alone cannot say which happened.
    if (presented.environment !== key.environment) {
      return next(refuse(AUTH_ERROR_CODES.invalid, verified));
    }

    const state = resolveKeyState(key, now());
    if (state === 'revoked') return next(refuse(AUTH_ERROR_CODES.revoked, verified));
    if (state === 'expired') return next(refuse(AUTH_ERROR_CODES.expired, verified));

    // Account-level suspension is a 403, not a 401: the credential is good, and
    // re-sending it with a different key will not help. 401 would tell a
    // customer to check their key, which is the wrong afternoon to spend.
    if (account.disabledAt !== null) {
      return next(refuse(AUTH_ERROR_CODES.accountDisabled, verified));
    }

    const principal: ApiPrincipal = {
      accountId: account.id,
      accountName: account.name,
      plan: account.plan,
      keyId: key.id,
      keyPrefix: key.prefix,
      environment: key.environment,
    };
    (res.locals as Record<symbol, unknown>)[PRINCIPAL] = principal;

    next();
  };
}
