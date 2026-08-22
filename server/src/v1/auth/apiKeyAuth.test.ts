import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import { requireApiKey, requireApiPrincipal, peekApiPrincipal, AUTH_ERROR_CODES } from './apiKeyAuth.js';
import { publicErrorHandler, publicNotFoundHandler } from '../publicErrors.js';
import {
  createMemoryApiKeyDirectory,
  withSecret,
  type MemoryKeySeed,
} from '../keys/memoryApiKeyDirectory.js';
import { mintApiKey, KEY_SECRET_LENGTH } from '../keys/keyFormat.js';
import type { ApiKeyDirectory } from '../keys/apiKeyStore.js';
import { createTestAuthFailureRecorder } from '../security/memoryAuthFailureSink.js';
import type { AuthFailureRecorder } from '../security/authFailureRecorder.js';

/**
 * The gate, branch by branch.
 *
 * ABL-300 asks for negative tests on missing, malformed, revoked and expired
 * keys; this file covers those four plus the two the implementation adds — a
 * disabled account and an environment segment that disagrees with the row —
 * and the two properties that are easy to lose in a later edit: that the codes
 * distinguishable *before* the secret is verified reveal nothing about a
 * particular key, and that a 401 body never contains the key that produced it.
 *
 * Driven through a real Express app over a real socket rather than by calling
 * the handler with a mock `req`. The middleware's contract includes what
 * `publicErrorHandler` does with what it throws, the status that reaches the
 * wire, and the `WWW-Authenticate` header — none of which a mocked `res`
 * would exercise.
 */

vi.spyOn(console, 'error').mockImplementation(() => {});

/** A minimal app shaped exactly like `publicApp`'s `/v1` stack: gate, routes, error contract. */
function appWith(
  directory: ApiKeyDirectory,
  now?: () => Date,
  recorder: AuthFailureRecorder = createTestAuthFailureRecorder().recorder
): Express {
  const app = express();
  app.get('/v1', (_req, res) => void res.json({ version: 'v1', status: 'ok' }));
  app.use('/v1', requireApiKey({ directory, recorder, now }));
  app.get('/v1/probe', (_req, res) => void res.json({ principal: requireApiPrincipal(res) }));
  app.get('/v1/peek', (_req, res) => void res.json({ seen: peekApiPrincipal(res) !== undefined }));
  app.use(publicNotFoundHandler);
  app.use(publicErrorHandler);
  return app;
}

interface Probe {
  status: number;
  body: {
    error?: { code?: string; message?: string };
    principal?: Record<string, unknown>;
    seen?: boolean;
  };
  text: string;
  challenge: string | null;
}

async function get(origin: string, path: string, key?: string): Promise<Probe> {
  const res = await fetch(`${origin}${path}`, {
    headers: key === undefined ? {} : { Authorization: key },
  });
  const text = await res.text();
  return {
    status: res.status,
    body: JSON.parse(text),
    text,
    challenge: res.headers.get('www-authenticate'),
  };
}

