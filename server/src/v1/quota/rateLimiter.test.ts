import { describe, it, expect } from 'vitest';
import { createRateLimiter, RATE_WINDOW_MS, SWEEP_INTERVAL_MS } from './rateLimiter.js';

/**
 * The sliding window, driven by an injected clock.
 *
 * Every test here passes `nowMs` explicitly, so nothing waits for a real minute
 * and nothing is flaky on a loaded machine. That is the whole reason `admit`
 * takes the time rather than reading it.
 */

const SUBJECT = 'acct_one';

describe('admission inside the window', () => {
  it('admits exactly the limit and refuses the next', () => {
    const limiter = createRateLimiter();

    for (let i = 1; i <= 10; i += 1) {
      const decision = limiter.admit(SUBJECT, 10, 1_000 + i);
      expect(decision.allowed).toBe(true);
      expect(decision.limit).toBe(10);
      expect(decision.remaining).toBe(10 - i);
    }

    const refused = limiter.admit(SUBJECT, 10, 1_020);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
  });

  it('does not record a refused request', () => {
    // The property that keeps `Retry-After` honest. If a refusal extended the
    // window, a client polling faster than its limit would never be admitted
    // again and every `Retry-After` we sent would be a number we knew to be
    // wrong. Here: fill the window, hammer it, then arrive exactly when the
    // first slot frees and be let in.
    const limiter = createRateLimiter();
    for (let i = 0; i < 3; i += 1) limiter.admit(SUBJECT, 3, 1_000);

    for (let t = 1_001; t < 1_000 + RATE_WINDOW_MS; t += 1_000) {
      expect(limiter.admit(SUBJECT, 3, t).allowed).toBe(false);
    }

    // The oldest hit was at 1_000, so it leaves the window at 1_000 + 60_000.
    expect(limiter.admit(SUBJECT, 3, 1_000 + RATE_WINDOW_MS + 1).allowed).toBe(true);
  });

  it('keeps subjects independent', () => {
    // The gate keys on the account, so one customer exhausting a window must
    // not touch another's. Trivial to get right and catastrophic to get wrong.
    const limiter = createRateLimiter();
    for (let i = 0; i < 5; i += 1) limiter.admit('acct_a', 5, 1_000);

    expect(limiter.admit('acct_a', 5, 1_000).allowed).toBe(false);
    expect(limiter.admit('acct_b', 5, 1_000).allowed).toBe(true);
  });
});

describe('the window slides rather than resetting', () => {
  it('refuses a burst that a fixed 60-second bucket would have admitted', () => {
    // The reason this is a sliding window and not three lines shorter. Ten
    // requests at t=59s and ten at t=61s is 20 requests in two seconds; a fixed
    // bucket boundary at t=60s admits every one of them.
    const limiter = createRateLimiter();
    const bucketBoundary = 60_000;

    for (let i = 0; i < 10; i += 1) {
      expect(limiter.admit(SUBJECT, 10, bucketBoundary - 1_000 + i).allowed).toBe(true);
    }
    expect(limiter.admit(SUBJECT, 10, bucketBoundary + 1_000).allowed).toBe(false);
  });

  it('frees slots one at a time as they age out', () => {
    const limiter = createRateLimiter();
    // Three requests, one second apart.
    for (let i = 0; i < 3; i += 1) limiter.admit(SUBJECT, 3, 1_000 + i * 1_000);

    // At the instant the first ages out, exactly one slot is free.
    const first = limiter.admit(SUBJECT, 3, 1_000 + RATE_WINDOW_MS + 1);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(0);

    expect(limiter.admit(SUBJECT, 3, 1_000 + RATE_WINDOW_MS + 2).allowed).toBe(false);
  });
});

describe('what a refused caller is told', () => {
  it('points Retry-After at the moment the oldest request leaves the window', () => {
    const limiter = createRateLimiter();
    limiter.admit(SUBJECT, 1, 10_000);

    // 30 seconds later the oldest hit has 30 seconds left to run.
    const refused = limiter.admit(SUBJECT, 1, 40_000);
    expect(refused.allowed).toBe(false);
    expect(refused.resetSeconds).toBe(30);

    // And obeying it works on the first retry, which is the point of computing
    // it exactly rather than sending a conservative constant.
    expect(limiter.admit(SUBJECT, 1, 40_000 + 30_000).allowed).toBe(true);
  });

  it('never tells a caller to retry in zero seconds', () => {
    // A zero would invite an immediate retry into the same refusal, and a
    // fractional value is not a legal `Retry-After`.
    const limiter = createRateLimiter();
    limiter.admit(SUBJECT, 1, 0);

    const refused = limiter.admit(SUBJECT, 1, RATE_WINDOW_MS - 1);
    expect(refused.allowed).toBe(false);
    expect(refused.resetSeconds).toBe(1);
  });

  it('reports a reset an admitted caller can also use', () => {
    const limiter = createRateLimiter();
    const admitted = limiter.admit(SUBJECT, 10, 5_000);
    expect(admitted.resetSeconds).toBe(RATE_WINDOW_MS / 1000);
  });
});

describe('the map does not grow without bound', () => {
  it('drops subjects whose window has emptied', () => {
    const limiter = createRateLimiter();
    for (const subject of ['a', 'b', 'c']) limiter.admit(subject, 10, 1_000);
    expect(limiter.size()).toBe(3);

    // A sweep runs on the first call after the interval, so one later call from
    // one subject is what collects the other two.
    limiter.admit('a', 10, 1_000 + SWEEP_INTERVAL_MS + 1);
    expect(limiter.size()).toBe(1);
  });

  it('holds at most `limit` timestamps for a busy subject', () => {
    // The memory claim in the header: bounded by the plan's own limit, so the
    // worst case is 600 numbers rather than one per request.
    const limiter = createRateLimiter();
    for (let i = 0; i < 5_000; i += 1) limiter.admit(SUBJECT, 10, 1_000 + i);

    // Nothing external can read the array, so the observable form of "it did not
    // keep 5,000 entries" is that a fresh window is immediately available once
    // the old one ages out.
    const after = limiter.admit(SUBJECT, 10, 1_000 + 5_000 + RATE_WINDOW_MS);
    expect(after.allowed).toBe(true);
    expect(after.remaining).toBe(9);
  });
});

describe('a limit of zero', () => {
  it('refuses without pretending to have a window', () => {
    // Not reachable from `PLAN_LIMITS`, and handled rather than trusted: the
    // untended path produces `remaining: -1` and a `Retry-After` computed off an
    // empty array, which reads as a bug in the limiter rather than as a bad plan
    // record.
    const limiter = createRateLimiter();
    const decision = limiter.admit(SUBJECT, 0, 1_000);

    expect(decision).toEqual({ allowed: false, limit: 0, remaining: 0, resetSeconds: 0 });
  });
});
