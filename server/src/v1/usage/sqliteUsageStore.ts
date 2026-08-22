import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { resolveApiKeysDbPath } from '../keys/sqliteApiKeyStore.js';
import { createAuthFailureStore } from '../security/sqliteAuthFailureStore.js';
import {
  DEFAULT_RETENTION_POLICY,
  IDEMPOTENCY_WINDOW_MS,
  IDEMPOTENT_SUPPRESSION_LIMIT,
  monthEndExclusive,
  resolveRetentionPolicy,
  subtractDays,
  subtractMonths,
  THROTTLED_STATUS,
  type AccountUsageExport,
  type CloseMonthsOutcome,
  type RetentionOutcome,
  type RetentionPolicy,
  type RollUpOutcome,
  type UsageAdminStore,
  type UsageEvent,
  type UsageRollupRow,
  type UsageWriteOutcome,
} from './usageStore.js';

/**
 * Usage records on disk: `usage_events` and `usage_rollup`, in the **same
 * SQLite file as the key store** and never in the energy database.
 *
 * That placement is settled — `sqliteApiKeyStore.ts`'s header argues it and
 * `resolveApiKeysDbPath` enforces it, refusing to start when `API_KEYS_DB_PATH`
 * and the energy database resolve to the same file. This module reuses that
 * resolver rather than reading the variable itself, so there is exactly one
 * place that decides what the store's path is and exactly one guard to keep
 * true.
 *
 * It matters more here than it did for keys. Key issuance writes a handful of
 * rows a week; **metering is the highest-volume write this surface will ever
 * make**, one row per authenticated request. Pointing that at a 376 GiB file
 * owned by somebody else's ingest process would put a per-request writer into
 * contention with bulk ingest on a shared file lock.
 *
 * ## Why this module opens its own handle
 *
 * `openApiKeyDirectory` opens the file **readonly**, and that property is worth
 * keeping: the process that answers requests still cannot alter a key record.
 * Metering has to write, so it takes a second handle to the same file, in WAL
 * mode, where a reader is never blocked by a writer. The serving process
 * therefore holds one readonly handle it cannot write keys through and one
 * read-write handle that can reach nothing but the two usage tables.
 *
 * That is also why `publicAppGraph.test.ts`'s "exactly one module imports
 * `better-sqlite3`" assertion now names two modules. Its own comment predicted
 * this — *"if a future issue needs another store — ABL-301's usage tables are
 * the obvious candidate — this fails and the new module gets named here on
 * purpose"* — and naming it is the point: a third would fail the same test.
 *
 * ## The schema decision that would have been silent
 *
 * `usage_events.id` is `INTEGER PRIMARY KEY AUTOINCREMENT`, and the
 * `AUTOINCREMENT` is load-bearing rather than decorative. See {@link SCHEMA}.
 */

/** How many event ids one rollup pass will span. Bounds how long the transaction blocks. */
export const ROLLUP_BATCH_EVENTS = 50_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_events (
  -- AUTOINCREMENT, and this is the single most important word in the file.
  --
  -- The monthly rollup is watermarked on the highest id it has aggregated,
  -- which is what makes it idempotent and what makes it safe if a second
  -- process ever meters the same account. A bare INTEGER PRIMARY KEY is the
  -- rowid, and SQLite assigns a new rowid as max(rowid)+1 — so deleting the
  -- highest rows makes their ids available again. This issue introduces the
  -- first scheduled deletion in the codebase. If retention ever empties this
  -- table, the next request is id 1, the watermark is still at the old maximum,
  -- and every subsequent event is skipped by the rollup forever: the customer
  -- is billed zero, and a zero invoice is the one error nobody reports.
  --
  -- Verified rather than assumed, on better-sqlite3 11 (2026-08-12): with a
  -- bare INTEGER PRIMARY KEY, DELETE FROM then INSERT returns id 1 again;
  -- with AUTOINCREMENT the same sequence returns id 4. Deleting only the
  -- highest row reuses that row's id too.
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Unique per request, and the reason a flush cannot over-count. A batch that
  -- commits and then reports an error is retried against
  -- ON CONFLICT(request_id) DO NOTHING and inserts nothing the second time.
  request_id          TEXT NOT NULL UNIQUE,

  received_at         TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  key_id              TEXT NOT NULL,
  method              TEXT NOT NULL,
  -- The route template, never the raw URL (ABL-293 §2c, ABL-297 §9.5).
  route_template      TEXT NOT NULL,
  -- Allowlisted parameters only; see LOGGED_QUERY_PARAMETERS.
  query_params        TEXT,
  status              INTEGER NOT NULL,
  row_count           INTEGER,
  response_bytes      INTEGER,
  duration_ms         INTEGER NOT NULL,
  billable            INTEGER NOT NULL,
  idempotency_key     TEXT,
  request_fingerprint TEXT NOT NULL,
  -- The request this one was judged a retry of. Kept so a billing dispute can
  -- be answered with "here is the call we did not charge you for, and here is
  -- the one we did" rather than with an assertion.
  duplicate_of        TEXT,

  -- The two personal-data fields (ABL-297 §3.3). Cleared by the retention job
  -- at USAGE_PII_RETENTION_DAYS; pii_scrubbed_at records that it happened, so
  -- "no IP because it was removed" is distinguishable from "no IP recorded".
  client_ip           TEXT,
  user_agent          TEXT,
  pii_scrubbed_at     TEXT
);

