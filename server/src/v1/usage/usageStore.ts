import { createHash } from 'node:crypto';

/**
 * What a usage record is, what may be written into one, and the two
 * capabilities over them.
 *
 * Types and pure functions only — no import here reaches a database driver, so
 * `publicApp.ts` and `usageMeter.ts` can name these without putting
 * `better-sqlite3` in their graph. `sqliteUsageStore.ts` is the implementation
 * and is reached only from the entrypoint and the usage CLI, exactly as
 * `apiKeyStore.ts` stands to `sqliteApiKeyStore.ts`.
 *
 * ## The one sentence this file exists to make true
 *
 * **This is the number a customer gets billed on.** Everywhere a failure forces
 * a choice between counting a request twice and not counting it at all, this
 * module chooses not to count it, and says so at the line where the choice is
 * made. An invoice that is slightly low is a margin we absorb quietly; an
 * invoice that is slightly high is a refund, an apology and a customer who now
 * checks every future invoice by hand.
 */

/** Where the billing month comes from: `received_at`, in UTC, always. */
export const YEAR_MONTH_LENGTH = 'YYYY-MM'.length;

/**
 * One metered request.
 *
 * Field-for-field the ABL-293 §2c list, plus the three fields the ABL-297
 * privacy notice §3.3 commits us to holding (`clientIp`, `userAgent`) or needs
 * in order to hold them honestly (`piiScrubbedAt`, set by the retention job
 * rather than at write time).
 */
export interface UsageEvent {
  /**
   * Unique per request, and `UNIQUE` in the table.
   *
   * This is what makes a flush idempotent: a batch that commits and then
   * reports an error is retried against `ON CONFLICT(request_id) DO NOTHING`,
   * and the retry inserts nothing. Without it the one failure mode that
   * *over*-counts is merely unlikely rather than impossible.
   */
  requestId: string;
  /** ISO 8601 UTC. The billing month is `substr(receivedAt, 0, 7)`. */
  receivedAt: string;
  accountId: string;
  keyId: string;
  method: string;
  /**
   * The route *template* — `/v1/observations/load` — never the raw URL.
   *
   * Raw URLs carry a customer's query patterns and explode the cardinality of
   * every aggregate over this column (ABL-293 §2c). They are also the obvious
   * accidental route for a customer identifier to reach the log, which is what
   * ABL-297 §9(5) forbids.
   */
  routeTemplate: string;
  /** Allowlisted parameters only, canonicalised. See {@link canonicaliseQuery}. */
  queryParams: string | null;
  status: number;
  /** Rows served, when a handler reported them (ABL-303). `null` means "not reported". */
  rowCount: number | null;
  /** Response bytes, when the response carried a length. See {@link UsageEvent.rowCount}'s neighbour note in `usageMeter.ts`. */
  responseBytes: number | null;
  durationMs: number;
  /** Whether this request goes on an invoice. See {@link isBillableStatus}. */
  billable: boolean;
  /** The client's `Idempotency-Key`, if it sent one. */
  idempotencyKey: string | null;
  /** `sha256(method + route + allowlisted params)`. See {@link requestFingerprint}. */
  fingerprint: string;
  /**
   * Source IP, for rate limiting, key-sharing detection and security
   * investigation (ABL-297 §3.3).
   *
   * **This single field is why the privacy notice exists** — an IP is personal
   * data under the GDPR — and it is why the retention job below is not
   * optional.
   */
  clientIp: string | null;
  userAgent: string | null;
}

/** What the request path is given: append, and nothing else. */
export interface UsageSink {
  /**
   * Append a batch. Must be atomic and must be safe to call twice with the
   * same events — see {@link UsageEvent.requestId}.
   */
  writeEvents(events: readonly UsageEvent[]): UsageWriteOutcome;
}

export interface UsageWriteOutcome {
  /** Rows actually inserted. */
  inserted: number;
  /**
   * Rows that were already present, matched on `request_id`.
   *
   * Non-zero means a flush was retried after committing. That is the designed
   * behaviour rather than an error, but it is counted so that a store retrying
   * every batch shows up as a number instead of as silence.
   */
  alreadyPresent: number;
  /**
   * Rows written with `billable = false` because they duplicate an earlier
   * request under the same `Idempotency-Key`. See
   * {@link IDEMPOTENT_SUPPRESSION_LIMIT}.
   */
  suppressedAsDuplicate: number;
}

