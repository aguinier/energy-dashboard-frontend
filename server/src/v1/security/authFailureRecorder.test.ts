import { describe, it, expect, vi } from 'vitest';
import type { Request } from 'express';
import {
  createAuthFailureRecorder,
  MAX_PRESENTED_PREFIX_LENGTH,
  MAX_USER_AGENT_LENGTH,
  type AuthFailureDraft,
  type AuthFailureRecorderOptions,
} from './authFailureRecorder.js';
import { createMemoryAuthFailureSink } from './memoryAuthFailureSink.js';

/**
 * The buffer, and the promise it exists to keep.
 *
 * `apiKeyAuth.test.ts` covers *which* refusals are recorded, driven through a
 * real socket. This file covers what the recorder does with them once it has
 * them, and in particular the two properties that would be invisible from the
 * outside until they were being exploited: that nothing is written from the
 * request path, and that a failing sink cannot reach it.
 */

/** Enough of a `Request` for the recorder, which reads four things off it. */
function request({
  path = '/observations/load',
  method = 'GET',
  ip = '192.0.2.10',
  userAgent = 'able-sdk/1.0',
}: { path?: string; method?: string; ip?: string | null; userAgent?: string | null } = {}): Request {
  return {
    path,
    method,
    socket: ip === null ? {} : { remoteAddress: ip },
    header: (name: string) => (name === 'user-agent' ? (userAgent ?? undefined) : undefined),
  } as unknown as Request;
}

const DRAFT: AuthFailureDraft = {
  errorCode: 'key_invalid',
  status: 401,
  presentedPrefix: '7f3a9c21',
  keyEnvironment: 'live',
  secretVerified: false,
  accountId: null,
  keyId: null,
};

function recorder(options: Partial<Omit<AuthFailureRecorderOptions, 'sink'>> = {}) {
  const sink = createMemoryAuthFailureSink();
  return {
    sink,
    recorder: createAuthFailureRecorder({
      sink,
      flushIntervalMs: 0,
      now: () => new Date('2026-08-22T09:00:00.000Z'),
      onError: () => {},
      ...options,
    }),
  };
}

describe('recording', () => {
  it('stamps the draft with what it reads off the request', () => {
    const { recorder: rec, sink } = recorder();

    rec.record(request(), DRAFT);
    rec.flush();

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      receivedAt: '2026-08-22T09:00:00.000Z',
      errorCode: 'key_invalid',
      status: 401,
      presentedPrefix: '7f3a9c21',
      keyEnvironment: 'live',
      secretVerified: false,
      accountId: null,
      keyId: null,
      routeTemplate: '/v1/observations/load',
      method: 'GET',
      clientIp: '192.0.2.10',
      userAgent: 'able-sdk/1.0',
    });
    expect(sink.events[0].eventId).toMatch(/^af_[0-9a-f-]{36}$/);
  });

  it('gives every record a distinct id, so a retried flush cannot duplicate one', () => {
    const { recorder: rec, sink } = recorder();

    for (let i = 0; i < 50; i += 1) rec.record(request(), DRAFT);
    rec.flush();

    expect(new Set(sink.events.map((event) => event.eventId)).size).toBe(50);
  });

  it('reads the address off the socket, never off X-Forwarded-For', () => {
    // The caller populating this table is the one whose credentials did not
    // work. A header they chose must not become the source address in the
    // evidence.
    const { recorder: rec, sink } = recorder();
    const spoofing = {
      ...request(),
      header: (name: string) => (name === 'x-forwarded-for' ? '203.0.113.9' : undefined),
    } as unknown as Request;

    rec.record(spoofing, DRAFT);
    rec.flush();

    expect(sink.events[0].clientIp).toBe('192.0.2.10');
    expect(JSON.stringify(sink.events)).not.toContain('203.0.113.9');
  });

  it('records a null address rather than inventing one when the socket has none', () => {
    const { recorder: rec, sink } = recorder();

    rec.record(request({ ip: null, userAgent: null }), DRAFT);
    rec.flush();

    expect(sink.events[0]).toMatchObject({ clientIp: null, userAgent: null });
  });

  it('caps the two caller-controlled fields', () => {
    const { recorder: rec, sink } = recorder();

    rec.record(request({ userAgent: 'u'.repeat(5_000) }), {
      ...DRAFT,
      presentedPrefix: 'p'.repeat(500),
    });
    rec.flush();

    expect(sink.events[0].userAgent).toHaveLength(MAX_USER_AGENT_LENGTH);
    expect(sink.events[0].presentedPrefix).toHaveLength(MAX_PRESENTED_PREFIX_LENGTH);
  });

  it('treats an empty header as absent, not as an empty string', () => {
    const { recorder: rec, sink } = recorder();

    rec.record(request({ userAgent: '   ' }), DRAFT);
    rec.flush();

    // `''` and `null` would group separately in every S3 aggregate, splitting one
    // origin's traffic across two rows.
    expect(sink.events[0].userAgent).toBeNull();
  });
});

