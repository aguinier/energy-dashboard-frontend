import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { requireApiPrincipal } from '../auth/apiKeyAuth.js';
import {
  canonicaliseQuery,
  isBillableStatus,
  requestFingerprint,
  type UsageEvent,
  type UsageSink,
} from './usageStore.js';

/**
 * The meter: count every authenticated request, buffered, and flush it to
 * durable storage without ever putting a disk write on the critical path.
 *
 * Mounted immediately after the API-key gate and **outside the cache**, which is
 * the order ABL-293 §2c specifies (auth → meter → rate-limit → cache →
 * handler) and the one detail here that is not negotiable: `cacheMiddleware`
 * returns early on a hit and never reaches the handler, so a meter inside the
 * cache bills a customer polling a 5-minute-TTL endpoint for 1 request in 300.
 *
 * ## What this file will not do, and why the alternative was rejected
 *
 * It does not write to SQLite per request. A synchronous insert on every
 * authenticated call puts an fsync on the critical path of the entire API, in a
 * single-threaded process, to keep a counter nobody reads in real time. The
 * cost of buffering instead is stated plainly below and is the designed
 * behaviour, not an oversight — see {@link UsageMeterOptions.flushIntervalMs}.
 *
 * ## Which way each failure is allowed to be wrong
 *
 * Two failure modes are reachable here and both are resolved toward
 * **under**-counting, because this number becomes an invoice:
 *
 * 1. **A hard kill loses the buffer.** At the default interval that is at most
 *    one second of traffic for that process, and it under-bills. Deliberate.
 * 2. **The sink is unavailable and the buffer fills.** New events are dropped
 *    rather than the oldest, and the count of drops is reported by
 *    {@link UsageMeter.stats}. Dropping the oldest would discard the events
 *    closest to being written; dropping the newest keeps the queue draining in
 *    order once the sink recovers. Either way it under-bills.
 *
 * The failure mode that would *over*-count — a flush that commits and is then
 * retried — is closed in the store rather than here, by `UNIQUE(request_id)`
 * and `INSERT OR IGNORE`.
 */

/** Where a handler's reported row count is parked, mirroring `apiKeyAuth`'s principal symbol. */
const ROW_COUNT = Symbol.for('able.v1.usageRowCount');

/**
 * Report how many rows this response served, for the quota dimension ABL-302
 * enforces and the `rows_returned` figure ABL-293 §2d prices against.
 *
 * Additive, so a handler assembling a response from two queries reports each
 * without having to total them itself. Nothing calls this yet — ABL-303 owns
 * the endpoints that will — and a response that never calls it records `null`
 * rather than `0`, because "no rows" and "nobody said" are different facts and
 * a billing table should not conflate them.
 */
export function recordUsageRows(res: Response, rows: number): void {
  if (!Number.isFinite(rows) || rows < 0) return;
  const locals = res.locals as Record<symbol, unknown>;
  locals[ROW_COUNT] = ((locals[ROW_COUNT] as number | undefined) ?? 0) + rows;
}

function readRowCount(res: Response): number | null {
  const value = (res.locals as Record<symbol, unknown>)[ROW_COUNT];
  return typeof value === 'number' ? value : null;
}

/**
 * The route template this request matched, never the raw URL.
 *
 * `req.route` is set by Express only once a route has matched, so an
 * unmatched path — which on this surface is every unknown path *behind* the
 * gate, because `requireApiKey` mounts on `/v1` as a whole — has no template.
 * Those are recorded under a constant rather than under their URL: they are
 * still traffic an authenticated customer sent, they are still worth counting
 * against a rate limit, and their path is exactly the free-text-shaped value
 * ABL-297 §9(5) says must not reach the log.
 */
export const UNMATCHED_ROUTE = '(unmatched)';

export function resolveRouteTemplate(req: Request): string {
  const route = (req as Request & { route?: { path?: unknown } }).route;
  const path = route && typeof route.path === 'string' ? route.path : null;
  if (path === null) return UNMATCHED_ROUTE;

  // `baseUrl` carries the mount prefix (`/v1`), `route.path` the leaf pattern
  // (`/observations/:series`). Joined they are the template a customer would
  // recognise from the documentation, with parameter *names* and never values.
  const base = req.baseUrl ?? '';
  const joined = `${base}${path}`.replace(/\/{2,}/g, '/');
  return joined === '' ? UNMATCHED_ROUTE : joined.replace(/(.)\/$/, '$1');
}