/** A single account's month, as the rollup holds it. */
export interface UsageRollupRow {
  accountId: string;
  keyId: string;
  /** `YYYY-MM`, UTC. */
  yearMonth: string;
  requests: number;
  billableRequests: number;
  rowsReturned: number;
  responseBytes: number;
  firstEventAt: string;
  lastEventAt: string;
  /** Set once the month is final. A closed month is never modified again. */
  closedAt: string | null;
  /** Requests that arrived for this month *after* it closed. Never billed. */
  lateRequests: number;
  lateBillableRequests: number;
}

export interface RollUpOutcome {
  /** Events aggregated on this pass. */
  events: number;
  /** Rollup rows created or updated. */
  rows: number;
  /** The watermark after this pass. */
  rolledThroughEventId: number;
  /** True when the batch cap stopped this pass short and more work remains. */
  moreRemaining: boolean;
}

export interface CloseMonthsOutcome {
  closed: string[];
  /**
   * Months that were due to close but could not, because events belonging to
   * them are not yet in the rollup. Reported rather than forced: closing a
   * month over the top of un-aggregated events is how an invoice silently
   * loses requests.
   */
  deferred: string[];
}

export interface RetentionOutcome {
  /** Rows whose `client_ip` and `user_agent` were cleared. */
  scrubbed: number;
  /** Rows deleted outright. */
  deleted: number;
  /**
   * Rows past the deletion boundary that were **kept**, because the rollup has
   * not aggregated them yet.
   *
   * A non-zero number here is a real alert: it means the rollup has been broken
   * for longer than the retention window, and the correct response is to fix
   * the rollup, not to delete the evidence. Deleting an un-aggregated event
   * removes it from the invoice for good.
   */
  keptPendingRollup: number;
}

/**
 * What the store currently holds, for an operator and for a compliance check.
 *
 * The two fields worth the most are the last two, and both are *evidence* for a
 * sentence we publish rather than statistics:
 *
 * - `unrolledEvents` non-zero and not falling means the materialised aggregate
 *   is drifting from the raw log, which is the state in which a month cannot
 *   close and retention starts keeping rows.
 * - `unscrubbedPastPii` is the direct check on ABL-297 §5. It should be zero
 *   every time it is read. Anything else is a request record still holding an IP
 *   address past the period we told a subscriber we would delete it — a
 *   published commitment we are demonstrably not meeting, which is exactly what
 *   §5 says is worse than having no policy at all.
 */
export interface UsageStoreStats {
  events: number;
  /** Events not yet aggregated into the rollup. */
  unrolledEvents: number;
  rollupRows: number;
  closedMonths: number;
  rolledThroughEventId: number;
  oldestEventAt: string | null;
  newestEventAt: string | null;
  /** Records past `piiDays` that still hold an IP or user agent. Must be 0. */
  unscrubbedPastPii: number;
}

/** Everything the operator and the invoice need. Held by the CLI and the maintenance timer. */
export interface UsageAdminStore extends UsageSink {
  /** Aggregate new events into `usage_rollup`. Idempotent; safe to run at any time. */
  rollUp(options?: { maxEvents?: number }): RollUpOutcome;
  /** Finalise every month that is past its grace period and fully aggregated. */
  closeMonths(now: Date): CloseMonthsOutcome;
  /** Apply the ABL-297 §5 boundaries. See {@link RetentionPolicy}. */
  applyRetention(now: Date): RetentionOutcome;
  /** The billable figure for a month, from the rollup and never from the raw events. */
  monthlyUsage(yearMonth: string): UsageRollupRow[];
  /**
   * Requests **served** to one account in a `YYYY-MM`, for the quota ABL-302
   * enforces. Excludes {@link THROTTLED_STATUS}: a refusal is recorded traffic
   * but never consumed quota.
   *
   * Read from `usage_events` and deliberately **not** from `usage_rollup`, which
   * is the opposite of the rule {@link monthlyUsage} follows, so the difference
   * is worth stating. An invoice is raised once, after the month has closed, and
   * must come from the materialised aggregate that survives retention. A quota is
   * enforced on the next request, against a month still open, and the rollup lags
   * it by a maintenance interval — enforcing against a figure that is minutes
   * stale would let a burst through in exactly the window a burst arrives in.
   *
   * Satisfies {@link MonthlyUsageReader} in `quota/monthlyQuota.ts`, which is the
   * only shape of this store the request path is ever given.
   */
  servedRequestsInMonth(accountId: string, yearMonth: string): number;
  /** Everything held about one account, for a subject access request (ABL-297 §9.3). */
  exportAccount(accountId: string): AccountUsageExport;
  /** Counts and the retention check. See {@link UsageStoreStats}. */
  stats(now: Date): UsageStoreStats;
  close(): void;
}

