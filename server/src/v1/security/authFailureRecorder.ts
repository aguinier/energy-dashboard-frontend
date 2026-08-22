import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { classifyRequestTarget } from './requestTarget.js';
import type { AuthFailureEvent, AuthFailureSink } from './authFailureStore.js';

/**
 * Buffer refused requests and write them without ever putting I/O on the
 * refusal path.
 *
 * Handed to `requireApiKey`, which calls {@link AuthFailureRecorder.record} at
 * every one of its six refusal sites. The gate supplies what only it knows — the
 * error code and whether the secret had already matched — and this module
 * supplies everything that comes off the request.
 *
 * ## The property this file exists to hold
 *
 * ABL-530: *"no write that introduces a measurable timing difference between a
 * known and an unknown prefix."*
 *
 * `apiKeyAuth.ts` goes to real trouble for that. An unknown prefix burns a
 * `timingSafeEqual` it does not need (`burnSecretComparison`) so that "no such
 * key" costs what "wrong secret" costs, because otherwise the **non-secret**
 * prefix becomes an enumeration oracle answerable by stopwatch. Recording the
 * refusal must not hand that back.
 *
 * Two things together are what hold it, and neither is sufficient alone:
 *
 * 1. **{@link AuthFailureRecorder.record} does no I/O.** It stamps a few fields
 *    and pushes onto an array. The sink is touched by the timer and by
 *    `setImmediate`, never by the request. So there is no disk write that could
 *    sit on one branch of the gate and not the other, whatever the gate's branch
 *    structure becomes later.
 * 2. **Every refusal site records the same shape.** The gate funnels all six
 *    through one `refuse()` helper, and this module reads the same fields off
 *    the request every time — including `presentedPrefix`, which is populated on
 *    the unknown-prefix branch exactly as on the wrong-secret branch. A field
 *    gathered on one path and not the other is work done on one path and not the
 *    other.
 *
 * `authFailureRecorder.test.ts` pins both: that the sink is untouched during a
 * recorded refusal, and that the known and unknown branches produce records with
 * the same fields populated.
 *
 * ## Why the early flush is asynchronous here and synchronous in the meter
 *
 * `usageMeter.ts` flushes inline once `maxBufferedEvents` is buffered, and that
 * is right for it: it meters **authenticated** traffic, which the plan gate has
 * already bounded by a per-minute rate limit and a monthly quota, so the write
 * rate has a ceiling somebody is paying for.
 *
 * This path has no such ceiling. It is mounted *ahead* of both the meter and the
 * plan gate, so a refused request is the one kind of traffic on this surface
 * that nothing throttles. An inline flush would let an attacker convert each
 * guess into a synchronous SQLite write in a single-threaded process — a
 * monitoring feature that is also a denial-of-service amplifier, and paid for by
 * the people it is meant to protect.
 *
 * So the soft threshold schedules a flush with `setImmediate` instead: the
 * buffer still drains promptly under a burst, and it drains *after* the response
 * has gone out rather than in front of it.
 *
 * ## Failure, and which way it errs
 *
 * `record` cannot throw. A monitoring feature that could break authentication
 * would be a worse defect than the blindness it removes, so the body is wrapped
 * and a failure is counted in {@link AuthFailureRecorderStats.failedRecords}
 * rather than propagated. A non-zero count there is a real finding — it means
 * refusals are happening and not being recorded — which is why it is a number
 * `usage:stats` can print rather than a silence.
 *
 * The buffer's hard ceiling is the one place a record is deliberately lost, and
 * it is reached only when the sink has been failing for a long time. New events
 * are dropped rather than old ones — the old ones are closest to being written,
 * and under a flood the *first* records of the flood are the ones that identify
 * it. The drop count is reported, so "we were flooded and lost N" is a number
 * instead of a gap.
 */

