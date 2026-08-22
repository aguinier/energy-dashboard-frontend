/**
 * What a **refused** `/v1` request leaves behind, and the two capabilities over
 * those records.
 *
 * Types and pure functions only — no import here reaches a database driver, so
 * `apiKeyAuth.ts` can name these without putting `better-sqlite3` in the graph
 * of the module that serves requests. `sqliteAuthFailureStore.ts` is the
 * implementation, reached only from the entrypoint and the usage CLI, exactly as
 * `usageStore.ts` stands to `sqliteUsageStore.ts`.
 *
 * ## The gap this closes (ABL-530, ABL-524 `breach-signals` §1.2)
 *
 * A failed authentication produced **no durable record anywhere**.
 * `publicApp.ts` mounts the gate, then the meter, then the plan gate; every
 * refusal in `apiKeyAuth.ts` ends the request with `next(authError(...))`, which
 * jumps to the error handler and never reaches the meter. `usage_events` could
 * not have held such a row in any case — `account_id` and `key_id` are both
 * `NOT NULL` and a failed auth has neither.
 *
 * That is not a defect in the metering work. The meter is a billing meter and it
 * is mounted exactly where a billing meter belongs. It means the *security*
 * record simply did not exist, and the honest answer to "would we notice a
 * credential-stuffing campaign?" was no.
 *
 * ## Which way this record is allowed to be wrong, and why it is the opposite
 *    of the meter's
 *
 * `usageStore.ts` resolves every ambiguity toward **under**-counting, because
 * its number becomes an invoice and an invoice that is slightly high is a
 * refund, an apology and a customer who checks every future one by hand.
 *
 * This table inverts that. A lost auth-failure record makes an attack invisible;
 * a duplicated one inflates a count an investigator reads with their own eyes.
 * So where the two conflict, this module keeps the record.
 *
 * It rarely has to choose, because {@link AuthFailureEvent.eventId} is `UNIQUE`
 * in the table and the insert is `ON CONFLICT(event_id) DO NOTHING`: a flush
 * that commits and is then retried writes nothing the second time. The
 * *direction* is stated anyway, because the next person to add a failure mode
 * here needs to know which way to resolve it and the neighbouring module says
 * the opposite.
 *
 * ## Two constraints from the issue that are not negotiable
 *
 * 1. **The presented secret is never recorded** — not hashed, not truncated,
 *    not prefixed-plus-N. There is no field on {@link AuthFailureEvent} that
 *    could hold one. A store of attempted secrets would be a second credential
 *    store with none of the protections the real one has, and it would be one
 *    that fills itself from the open internet.
 *
 *    The **prefix** is recorded, and that is deliberate rather than a
 *    compromise: `apiKeyAuth.ts` describes it as "the non-secret handle — safe
 *    to log, and the thing support will ask for". It is also the single column
 *    that separates *many prefixes from one origin* (enumeration) from *one
 *    prefix from one origin* (a customer with a stale key). Same status code,
 *    opposite meanings, and indistinguishable without it.
 *
 * 2. **The response does not change, in body or in timing.** Nothing here is
 *    read by a handler; the whole record is written after the refusal has been
 *    decided. See `authFailureRecorder.ts` for the timing half, which is a
 *    property of *when* the write happens rather than of what is in it.
 *
 * ## Retention
 *
 * `client_ip` and `user_agent` put this table inside the ABL-297 §5 promise from
 * its first row, so it is scrubbed and deleted by the **same job** on the
 * **same two boundaries** as `usage_events` — see `RetentionPolicy` in
 * `usageStore.ts`, which stays the one place those periods are read from.
 * `usage:stats` counts this table in `unscrubbedPastPii` too; a compliance check
 * that silently stopped covering a table holding IP addresses would be worse
 * than no check.
 */

/**
 * One refused request.
 *
 * Every field is either a fact about our own decision or a fact about the
 * connection. Nothing here is derived from a value the caller chose except
 * {@link presentedPrefix} and {@link userAgent}, and both are bounded — see
 * `authFailureRecorder.ts`.
 */