/** The shape a subject access request is answered with. */
export interface AccountUsageExport {
  exportedAt: string;
  accountId: string;
  /** Never contains `secret_sha256`; a key hash is a credential, not a subject's data. */
  keys: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  rollups: UsageRollupRow[];
}

/*
 * ---------------------------------------------------------------------------
 * Billability
 * ---------------------------------------------------------------------------
 */

/**
 * Whether a response is charged for.
 *
 * `2xx` only, and the exclusions are each a deliberate under-count:
 *
 * - **`4xx`** — the caller's mistake, recorded and not billed (ABL-293 §2c).
 *   It still counts toward the rate limit, which is ABL-302's to enforce, so a
 *   broken client cannot use errors as free unlimited traffic.
 * - **`5xx`** — our fault. Never billable, under any circumstance.
 * - **`3xx`** — no data was served. There are no redirects on this surface and
 *   a `304` returns an empty body. If ABL-303 adds conditional requests and we
 *   decide a validated cache hit is worth charging for, that is a deliberate
 *   edit to this function with a test attached, not a reinterpretation of what
 *   the old rows meant.
 *
 * Kept as a named pure function rather than an inline `status < 400` precisely
 * so that changing it is a diff somebody reviews.
 */
export function isBillableStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * The status a request refused by the plan gate carries (ABL-302).
 *
 * One constant with two consumers, and they must not be able to drift. `planGate`
 * answers with it; {@link UsageAdminStore.servedRequestsInMonth} excludes it. If
 * the two ever disagreed, the durable seed for a quota would count requests the
 * quota refused — which on a hard-stop plan is a customer permanently locked out
 * a little early, and on a soft-overage plan is a euro billed for a request we
 * did not serve.
 *
 * Nothing else on this surface produces a 429, which is what makes the exclusion
 * exact rather than approximate. That is a property of the code as it stands and
 * not a law: a second source of 429 would need this comment read again, which is
 * why it is written here rather than left as a `<> 429` in a query.
 */
export const THROTTLED_STATUS = 429;

/*
 * ---------------------------------------------------------------------------
 * What of the request reaches the log
 * ---------------------------------------------------------------------------
 */

/**
 * Query parameters that may be recorded, by name.
 *
 * **An allowlist, and that is the whole control.** ABL-297 §9(5) requires that
 * a future endpoint accepting a free-text or customer-supplied identifier must
 * not have that parameter logged. A denylist would depend on somebody
 * remembering to add it at the moment they add the parameter — which is the
 * moment they are thinking about the feature, not about the log. With an
 * allowlist the new parameter is excluded because nobody listed it, so the
 * default is the safe one and the mistake is unrepresentable rather than
 * unlikely.
 *
 * The cost of the list being short is a slightly less useful log; the cost of
 * it being long is a personal-data vector. It is short on purpose and grows by
 * hand as ABL-303 lands endpoints.
 */
export const LOGGED_QUERY_PARAMETERS: readonly string[] = [
  'country',
  'countries',
  'zone',
  'border',
  'start',
  'end',
  'date',
  'granularity',
  'resolution',
  'horizon',
  'model',
  'limit',
  'cursor',
];

/**
 * A backstop on the allowlist, not a substitute for it.
 *
 * Every allowlisted parameter above is a market-data value — a country code, a
 * date, a model name — and none of them is close to this long. The cap is here
 * so that an allowlisted parameter which later starts accepting something
 * larger cannot quietly turn the log into a store of whatever the caller sent.
 */
export const MAX_LOGGED_PARAMETER_VALUE_LENGTH = 64;