-- No FOREIGN KEY to api_keys(id), deliberately.
--
-- The reference does hold: key rows are never deleted, only soft-revoked, and
-- apiKeyStore.ts says why in those terms. Declaring and enforcing it would add
-- one failure mode with a very bad shape — an operator who hard-deletes a key
-- row turns every subsequent flush into a throw, and the metering path would
-- start discarding batches of billing data in order to protect referential
-- tidiness. On the one table we invoice from, resilience beats integrity
-- enforcement, and the integrity is maintained by policy that is itself tested.

CREATE INDEX IF NOT EXISTS idx_usage_events_received ON usage_events(received_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_account_received ON usage_events(account_id, received_at);
-- Partial, because only a request that carried an Idempotency-Key is ever
-- looked up this way, and those are the minority.
CREATE INDEX IF NOT EXISTS idx_usage_events_idempotency
  ON usage_events(account_id, idempotency_key, request_fingerprint, received_at)
  WHERE idempotency_key IS NOT NULL;

-- The invoice reads from here and never from usage_events.
--
-- ABL-297 §9(2): "If invoices are computed by scanning raw request rows, then
-- deleting those rows at 90 days destroys our ability to reconstruct or defend
-- an invoice from eight months ago." These rows are retained for seven years
-- and nothing in this module ever deletes one.
CREATE TABLE IF NOT EXISTS usage_rollup (
  account_id             TEXT NOT NULL,
  key_id                 TEXT NOT NULL,
  -- YYYY-MM, UTC. The billing month is a UTC month for every customer, in every
  -- timezone; a month boundary that moved per customer would make two invoices
  -- for the same traffic disagree.
  year_month             TEXT NOT NULL,
  requests               INTEGER NOT NULL DEFAULT 0,
  billable_requests      INTEGER NOT NULL DEFAULT 0,
  rows_returned          INTEGER NOT NULL DEFAULT 0,
  response_bytes         INTEGER NOT NULL DEFAULT 0,
  first_event_at         TEXT NOT NULL,
  last_event_at          TEXT NOT NULL,
  -- Once set, this row is final and no later event changes a figure in it.
  closed_at              TEXT,
  -- Events that arrived for a month after it closed. Counted, never billed, and
  -- never folded into the figures above: raising an invoice a customer has
  -- already received is a worse outcome than under-counting, which is the rule
  -- this whole module is written to.
  late_requests          INTEGER NOT NULL DEFAULT 0,
  late_billable_requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, key_id, year_month)
);

-- One row, holding the watermark. A single-row table rather than a column on
-- usage_rollup because the watermark is a property of the aggregation, not of
-- any one account's month.
CREATE TABLE IF NOT EXISTS usage_rollup_state (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  rolled_through_event_id INTEGER NOT NULL,
  updated_at              TEXT NOT NULL
);