export interface AuthFailureEvent {
  /**
   * Unique per refusal, and `UNIQUE` in the table.
   *
   * Present for the same reason `usage_events.request_id` is: it makes a flush
   * idempotent, so a batch that commits and is then retried inserts nothing.
   * Without it this module would have to *choose* between losing a record and
   * duplicating one, and the note in this file's header about which way to err
   * would become load-bearing instead of merely informative.
   */
  eventId: string;
  /** ISO 8601 UTC, stamped when the refusal was decided. */
  receivedAt: string;
  /** The `error.code` the caller was answered with — `key_invalid`, `key_revoked`, … */
  errorCode: string;
  /** 401 for every code except `account_disabled`, which is 403. */
  status: number;
  /**
   * The non-secret handle the caller presented, or `null` when nothing
   * parseable arrived (`key_missing`, and most `key_malformed`).
   *
   * **Never the secret**, and there is no field that could hold one.
   */
  presentedPrefix: string | null;
  /** `live` / `test`, as presented. `null` when the key did not parse. */
  keyEnvironment: string | null;
  /**
   * Whether the presented secret had already matched the stored hash when this
   * refusal was decided. **The highest-specificity column on the row** (ABL-524
   * §2 S4).
   *
   * `key_revoked`, `key_expired` and `account_disabled` are reachable *only*
   * after `secretMatchesHash` has succeeded, so anyone who triggers one is in
   * possession of a real secret — there is no guessing path to them. A
   * `key_revoked` from an origin that key was never served from is close to
   * proof that the credential is in someone else's hands.
   *
   * Recorded explicitly rather than derived from {@link errorCode}, and that is
   * not redundancy. `key_invalid` sits on **both** sides of the secret check —
   * an unknown prefix and a wrong secret produce it before, and an
   * environment mismatch produces it *after* — so the mapping from code to
   * "did they hold the secret" is not a function today, and a code added later
   * on the wrong side of the check would join the wrong bucket silently. The
   * gate knows the answer at the line where it refuses; this column is that
   * answer, written down where it was known.
   */
  secretVerified: boolean;
  /**
   * Our own identifiers for the key that was presented, when the secret matched.
   *
   * `null` on every pre-secret refusal, because there is no key — a prefix that
   * matched no row names nothing. Present on the S4 codes, where they are what
   * makes the question answerable at all: "was this key ever *served* from this
   * address?" is a join against `usage_events.key_id`, and without the id there
   * is nothing to join on.
   */
  accountId: string | null;
  keyId: string | null;
  /**
   * Which `/v1` surface was aimed at, as a **template from a fixed table**, or
   * `(unrecognised)`.
   *
   * Never `req.path`. On a refused request the path is an unauthenticated,
   * caller-controlled string — the free-text-shaped value ABL-297 §9(5) says
   * must not reach the log, and on this table the callers are by definition the
   * ones we trust least. See `requestTarget.ts` for the table and for the drift
   * check that keeps it honest.
   */
  routeTemplate: string;
  method: string;
  /**
   * Source address, from the socket. Personal data under the GDPR, which is why
   * the retention job below is not optional.
   */
  clientIp: string | null;
  userAgent: string | null;
}

/** What the request path is given: append, and nothing else. */
export interface AuthFailureSink {
  /**
   * Append a batch. Must be atomic and safe to call twice with the same events
   * — see {@link AuthFailureEvent.eventId}.
   */
  writeAuthFailures(events: readonly AuthFailureEvent[]): AuthFailureWriteOutcome;
}

export interface AuthFailureWriteOutcome {
  inserted: number;
  /** Rows already present, matched on `event_id`. Non-zero means a flush was retried. */
  alreadyPresent: number;
}

/*
 * ---------------------------------------------------------------------------
 * The read side: four questions, from ABL-524 `breach-signals` §2
 * ---------------------------------------------------------------------------
 *
 * Each shape below answers exactly one of them. The store returns rows; the
 * judgement about what a row *means* lives in `securityReport.ts`, which is
 * pure and tested without a database — the same split `freshness.ts` has from
 * `dataFreshnessService.ts`.
 */

/** A half-open `[since, until)` window in ISO 8601 UTC. */
export interface AuthFailureWindow {
  since: string;
  until: string;
}

/**
 * S3, grouped by **origin**: the enumeration shape.
 *
 * Many distinct presented prefixes from one address is someone walking our key
 * space. One prefix from one address at a low steady rate is a customer with a
 * stale key.
 */
export interface OriginFailureRow {
  clientIp: string | null;
  failures: number;
  distinctPrefixes: number;
  /** Comma-joined distinct `error_code`s, so the shape is readable without a second query. */
  errorCodes: string;
  /** Refusals from this origin where the caller had already proven the secret. See S4. */
  secretVerifiedFailures: number;
  firstAt: string;
  lastAt: string;
}

/**
 * S3, grouped by **presented prefix**: the leaked-key shape.
 *
 * One prefix tried from many addresses is a key that has got out and is being
 * tried by several parties.
 */
export interface PrefixFailureRow {
  presentedPrefix: string | null;
  failures: number;
  distinctOrigins: number;
  errorCodes: string;
  firstAt: string;
  lastAt: string;
}

