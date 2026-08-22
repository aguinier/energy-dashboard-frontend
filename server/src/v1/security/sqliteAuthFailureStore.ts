import type { Database as DatabaseType } from 'better-sqlite3';
import type {
  AuthFailureAdminStore,
  AuthFailureEvent,
  AuthFailureRetentionOutcome,
  AuthFailureStats,
  AuthFailureWindow,
  AuthFailureWriteOutcome,
  KeyFingerprintRow,
  KeyOriginRow,
  OriginFailureRow,
  PrefixFailureRow,
  SecretHolderFailureRow,
} from './authFailureStore.js';

/**
 * `auth_failures` on disk, in the **same SQLite file** as the key store and the
 * usage tables, and never in the energy database.
 *
 * ## Why this module does not open the file
 *
 * It is handed an already-open handle. `sqliteUsageStore.ts` opens
 * `API_KEYS_DB_PATH` read-write, resolves it through `resolveApiKeysDbPath` — the
 * one guard that refuses to let this be the 376 GiB energy database — and passes
 * the handle here.
 *
 * That is not an accident of convenience. `publicAppGraph.test.ts` asserts that
 * **exactly three modules import `better-sqlite3`**, by name, and its own comment
 * says why the assertion names them individually rather than counting: a fourth
 * is a decision somebody should have to justify in review. A second handle on the
 * same file would also be a second place `resolveApiKeysDbPath` had to be
 * remembered, and the metering module's header already records that having one
 * decision about that path and one guard to keep true is the point.
 *
 * So the import above is `import type`, which `tsc` erases. This module holds the
 * SQL for a security record; it holds no capability to decide where that record
 * lands.
 *
 * ## Why the table is here and not beside `usage_events`
 *
 * Same file, different question. `usage_events` answers *what did we serve and
 * to whom*; this answers *who tried and failed*. They cannot be one table:
 * `usage_events.account_id` and `.key_id` are `NOT NULL`, and the entire point of
 * this record is that it works when neither exists (ABL-524 §1.2).
 *
 * What they must share is the **retention job**, because both hold `client_ip`
 * and `user_agent`. See {@link applyAuthFailureRetention}.
 */

/**
 * `INTEGER PRIMARY KEY`, deliberately **without** `AUTOINCREMENT`.
 *
 * `usage_events` needs it and its schema comment calls it "the single most
 * important word in the file": the monthly rollup is watermarked on the highest
 * id it has aggregated, and a bare rowid is reassigned as `max(rowid)+1`, so once
 * retention empties that table the next request reuses an id below the watermark
 * and is skipped by the rollup forever — billing the customer zero.
 *
 * None of that applies here. Nothing aggregates this table, there is no
 * watermark, and no query orders on `id` for anything but a tie-break. Copying
 * `AUTOINCREMENT` across would cost a `sqlite_sequence` row and, worse, would
 * tell the next reader that a watermark exists somewhere and they have not found
 * it yet. The difference is stated rather than left to be inferred from the
 * absence of a keyword.
 *
 * Note what the column list does **not** contain, and cannot be made to contain
 * without a reviewed migration: any field that could hold a presented secret. The
 * prefix is stored because `apiKeyAuth.ts` describes it as the non-secret handle;
 * a store of attempted secrets would be a second credential store, filled from
 * the open internet, with none of the protections the real one has.
 */