/** What only the gate knows at the moment it refuses. */
export interface AuthFailureDraft {
  errorCode: string;
  status: number;
  presentedPrefix: string | null;
  keyEnvironment: string | null;
  /** See {@link AuthFailureEvent.secretVerified} — the S4 column. */
  secretVerified: boolean;
  accountId: string | null;
  keyId: string | null;
}

export interface AuthFailureRecorder {
  /**
   * Record one refusal. **O(1), no I/O, never throws.**
   *
   * Called from inside the gate rather than from a `res.on('close')` listener,
   * because the gate is the only place that knows *why* the request was refused
   * — by the time the response closes, the error has been flattened into a
   * status and a constant message that is identical for several distinct causes.
   */
  record(req: Request, draft: AuthFailureDraft): void;
  /** Write everything buffered, now. Synchronous, because the store is. */
  flush(): void;
  stats(): AuthFailureRecorderStats;
  /** Final flush, then stop the timer. Safe to call twice. */
  close(): void;
}

export interface AuthFailureRecorderStats {
  /** Buffered and not yet written. */
  pending: number;
  /** Written since start. */
  written: number;
  /** Refused because the buffer was at {@link AuthFailureRecorderOptions.maxQueuedEvents}. */
  dropped: number;
  /** Flushes that threw. The records stay buffered and are retried. */
  failedFlushes: number;
  /** Refusals `record` could not turn into a record at all. Should be 0. */
  failedRecords: number;
}

export interface AuthFailureRecorderOptions {
  /** Where flushed records go. Injected, so `publicApp.ts` never names a database. */
  sink: AuthFailureSink;
  /**
   * How often the buffer is written. `0` disables the timer, which is what tests
   * use so that flushing is something they do rather than something they wait
   * for.
   *
   * One second, matching the meter: a hard kill discards at most this much. The
   * window is the same, the consequence is not — a lost billing record
   * under-bills, a lost auth failure is an attack we cannot see.
   */
  flushIntervalMs?: number;
  /** Schedule an out-of-band flush once this many are buffered. Never inline — see the header. */
  softFlushAt?: number;
  /** Hard ceiling, after which new records are dropped and counted. */
  maxQueuedEvents?: number;
  now?: () => Date;
  /** Injectable so a test can assert what was reported without capturing console. */
  onError?: (message: string, err: unknown) => void;
}

export const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
export const DEFAULT_SOFT_FLUSH_AT = 200;

/**
 * Ten thousand refusals buffered between flushes.
 *
 * Generous on purpose: this is the backstop for a broken sink, not a rate limit.
 * At the one-second default it takes ten thousand refused requests **in a single
 * second** to drop anything while the sink is healthy, which is past what a
 * single-threaded Node process bound to loopback will answer anyway. If it is
 * ever reached, the number is reported rather than the records silently
 * disappearing, and a non-zero drop count is itself the enumeration signal S3
 * exists to surface.
 */
export const DEFAULT_MAX_QUEUED_EVENTS = 10_000;

/**
 * A caller-controlled header, so it is capped.
 *
 * The same 256 the meter uses, for the same reason and one that bites harder
 * here: ABL-297 §3.3 commits us to holding a user agent for abuse detection, and
 * nothing commits us to holding an unbounded amount of one — least of all from
 * an unauthenticated caller who chose it.
 */
export const MAX_USER_AGENT_LENGTH = 256;

/**
 * A cap on the presented prefix, as a backstop rather than as validation.
 *
 * `parseApiKey` already rejects anything whose prefix is not exactly
 * `KEY_PREFIX_LENGTH` characters, so in practice every value that reaches here
 * is 8. The cap is here so that a parser later loosened to accept a
 * variable-length prefix cannot turn this column into a store of whatever the
 * caller sent — the same reasoning `MAX_LOGGED_PARAMETER_VALUE_LENGTH` carries
 * in `usageStore.ts`.
 */
export const MAX_PRESENTED_PREFIX_LENGTH = 32;

function cap(value: string | null, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, maxLength);
}