-- Which billing months are closed, as a property of the *month* rather than of
-- any row in usage_rollup.
--
-- This table exists because the obvious design — closure recorded only as
-- usage_rollup.closed_at — is right for every row that exists at the moment the
-- month closes and silently wrong for every row that does not. The late_*
-- columns are maintained by the ON CONFLICT ... DO UPDATE arm of ROLL_UP, so
-- they only ever fire for an (account, key, month) that already has a row. A
-- late event on a key with no traffic that month takes the INSERT arm instead
-- and, with nothing to conflict against, was born with closed_at = NULL and its
-- requests in the *billable* columns. The month's invoice figure then grew
-- after the invoice was sent.
--
-- That is the over-count this module is written to make impossible, and it was
-- reachable: a key issued mid-month whose first traffic is a replayed batch, a
-- process whose buffered events flush after a long stall, an operator replaying
-- a dead-letter file, or a clock that was wrong. Rare is not the same as
-- unreachable, and the failure is discovered by a customer reading an invoice.
--
-- With this table the closed state is known before the row exists, so a row
-- created for a closed month is born closed with its counts in late_*.
CREATE TABLE IF NOT EXISTS usage_month_close (
  year_month TEXT PRIMARY KEY,
  closed_at  TEXT NOT NULL
);
`;

/**
 * Append one event, ignoring **only** a repeat of the same `request_id`.
 *
 * `ON CONFLICT(request_id) DO NOTHING` rather than the `INSERT OR IGNORE` this
 * started as, and the difference is not stylistic. `OR IGNORE` suppresses
 * *every* constraint violation on the row — `NOT NULL` and `CHECK` as well as
 * `UNIQUE` — so a malformed event would be dropped silently and then counted as
 * `alreadyPresent`, which reads as "a flush was retried" rather than as "a
 * billing record was thrown away". That is a data loss disguised as a benign
 * number, in the table we invoice from.
 *
 * Targeting the conflict names the one case we mean: a batch that committed and
 * was then retried inserts nothing the second time, and anything else about the
 * row still raises, aborts the transaction, and leaves the batch for the meter
 * to retry intact. Found by a test that expected a bad row to throw and watched
 * it vanish instead.
 */
const INSERT_EVENT = `
INSERT INTO usage_events (
  request_id, received_at, account_id, key_id, method, route_template,
  query_params, status, row_count, response_bytes, duration_ms, billable,
  idempotency_key, request_fingerprint, duplicate_of, client_ip, user_agent,
  pii_scrubbed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
ON CONFLICT(request_id) DO NOTHING
`;

/**
 * Earlier requests this one could be a retry of.
 *
 * Matched on account, idempotency key **and** fingerprint. The fingerprint is
 * the part ABL-293 §2c does not specify and the part that makes the header safe
 * to honour: without it a client can pin one `Idempotency-Key` to every request
 * it ever makes and be billed for one of them.
 */
const FIND_IDEMPOTENT_PRIOR = `
SELECT request_id, COUNT(*) OVER () AS prior_count
  FROM usage_events
 WHERE account_id = ?
   AND idempotency_key = ?
   AND request_fingerprint = ?
   AND received_at >= ?
 ORDER BY received_at, id
 LIMIT 1
`;

/**
 * Fold a range of events into the rollup.
 *
 * `WHERE true` before `ON CONFLICT` is not decoration: with an
 * `INSERT … SELECT`, SQLite's parser cannot otherwise tell the upsert clause
 * from a continuation of the SELECT.
 *
 * ## Where a month's counts are routed, and why the join decides it
 *
 * A closed month is final. Events that arrive for it afterwards are counted in
 * the two `late_*` columns, where somebody investigating a dispute can see
 * them, and are never folded into a figure that has already been invoiced.
 *
 * The routing is decided by the `LEFT JOIN` against `usage_month_close` — the
 * month's own closed state — and **not** by `usage_rollup.closed_at`, which is
 * the state of a row that may not exist yet. Those two are the same thing for
 * every row present when the month closed, and differ for exactly the case that
 * used to over-count: the first event of a month arriving on a key that has no
 * row in it, after that month closed. See the `usage_month_close` comment.
 *
 * The aggregate is a subquery so the join is against one row per group rather
 * than per event, and so `DO UPDATE` can add `excluded.*` unconditionally: the
 * SELECT has already put each count in the column it belongs in. Only
 * `first_event_at`/`last_event_at` still test the row's own `closed_at`, to
 * hold the window of a closed month fixed at what was invoiced.
 */
const ROLL_UP = `
INSERT INTO usage_rollup (
  account_id, key_id, year_month, requests, billable_requests,
  rows_returned, response_bytes, first_event_at, last_event_at,
  closed_at, late_requests, late_billable_requests
)
SELECT g.account_id,
       g.key_id,
       g.year_month,
       CASE WHEN c.closed_at IS NULL THEN g.requests ELSE 0 END,
       CASE WHEN c.closed_at IS NULL THEN g.billable_requests ELSE 0 END,
       CASE WHEN c.closed_at IS NULL THEN g.rows_returned ELSE 0 END,
       CASE WHEN c.closed_at IS NULL THEN g.response_bytes ELSE 0 END,
       g.first_event_at,
       g.last_event_at,
       -- Born closed when the month already is, so the row can never be read as
       -- an open month that is still accruing.
       c.closed_at,
       CASE WHEN c.closed_at IS NULL THEN 0 ELSE g.requests END,
       CASE WHEN c.closed_at IS NULL THEN 0 ELSE g.billable_requests END
  FROM (
    SELECT account_id,
           key_id,
           substr(received_at, 1, 7)          AS year_month,
           COUNT(*)                           AS requests,
           SUM(billable)                      AS billable_requests,
           COALESCE(SUM(row_count), 0)        AS rows_returned,
           COALESCE(SUM(response_bytes), 0)   AS response_bytes,
           MIN(received_at)                   AS first_event_at,
           MAX(received_at)                   AS last_event_at
      FROM usage_events
     WHERE id > ? AND id <= ?
     GROUP BY account_id, key_id, substr(received_at, 1, 7)
  ) g
  LEFT JOIN usage_month_close c ON c.year_month = g.year_month
 WHERE true
ON CONFLICT(account_id, key_id, year_month) DO UPDATE SET
  requests = usage_rollup.requests + excluded.requests,
  billable_requests = usage_rollup.billable_requests + excluded.billable_requests,
  rows_returned = usage_rollup.rows_returned + excluded.rows_returned,
  response_bytes = usage_rollup.response_bytes + excluded.response_bytes,
  first_event_at = CASE
    WHEN usage_rollup.closed_at IS NULL
    THEN MIN(usage_rollup.first_event_at, excluded.first_event_at)
    ELSE usage_rollup.first_event_at END,
  last_event_at = CASE
    WHEN usage_rollup.closed_at IS NULL
    THEN MAX(usage_rollup.last_event_at, excluded.last_event_at)
    ELSE usage_rollup.last_event_at END,
  late_requests = usage_rollup.late_requests + excluded.late_requests,
  late_billable_requests =
    usage_rollup.late_billable_requests + excluded.late_billable_requests
`;

/**
 * Requests one account had served in a month — the live quota figure (ABL-302).
 *
 * Three things about this statement are deliberate:
 *
 * - **A half-open `received_at` range, not `substr(received_at, 1, 7) = ?`.** The
 *   substring form is the obvious way to write it, reads better, and cannot use
 *   `idx_usage_events_account_received`: a function of the column is not
 *   sargable, so it degrades to a scan of every event the account has ever sent.
 *   This runs on a request path, once per account per re-seed interval, and the
 *   difference is an index seek against a table that grows by one row per
 *   request forever.
 * - **`status <> THROTTLED_STATUS`.** See that constant. Quota counts requests we
 *   served, and a 429 is one we refused.
 * - **Every key of the account, summed.** The plan is sold to the account, so the
 *   quota belongs to the account; `usage_rollup` keeps the per-key split for the
 *   invoice and for key-sharing investigation.
 */
const COUNT_SERVED_IN_MONTH = `
SELECT COUNT(*) AS v
  FROM usage_events
 WHERE account_id = ?
   AND received_at >= ?
   AND received_at < ?
   AND status <> ${THROTTLED_STATUS}
`;

/**
 * The first instant of a `YYYY-MM`, in the same text form `received_at` holds.
 *
 * `Date#toISOString()` is what the meter writes, so the bounds are built the same
 * way rather than by string concatenation: comparing `2026-08-01T00:00:00.000Z`
 * against `2026-08-01T00:00:00.000Z` is a string comparison that works only
 * because both sides are that exact fixed-width form.
 */
function monthStartIso(yearMonth: string): string {
  return new Date(`${yearMonth}-01T00:00:00.000Z`).toISOString();
}

function readRollup(row: Record<string, unknown>): UsageRollupRow {
  return {
    accountId: row.account_id as string,
    keyId: row.key_id as string,
    yearMonth: row.year_month as string,
    requests: row.requests as number,
    billableRequests: row.billable_requests as number,
    rowsReturned: row.rows_returned as number,
    responseBytes: row.response_bytes as number,
    firstEventAt: row.first_event_at as string,
    lastEventAt: row.last_event_at as string,
    closedAt: (row.closed_at as string | null) ?? null,
    lateRequests: row.late_requests as number,
    lateBillableRequests: row.late_billable_requests as number,
  };
}

export interface OpenUsageStoreOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides what {@link resolveRetentionPolicy} reads from the environment. */
  policy?: RetentionPolicy;
}