export const AUTH_FAILURE_SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_failures (
  id                INTEGER PRIMARY KEY,

  -- Unique per refusal, and the reason a retried flush cannot duplicate a row.
  event_id          TEXT NOT NULL UNIQUE,

  received_at       TEXT NOT NULL,
  -- The error.code the caller was answered with. Not narrowed by a CHECK: the
  -- set lives in apiKeyAuth.ts's AUTH_ERROR_CODES, and a CHECK here would be a
  -- second copy that fails a *write* — losing the record of a refusal — the
  -- first time somebody adds a code. The table is a log, and a log that refuses
  -- unfamiliar entries is not one.
  error_code        TEXT NOT NULL,
  status            INTEGER NOT NULL,

  -- The non-secret handle, in clear. NULL when nothing parseable arrived.
  presented_prefix  TEXT,
  key_environment   TEXT,

  -- Whether the presented secret had already matched when this refusal was
  -- decided. The S4 column: revoked / expired / disabled are reachable only
  -- after secretMatchesHash succeeds, so a 1 here means the caller holds a real
  -- key and there is no guessing path to it. Recorded rather than derived,
  -- because key_invalid appears on both sides of that check.
  secret_verified   INTEGER NOT NULL,

  -- Our own ids, present only when secret_verified = 1. They are what make
  -- "was this key ever served from this address?" a join rather than a guess.
  account_id        TEXT,
  key_id            TEXT,

  -- A template from a fixed table, never req.path. See requestTarget.ts.
  route_template    TEXT NOT NULL,
  method            TEXT NOT NULL,

  -- The two personal-data fields (ABL-297 §3.3), cleared by the same retention
  -- job on the same boundary as usage_events'. pii_scrubbed_at records that it
  -- happened, so "no address because it was removed" stays distinguishable from
  -- "no address recorded" — which for this table is the difference between
  -- "never used from here" and "we no longer remember".
  client_ip         TEXT,
  user_agent        TEXT,
  pii_scrubbed_at   TEXT
);

-- No FOREIGN KEY to api_keys(id), for the reason usage_events states and one
-- more: most rows here name no key at all, and a key that was hard-deleted must
-- not turn the flush of a security record into a throw.

CREATE INDEX IF NOT EXISTS idx_auth_failures_received ON auth_failures(received_at);
-- S3, both groupings. Leading with the group key so the window is a range scan
-- inside it rather than a scan of the table filtered afterwards.
CREATE INDEX IF NOT EXISTS idx_auth_failures_origin ON auth_failures(client_ip, received_at);
CREATE INDEX IF NOT EXISTS idx_auth_failures_prefix ON auth_failures(presented_prefix, received_at);
-- S4. Partial, because a refusal by somebody holding a real secret should be a
-- vanishing fraction of this table — and if it ever is not, that is the finding.
CREATE INDEX IF NOT EXISTS idx_auth_failures_verified
  ON auth_failures(received_at) WHERE secret_verified = 1;