async function listen(app: Express) {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** One seeded key per scenario, so a mistake in one row cannot mask another. */
const SEEDS = {
  good: {} as MemoryKeySeed,
  revoked: { revokedAt: '2026-06-01T00:00:00.000Z', revokedReason: 'leaked' } as MemoryKeySeed,
  expired: { expiresAt: '2026-01-01T00:00:00.000Z' } as MemoryKeySeed,
  futureExpiry: { expiresAt: '2099-01-01T00:00:00.000Z' } as MemoryKeySeed,
  disabledAccount: { accountDisabledAt: '2026-07-01T00:00:00.000Z' } as MemoryKeySeed,
  corruptHash: { secretSha256: 'not-a-hash' } as MemoryKeySeed,
  testEnv: { environment: 'test' } as MemoryKeySeed,
  professional: { plan: 'professional', accountName: 'Acme Energy' } as MemoryKeySeed,
  badExpiry: { expiresAt: 'not a date' } as MemoryKeySeed,
} satisfies Record<string, MemoryKeySeed>;

const order = Object.keys(SEEDS) as (keyof typeof SEEDS)[];
const seeded = createMemoryApiKeyDirectory(order.map((name) => SEEDS[name]));
const KEY = Object.fromEntries(order.map((name, i) => [name, seeded.keys[i]])) as Record<
  keyof typeof SEEDS,
  (typeof seeded.keys)[number]
>;

let api: Awaited<ReturnType<typeof listen>>;
beforeAll(async () => {
  api = await listen(appWith(seeded.directory, () => new Date('2026-08-12T00:00:00.000Z')));
});
afterAll(async () => {
  await api.close();
});

describe('a valid key', () => {
  it('passes and identifies the caller', async () => {
    const res = await get(api.origin, '/v1/probe', `Bearer ${KEY.good.key}`);

    expect(res.status).toBe(200);
    expect(res.body.principal).toEqual({
      accountId: KEY.good.account.id,
      accountName: KEY.good.account.name,
      plan: KEY.good.account.plan,
      keyId: KEY.good.record.id,
      keyPrefix: KEY.good.record.prefix,
      environment: 'live',
    });
  });

  it('carries the plan without acting on it — ABL-302 enforces, ABL-300 identifies', async () => {
    const res = await get(api.origin, '/v1/probe', `Bearer ${KEY.professional.key}`);

    expect(res.status).toBe(200);
    expect(res.body.principal).toMatchObject({ plan: 'professional', accountName: 'Acme Energy' });
    // Nothing about the plan changed the outcome: an explorer key reaches the
    // same handler with the same status. If a quota check ever appears in this
    // middleware it belongs in ABL-302, and this assertion is what will say so.
    expect((await get(api.origin, '/v1/probe', `Bearer ${KEY.good.key}`)).status).toBe(200);
  });

  it('accepts a key whose expiry is still in the future', async () => {
    expect((await get(api.origin, '/v1/probe', `Bearer ${KEY.futureExpiry.key}`)).status).toBe(200);
  });

  it('is case-insensitive about the scheme, as RFC 7235 requires', async () => {
    expect((await get(api.origin, '/v1/probe', `bearer ${KEY.good.key}`)).status).toBe(200);
  });

  it('still carries the challenge header, because it is set before any branch', async () => {
    // Harmless on a 200, and pinned here on purpose: it is the evidence that
    // `setHeader` runs ahead of the checks. A future edit "tidying" it to only
    // fire on failure would have to move it below the branches, which is how
    // one refusal path ends up without a challenge.
    const res = await get(api.origin, '/v1/probe', `Bearer ${KEY.good.key}`);
    expect(res.status).toBe(200);
    expect(res.challenge).toBe('Bearer realm="able-v1"');
  });
});

describe('the four negative cases ABL-300 names', () => {
  it('missing: no Authorization header at all', async () => {
    const res = await get(api.origin, '/v1/probe');

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe(AUTH_ERROR_CODES.missing);
    expect(res.body.error?.message).toContain('Authorization: Bearer');
  });

  it.each([
    { why: 'a Basic credential', header: 'Basic dXNlcjpwYXNzd29yZA==' },
    { why: 'the bare word Bearer', header: 'Bearer' },
    { why: 'a key with no scheme', header: mintApiKey('live').key },
    { why: 'a token that is not a key', header: 'Bearer hunter2' },
    { why: 'the private app shared-secret shape', header: 'Bearer some-helio-write-token' },
    { why: 'a key with a segment missing', header: 'Bearer able_live_abcdefgh' },
    { why: 'an unknown environment segment', header: `Bearer ${mintApiKey('live').key.replace('_live_', '_prod_')}` },
    { why: 'a truncated secret', header: `Bearer ${mintApiKey('live').key.slice(0, -1)}` },
  ])('malformed: $why', async ({ header }) => {
    const res = await get(api.origin, '/v1/probe', header);

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe(AUTH_ERROR_CODES.malformed);
  });

  it('revoked: a key that was turned off', async () => {
    const res = await get(api.origin, '/v1/probe', `Bearer ${KEY.revoked.key}`);

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe(AUTH_ERROR_CODES.revoked);
    // The reason is recorded for support and never sent: "leaked" is our note
    // about the customer, not a message for them.
    expect(res.text).not.toContain('leaked');
  });

  it('expired: a key past its deadline', async () => {
    const res = await get(api.origin, '/v1/probe', `Bearer ${KEY.expired.key}`);

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe(AUTH_ERROR_CODES.expired);
  });
});

describe('invalid keys', () => {
  it('a well-formed key that was never issued', async () => {
    const res = await get(api.origin, '/v1/probe', `Bearer ${mintApiKey('live').key}`);

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe(AUTH_ERROR_CODES.invalid);
  });

  it('the right prefix with the wrong secret', async () => {
    // The branch a random key would almost never reach: same row, bad secret.
    const forged = withSecret(KEY.good.key, 'z'.repeat(KEY_SECRET_LENGTH));
    const res = await get(api.origin, '/v1/probe', `Bearer ${forged}`);

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe(AUTH_ERROR_CODES.invalid);
  });

  it('a live-looking key whose row says test', async () => {
    // The environment segment is checked against the row, so it is a fact
    // rather than decoration. Same prefix, same secret, wrong environment.
    const parsed = KEY.testEnv.key.replace('_test_', '_live_');
    const res = await get(api.origin, '/v1/probe', `Bearer ${parsed}`);

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe(AUTH_ERROR_CODES.invalid);
    expect((await get(api.origin, '/v1/probe', `Bearer ${KEY.testEnv.key}`)).status).toBe(200);
  });

  it('a row whose stored hash is corrupt fails closed, with a 401 and not a 500', async () => {
    // A truncated or hand-edited row is a data problem. It must not become an
    // availability problem: `timingSafeEqual` throws on a length mismatch, and
    // an uncaught throw here would be a 500 on every request from that key.
    const res = await get(api.origin, '/v1/probe', `Bearer ${KEY.corruptHash.key}`);

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe(AUTH_ERROR_CODES.invalid);
  });

  it('an unparseable deadline is treated as expired, never as forever', async () => {
    const res = await get(api.origin, '/v1/probe', `Bearer ${KEY.badExpiry.key}`);

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe(AUTH_ERROR_CODES.expired);
  });
});

describe('a disabled account', () => {
  it('is 403, not 401 — the credential is fine and re-sending it will not help', async () => {
    const res = await get(api.origin, '/v1/probe', `Bearer ${KEY.disabledAccount.key}`);

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe(AUTH_ERROR_CODES.accountDisabled);
  });
});

describe('what a refusal discloses', () => {
  it('never echoes the presented key, its prefix, or an account name', async () => {
    const cases = [
      undefined,
      'Basic abc',
      `Bearer ${KEY.revoked.key}`,
      `Bearer ${KEY.expired.key}`,
      `Bearer ${KEY.disabledAccount.key}`,
      `Bearer ${withSecret(KEY.professional.key, 'q'.repeat(KEY_SECRET_LENGTH))}`,
    ];
    const bodies = (await Promise.all(cases.map((h) => get(api.origin, '/v1/probe', h)))).map(
      (r) => r.text
    );
    const all = bodies.join('\n');

    for (const secret of [
      KEY.revoked.key,
      KEY.revoked.record.prefix,
      KEY.expired.record.prefix,
      KEY.professional.record.prefix,
      KEY.professional.account.name,
      KEY.disabledAccount.account.id,
      'leaked',
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  it('tells an attacker without the secret only that the key is invalid', async () => {
    // Every code that says something specific — revoked, expired, disabled —
    // sits behind the hash comparison. Someone guessing keys sees exactly one
    // code, so the specific ones disclose nothing they could not already
    // deduce from holding the key.
    const guesses = Array.from({ length: 12 }, () => mintApiKey('live').key);
    const codes = new Set(
      await Promise.all(
        guesses.map(async (g) => (await get(api.origin, '/v1/probe', `Bearer ${g}`)).body.error?.code)
      )
    );

    expect([...codes]).toEqual([AUTH_ERROR_CODES.invalid]);
  });

  it('answers every refusal with an RFC 6750 challenge and no error_description', async () => {
    for (const header of [undefined, 'Basic abc', `Bearer ${KEY.revoked.key}`]) {
      const res = await get(api.origin, '/v1/probe', header);
      expect(res.challenge).toBe('Bearer realm="able-v1"');
      // `error_description` is free text by specification, which would make the
      // challenge a second channel for a message to reach the wire unscrubbed.
      expect(res.challenge).not.toContain('error_description');
    }
  });

  it('keeps the public error envelope, not the internal {success,error,code} shape', async () => {
    const res = await get(api.origin, '/v1/probe');

    expect(Object.keys(res.body)).toEqual(['error']);
    expect(Object.keys(res.body.error as object).sort()).toEqual(['code', 'message']);
    expect(res.body).not.toHaveProperty('success');
  });
});

describe('the gate covers paths, not routes', () => {
  it('401s a path that matches no route, so the surface cannot be enumerated', async () => {
    // The property that makes the gate structural: an unauthenticated caller
    // gets 401 rather than 404 for `/v1/anything`, so probing tells them
    // nothing — and a resource ABL-303 adds is authenticated whether or not its
    // author thought about it.
    for (const path of ['/v1/observations/load', '/v1/does-not-exist', '/v1/forecasts/DE']) {
      const res = await get(api.origin, path);
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe(AUTH_ERROR_CODES.missing);
    }
  });

  it('404s an unknown path once a valid key is presented', async () => {
    const res = await get(api.origin, '/v1/does-not-exist', `Bearer ${KEY.good.key}`);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('not_found');
  });

  it('leaves the discovery root mounted ahead of it alone', async () => {
    const res = await get(api.origin, '/v1');
    expect(res.status).toBe(200);
  });
});

describe('requireApiPrincipal', () => {
  it('throws rather than returning undefined on an ungated route', async () => {
    // A route mounted on the wrong side of the gate must fail loudly the first
    // time it is exercised. The alternative — an optional principal — is one
    // `?.` away from a request that gets metered to nobody.
    const app = express();
    app.get('/ungated', (_req, res) => void res.json({ p: requireApiPrincipal(res) }));
    app.use(publicNotFoundHandler);
    app.use(publicErrorHandler);
    const server = await listen(app);
    try {
      const res = await get(server.origin, '/ungated');
      expect(res.status).toBe(500);
      // The message names the mistake for the operator's log, and the customer
      // still gets the constant 500 body.
      expect(res.body.error).toEqual({
        code: 'internal_error',
        message: 'An unexpected error occurred.',
      });
    } finally {
      await server.close();
    }
  });

  it('peekApiPrincipal reports presence and absence without throwing', async () => {
    const gated = await get(api.origin, '/v1/peek', `Bearer ${KEY.good.key}`);
    expect(gated.status).toBe(200);
    expect(gated.body).toEqual({ seen: true });

    const app = express();
    app.get('/ungated', (_req, res) => void res.json({ seen: peekApiPrincipal(res) !== undefined }));
    const server = await listen(app);
    try {
      expect((await get(server.origin, '/ungated')).body).toEqual({ seen: false });
    } finally {
      await server.close();
    }
  });
});

describe('every refusal is recorded — ABL-530', () => {
  /**
   * A gate with its own recorder, so refusals can be counted without the shared
   * app's traffic from every other block in this file landing in the same sink.
   */
  async function recording(now = () => new Date('2026-08-12T00:00:00.000Z')) {
    const { recorder, sink } = createTestAuthFailureRecorder();
    const server = await listen(appWith(seeded.directory, now, recorder));
    return {
      ...server,
      sink,
      /** Refusals are buffered, never written inline. Nothing is in the sink until this runs. */
      drain: () => {
        recorder.flush();
        return sink.events;
      },
      stats: () => recorder.stats(),
    };
  }

  it.each([
    { why: 'no header', header: undefined, code: AUTH_ERROR_CODES.missing, prefixed: false, verified: false },
    { why: 'a Basic credential', header: 'Basic abc', code: AUTH_ERROR_CODES.malformed, prefixed: false, verified: false },
    { why: 'an unissued key', header: null, code: AUTH_ERROR_CODES.invalid, prefixed: true, verified: false },
    { why: 'a revoked key', header: 'revoked', code: AUTH_ERROR_CODES.revoked, prefixed: true, verified: true },
    { why: 'an expired key', header: 'expired', code: AUTH_ERROR_CODES.expired, prefixed: true, verified: true },
    { why: 'a disabled account', header: 'disabledAccount', code: AUTH_ERROR_CODES.accountDisabled, prefixed: true, verified: true },
  ])('$why lands exactly one row with code $code', async ({ header, code, prefixed, verified }) => {
    // Every one of these produced *nothing* before this issue: the meter is
    // mounted behind the gate, so a refused request never reached it, and
    // `usage_events.account_id`/`key_id` are NOT NULL so it could not have held
    // the row anyway.
    const api = await recording();
    try {
      const sent =
        header === undefined
          ? undefined
          : header === null
            ? `Bearer ${mintApiKey('live').key}`
            : header in KEY
              ? `Bearer ${KEY[header as keyof typeof KEY].key}`
              : header;

      const res = await get(api.origin, '/v1/observations/load', sent);
      const rows = api.drain();

      expect(res.body.error?.code).toBe(code);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        errorCode: code,
        status: res.status,
        secretVerified: verified,
        // A template from the fixed table, never the raw path.
        routeTemplate: '/v1/observations/load',
        method: 'GET',
      });
      expect(rows[0].presentedPrefix === null).toBe(!prefixed);
      // The ids appear only once the secret has matched. A prefix guess names
      // nobody, and recording it as a key's owner would make the S4 query
      // ("who presented a real secret") answer with people who guessed.
      expect(rows[0].keyId === null).toBe(!verified);
      expect(rows[0].accountId === null).toBe(!verified);
    } finally {
      await api.close();
    }
  });

  it('never stores the presented secret, in any field', async () => {
    // The constraint the issue calls non-negotiable. Asserted against the whole
    // serialised row rather than field by field, so a column added later is
    // covered without anybody remembering to extend this.
    const api = await recording();
    try {
      const unissued = mintApiKey('live');
      const forged = withSecret(KEY.good.key, 'z'.repeat(KEY_SECRET_LENGTH));

      await get(api.origin, '/v1/probe', `Bearer ${unissued.key}`);
      await get(api.origin, '/v1/probe', `Bearer ${forged}`);
      await get(api.origin, '/v1/probe', `Bearer ${KEY.revoked.key}`);

      const serialised = JSON.stringify(api.drain());
      for (const secret of [
        unissued.key.split('_')[3],
        'z'.repeat(KEY_SECRET_LENGTH),
        KEY.good.key.split('_')[3],
        KEY.revoked.key.split('_')[3],
      ]) {
        expect(serialised).not.toContain(secret);
      }
      // …while the non-secret handle *is* there, because it is the one column
      // that separates enumeration from a customer with a stale key.
      expect(serialised).toContain(unissued.prefix);
      expect(serialised).toContain(KEY.revoked.record.prefix);
    } finally {
      await api.close();
    }
  });

  it('records the same shape whether the prefix is known or unknown', async () => {
    // The timing constraint, expressed as the thing that would cause a timing
    // difference: work done on one branch and not the other. `apiKeyAuth.ts`
    // burns a comparison so that "no such key" costs what "wrong secret" costs,
    // and a record gathered asymmetrically would hand that back.
    const api = await recording();
    try {
      await get(api.origin, '/v1/probe', `Bearer ${mintApiKey('live').key}`);
      await get(api.origin, '/v1/probe', `Bearer ${withSecret(KEY.good.key, 'z'.repeat(KEY_SECRET_LENGTH))}`);

      const [unknown, known] = api.drain();
      const populated = (row: Record<string, unknown>) =>
        Object.keys(row)
          .filter((field) => row[field] !== null)
          .sort();

      expect(populated(unknown as unknown as Record<string, unknown>)).toEqual(
        populated(known as unknown as Record<string, unknown>)
      );
      expect(unknown.errorCode).toBe(known.errorCode);
      expect(unknown.secretVerified).toBe(known.secretVerified);
    } finally {
      await api.close();
    }
  });

  it('writes nothing during the request — the sink is only touched on flush', async () => {
    // The other half of the timing property, and the one that also keeps this
    // from being a denial-of-service amplifier: a refused request is the one
    // kind of traffic on this surface that nothing rate-limits, because the plan
    // gate is mounted behind the key gate.
    const api = await recording();
    try {
      for (let i = 0; i < 5; i += 1) {
        await get(api.origin, '/v1/probe', `Bearer ${mintApiKey('live').key}`);
      }
      expect(api.sink.writeCalls).toBe(0);
      expect(api.stats().pending).toBe(5);

      expect(api.drain()).toHaveLength(5);
    } finally {
      await api.close();
    }
  });

  it('a sink that fails cannot change the response, and the records are retried', async () => {
    const api = await recording();
    try {
      api.sink.failNext();
      const first = await get(api.origin, '/v1/probe', `Bearer ${mintApiKey('live').key}`);
      expect(first.status).toBe(401);
      expect(first.body.error?.code).toBe(AUTH_ERROR_CODES.invalid);

      // The failed batch is put back rather than dropped: a security record is
      // the opposite trade from a billing one, where under-counting is the safe
      // direction.
      api.drain();
      expect(api.stats().failedFlushes).toBe(1);
      expect(api.drain()).toHaveLength(1);
    } finally {
      await api.close();
    }
  });

  it('an unrecognised path is recorded as such, never as the caller wrote it', async () => {
    // On a refused request the path is an unauthenticated caller-controlled
    // string, and this table is fed by exactly the callers we trust least.
    const api = await recording();
    try {
      // Kept under `/v1` deliberately: `fetch` normalises a literal `..` away
      // before the request leaves, so a traversal has to arrive percent-encoded
      // to reach the gate at all — which is also how a real scanner sends it.
      await get(api.origin, '/v1/%2e%2e%2f%2e%2e%2fetc%2fpasswd', undefined);
      await get(api.origin, '/v1/wp-login.php', undefined);

      const rows = api.drain();
      expect(rows.map((row) => row.routeTemplate)).toEqual(['(unrecognised)', '(unrecognised)']);
      expect(JSON.stringify(rows)).not.toContain('passwd');
      expect(JSON.stringify(rows)).not.toContain('wp-login');
    } finally {
      await api.close();
    }
  });

  it('records nothing for a request that succeeds', async () => {
    const api = await recording();
    try {
      expect((await get(api.origin, '/v1/probe', `Bearer ${KEY.good.key}`)).status).toBe(200);
      expect(api.drain()).toEqual([]);
    } finally {
      await api.close();
    }
  });

  it('an environment mismatch is recorded as secret-verified, which its code cannot say', async () => {
    // The branch that makes `secret_verified` a column rather than something
    // derivable from `error_code`: `key_invalid` is produced on both sides of
    // the hash comparison, so the code alone cannot distinguish somebody
    // guessing a prefix from somebody holding a real secret.
    const api = await recording();
    try {
      const res = await get(
        api.origin,
        '/v1/probe',
        `Bearer ${KEY.testEnv.key.replace('_test_', '_live_')}`
      );
      expect(res.body.error?.code).toBe(AUTH_ERROR_CODES.invalid);

      const [row] = api.drain();
      expect(row.secretVerified).toBe(true);
      expect(row.keyId).toBe(KEY.testEnv.record.id);
    } finally {
      await api.close();
    }
  });
});

describe('the directory contract', () => {
  it('is asked for the prefix and never the secret', async () => {
    // The secret must not become a query parameter, an index key or a log
    // line. Lookup is by the non-secret handle and the comparison happens in
    // this process.
    const seen: string[] = [];
    const spy: ApiKeyDirectory = {
      findByPrefix: (prefix) => {
        seen.push(prefix);
        return seeded.directory.findByPrefix(prefix);
      },
      close: () => {},
    };
    const server = await listen(appWith(spy));
    try {
      await get(server.origin, '/v1/probe', `Bearer ${KEY.good.key}`);
      expect(seen).toEqual([KEY.good.record.prefix]);
      // What it was handed is the 8-character handle, not the secret half.
      const secret = KEY.good.key.split('_')[3];
      expect(seen[0]).toHaveLength(8);
      expect(seen[0]).not.toBe(secret);
      expect(secret).not.toContain(seen[0]);
    } finally {
      await server.close();
    }
  });

  it('is consulted once per request', async () => {
    let calls = 0;
    const counting: ApiKeyDirectory = {
      findByPrefix: (prefix) => {
        calls += 1;
        return seeded.directory.findByPrefix(prefix);
      },
      close: () => {},
    };
    const server = await listen(appWith(counting));
    try {
      await get(server.origin, '/v1/probe', `Bearer ${KEY.good.key}`);
      expect(calls).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('a store failure is a 500 with the generic body, never a leaked message', async () => {
    const broken: ApiKeyDirectory = {
      findByPrefix: () => {
        throw new Error('SQLITE_CANTOPEN: unable to open /srv/secrets/api_keys.db');
      },
      close: () => {},
    };
    const server = await listen(appWith(broken));
    try {
      const res = await get(server.origin, '/v1/probe', `Bearer ${KEY.good.key}`);
      expect(res.status).toBe(500);
      expect(res.text).not.toContain('SQLITE');
      expect(res.text).not.toContain('/srv/secrets');
    } finally {
      await server.close();
    }
  });
});