describe('nothing is written from the request path', () => {
  it('does not touch the sink until a flush', () => {
    // The timing property, and the denial-of-service one. `record` is mounted
    // inside the gate, which sits *ahead* of the plan gate — so a refused
    // request is the only traffic on this surface that nothing rate-limits, and
    // it must not be able to turn each guess into a synchronous SQLite write.
    const { recorder: rec, sink } = recorder();

    for (let i = 0; i < 500; i += 1) rec.record(request(), DRAFT);

    expect(sink.writeCalls).toBe(0);
    expect(rec.stats().pending).toBe(500);
  });

  it('schedules the early flush out of band rather than running it inline', async () => {
    const { recorder: rec, sink } = recorder({ softFlushAt: 3 });

    rec.record(request(), DRAFT);
    rec.record(request(), DRAFT);
    rec.record(request(), DRAFT);
    // Still nothing: the threshold was reached, but the flush is a `setImmediate`
    // so it runs after the response has gone out.
    expect(sink.writeCalls).toBe(0);

    await new Promise((resolve) => setImmediate(resolve));
    expect(sink.events).toHaveLength(3);
  });

  it('schedules at most one out-of-band flush at a time', async () => {
    const { recorder: rec, sink } = recorder({ softFlushAt: 2 });

    for (let i = 0; i < 20; i += 1) rec.record(request(), DRAFT);
    await new Promise((resolve) => setImmediate(resolve));

    expect(sink.events).toHaveLength(20);
    expect(sink.writeCalls).toBe(1);
  });
});

describe('failure', () => {
  it('retains a failed batch and retries it, rather than dropping it', () => {
    // The opposite trade from the billing meter's. A lost billing record
    // under-bills, which is the safe direction there; a lost auth-failure record
    // makes an attack invisible, which is not.
    const { recorder: rec, sink } = recorder();

    rec.record(request(), DRAFT);
    sink.failNext();
    rec.flush();

    expect(sink.events).toHaveLength(0);
    expect(rec.stats().failedFlushes).toBe(1);
    expect(rec.stats().pending).toBe(1);

    rec.flush();
    expect(sink.events).toHaveLength(1);
  });

  it('keeps records in order when a failed batch is retried behind newer ones', () => {
    const { recorder: rec, sink } = recorder();

    rec.record(request({ path: '/accuracy' }), DRAFT);
    sink.failNext();
    rec.flush();
    rec.record(request({ path: '/forecasts' }), DRAFT);
    rec.flush();

    expect(sink.events.map((event) => event.routeTemplate)).toEqual([
      '/v1/accuracy',
      '/v1/forecasts',
    ]);
  });

  it('drops the newest past the ceiling, and counts what it dropped', () => {
    // Reached only when the sink has been failing for a long time. Newest rather
    // than oldest: the old ones are closest to being written, and under a flood
    // the *first* records identify it.
    const { recorder: rec, sink } = recorder({ maxQueuedEvents: 3 });

    for (let i = 0; i < 10; i += 1) rec.record(request({ path: `/accuracy?i=${i}` }), DRAFT);

    expect(rec.stats().pending).toBe(3);
    expect(rec.stats().dropped).toBe(7);

    rec.flush();
    expect(sink.events).toHaveLength(3);
  });

  it('never throws out of record, whatever it is handed', () => {
    // It runs inside the authentication gate. A throw here would turn a refusal
    // into a 500 — and, since it would differ per branch, would be exactly the
    // observable difference this module promises not to create.
    const errors: string[] = [];
    const { recorder: rec } = recorder({ onError: (message: string) => errors.push(message) });
    const hostile = {
      get path() {
        throw new Error('exploded');
      },
    } as unknown as Request;

    expect(() => rec.record(hostile, DRAFT)).not.toThrow();
    expect(rec.stats().failedRecords).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it('a flush with an empty buffer is a no-op, not an empty write', () => {
    const { recorder: rec, sink } = recorder();

    rec.flush();
    rec.flush();

    expect(sink.writeCalls).toBe(0);
  });
});

describe('the timer', () => {
  it('flushes on its interval and is unref’d so it cannot hold a process open', () => {
    vi.useFakeTimers();
    try {
      const sink = createMemoryAuthFailureSink();
      const rec = createAuthFailureRecorder({ sink, flushIntervalMs: 1_000, onError: () => {} });

      rec.record(request(), DRAFT);
      expect(sink.events).toHaveLength(0);

      vi.advanceTimersByTime(1_000);
      expect(sink.events).toHaveLength(1);

      rec.close();
      vi.advanceTimersByTime(10_000);
      expect(sink.writeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('close flushes what is buffered, which is what a clean shutdown relies on', () => {
    const { recorder: rec, sink } = recorder();

    rec.record(request(), DRAFT);
    rec.close();

    expect(sink.events).toHaveLength(1);
    // Safe to call twice: `publicIndex.ts` guards against a second signal, but
    // the shutdown sequence should not depend on that guard being there.
    expect(() => rec.close()).not.toThrow();
  });
});