/** Express's parsed query, loosely typed because `qs` can yield nested values. */
export type RequestQuery = Record<string, unknown>;

/**
 * Canonicalise the allowlisted query parameters into one stable string.
 *
 * Sorted by name and joined with `&`, so the same logical request produces the
 * same string whatever order the client sent the parameters in — which is what
 * makes {@link requestFingerprint} able to recognise a retry. Repeated
 * parameters are joined with `,`. Anything not on the allowlist is dropped
 * without trace; anything nested or non-scalar is dropped too, because a value
 * we cannot render as a short scalar is a value we have not thought about.
 *
 * Returns `null` rather than `''` when nothing survives, so "no parameters" and
 * "parameters we chose not to record" are the same thing in the column, which
 * they are.
 */
export function canonicaliseQuery(query: RequestQuery | undefined): string | null {
  if (!query) return null;

  const parts: string[] = [];
  for (const name of [...LOGGED_QUERY_PARAMETERS].sort()) {
    const raw = query[name];
    if (raw === undefined || raw === null) continue;

    const scalars = (Array.isArray(raw) ? raw : [raw]).filter(
      (v): v is string | number | boolean =>
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    );
    if (scalars.length === 0) continue;

    const value = scalars.map(String).join(',').slice(0, MAX_LOGGED_PARAMETER_VALUE_LENGTH);
    parts.push(`${name}=${value}`);
  }

  return parts.length === 0 ? null : parts.join('&');
}

/**
 * A stable identity for "the same logical call".
 *
 * Used only to decide whether an `Idempotency-Key` match is a genuine retry.
 * Hashed rather than stored in the clear so the column cannot become a second,
 * un-allowlisted copy of the request; the inputs are already scrubbed by
 * {@link canonicaliseQuery} either way.
 */
export function requestFingerprint(
  method: string,
  routeTemplate: string,
  queryParams: string | null
): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()} ${routeTemplate}?${queryParams ?? ''}`)
    .digest('hex');
}

/*
 * ---------------------------------------------------------------------------
 * Idempotency — the double-count failure mode
 * ---------------------------------------------------------------------------
 */

/**
 * How long after a request another identical one is treated as its retry.
 *
 * The ABL-293 §2c figure. It is generous for the case it exists to cover — a
 * client that timed out and retried does so in seconds — and the generosity is
 * deliberate, because every hour of it is an hour in which we under-bill rather
 * than double-bill.
 */
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How many repeats one `Idempotency-Key` may suppress before the rest are
 * billed again.
 *
 * ABL-293 §2c specifies the key and the window but not a limit, and without one
 * the header is a free-traffic switch: a client that sends a constant
 * `Idempotency-Key` on every request pays for one request a day. Two things
 * close that, and both are needed:
 *
 * 1. The {@link requestFingerprint} must match too, so a pinned key across
 *    *different* calls suppresses nothing.
 * 2. This cap, so a pinned key against the *same* call suppresses a retry storm
 *    and then stops. Five is chosen against real retry policies, which give up
 *    after three to five attempts; a sixth identical call inside the window is
 *    a polling loop, and a polling loop is traffic we served.
 *
 * The residual exposure is bounded and stated rather than hidden: at most five
 * requests per key per fingerprint per window go unbilled, and every one of them
 * still counts toward the quota ABL-302 enforces, because that quota counts
 * requests and not billable requests.
 */
export const IDEMPOTENT_SUPPRESSION_LIMIT = 5;

/*
 * ---------------------------------------------------------------------------
 * Retention — ABL-297 §5, which is a public commitment and not a preference
 * ---------------------------------------------------------------------------
 */

/**
 * The two boundaries, both read from configuration.
 *
 * ABL-297 §5 carries a Board decision of 2026-08-12 fixing the personal-data
 * period at **90 days**, and requires in terms that "the implementation must
 * read the period from configuration, so that if counsel prefers a different
 * number it is a config change and not a migration."
 *
 * ## Where this differs from ABL-293 §2c, and why the later document wins
 *
 * §2c says "keep `usage_events` for 90 days for dispute resolution, then
 * prune". ABL-297 §5 is later, is more precise, and is the text a subscriber
 * will be shown, so it governs: at 90 days the personal-data fields are
 * **cleared from the row**, and the de-identified remainder lives to 13 months.
 * Deleting the whole row at 90 days would satisfy the privacy half and quietly
 * break the other half of the same table — §5 promises 13 months of
 * de-identified records for capacity planning, and a promise we delete the
 * evidence of is not a promise.
 */
export interface RetentionPolicy {
  /** Days before `client_ip` and `user_agent` are cleared. ABL-297 §5: 90. */
  piiDays: number;
  /** Calendar months before the de-identified row is deleted. ABL-297 §5: 13. */
  eventMonths: number;
  /**
   * Days after a month ends before it may be closed.
   *
   * A month is closed once nothing more can be added to it, and closing is
   * irreversible, so the grace period is the margin for a maintenance pass that
   * did not run on time. Two days rather than zero because the alternative to
   * waiting is a month closed while its last hour of events is still buffered.
   */
  monthCloseGraceDays: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  piiDays: 90,
  eventMonths: 13,
  monthCloseGraceDays: 2,
};

const RETENTION_ENV = {
  piiDays: 'USAGE_PII_RETENTION_DAYS',
  eventMonths: 'USAGE_EVENT_RETENTION_MONTHS',
  monthCloseGraceDays: 'USAGE_MONTH_CLOSE_GRACE_DAYS',
} as const;

function readPositiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = (env[name] ?? '').trim();
  if (raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${name} must be a whole number of at least 1, and is "${raw}". This value is a ` +
        'published retention commitment (ABL-297 §5); a process that cannot read it should ' +
        'refuse to start rather than fall back to a default nobody chose.'
    );
  }
  return value;
}

