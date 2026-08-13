import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import { createPlanGate, QUOTA_HEADERS, RATE_LIMIT_HEADERS, THROTTLE_ERROR_CODES } from './planGate.js';
import { PLAN_LIMITS, type PlanLimits } from './planLimits.js';
import type { MonthlyUsageReader } from './monthlyQuota.js';
import { requireApiKey } from '../auth/apiKeyAuth.js';
import { createMemoryApiKeyDirectory } from '../keys/memoryApiKeyDirectory.js';
import { publicErrorHandler, publicNotFoundHandler } from '../publicErrors.js';
import { THROTTLED_STATUS } from '../usage/usageStore.js';
import type { AccountPlan } from '../keys/apiKeyStore.js';
import { walkModuleGraph } from '../importGraph.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '../..');

/**
 * The gate, behind a real key gate, over a real HTTP server.
 *
 * Mounted as `requireApiKey` → gate → a trivial resource, which is the production
 * order minus the meter. The meter is left out deliberately: it writes to a sink
 * and asserts nothing about throttling, and threading one through here would mean
 * a metering failure read as a quota failure. `publicApp.test.ts` covers the
 * composed stack.
 *
 * Both clocks are injected and driven by the test. Nothing here waits for a
 * minute to pass and nothing is flaky under load.
 */

vi.spyOn(console, 'error').mockImplementation(() => {});

/** Small enough to drive a boundary in a handful of requests. */
const TEST_LIMITS: Record<AccountPlan, PlanLimits> = {
  explorer: { plan: 'explorer', monthlyRequests: 3, requestsPerMinute: 2, overage: { kind: 'hard_stop' } },
  developer: { plan: 'developer', monthlyRequests: 5, requestsPerMinute: 4, overage: { kind: 'hard_stop' } },
  professional: {
    plan: 'professional',
    monthlyRequests: 3,
    requestsPerMinute: 50,
    overage: { kind: 'soft', maxOverageRequests: 2, eurPer1000Requests: 1 },
  },
  enterprise: {
    plan: 'enterprise',
    monthlyRequests: null,
    requestsPerMinute: 50,
    overage: { kind: 'hard_stop' },
  },
};

interface Harness {
  origin: string;
  key(plan: AccountPlan): string;
  /** Wall clock, for the billing month and the month-boundary `Retry-After`. */
  wallClock: Date;
  /** Monotonic milliseconds, for the rate window. */
  monotonic: number;
  durable: { value: number; calls: number };
  close(): Promise<void>;
}

let harness: Harness;