/**
 * Open the usage store read-write, applying its schema.
 *
 * `fileMustExist` so this can never create a stray database of its own: the
 * file is the key store's, created by `npm run keys`, and a path typo must fail
 * rather than quietly start metering into an empty file nobody will look in.
 * The `api_keys` check is the same idea one level down — a real SQLite file at
 * the wrong path is still the wrong path.
 *
 * The schema itself *is* applied here rather than by the CLI, which is the one
 * place this module departs from `sqliteApiKeyStore.ts`'s split. A key store
 * that has not been created refuses every request loudly; a metering table that
 * has not been created would let the API serve traffic and bill nobody, which
 * is the silent under-count this whole issue exists to prevent. The DDL is
 * confined to the three tables above, in a file that `resolveApiKeysDbPath`
 * will not let be the energy database.
 */
export function openUsageStore({
  env = process.env,
  policy,
}: OpenUsageStoreOptions = {}): UsageAdminStore {
  const dbPath = resolveApiKeysDbPath(env);
  const retention = policy ?? resolveRetentionPolicy(env);

  let db: DatabaseType;
  try {
    db = new Database(dbPath, { fileMustExist: true });
  } catch (err) {
    throw new Error(
      `Cannot open the /v1 usage store at ${dbPath}: ${(err as Error).message}. ` +
        'Usage records live in the same file as the key store; create it with ' +
        '`npm run keys -- accounts:create --name "..." --plan explorer` in server/.'
    );
  }

  const isKeyStore = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'")
    .get();
  if (!isKeyStore) {
    db.close();
    throw new Error(
      `The file at ${dbPath} has no api_keys table, so it is not a /v1 key store and usage ` +
        'tables do not belong in it. Check API_KEYS_DB_PATH.'
    );
  }

  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);

  // The auth-failure record (ABL-530), on this same handle rather than on a
  // fourth one. `sqliteAuthFailureStore.ts` holds its schema and its SQL and
  // imports `better-sqlite3` for its *type* only, so `publicAppGraph.test.ts`'s
  // "exactly three modules open a database" assertion is unaffected — which is
  // the assertion, and not the module count, that was ever the control.
  //
  // Same file for a reason that is not tidiness: that table holds `client_ip` and
  // `user_agent`, so it is inside the ABL-297 §5 promise from its first row and
  // has to be scrubbed by `applyRetention` below, atomically, on the same
  // boundary. A second store would be a second retention job, and the forgotten
  // one would be the table nobody had ever printed a compliance line for.
  const authFailures = createAuthFailureStore(db);

  const insertEvent = db.prepare(INSERT_EVENT);
  const findPrior = db.prepare(FIND_IDEMPOTENT_PRIOR);
  const rollUpRange = db.prepare(ROLL_UP);
  const countServedInMonth = db.prepare(COUNT_SERVED_IN_MONTH);

  function readWatermark(): number {
    const row = db
      .prepare('SELECT rolled_through_event_id AS id FROM usage_rollup_state WHERE id = 1')
      .get() as { id: number } | undefined;
    return row?.id ?? 0;
  }

  function writeWatermark(id: number, at: string): void {
    db.prepare(
      `INSERT INTO usage_rollup_state (id, rolled_through_event_id, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET rolled_through_event_id = excluded.rolled_through_event_id,
                                     updated_at = excluded.updated_at`
    ).run(id, at);
  }

  /**
   * Decide whether one event is a retry of an earlier one.
   *
   * Returns the `request_id` it duplicates, or `null`. Runs inside the write
   * transaction, so it sees events inserted earlier in the same batch — a retry
   * storm that arrives inside one flush is recognised just as one that arrives
   * across two.
   */
  function findDuplicateOf(event: UsageEvent): string | null {
    if (event.idempotencyKey === null) return null;

    const windowStart = new Date(
      Date.parse(event.receivedAt) - IDEMPOTENCY_WINDOW_MS
    ).toISOString();

    const row = findPrior.get(
      event.accountId,
      event.idempotencyKey,
      event.fingerprint,
      windowStart
    ) as { request_id: string; prior_count: number } | undefined;

    if (!row) return null;
    // Past the cap this is no longer a retry, it is a polling loop, and traffic
    // we served is traffic we bill. See IDEMPOTENT_SUPPRESSION_LIMIT.
    if (row.prior_count > IDEMPOTENT_SUPPRESSION_LIMIT) return null;
    return row.request_id;
  }

  const writeBatch = db.transaction((events: readonly UsageEvent[]): UsageWriteOutcome => {
    let inserted = 0;
    let alreadyPresent = 0;
    let suppressedAsDuplicate = 0;

    for (const event of events) {
      const duplicateOf = findDuplicateOf(event);
      const billable = event.billable && duplicateOf === null;
      if (event.billable && !billable) suppressedAsDuplicate += 1;

      const result = insertEvent.run(
        event.requestId,
        event.receivedAt,
        event.accountId,
        event.keyId,
        event.method,
        event.routeTemplate,
        event.queryParams,
        event.status,
        event.rowCount,
        event.responseBytes,
        event.durationMs,
        billable ? 1 : 0,
        event.idempotencyKey,
        event.fingerprint,
        duplicateOf,
        // The two personal-data fields, bound last and cleared later by
        // `applyRetention`. `pii_scrubbed_at` is the literal NULL in the
        // statement rather than a parameter: it is the retention job's to set,
        // never the write path's, so there is no argument position here that
        // could accidentally mark a fresh row as already scrubbed.
        event.clientIp,
        event.userAgent
      );

      if (result.changes === 1) inserted += 1;
      else alreadyPresent += 1;
    }

    return { inserted, alreadyPresent, suppressedAsDuplicate };
  });

  const rollUp = db.transaction((maxEvents: number): RollUpOutcome => {
    const watermark = readWatermark();
    const maxId =
      (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM usage_events').get() as { id: number })
        .id;

    if (maxId <= watermark) {
      return { events: 0, rows: 0, rolledThroughEventId: watermark, moreRemaining: false };
    }

    // Bounded by id range rather than by row count, which is the same thing
    // until retention has removed rows and is cheaper to reason about either
    // way: the next pass simply starts where this one stopped.
    const ceiling = Math.min(maxId, watermark + maxEvents);
    const events = (
      db
        .prepare('SELECT COUNT(*) AS n FROM usage_events WHERE id > ? AND id <= ?')
        .get(watermark, ceiling) as { n: number }
    ).n;

    const rows = rollUpRange.run(watermark, ceiling).changes;
    writeWatermark(ceiling, new Date().toISOString());

    return { events, rows, rolledThroughEventId: ceiling, moreRemaining: ceiling < maxId };
  });

  const closeMonths = db.transaction((now: Date): CloseMonthsOutcome => {
    const watermark = readWatermark();
    const nowIso = now.toISOString();
    const graceMs = retention.monthCloseGraceDays * 86_400_000;

    const openMonths = (
      db
        .prepare(
          'SELECT DISTINCT year_month FROM usage_rollup WHERE closed_at IS NULL ORDER BY year_month'
        )
        .all() as Array<{ year_month: string }>
    ).map((row) => row.year_month);

    const closed: string[] = [];
    const deferred: string[] = [];

    for (const yearMonth of openMonths) {
      if (now.getTime() < monthEndExclusive(yearMonth).getTime() + graceMs) continue;

      // Refuse to close over the top of events that are not in the rollup yet.
      // Ordering the maintenance pass as roll-up-then-close would usually make
      // this vacuous; relying on the call order for a figure this size is how a
      // month's tail silently stops being billable.
      const pending = (
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM usage_events WHERE substr(received_at, 1, 7) = ? AND id > ?'
          )
          .get(yearMonth, watermark) as { n: number }
      ).n;

      if (pending > 0) {
        deferred.push(yearMonth);
        continue;
      }

      // Both writes, in this one transaction. The rows record what was
      // invoiced; the month record is what a *later* row for this month is
      // judged against, and a row created after this point is born closed
      // because of it. Splitting them would reintroduce the over-count in the
      // window between the two statements.
      //
      // `DO NOTHING` rather than an overwrite: a month closes once, and the
      // timestamp of that first closing is the one an invoice was raised
      // against.
      db.prepare(
        `INSERT INTO usage_month_close (year_month, closed_at) VALUES (?, ?)
         ON CONFLICT(year_month) DO NOTHING`
      ).run(yearMonth, nowIso);
      db.prepare(
        'UPDATE usage_rollup SET closed_at = ? WHERE year_month = ? AND closed_at IS NULL'
      ).run(nowIso, yearMonth);
      closed.push(yearMonth);
    }

    return { closed, deferred };
  });

  const applyRetention = db.transaction((now: Date): RetentionOutcome => {
    const nowIso = now.toISOString();
    const scrubBefore = subtractDays(now, retention.piiDays).toISOString();
    const deleteBefore = subtractMonths(now, retention.eventMonths).toISOString();

    const scrubbed = db
      .prepare(
        `UPDATE usage_events
            SET client_ip = NULL, user_agent = NULL, pii_scrubbed_at = ?
          WHERE received_at < ? AND pii_scrubbed_at IS NULL`
      )
      .run(nowIso, scrubBefore).changes;

    // Deletion is gated on the watermark. An event that has not been aggregated
    // is an event missing from an invoice if it is deleted, so it is kept
    // instead and the number is reported — the correct response to "the rollup
    // has been broken for thirteen months" is to fix the rollup, never to
    // delete the evidence.
    const watermark = readWatermark();
    const keptPendingRollup = (
      db
        .prepare('SELECT COUNT(*) AS n FROM usage_events WHERE received_at < ? AND id > ?')
        .get(deleteBefore, watermark) as { n: number }
    ).n;

    const deleted = db
      .prepare('DELETE FROM usage_events WHERE received_at < ? AND id <= ?')
      .run(deleteBefore, watermark).changes;

    // Inside this same transaction, on the same two boundaries. Both tables hold
    // an address, `usage:stats` reports one compliance figure across both, and a
    // pass that committed one and failed the other would print a non-zero total
    // with no failed job to point at.
    return {
      scrubbed,
      deleted,
      keptPendingRollup,
      authFailures: authFailures.applyAuthFailureRetention(scrubBefore, deleteBefore, nowIso),
    };
  });

  return {
    // The auth-failure record's append and its four investigation reads
    // (ABL-530). Spread first so the explicit members below cannot be shadowed
    // by one of them: `applyRetention` and `stats` here are the whole-store
    // versions and must win over anything the sub-store happens to export.
    ...authFailures,

    writeEvents(events) {
      if (events.length === 0) {
        return { inserted: 0, alreadyPresent: 0, suppressedAsDuplicate: 0 };
      }
      return writeBatch(events);
    },

    rollUp({ maxEvents = ROLLUP_BATCH_EVENTS } = {}) {
      return rollUp(maxEvents);
    },

    closeMonths,

    applyRetention,

    monthlyUsage(yearMonth) {
      return (
        db
          .prepare(
            'SELECT * FROM usage_rollup WHERE year_month = ? ORDER BY account_id, key_id'
          )
          .all(yearMonth) as Record<string, unknown>[]
      ).map(readRollup);
    },

    servedRequestsInMonth(accountId, yearMonth) {
      return (
        countServedInMonth.get(
          accountId,
          monthStartIso(yearMonth),
          monthEndExclusive(yearMonth).toISOString()
        ) as { v: number }
      ).v;
    },

    exportAccount(accountId): AccountUsageExport {
      return {
        exportedAt: new Date().toISOString(),
        accountId,
        // Every column of `api_keys` **except** `secret_sha256`, named
        // explicitly rather than taken with `SELECT *`.
        //
        // A subject access request is answered with the data we hold *about*
        // the subject; a key hash is a credential, and handing one out — in a
        // file that by definition travels outside the system, often by email —
        // would turn a privacy obligation into a credential disclosure. Listing
        // the columns rather than deleting the field afterwards means a column
        // added to `api_keys` later is absent from the export until somebody
        // decides it belongs, which is the right default for this direction.
        keys: db
          .prepare(
            `SELECT id, account_id, key_env, key_prefix, label, created_at,
                    expires_at, revoked_at, revoked_reason
               FROM api_keys WHERE account_id = ? ORDER BY created_at, id`
          )
          .all(accountId) as Array<Record<string, unknown>>,
        events: db
          .prepare('SELECT * FROM usage_events WHERE account_id = ? ORDER BY id')
          .all(accountId) as Array<Record<string, unknown>>,
        rollups: (
          db
            .prepare(
              'SELECT * FROM usage_rollup WHERE account_id = ? ORDER BY year_month, key_id'
            )
            .all(accountId) as Record<string, unknown>[]
        ).map(readRollup),
      };
    },

    stats(now) {
      const one = <T>(sql: string, ...params: unknown[]): T =>
        (db.prepare(sql).get(...params) as { v: T }).v;

      const watermark = readWatermark();
      const scrubBefore = subtractDays(now, retention.piiDays).toISOString();
      const authFailureStats = authFailures.authFailureStats(scrubBefore);
      const unscrubbedUsageEvents = one<number>(
        `SELECT COUNT(*) AS v FROM usage_events
          WHERE received_at < ? AND (client_ip IS NOT NULL OR user_agent IS NOT NULL)`,
        scrubBefore
      );

      return {
        events: one<number>('SELECT COUNT(*) AS v FROM usage_events'),
        unrolledEvents: one<number>('SELECT COUNT(*) AS v FROM usage_events WHERE id > ?', watermark),
        rollupRows: one<number>('SELECT COUNT(*) AS v FROM usage_rollup'),
        closedMonths: one<number>(
          'SELECT COUNT(DISTINCT year_month) AS v FROM usage_rollup WHERE closed_at IS NOT NULL'
        ),
        rolledThroughEventId: watermark,
        oldestEventAt: one<string | null>('SELECT MIN(received_at) AS v FROM usage_events'),
        newestEventAt: one<string | null>('SELECT MAX(received_at) AS v FROM usage_events'),
        // The ABL-297 §5 check. Counts rows past the boundary that still hold
        // either personal-data field — not rows where `pii_scrubbed_at` is
        // unset, which would also count rows that never had an IP to begin
        // with and would make a clean store look non-compliant.
        //
        // The **sum across both tables** since ABL-530. A figure that kept
        // covering `usage_events` alone while `auth_failures` filled with
        // addresses would still print COMPLIANT, and a check that silently
        // stopped covering a table is worse than one that was never claimed.
        unscrubbedPastPii: unscrubbedUsageEvents + authFailureStats.unscrubbedPastPii,
        unscrubbedPastPiiByTable: {
          usageEvents: unscrubbedUsageEvents,
          authFailures: authFailureStats.unscrubbedPastPii,
        },
        authFailures: authFailureStats,
      };
    },

    close() {
      db.close();
    },
  };
}

/** Re-exported so callers configuring a store do not need two imports. */
export { DEFAULT_RETENTION_POLICY, resolveRetentionPolicy };