/**
 * The caller's address.
 *
 * Read off the socket, deliberately **not** from `X-Forwarded-For`. Express
 * only trusts that header when `trust proxy` is set, this app does not set it,
 * and there is no proxy in front of the LAN deployment — so an `X-Forwarded-For`
 * arriving today is a value the caller chose. Recording a spoofable value in
 * the one field we rate-limit on, detect key sharing with, and name in a
 * privacy notice as personal data would make all three wrong at once. When a
 * proxy exists it comes with a `trust proxy` setting and a change here, both
 * reviewed together.
 */
function resolveClientIp(req: Request): string | null {
  return req.socket?.remoteAddress ?? null;
}

/**
 * A header value as a single short string, or `null`.
 *
 * `user-agent` is free text a caller controls, so it is capped. ABL-297 §3.3
 * commits us to holding it for abuse detection; nothing commits us to holding
 * an unbounded amount of it.
 */
const MAX_USER_AGENT_LENGTH = 256;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

function readHeader(req: Request, name: string, maxLength: number): string | null {
  const raw = req.header(name);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed.slice(0, maxLength);
}

export interface UsageMeterOptions {
  /** Where flushed events go. Injected, so `publicApp.ts` never names a database. */
  sink: UsageSink;
  /**
   * How often the buffer is written, in milliseconds. `0` disables the timer
   * entirely, which is what the tests use so that flushing is something they
   * do rather than something they wait for.
   *
   * One second is the ABL-293 §2c figure and it prices the lost-write window
   * directly: a hard kill discards at most this much traffic. Lowering it
   * raises the write rate; raising it widens the window. Both directions are
   * defensible and neither changes the direction of the error.
   */
  flushIntervalMs?: number;
  /** Flush early once this many events are buffered. The §2c figure is 500. */
  maxBufferedEvents?: number;
  /**
   * Hard ceiling on the buffer, after which new events are dropped and counted.
   *
   * Reached only when the sink has been failing for a long time. It exists so
   * that a broken disk costs us billing records instead of costing us the
   * process: an unbounded buffer in front of a failing writer is how a metering
   * bug becomes an outage on the endpoints it was metering.
   */
  maxQueuedEvents?: number;
  now?: () => Date;
  /** Monotonic milliseconds, for durations. Injectable so a duration can be asserted. */
  monotonicMs?: () => number;
}

export interface UsageMeterStats {
  /** Events buffered and not yet written. */
  pending: number;
  /** Events written since start. */
  flushed: number;
  /** Events refused because the buffer was at {@link UsageMeterOptions.maxQueuedEvents}. */
  dropped: number;
  /** Flushes that threw. The events stay buffered and are retried. */
  failedFlushes: number;
  /** Requests that never reached `finish` — the client went away mid-response. */
  aborted: number;
}

export interface UsageMeter {
  /** Mount this immediately after the key gate. */
  middleware: RequestHandler;
  /**
   * Write everything buffered, now.
   *
   * Synchronous, because the store is `better-sqlite3` and because the one
   * caller that must not miss is the shutdown path — an `await` there is a
   * promise the process may exit before settling.
   */
  flush(): void;
  stats(): UsageMeterStats;
  /** Final flush, then stop the timer. Safe to call twice. */
  close(): void;
}

export const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
export const DEFAULT_MAX_BUFFERED_EVENTS = 500;
export const DEFAULT_MAX_QUEUED_EVENTS = 50_000;