/**
 * The caller's address.
 *
 * Read off the socket, deliberately **not** from `X-Forwarded-For` — the same
 * decision `usageMeter.ts` documents, and it matters more here. Express only
 * trusts that header when `trust proxy` is set, this app does not set it, and
 * there is no proxy in front of the deployment. So an `X-Forwarded-For` arriving
 * today is a value the *caller* chose, and the caller populating this table is
 * the one whose credentials did not work. Recording it would let an attacker
 * write their own source address into the evidence.
 */
function resolveClientIp(req: Request): string | null {
  return req.socket?.remoteAddress ?? null;
}

export function createAuthFailureRecorder({
  sink,
  flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
  softFlushAt = DEFAULT_SOFT_FLUSH_AT,
  maxQueuedEvents = DEFAULT_MAX_QUEUED_EVENTS,
  now = () => new Date(),
  onError = (message, err) => console.error(message, err),
}: AuthFailureRecorderOptions): AuthFailureRecorder {
  let buffer: AuthFailureEvent[] = [];
  let flushScheduled = false;
  const stats: AuthFailureRecorderStats = {
    pending: 0,
    written: 0,
    dropped: 0,
    failedFlushes: 0,
    failedRecords: 0,
  };

  function flush(): void {
    flushScheduled = false;
    if (buffer.length === 0) return;

    // Detach before writing, so records arriving during the write land in the
    // next batch rather than being written twice or lost.
    const batch = buffer;
    buffer = [];

    try {
      stats.written += sink.writeAuthFailures(batch).inserted;
    } catch (err) {
      // Put the batch back at the front and keep going. A failing sink must not
      // take down the API it is watching, and it must not silently discard the
      // records either — `eventId` is `UNIQUE`, so a retry after a write that
      // actually committed inserts nothing rather than duplicating.
      stats.failedFlushes += 1;
      buffer = batch.concat(buffer);
      onError('Auth failure recorder: flush failed, records retained for retry:', err);
    } finally {
      stats.pending = buffer.length;
    }
  }

  const timer =
    flushIntervalMs > 0
      ? // `unref` so the timer never holds a terminating process open. The
        // shutdown path flushes explicitly.
        setInterval(flush, flushIntervalMs).unref()
      : null;

  return {
    record(req, draft) {
      try {
        if (buffer.length >= maxQueuedEvents) {
          stats.dropped += 1;
          return;
        }

        buffer.push({
          eventId: `af_${randomUUID()}`,
          receivedAt: now().toISOString(),
          errorCode: draft.errorCode,
          status: draft.status,
          presentedPrefix: cap(draft.presentedPrefix, MAX_PRESENTED_PREFIX_LENGTH),
          keyEnvironment: cap(draft.keyEnvironment, MAX_PRESENTED_PREFIX_LENGTH),
          secretVerified: draft.secretVerified,
          accountId: draft.accountId,
          keyId: draft.keyId,
          routeTemplate: classifyRequestTarget(req.path),
          method: req.method,
          clientIp: resolveClientIp(req),
          userAgent: cap(req.header('user-agent') ?? null, MAX_USER_AGENT_LENGTH),
        });
        stats.pending = buffer.length;

        // Out of band, never inline. See the header: this is the one path on
        // this surface that nothing rate-limits, so it must not be able to make
        // itself expensive.
        if (buffer.length >= softFlushAt && !flushScheduled) {
          flushScheduled = true;
          setImmediate(flush);
        }
      } catch (err) {
        // Deliberately swallowed. This runs inside the authentication gate, and
        // an exception here would turn a refusal into a 500 — which is both a
        // worse outcome and, since it would differ per branch, exactly the
        // observable difference this module promises not to create.
        stats.failedRecords += 1;
        onError('Auth failure recorder: could not record a refusal:', err);
      }
    },

    flush,
    stats: () => ({ ...stats }),

    close() {
      flush();
      if (timer) clearInterval(timer);
    },
  };
}