/**
 * S4: a refusal by somebody who **held a real secret**.
 *
 * One row per (key, code, origin). `originServedRequests` is the join that turns
 * this from "a revoked key was tried" into "a revoked key was tried from an
 * address it was never served from", which is the finding.
 */
export interface SecretHolderFailureRow {
  keyId: string | null;
  accountId: string | null;
  presentedPrefix: string | null;
  errorCode: string;
  clientIp: string | null;
  failures: number;
  firstAt: string;
  lastAt: string;
  /**
   * How many requests this key was **successfully served** from this same
   * address, within the retained IP history.
   *
   * `0` is the alarming value — but only when {@link usageHistoryFrom} shows we
   * actually hold history to have missed it in. See §4: `client_ip` is nulled at
   * 90 days, so "never seen from here" and "we no longer remember" are the same
   * query and different claims.
   *
   * **`null` means the question could not be asked**, because this failure row's
   * own address has already been scrubbed. A `COUNT(*)` joined on a `NULL`
   * address returns `0`, which reads identically to "served from here never" and
   * is the single most likely way this report would state something false. So
   * the store returns `null` rather than letting SQL's three-valued logic
   * collapse into a confident zero.
   */
  originServedRequests: number | null;
  /** Earliest retained request for this key that still carries an address, or `null`. */
  usageHistoryFrom: string | null;
}

/**
 * S2: one (key, origin) pair from `usage_events` — **successful** traffic.
 *
 * Deliberately built from the metering table rather than from this one. S2 is a
 * question about *use*, not about refusal, and ABL-524 §2 records that it is
 * already answerable with no new instrumentation.
 */
export interface KeyOriginRow {
  keyId: string;
  accountId: string;
  clientIp: string;
  requests: number;
  firstAt: string;
  lastAt: string;
}

/**
 * S5: one key's request breadth, recent against **its own** baseline.
 *
 * `request_fingerprint` is `sha256(method + route + allowlisted params)`. It
 * exists for idempotency and works unchanged here.
 *
 * The two windows do not overlap: `baseline*` counts the period *before*
 * `recent*`, so a key whose breadth is genuinely growing shows a ratio above 1
 * rather than being diluted by its own recent traffic.
 */
export interface KeyFingerprintRow {
  keyId: string;
  accountId: string;
  recentFingerprints: number;
  recentRequests: number;
  baselineFingerprints: number;
  baselineRequests: number;
}

/** Counts and the retention check for this table, folded into `usage:stats`. */
export interface AuthFailureStats {
  records: number;
  oldestAt: string | null;
  newestAt: string | null;
  /** Refusals by a caller who had already proven a secret. Rare, and worth a number. */
  secretVerifiedRecords: number;
  /** Records past `piiDays` still holding an address or user agent. Must be 0. */
  unscrubbedPastPii: number;
}

/** Rows scrubbed and deleted by one retention pass over this table. */
export interface AuthFailureRetentionOutcome {
  scrubbed: number;
  deleted: number;
}

/**
 * Everything an operator and an investigator need. Held by the usage CLI, never
 * by the request path — which holds {@link AuthFailureSink} and nothing else.
 */
export interface AuthFailureAdminStore extends AuthFailureSink {
  /** S3, by origin. Ordered by distinct prefixes descending: the enumeration shape first. */
  failuresByOrigin(window: AuthFailureWindow): OriginFailureRow[];
  /** S3, by presented prefix. Ordered by distinct origins descending. */
  failuresByPrefix(window: AuthFailureWindow): PrefixFailureRow[];
  /** S4. Every refusal in the window where the secret had already matched. */
  secretHolderFailures(window: AuthFailureWindow): SecretHolderFailureRow[];
  /**
   * S2. Successful (key, origin) pairs from `usage_events`, over **all retained
   * history** rather than over a window.
   *
   * Deliberately unbounded, because the question is "has this key ever been used
   * from here before" and a windowed query cannot answer it — every origin looks
   * new if you only look at the last week. The lookback that decides which
   * origins count as *new* is applied by `securityReport.ts` to these rows, so
   * the horizon of what we actually hold stays visible instead of being consumed
   * by the query.
   *
   * Bounded in practice by retention: rows past 90 days carry no address and are
   * excluded, so this is at most a 90-day group-by however long the key has
   * existed.
   */
  keyOrigins(keyId?: string): KeyOriginRow[];
  /** S5. Per-key fingerprint breadth, recent window against the preceding baseline. */
  keyFingerprintBreadth(recent: AuthFailureWindow, baselineSince: string): KeyFingerprintRow[];
}