export function createUsageMeter({
  sink,
  flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
  maxBufferedEvents = DEFAULT_MAX_BUFFERED_EVENTS,
  maxQueuedEvents = DEFAULT_MAX_QUEUED_EVENTS,
  now = () => new Date(),
  monotonicMs = () => performance.now(),
}: UsageMeterOptions): UsageMeter {
  let buffer: UsageEvent[] = [];
  const stats: UsageMeterStats = {
    pending: 0,
    flushed: 0,
    dropped: 0,
    failedFlushes: 0,
    aborted: 0,
  };

  function flush(): void {
    if (buffer.length === 0) return;

    // Detach the batch *before* writing, so events arriving during the write
    // land in the next one rather than being written twice or lost.
    const batch = buffer;
    buffer = [];

    try {
      const outcome = sink.writeEvents(batch);
      stats.flushed += outcome.inserted;
    } catch (err) {
      // Put the batch back at the front and keep going. A failing sink must not
      // take the API down with it, and it must not silently discard billing
      // records either — the retry is what turns a transient lock into a
      // late write rather than a lost one.
      stats.failedFlushes += 1;
      buffer = batch.concat(buffer);
      console.error('Usage meter: flush failed, events retained for retry:', err);
    } finally {
      stats.pending = buffer.length;
    }
  }

  const timer =
    flushIntervalMs > 0
      ? // `unref` so the timer never holds the process open. The shutdown path
        // flushes explicitly; a metering timer that kept a terminating process
        // alive would be a worse bug than the one it prevents.
        setInterval(flush, flushIntervalMs).unref()
      : null;

  function enqueue(event: UsageEvent): void {
    if (buffer.length >= maxQueuedEvents) {
      stats.dropped += 1;
      return;
    }
    buffer.push(event);
    stats.pending = buffer.length;
    if (buffer.length >= maxBufferedEvents) flush();
  }

  const middleware: RequestHandler = function meterUsage(req, res, next) {
    // Read the principal here, synchronously, rather than inside the `close`
    // handler. Both would throw when this middleware is mounted ahead of the
    // gate — but a throw here is a request Express turns into a 500, and a
    // throw inside an event handler is an uncaught exception that takes the
    // process down. The loud failure `requireApiPrincipal` is designed for is
    // only useful if it stays survivable.
    const principal = requireApiPrincipal(res);

    const receivedAt = now().toISOString();
    const startedAt = monotonicMs();
    const queryParams = canonicaliseQuery(req.query as Record<string, unknown> | undefined);
    const idempotencyKey = readHeader(req, 'idempotency-key', MAX_IDEMPOTENCY_KEY_LENGTH);
    const userAgent = readHeader(req, 'user-agent', MAX_USER_AGENT_LENGTH);
    const clientIp = resolveClientIp(req);

    // One listener, on `close`, rather than one on `finish` and one on `error`.
    // `close` always fires exactly once per response in supported Node versions,
    // so there is no arrangement of events that records this request twice —
    // and `writableFinished` then says which of the two things happened.
    res.on('close', () => {
      const completed = res.writableFinished === true;
      if (!completed) stats.aborted += 1;

      const routeTemplate = resolveRouteTemplate(req);
      const lengthHeader = Number(res.getHeader('content-length'));

      enqueue({
        requestId: `req_${randomUUID()}`,
        receivedAt,
        accountId: principal.accountId,
        keyId: principal.keyId,
        method: req.method,
        routeTemplate,
        queryParams,
        status: res.statusCode,
        rowCount: readRowCount(res),
        // Present only when the response carried a length. A compressed or
        // chunked response does not, and that is left as `null` rather than
        // guessed at: bytes are capacity-planning colour, the billing dimension
        // is requests, and a fabricated number in a table we invoice from is
        // worse than an honest gap.
        responseBytes: Number.isFinite(lengthHeader) && lengthHeader >= 0 ? lengthHeader : null,
        durationMs: Math.max(0, Math.round(monotonicMs() - startedAt)),
        // A response the client abandoned is recorded and not billed. We did
        // the work, so it belongs in the log for capacity planning and abuse
        // detection; the customer did not receive it, so it does not belong on
        // an invoice.
        billable: completed && isBillableStatus(res.statusCode),
        idempotencyKey,
        fingerprint: requestFingerprint(req.method, routeTemplate, queryParams),
        clientIp,
        userAgent,
      });
    });

    next();
  };

  let closed = false;
  return {
    middleware,
    flush,
    stats: () => ({ ...stats }),
    close() {
      if (closed) return;
      closed = true;
      flush();
      if (timer) clearInterval(timer);
    },
  };
}