`;

/**
 * Append one refusal, ignoring **only** a repeat of the same `event_id`.
 *
 * `ON CONFLICT(event_id) DO NOTHING` rather than `INSERT OR IGNORE`, for the
 * reason `usageStore`'s insert gives: `OR IGNORE` swallows `NOT NULL` and `CHECK`
 * violations too, so a malformed row would vanish and be counted as "a flush was
 * retried". On a security log that is the difference between a record we chose
 * not to duplicate and a record we silently threw away.
 */
const INSERT_FAILURE = `
INSERT INTO auth_failures (
  event_id, received_at, error_code, status, presented_prefix, key_environment,
  secret_verified, account_id, key_id, route_template, method, client_ip,
  user_agent, pii_scrubbed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
ON CONFLICT(event_id) DO NOTHING
`;

/**
 * S3, by origin — the enumeration shape.
 *
 * `COUNT(DISTINCT presented_prefix)` is the whole signal. Ordered by it, so the
 * address walking our key space is the first line an investigator reads, not the
 * loudest one: a broken client retrying one stale key forever produces the
 * largest `failures` on the page and means nothing.
 */
const FAILURES_BY_ORIGIN = `
SELECT client_ip,
       COUNT(*)                          AS failures,
       COUNT(DISTINCT presented_prefix)  AS distinct_prefixes,
       group_concat(DISTINCT error_code) AS error_codes,
       SUM(secret_verified)              AS secret_verified_failures,
       MIN(received_at)                  AS first_at,
       MAX(received_at)                  AS last_at
  FROM auth_failures
 WHERE received_at >= ? AND received_at < ?
 GROUP BY client_ip
 ORDER BY distinct_prefixes DESC, failures DESC
`;

/**
 * S3, by prefix — the leaked-key shape.
 *
 * The mirror of the query above, and it has to be a second query rather than a
 * second column on the first: one prefix tried from many addresses and many
 * prefixes tried from one address are different groupings of the same rows, and
 * they mean opposite things.
 *
 * Rows with no prefix are excluded rather than grouped under `NULL`. A
 * `key_missing` carries no prefix by definition, and letting several thousand of
 * them collapse into one row at the top of a report ordered by distinct origins
 * would bury the finding under a scanner that never sent a key at all — those are
 * counted by the origin query, where they belong.
 */
const FAILURES_BY_PREFIX = `
SELECT presented_prefix,
       COUNT(*)                          AS failures,
       COUNT(DISTINCT client_ip)         AS distinct_origins,
       group_concat(DISTINCT error_code) AS error_codes,
       MIN(received_at)                  AS first_at,
       MAX(received_at)                  AS last_at
  FROM auth_failures
 WHERE received_at >= ? AND received_at < ? AND presented_prefix IS NOT NULL
 GROUP BY presented_prefix
 ORDER BY distinct_origins DESC, failures DESC
`;

/**
 * S4 — the high-specificity one.
 *
 * Two correlated reads per group, and both exist to stop the report saying
 * something false:
 *
 * - `origin_served_requests` is wrapped in a `CASE` that yields `NULL` when the
 *   failure row's own address has been scrubbed. Without it the join
 *   `u.client_ip = f.client_ip` is `NULL = NULL`, which is not true, so `COUNT(*)`
 *   returns `0` — indistinguishable from "this key was never served from this
 *   address", which is the exact claim that makes this signal "close to proof".
 *   Three-valued logic quietly manufacturing the most alarming reading is not a
 *   thing to leave to a reader's judgement.
 * - `usage_history_from` is how far back we can actually see for this key. At 90
 *   days the retention job nulls every address, so a zero above means "not in the
 *   history we hold" and never "not ever". `securityReport.ts` refuses to call it
 *   a new origin when there is no history to be new against.
 */
const SECRET_HOLDER_FAILURES = `
SELECT f.key_id,
       f.account_id,
       f.presented_prefix,
       f.error_code,
       f.client_ip,
       COUNT(*)            AS failures,
       MIN(f.received_at)  AS first_at,
       MAX(f.received_at)  AS last_at,
       CASE WHEN f.client_ip IS NULL THEN NULL ELSE (
         SELECT COUNT(*) FROM usage_events u
          WHERE u.key_id = f.key_id AND u.client_ip = f.client_ip
       ) END AS origin_served_requests,
       (SELECT MIN(u2.received_at) FROM usage_events u2
         WHERE u2.key_id = f.key_id AND u2.client_ip IS NOT NULL) AS usage_history_from
  FROM auth_failures f
 WHERE f.received_at >= ? AND f.received_at < ? AND f.secret_verified = 1
 GROUP BY f.key_id, f.account_id, f.presented_prefix, f.error_code, f.client_ip
 ORDER BY last_at DESC
`;

/**
 * S2 — every (key, origin) pair we still hold an address for.
 *
 * From `usage_events`, not from `auth_failures`: S2 is a question about
 * *successful* use. ABL-524 §2 records that it needs no new instrumentation, and
 * this is that query.
 *
 * Unbounded in time on purpose — see {@link AuthFailureAdminStore.keyOrigins}.
 * Retention bounds it in practice, and that bound is exactly what the report has
 * to disclose rather than hide.
 */
const KEY_ORIGINS = `
SELECT key_id,
       account_id,
       client_ip,
       COUNT(*)         AS requests,
       MIN(received_at) AS first_at,
       MAX(received_at) AS last_at
  FROM usage_events
 WHERE client_ip IS NOT NULL
   AND (? IS NULL OR key_id = ?)
 GROUP BY key_id, account_id, client_ip
 ORDER BY key_id, first_at
`;

/**
 * S5 — request breadth, recent against the key's **own** preceding baseline.
 *
 * One pass with two conditional aggregates rather than two queries and a join in
 * TypeScript, so the two windows are guaranteed to be measured over the same
 * rows under the same predicate.
 *
 * The windows do not overlap: `baseline_*` counts strictly before
 * `@recentSince`. Overlapping them would dilute a genuine widening with the very
 * traffic being asked about, which is the direction that hides the signal.
 *
 * `HAVING recent_requests > 0` drops keys with nothing recent. A key that has
 * gone quiet is a different question, and one this report has no opinion about.
 */
const KEY_FINGERPRINT_BREADTH = `
SELECT key_id,
       account_id,
       COUNT(DISTINCT CASE WHEN received_at >= @recentSince THEN request_fingerprint END)
         AS recent_fingerprints,
       SUM(CASE WHEN received_at >= @recentSince THEN 1 ELSE 0 END)
         AS recent_requests,
       COUNT(DISTINCT CASE WHEN received_at < @recentSince THEN request_fingerprint END)
         AS baseline_fingerprints,
       SUM(CASE WHEN received_at < @recentSince THEN 1 ELSE 0 END)
         AS baseline_requests
  FROM usage_events
 WHERE received_at >= @baselineSince AND received_at < @until
 GROUP BY key_id, account_id
HAVING recent_requests > 0
 ORDER BY key_id
`;

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Build the statements against an already-open handle.
 *
 * Applies {@link AUTH_FAILURE_SCHEMA} first, for the reason `openUsageStore`
 * gives for applying its own: a table that has not been created would let the API
 * serve traffic and record nothing, which is the silent blindness this issue
 * exists to remove. `CREATE TABLE IF NOT EXISTS` plus three indexes; no existing
 * table is read for writing, altered or dropped.
 */
export function createAuthFailureStore(db: DatabaseType): AuthFailureAdminStore & {
  applyAuthFailureRetention(scrubBefore: string, deleteBefore: string, nowIso: string): AuthFailureRetentionOutcome;
  authFailureStats(scrubBefore: string): AuthFailureStats;
} {
  db.exec(AUTH_FAILURE_SCHEMA);

  const insertFailure = db.prepare(INSERT_FAILURE);
  const byOrigin = db.prepare(FAILURES_BY_ORIGIN);
  const byPrefix = db.prepare(FAILURES_BY_PREFIX);
  const secretHolders = db.prepare(SECRET_HOLDER_FAILURES);
  const keyOriginRows = db.prepare(KEY_ORIGINS);
  const fingerprintBreadth = db.prepare(KEY_FINGERPRINT_BREADTH);

  const writeBatch = db.transaction((events: readonly AuthFailureEvent[]): AuthFailureWriteOutcome => {
    let inserted = 0;
    let alreadyPresent = 0;

    for (const event of events) {
      const result = insertFailure.run(
        event.eventId,
        event.receivedAt,
        event.errorCode,
        event.status,
        event.presentedPrefix,
        event.keyEnvironment,
        event.secretVerified ? 1 : 0,
        event.accountId,
        event.keyId,
        event.routeTemplate,
        event.method,
        // The two personal-data fields, bound last and cleared later by the
        // retention job. `pii_scrubbed_at` is the literal NULL in the statement
        // rather than a parameter, so there is no argument position that could
        // mark a fresh row as already scrubbed.
        event.clientIp,
        event.userAgent
      );
      if (result.changes === 1) inserted += 1;
      else alreadyPresent += 1;
    }

    return { inserted, alreadyPresent };
  });

  return {
    writeAuthFailures(events) {
      if (events.length === 0) return { inserted: 0, alreadyPresent: 0 };
      return writeBatch(events);
    },

    failuresByOrigin({ since, until }: AuthFailureWindow): OriginFailureRow[] {
      return (byOrigin.all(since, until) as Array<Record<string, unknown>>).map((row) => ({
        clientIp: text(row.client_ip),
        failures: row.failures as number,
        distinctPrefixes: row.distinct_prefixes as number,
        errorCodes: text(row.error_codes) ?? '',
        secretVerifiedFailures: (row.secret_verified_failures as number | null) ?? 0,
        firstAt: row.first_at as string,
        lastAt: row.last_at as string,
      }));
    },

    failuresByPrefix({ since, until }: AuthFailureWindow): PrefixFailureRow[] {
      return (byPrefix.all(since, until) as Array<Record<string, unknown>>).map((row) => ({
        presentedPrefix: text(row.presented_prefix),
        failures: row.failures as number,
        distinctOrigins: row.distinct_origins as number,
        errorCodes: text(row.error_codes) ?? '',
        firstAt: row.first_at as string,
        lastAt: row.last_at as string,
      }));
    },

    secretHolderFailures({ since, until }: AuthFailureWindow): SecretHolderFailureRow[] {
      return (secretHolders.all(since, until) as Array<Record<string, unknown>>).map((row) => ({
        keyId: text(row.key_id),
        accountId: text(row.account_id),
        presentedPrefix: text(row.presented_prefix),
        errorCode: row.error_code as string,
        clientIp: text(row.client_ip),
        failures: row.failures as number,
        firstAt: row.first_at as string,
        lastAt: row.last_at as string,
        originServedRequests:
          typeof row.origin_served_requests === 'number' ? row.origin_served_requests : null,
        usageHistoryFrom: text(row.usage_history_from),
      }));
    },

    keyOrigins(keyId?: string): KeyOriginRow[] {
      const filter = keyId ?? null;
      return (keyOriginRows.all(filter, filter) as Array<Record<string, unknown>>).map((row) => ({
        keyId: row.key_id as string,
        accountId: row.account_id as string,
        clientIp: row.client_ip as string,
        requests: row.requests as number,
        firstAt: row.first_at as string,
        lastAt: row.last_at as string,
      }));
    },

    keyFingerprintBreadth(recent: AuthFailureWindow, baselineSince: string): KeyFingerprintRow[] {
      return (
        fingerprintBreadth.all({
          recentSince: recent.since,
          until: recent.until,
          baselineSince,
        }) as Array<Record<string, unknown>>
      ).map((row) => ({
        keyId: row.key_id as string,
        accountId: row.account_id as string,
        recentFingerprints: row.recent_fingerprints as number,
        recentRequests: row.recent_requests as number,
        baselineFingerprints: row.baseline_fingerprints as number,
        baselineRequests: row.baseline_requests as number,
      }));
    },

    /**
     * The ABL-297 §5 boundaries, applied to this table.
     *
     * Called by `sqliteUsageStore.applyRetention` **inside its transaction**, so
     * the two tables are scrubbed and deleted atomically. That matters for the
     * compliance check more than for the data: `usage:stats` reports one
     * `unscrubbedPastPii` across both, and a pass that committed one table and
     * failed the other would print a non-zero total with no failed job to point
     * at.
     *
     * The delete is **unconditional**, where `usage_events`' is gated on the
     * rollup watermark — and that difference is the point rather than an
     * oversight. That gate exists because an un-aggregated event deleted at 13
     * months is a request permanently missing from an invoice. Nothing aggregates
     * this table, nothing is invoiced from it, and there is no watermark it could
     * be measured against; a gate here would be a condition that is always true,
     * which reads to the next maintainer as protection that is not there.
     */
    applyAuthFailureRetention(scrubBefore, deleteBefore, nowIso): AuthFailureRetentionOutcome {
      const scrubbed = db
        .prepare(
          `UPDATE auth_failures
              SET client_ip = NULL, user_agent = NULL, pii_scrubbed_at = ?
            WHERE received_at < ? AND pii_scrubbed_at IS NULL`
        )
        .run(nowIso, scrubBefore).changes;

      const deleted = db
        .prepare('DELETE FROM auth_failures WHERE received_at < ?')
        .run(deleteBefore).changes;

      return { scrubbed, deleted };
    },

    authFailureStats(scrubBefore): AuthFailureStats {
      const one = <T>(sql: string, ...params: unknown[]): T =>
        (db.prepare(sql).get(...params) as { v: T }).v;

      return {
        records: one<number>('SELECT COUNT(*) AS v FROM auth_failures'),
        oldestAt: one<string | null>('SELECT MIN(received_at) AS v FROM auth_failures'),
        newestAt: one<string | null>('SELECT MAX(received_at) AS v FROM auth_failures'),
        secretVerifiedRecords: one<number>(
          'SELECT COUNT(*) AS v FROM auth_failures WHERE secret_verified = 1'
        ),
        // Counts rows past the boundary still holding either personal-data
        // field — not rows where `pii_scrubbed_at` is unset, which would also
        // count every refusal that never had an address to begin with and would
        // make a clean store read as non-compliant.
        unscrubbedPastPii: one<number>(
          `SELECT COUNT(*) AS v FROM auth_failures
            WHERE received_at < ? AND (client_ip IS NOT NULL OR user_agent IS NOT NULL)`,
          scrubBefore
        ),
      };
    },
  };
}
