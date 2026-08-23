import { describe, it, expect, afterEach, vi } from 'vitest';
import express, { type Express, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { requireApiKey } from '../auth/apiKeyAuth.js';
import { createMemoryApiKeyDirectory } from '../keys/memoryApiKeyDirectory.js';
import { createTestAuthFailureRecorder } from '../security/memoryAuthFailureSink.js';
import { createMemoryUsageSink, type MemoryUsageSink } from './memoryUsageSink.js';
import {
  createUsageMeter,
  recordUsageRows,
  resolveRouteTemplate,
  UNMATCHED_ROUTE,
  type UsageMeter,
} from './usageMeter.js';

/**
 * The meter as it actually sits in the stack: behind the ABL-300 gate, in front
 * of routes, driven over a real socket.
 *
 * Driven over HTTP rather than by calling the middleware with a fake `req`,
 * because the two things most likely to be wrong here are both properties of a
 * real response — that `close` fires exactly once, and that
 * `res.writableFinished` distinguishes a response the client received from one
 * it abandoned. A hand-rolled fake would assert whatever it was built to
 * assert.
 *
 * **The failure modes this file exists to pin are the last two describes.** One
 * is the lost write; the other is the double count. Both are stated as the
 * direction the error is allowed to go, because that is the actual requirement:
 * an invoice that is slightly low is a margin we absorb, and an invoice that is
 * slightly high is a refund and a customer who checks every future invoice by
 * hand.
 */

const seeded = createMemoryApiKeyDirectory([{ accountName: 'Acme Energy' }]);
const KEY = seeded.keys[0];
const AUTH = { Authorization: `Bearer ${KEY.key}` };

const openServers: Array<() => Promise<void>> = [];
const openMeters: UsageMeter[] = [];

afterEach(async () => {
  for (const close of openServers.splice(0)) await close();
  for (const meter of openMeters.splice(0)) meter.close();
});

interface Harness {
  origin: string;
  sink: MemoryUsageSink;
  meter: UsageMeter;
}

/**
 * The gate, then the meter, then the routes — the order `publicApp.ts` mounts.
 *
 * `flushIntervalMs: 0` by default, so flushing is something a test *does*
 * rather than something it waits for. A suite that slept for a timer would be
 * slow and flaky in exchange for testing `setInterval`.
 */
async function harness(
  build: (app: Express) => void,
  options: { flushIntervalMs?: number; maxBufferedEvents?: number; maxQueuedEvents?: number } = {}
): Promise<Harness> {
  const sink = createMemoryUsageSink();
  const meter = createUsageMeter({ sink, flushIntervalMs: 0, ...options });
  openMeters.push(meter);

  const app = express();
  app.use(
    requireApiKey({ directory: seeded.directory, recorder: createTestAuthFailureRecorder().recorder })
  );
  app.use(meter.middleware);
  build(app);
  // A minimal error handler, so a 4xx from a route is a 4xx and not Express's
  // HTML default with a stack in it.
  app.use((_req: Request, res: Response) => res.status(404).json({ error: 'not_found' }));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  openServers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server did not bind');
  return { origin: `http://127.0.0.1:${addr.port}`, sink, meter };
}

/** Wait until the response's `close` handler has enqueued, which is not synchronous with fetch. */
async function settle(meter: UsageMeter, expected: number): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (meter.stats().pending + meter.stats().flushed + meter.stats().dropped >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('what one metered request records', () => {
  it('counts the request against the key that made it', async () => {
    const { origin, sink, meter } = await harness((app) =>
      app.get('/observations/:series', (_req, res) => res.json({ ok: true }))
    );

    await fetch(`${origin}/observations/load?country=BE`, { headers: AUTH });
    await settle(meter, 1);
    meter.flush();

    expect(sink.events).toHaveLength(1);
    const event = sink.events[0];
    expect(event.keyId).toBe(KEY.record.id);
    expect(event.accountId).toBe(KEY.account.id);
    expect(event.status).toBe(200);
    expect(event.billable).toBe(true);
    expect(event.method).toBe('GET');
    expect(event.requestId).toMatch(/^req_/);
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records the route template and never the raw URL', async () => {
    const { origin, sink, meter } = await harness((app) =>
      app.get('/observations/:series', (_req, res) => res.json({ ok: true }))
    );

    await fetch(`${origin}/observations/load?country=BE&secret=hunter2`, { headers: AUTH });
    await settle(meter, 1);
    meter.flush();

    // Parameter *names*, never values: a raw URL carries a customer's query
    // patterns and explodes the cardinality of every aggregate over the column.
    expect(sink.events[0].routeTemplate).toBe('/observations/:series');
    expect(sink.events[0].routeTemplate).not.toContain('load');
    // And the un-allowlisted parameter did not travel with it.
    expect(sink.events[0].queryParams).toBe('country=BE');
    expect(JSON.stringify(sink.events[0])).not.toContain('hunter2');
  });

  it('records an unmatched path under a constant rather than under its path', async () => {
    const { origin, sink, meter } = await harness(() => {});

    await fetch(`${origin}/nothing/here/at/all`, { headers: AUTH });
    await settle(meter, 1);
    meter.flush();

    // Still an authenticated customer's traffic, so still counted — but the
    // path is exactly the free-text-shaped value ABL-297 §9(4) keeps out.
    expect(sink.events[0].routeTemplate).toBe(UNMATCHED_ROUTE);
    expect(sink.events[0].status).toBe(404);
    expect(sink.events[0].billable).toBe(false);
  });

  it('records a 4xx and does not bill for it', async () => {
    const { origin, sink, meter } = await harness((app) =>
      app.get('/bad', (_req, res) => res.status(400).json({ error: 'bad_request' }))
    );

    await fetch(`${origin}/bad`, { headers: AUTH });
    await settle(meter, 1);
    meter.flush();

    expect(sink.events[0].status).toBe(400);
    expect(sink.events[0].billable).toBe(false);
    // Recorded, though: it counts toward the rate limit ABL-302 enforces.
    expect(sink.events).toHaveLength(1);
  });

  it('does not meter a request the gate refused', async () => {
    const { origin, sink, meter } = await harness((app) =>
      app.get('/observations/:series', (_req, res) => res.json({ ok: true }))
    );

    const res = await fetch(`${origin}/observations/load`);
    expect(res.status).toBe(401);

    await settle(meter, 1);
    meter.flush();
    // Nothing to attribute it to. An unauthenticated request is not a
    // customer's usage, and counting it to nobody is how a table gets rows that
    // no invoice can ever explain.
    expect(sink.events).toHaveLength(0);
  });

  it('carries a row count only when a handler reported one', async () => {
    const { origin, sink, meter } = await harness((app) => {
      app.get('/counted', (_req, res) => {
        recordUsageRows(res, 40);
        recordUsageRows(res, 2); // additive, for a response assembled from two queries
        res.json({ ok: true });
      });
      app.get('/silent', (_req, res) => res.json({ ok: true }));
    });

    await fetch(`${origin}/counted`, { headers: AUTH });
    await fetch(`${origin}/silent`, { headers: AUTH });
    await settle(meter, 2);
    meter.flush();

    expect(sink.events.find((e) => e.routeTemplate === '/counted')!.rowCount).toBe(42);
    // `null`, not `0`. "No rows" and "nobody said" are different facts and a
    // billing table should not conflate them.
    expect(sink.events.find((e) => e.routeTemplate === '/silent')!.rowCount).toBeNull();
  });

  it('records the client IP and user agent the privacy notice names', async () => {
    const { origin, sink, meter } = await harness((app) =>
      app.get('/x', (_req, res) => res.json({ ok: true }))
    );

    await fetch(`${origin}/x`, { headers: { ...AUTH, 'User-Agent': 'able-sdk/1.0' } });
    await settle(meter, 1);
    meter.flush();

    expect(sink.events[0].clientIp).toBeTruthy();
    expect(sink.events[0].userAgent).toBe('able-sdk/1.0');
  });

  it('does not take the client IP from a header the caller controls', async () => {
    const { origin, sink, meter } = await harness((app) =>
      app.get('/x', (_req, res) => res.json({ ok: true }))
    );

    await fetch(`${origin}/x`, { headers: { ...AUTH, 'X-Forwarded-For': '203.0.113.9' } });
    await settle(meter, 1);
    meter.flush();

    // This app sets no `trust proxy` and has no proxy in front of it, so an
    // `X-Forwarded-For` arriving today is a value the caller chose. Recording it
    // would make rate limiting, key-sharing detection and the privacy notice
    // wrong at once.
    expect(sink.events[0].clientIp).not.toBe('203.0.113.9');
    expect(sink.events[0].clientIp).toMatch(/127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
  });

  it('caps a user agent, which is free text a caller controls', async () => {
    const { origin, sink, meter } = await harness((app) =>
      app.get('/x', (_req, res) => res.json({ ok: true }))
    );

    await fetch(`${origin}/x`, { headers: { ...AUTH, 'User-Agent': 'A'.repeat(4000) } });
    await settle(meter, 1);
    meter.flush();

    expect(sink.events[0].userAgent!.length).toBe(256);
  });

  it('does not bill for a response the client abandoned', async () => {
    const { origin, sink, meter } = await harness((app) =>
      app.get('/slow', (_req, res) => {
        res.write('{"partial":');
        // Never ended: the client aborts below while this response is open.
      })
    );

    const controller = new AbortController();
    const pending = fetch(`${origin}/slow`, { headers: AUTH, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await pending.catch(() => undefined);

    await settle(meter, 1);
    meter.flush();

    expect(sink.events).toHaveLength(1);
    // We did the work, so it belongs in the log for capacity planning and abuse
    // detection. The customer did not receive it, so it does not belong on an
    // invoice.
    expect(sink.events[0].billable).toBe(false);
    expect(meter.stats().aborted).toBe(1);
  });
});

describe('resolveRouteTemplate', () => {
  it('joins the mount prefix to the leaf pattern', () => {
    expect(
      resolveRouteTemplate({ baseUrl: '/v1', route: { path: '/observations/:series' } } as never)
    ).toBe('/v1/observations/:series');
  });

  it('collapses a double slash and trims a trailing one', () => {
    expect(resolveRouteTemplate({ baseUrl: '/v1/', route: { path: '/x' } } as never)).toBe('/v1/x');
    expect(resolveRouteTemplate({ baseUrl: '/v1', route: { path: '/' } } as never)).toBe('/v1');
  });

  it('falls back to the constant when Express matched no route', () => {
    expect(resolveRouteTemplate({ baseUrl: '/v1' } as never)).toBe(UNMATCHED_ROUTE);
    expect(resolveRouteTemplate({} as never)).toBe(UNMATCHED_ROUTE);
  });
});

describe('the meter must not be able to take the API down with it', () => {
  it('turns a route mounted ahead of the gate into a 500, not a process crash', async () => {
    // `requireApiPrincipal` throws when there is no principal — deliberately, so
    // a route on the wrong side of the gate fails loudly rather than being
    // metered to nobody. Read synchronously in the middleware so Express catches
    // it; read inside the `close` handler it would be an uncaught exception that
    // takes the process down, and a loud failure is only useful if it stays
    // survivable.
    const sink = createMemoryUsageSink();
    const meter = createUsageMeter({ sink, flushIntervalMs: 0 });
    openMeters.push(meter);

    const app = express();
    app.use(meter.middleware); // no gate ahead of it
    app.get('/x', (_req, res) => res.json({ ok: true }));

    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    openServers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const addr = server.address() as { port: number };

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/x`, { headers: AUTH });
      expect(res.status).toBe(500);
    } finally {
      errors.mockRestore();
    }
    expect(sink.events).toHaveLength(0);
  });

  it('keeps serving when the sink throws, and retains the batch for retry', async () => {
    const { origin, sink, meter } = await harness((app) =>
      app.get('/x', (_req, res) => res.json({ ok: true }))
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await fetch(`${origin}/x`, { headers: AUTH });
      await settle(meter, 1);

      sink.failNext();
      meter.flush();

      // Not lost: a transient lock must become a *late* write, not a missing
      // one. This is the difference between a database hiccup and an invoice
      // that is quietly short.
      expect(sink.events).toHaveLength(0);
      expect(meter.stats().failedFlushes).toBe(1);
      expect(meter.stats().pending).toBe(1);

      meter.flush();
      expect(sink.events).toHaveLength(1);
      expect(meter.stats().pending).toBe(0);

      // And the API kept answering throughout.
      expect((await fetch(`${origin}/x`, { headers: AUTH })).status).toBe(200);
    } finally {
      errors.mockRestore();
    }
  });

  it('drops the newest events rather than growing without bound, and counts the drops', async () => {
    const { origin, sink, meter } = await harness(
      (app) => app.get('/x', (_req, res) => res.json({ ok: true })),
      { maxQueuedEvents: 2, maxBufferedEvents: 1000 }
    );

    for (let i = 0; i < 5; i += 1) await fetch(`${origin}/x`, { headers: AUTH });
    await settle(meter, 5);

    // An unbounded buffer in front of a failing writer is how a metering bug
    // becomes an outage on the endpoints it was metering. Bounded, it costs
    // billing records instead — and the number of them is reported rather than
    // silent.
    expect(meter.stats().dropped).toBe(3);
    expect(meter.stats().pending).toBe(2);

    meter.flush();
    expect(sink.events).toHaveLength(2);
  });
});

describe('THE LOST-WRITE FAILURE MODE — it under-counts, and that is the choice', () => {
  it('loses the buffered events when the process dies without flushing', async () => {
    const { origin, sink, meter } = await harness((app) =>
      app.get('/x', (_req, res) => res.json({ ok: true }))
    );

    for (let i = 0; i < 3; i += 1) await fetch(`${origin}/x`, { headers: AUTH });
    await settle(meter, 3);

    // A hard kill here — SIGKILL, a power cut, an OOM — takes the buffer with
    // it. This is the failure stated plainly rather than defended against: the
    // alternative is an fsync on the critical path of every authenticated
    // request, in a single-threaded process, to keep a counter nobody reads in
    // real time.
    expect(meter.stats().pending).toBe(3);
    expect(sink.events).toHaveLength(0);

    // The direction is the requirement. Three requests were served and zero are
    // billable, so the invoice is LOW. It is never high.
    const served = 3;
    const billed = sink.billable().length;
    expect(billed).toBeLessThanOrEqual(served);
    expect(billed).toBe(0);
  });

  it('bounds the loss to one flush interval, which is what the interval buys', async () => {
    // The window is priced directly by `flushIntervalMs`: at the one-second
    // default, a hard kill discards at most one second of that process's
    // traffic. Here the timer is real and short, so the assertion is that the
    // buffer genuinely empties itself without anyone calling flush.
    const { origin, sink, meter } = await harness(
      (app) => app.get('/x', (_req, res) => res.json({ ok: true })),
      { flushIntervalMs: 20 }
    );

    await fetch(`${origin}/x`, { headers: AUTH });

    for (let i = 0; i < 100 && sink.events.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(sink.events).toHaveLength(1);
    expect(meter.stats().pending).toBe(0);
  });

  it('flushes on close, so a clean shutdown loses nothing at all', async () => {
    const { origin, sink, meter } = await harness((app) =>
      app.get('/x', (_req, res) => res.json({ ok: true }))
    );

    await fetch(`${origin}/x`, { headers: AUTH });
    await settle(meter, 1);
    expect(sink.events).toHaveLength(0);

    meter.close();

    // A deploy is the most frequent way this process dies, so it is the
    // lost-write case most worth closing — and it is closed completely.
    expect(sink.events).toHaveLength(1);
    meter.close(); // safe twice: the shutdown path may be reached from two signals
    expect(sink.events).toHaveLength(1);
  });

  it('flushes early at the buffer threshold rather than waiting for the timer', async () => {
    const { origin, sink, meter } = await harness(
      (app) => app.get('/x', (_req, res) => res.json({ ok: true })),
      { maxBufferedEvents: 3 }
    );

    for (let i = 0; i < 3; i += 1) await fetch(`${origin}/x`, { headers: AUTH });
    await settle(meter, 3);

    // Under load the interval stops being what bounds the loss; the threshold
    // does.
    expect(sink.events).toHaveLength(3);
    expect(meter.stats().pending).toBe(0);
  });
});

describe('THE DOUBLE-COUNT FAILURE MODE — one request is one row, once', () => {
  it('records exactly one event per response, however the response ended', async () => {
    const { origin, sink, meter } = await harness((app) => {
      app.get('/ok', (_req, res) => res.json({ ok: true }));
      app.get('/boom', () => {
        throw new Error('handler exploded');
      });
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await fetch(`${origin}/ok`, { headers: AUTH });
      await fetch(`${origin}/boom`, { headers: AUTH });
      await settle(meter, 2);
      meter.flush();

      // One listener on `close`, not one on `finish` and one on `error`. There
      // is no arrangement of events that produces two rows for one request —
      // which is the only failure mode here that would *over*-bill.
      expect(sink.events).toHaveLength(2);
      expect(new Set(sink.events.map((e) => e.requestId)).size).toBe(2);
    } finally {
      errors.mockRestore();
    }
  });

  it('detaches the batch before writing, so a flush during a flush cannot duplicate', async () => {
    const { origin, sink, meter } = await harness((app) =>
      app.get('/x', (_req, res) => res.json({ ok: true }))
    );

    await fetch(`${origin}/x`, { headers: AUTH });
    await settle(meter, 1);

    meter.flush();
    meter.flush();
    meter.flush();

    expect(sink.events).toHaveLength(1);
    expect(meter.stats().flushed).toBe(1);
  });

  it('gives every event a unique request id, which is what makes a retried flush safe', async () => {
    const { origin, sink, meter } = await harness((app) =>
      app.get('/x', (_req, res) => res.json({ ok: true }))
    );

    for (let i = 0; i < 25; i += 1) await fetch(`${origin}/x`, { headers: AUTH });
    await settle(meter, 25);
    meter.flush();

    expect(new Set(sink.events.map((e) => e.requestId)).size).toBe(25);

    // The store side of it: replaying an identical batch inserts nothing. This
    // is the property that turns "a flush that committed and then reported an
    // error" from an over-count into a no-op.
    const replay = sink.writeEvents(sink.events.slice());
    expect(replay.inserted).toBe(0);
    expect(replay.alreadyPresent).toBe(25);
    expect(sink.events).toHaveLength(25);
  });
});