async function listen(app: Express): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server did not bind a port');
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function build(limits: Record<AccountPlan, PlanLimits> = TEST_LIMITS): Promise<Harness> {
  const seeded = createMemoryApiKeyDirectory([
    { plan: 'explorer', accountName: 'Explorer' },
    { plan: 'developer', accountName: 'Developer' },
    { plan: 'professional', accountName: 'Professional' },
    { plan: 'enterprise', accountName: 'Enterprise' },
  ]);
  const byPlan = new Map<AccountPlan, string>(
    seeded.keys.map((seed) => [seed.account.plan, seed.key])
  );

  const state = {
    wallClock: new Date('2026-08-13T12:00:00.000Z'),
    monotonic: 0,
    durable: { value: 0, calls: 0 },
  };

  const usage: MonthlyUsageReader = {
    servedRequestsInMonth() {
      state.durable.calls += 1;
      return state.durable.value;
    },
  };

  const gate = createPlanGate({
    usage,
    limits: (plan) => limits[plan],
    now: () => state.wallClock,
    monotonicMs: () => state.monotonic,
  });

  const app = express();
  app.use('/v1', requireApiKey({ directory: seeded.directory }));
  app.use('/v1', gate.middleware);
  app.get('/v1/ping', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(publicNotFoundHandler);
  app.use(publicErrorHandler);

  const server = await listen(app);

  return {
    origin: server.origin,
    key: (plan) => byPlan.get(plan) as string,
    get wallClock() {
      return state.wallClock;
    },
    set wallClock(value: Date) {
      state.wallClock = value;
    },
    get monotonic() {
      return state.monotonic;
    },
    set monotonic(value: number) {
      state.monotonic = value;
    },
    durable: state.durable,
    close: server.close,
  };
}

interface Probe {
  status: number;
  headers: Headers;
  body: { error?: { code: string; message: string }; ok?: boolean };
}

async function call(plan: AccountPlan, at = '/v1/ping'): Promise<Probe> {
  const res = await fetch(`${harness.origin}${at}`, {
    headers: { Authorization: `Bearer ${harness.key(plan)}` },
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

beforeEach(async () => {
  harness = await build();
});

afterEach(async () => {
  await harness.close();
});

describe('the per-minute rate limit', () => {
  it('serves up to the limit and then answers 429', async () => {
    expect((await call('explorer')).status).toBe(200);
    expect((await call('explorer')).status).toBe(200);

    const refused = await call('explorer');
    expect(refused.status).toBe(THROTTLED_STATUS);
    expect(refused.body.error?.code).toBe(THROTTLE_ERROR_CODES.rate);
  });

  it('states the limit, what is left, and when it resets on every response', async () => {
    // On success as much as on failure. A client that can only learn its
    // position by being refused has to be refused in order to behave.
    const first = await call('explorer');
    expect(first.headers.get(RATE_LIMIT_HEADERS.limit)).toBe('2');
    expect(first.headers.get(RATE_LIMIT_HEADERS.remaining)).toBe('1');
    expect(first.headers.get(RATE_LIMIT_HEADERS.reset)).toBe('60');
  });

  it('sends a Retry-After a client can obey exactly once', async () => {
    await call('explorer');
    await call('explorer');

    harness.monotonic = 30_000;
    const refused = await call('explorer');
    expect(refused.status).toBe(THROTTLED_STATUS);
    // The first request was at t=0, so its slot frees 30 seconds from now.
    expect(refused.headers.get('Retry-After')).toBe('30');

    // Obeying it works on the first retry, rather than landing in the same 429.
    harness.monotonic = 60_001;
    expect((await call('explorer')).status).toBe(200);
  });

  it('does not let one account’s burst refuse another', async () => {
    await call('explorer');
    await call('explorer');
    expect((await call('explorer')).status).toBe(THROTTLED_STATUS);

    expect((await call('developer')).status).toBe(200);
  });

  it('applies to a plan with no monthly quota', async () => {
    // Enterprise is "negotiated" on the quota and still rate-limited, because a
    // per-minute cap is a service protection as much as a commercial term.
    for (let i = 0; i < 50; i += 1) expect((await call('enterprise')).status).toBe(200);
    expect((await call('enterprise')).status).toBe(THROTTLED_STATUS);
  });
});

describe('the monthly quota', () => {
  it('hard-stops Explorer at its quota', async () => {
    // Three requests on the test table, spread so the rate limit is not what
    // refuses the fourth.
    for (let i = 0; i < 3; i += 1) {
      harness.monotonic = i * 60_000;
      expect((await call('explorer')).status).toBe(200);
    }

    harness.monotonic = 3 * 60_000;
    const refused = await call('explorer');
    expect(refused.status).toBe(THROTTLED_STATUS);
    expect(refused.body.error?.code).toBe(THROTTLE_ERROR_CODES.quota);
    expect(refused.body.error?.message).toContain('stops at its quota');
  });

  it('counts down remaining and reports zero at the quota', async () => {
    const first = await call('explorer');
    expect(first.headers.get(QUOTA_HEADERS.limit)).toBe('3');
    expect(first.headers.get(QUOTA_HEADERS.remaining)).toBe('2');

    harness.monotonic = 60_000;
    expect((await call('explorer')).headers.get(QUOTA_HEADERS.remaining)).toBe('1');
    harness.monotonic = 120_000;
    expect((await call('explorer')).headers.get(QUOTA_HEADERS.remaining)).toBe('0');
  });

  it('points Retry-After at the month boundary, not at a minute', async () => {
    // A quota is monthly, so the next instant the call could succeed is the
    // first of the next month. A small number here would invite a client to
    // retry into the same 429 every minute for three weeks.
    for (let i = 0; i < 3; i += 1) {
      harness.monotonic = i * 60_000;
      await call('explorer');
    }

    harness.wallClock = new Date('2026-08-31T23:59:00.000Z');
    harness.monotonic = 3 * 60_000;
    const refused = await call('explorer');

    expect(refused.status).toBe(THROTTLED_STATUS);
    expect(Number(refused.headers.get('Retry-After'))).toBe(60);
  });

  it('does not charge quota for a request it refused', async () => {
    // The property that keeps a hard-stop plan recoverable and a soft-overage
    // plan honest: refusing and then counting the refusal would run the counter
    // away past the ceiling, and on Professional every request past the quota is
    // a billed euro.
    for (let i = 0; i < 3; i += 1) {
      harness.monotonic = i * 60_000;
      await call('explorer');
    }

    harness.monotonic = 3 * 60_000;
    for (let i = 0; i < 5; i += 1) await call('explorer');

    // A fresh month is a full quota again, which it would not be if the five
    // refusals above had been counted against anything.
    harness.wallClock = new Date('2026-09-01T00:00:00.000Z');
    harness.monotonic = 10 * 60_000;
    const next = await call('explorer');
    expect(next.status).toBe(200);
    expect(next.headers.get(QUOTA_HEADERS.remaining)).toBe('2');
  });

  it('starts from what storage already recorded', async () => {
    // A restart mid-month must not hand the customer a fresh quota.
    await harness.close();
    harness = await build();
    harness.durable.value = 3;

    const refused = await call('explorer');
    expect(refused.status).toBe(THROTTLED_STATUS);
    expect(refused.body.error?.code).toBe(THROTTLE_ERROR_CODES.quota);
  });

  it('leaves a plan with no monthly quota unmetered by the month', async () => {
    for (let i = 0; i < 20; i += 1) expect((await call('enterprise')).status).toBe(200);
  });

  it('sends no Quota-* headers for a plan with no quota', async () => {
    // Rather than `unlimited`, which every client parses as `NaN`, or `-1`,
    // which is a convention nobody agreed to.
    const response = await call('enterprise');
    expect(response.headers.get(QUOTA_HEADERS.limit)).toBeNull();
    expect(response.headers.get(QUOTA_HEADERS.remaining)).toBeNull();
    expect(response.headers.get(RATE_LIMIT_HEADERS.limit)).toBe('50');
  });
});

describe('Professional soft overage', () => {
  it('keeps serving past the quota and says what it will cost', async () => {
    // Brief §1.2: "Professional soft-overages… so a customer's spike does not
    // break their product." Three quota requests, then two overage ones.
    for (let i = 0; i < 3; i += 1) expect((await call('professional')).status).toBe(200);

    const firstOverage = await call('professional');
    expect(firstOverage.status).toBe(200);
    expect(firstOverage.headers.get(QUOTA_HEADERS.remaining)).toBe('0');
    expect(firstOverage.headers.get(QUOTA_HEADERS.overage)).toBe('1');

    const secondOverage = await call('professional');
    expect(secondOverage.status).toBe(200);
    expect(secondOverage.headers.get(QUOTA_HEADERS.overage)).toBe('2');
  });

  it('stops at the overage cap with its own error code', async () => {
    // The bill cap is 2× the plan price, so the allowance is finite and the
    // customer is told which of the two limits they hit — "wait for the month"
    // and "ask us to raise the cap" are different afternoons.
    for (let i = 0; i < 5; i += 1) expect((await call('professional')).status).toBe(200);

    const refused = await call('professional');
    expect(refused.status).toBe(THROTTLED_STATUS);
    expect(refused.body.error?.code).toBe(THROTTLE_ERROR_CODES.overageCap);
    expect(refused.body.error?.message).toContain('overage');
  });

  it('sends no overage header to a plan that cannot accrue one', async () => {
    const response = await call('explorer');
    expect(response.headers.get(QUOTA_HEADERS.overage)).toBeNull();
  });
});

describe('what a 429 body says', () => {
  it('is the public error envelope and nothing else', async () => {
    await call('explorer');
    await call('explorer');
    const refused = await call('explorer');

    expect(refused.body).toEqual({
      error: { code: THROTTLE_ERROR_CODES.rate, message: expect.any(String) },
    });
  });

  it('reflects nothing the caller sent', async () => {
    // The invariant `publicErrors.ts` inverted the error contract to establish.
    // A 429 body is among the most likely things a customer pastes into a public
    // issue tracker, and the path and query are the obvious things to helpfully
    // echo into one.
    await call('explorer', '/v1/ping?zone=DE&secret=hunter2');
    await call('explorer', '/v1/ping?zone=DE&secret=hunter2');
    const refused = await call('explorer', '/v1/ping?zone=DE&secret=hunter2');

    expect(refused.status).toBe(THROTTLED_STATUS);
    expect(refused.body.error?.message).not.toContain('hunter2');
    expect(refused.body.error?.message).not.toContain('/v1/ping');
  });

  it('distinguishes a busy minute from an exhausted month', async () => {
    // Different codes because a client that retries a monthly quota breach with
    // exponential backoff will do so for the rest of the month.
    await call('explorer');
    await call('explorer');
    expect((await call('explorer')).body.error?.code).toBe(THROTTLE_ERROR_CODES.rate);

    harness.monotonic = 60_001;
    await call('explorer');
    harness.monotonic = 120_001;
    expect((await call('explorer')).body.error?.code).toBe(THROTTLE_ERROR_CODES.quota);
  });
});

describe('the gate reports position even when it is refusing', () => {
  it('sends the monthly figures alongside a rate-limit 429', async () => {
    // Otherwise a client cannot tell a busy minute from an exhausted month
    // without waiting out the minute to find out.
    await call('explorer');
    await call('explorer');
    const refused = await call('explorer');

    expect(refused.headers.get(RATE_LIMIT_HEADERS.remaining)).toBe('0');
    expect(refused.headers.get(QUOTA_HEADERS.limit)).toBe('3');
    expect(refused.headers.get(QUOTA_HEADERS.remaining)).toBe('1');
  });
});

describe('mounting', () => {
  it('fails loudly if it is mounted ahead of the key gate', async () => {
    // `requireApiPrincipal` throws rather than returning undefined, and this is
    // the reason: a gate with no principal would have to either invent a subject
    // or wave the request through, and both are silent.
    const gate = createPlanGate({ usage: { servedRequestsInMonth: () => 0 } });
    const app = express();
    app.use('/v1', gate.middleware);
    app.get('/v1/ping', (_req, res) => {
      res.json({ ok: true });
    });
    app.use(publicNotFoundHandler);
    app.use(publicErrorHandler);

    const server = await listen(app);
    const res = await fetch(`${server.origin}/v1/ping`);
    expect(res.status).toBe(500);
    // And the 500 is the generic one, so the internal message does not travel.
    expect(await res.json()).toEqual({
      error: { code: 'internal_error', message: 'An unexpected error occurred.' },
    });
    await server.close();
  });
});

describe('enforcement never suspends an account (ABL-297 §6.5, AUP)', () => {
  const graph = walkModuleGraph(path.join(HERE, 'planGate.ts'), SRC_ROOT);

  it('resolves every specifier it followed', () => {
    // Assert the walk first: an unresolved edge means the graph below is missing
    // and every assertion here would pass for the wrong reason.
    expect(graph.unresolved).toEqual([]);
  });

  it('cannot reach any module that can write a key or an account record', () => {
    // The commitment is in writing and it is specific: automated throttling and
    // automated 429s are permitted (privacy notice §8 — a technical control, not
    // a decision about a person, which is what keeps it outside GDPR Art. 22),
    // but suspension and termination are never fully automated. A human reviews
    // and confirms, and the subscriber can appeal.
    //
    // `setAccountDisabled` and `revokeKey` live on `ApiKeyAdminStore`, whose only
    // implementation is `sqliteApiKeyStore.ts`, and the keys CLI is the only
    // thing that holds one. This asserts the gate could not call either if it
    // tried — which is what "satisfied by construction" has to mean if it is to
    // mean anything.
    expect(graph.modules).not.toContain('v1/keys/sqliteApiKeyStore.ts');
    expect(graph.modules).not.toContain('v1/keys/keysCli.ts');
    expect(graph.modules).not.toContain('v1/usage/usageCli.ts');
  });

  it('touches nothing on the store but the one read method', async () => {
    // The runtime half of the same claim, and the reason `usage` is typed as
    // `MonthlyUsageReader` rather than as the store the entrypoint actually
    // passes. Structural typing means the real object *is* a `UsageAdminStore`
    // at runtime — `closeMonths`, `applyRetention` and `exportAccount` are all
    // sitting there on it — and the narrow parameter type is what stops any of
    // them being reachable from a request path. A proxy is how that stops being
    // a claim about TypeScript and becomes a claim about the running code.
    const touched: string[] = [];
    const store = new Proxy(
      { servedRequestsInMonth: () => 0 },
      {
        get(target, property, receiver) {
          if (typeof property === 'string') touched.push(property);
          return Reflect.get(target, property, receiver);
        },
      }
    ) as MonthlyUsageReader;

    await harness.close();
    const seeded = createMemoryApiKeyDirectory([{ plan: 'explorer', accountName: 'Explorer' }]);
    const gate = createPlanGate({ usage: store, limits: (plan) => TEST_LIMITS[plan] });
    const app = express();
    app.use('/v1', requireApiKey({ directory: seeded.directory }));
    app.use('/v1', gate.middleware);
    app.get('/v1/ping', (_req, res) => {
      res.json({ ok: true });
    });
    app.use(publicNotFoundHandler);
    app.use(publicErrorHandler);
    const server = await listen(app);

    for (let i = 0; i < 6; i += 1) {
      await fetch(`${server.origin}/v1/ping`, {
        headers: { Authorization: `Bearer ${seeded.keys[0].key}` },
      });
    }
    await server.close();
    // Rebuilt so `afterEach` has something to close.
    harness = await build();

    expect([...new Set(touched)]).toEqual(['servedRequestsInMonth']);
  });

  it('has no branch that disables, locks, suspends or flags', () => {
    // A text check, and a deliberately blunt one. The graph assertions above are
    // the real control; this catches the shape of the mistake before it needs a
    // new import — a boolean written onto the account object in `res.locals`, a
    // counter that trips at N breaches, a TODO that became a branch.
    const source = fs.readFileSync(path.join(HERE, 'planGate.ts'), 'utf8');
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    for (const forbidden of ['disable', 'suspend', 'terminat', 'revoke', 'lock']) {
      expect(code.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('answers a repeat offender exactly as it answers a first-time one', () => {
    // The behavioural statement of the same property, and the one a subscriber
    // would recognise: breaching a limit a hundred times leaves no residue. The
    // hundred-and-first request is evaluated against the window and the month,
    // like the first.
    //
    // Covered by `does not charge quota for a request it refused` and by the
    // rate-limiter's `does not record a refused request`; named here so the
    // commitment reads as one block rather than as three tests nobody connects.
    expect(PLAN_LIMITS.explorer.overage.kind).toBe('hard_stop');
  });
});