/**
 * Read the policy, refusing a configuration that cannot be honoured.
 *
 * The one cross-field rule: the de-identified window must outlast the
 * personal-data window. Configured the other way round the rows would be
 * deleted before they were ever scrubbed — which is *more* private, and is
 * still wrong, because §5 states two distinct periods to two different
 * audiences and an implementation that collapses them makes one of those
 * statements false.
 */
export function resolveRetentionPolicy(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  const policy: RetentionPolicy = {
    piiDays: readPositiveInteger(env, RETENTION_ENV.piiDays, DEFAULT_RETENTION_POLICY.piiDays),
    eventMonths: readPositiveInteger(
      env,
      RETENTION_ENV.eventMonths,
      DEFAULT_RETENTION_POLICY.eventMonths
    ),
    monthCloseGraceDays: readPositiveInteger(
      env,
      RETENTION_ENV.monthCloseGraceDays,
      DEFAULT_RETENTION_POLICY.monthCloseGraceDays
    ),
  };

  if (policy.eventMonths * 28 < policy.piiDays) {
    throw new Error(
      `${RETENTION_ENV.eventMonths}=${policy.eventMonths} is shorter than ` +
        `${RETENTION_ENV.piiDays}=${policy.piiDays}, so request records would be deleted before ` +
        'their personal-data fields were ever cleared. ABL-297 §5 publishes both periods; set ' +
        'the event window to at least the personal-data window.'
    );
  }

  return policy;
}

/*
 * ---------------------------------------------------------------------------
 * Calendar arithmetic, in UTC, because the billing month is UTC
 * ---------------------------------------------------------------------------
 */

/** `YYYY-MM` for an instant, in UTC. The unit of account for an invoice. */
export function yearMonthOf(iso: string): string {
  return iso.slice(0, YEAR_MONTH_LENGTH);
}

export function subtractDays(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

/**
 * Subtract calendar months in UTC, clamping to the end of the target month.
 *
 * Calendar months rather than an approximation in days, because "13 months" is
 * what ABL-297 §5 publishes and 13 × 30.44 is a number nobody agreed to. The
 * clamp is the ordinary one: 31 March minus one month is 28 (or 29) February,
 * not 3 March.
 */
export function subtractMonths(now: Date, months: number): Date {
  const target = new Date(now.getTime());
  const day = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() - months);
  const daysInTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTargetMonth));
  return target;
}

/** The first instant *after* a `YYYY-MM`, in UTC. */
export function monthEndExclusive(yearMonth: string): Date {
  const [year, month] = yearMonth.split('-').map(Number);
  return new Date(Date.UTC(year, month, 1));
}
