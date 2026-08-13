import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { createPublicApp } from './publicApp.js';
import { FORBIDDEN_PUBLIC_ENV } from './publicEnv.js';
import { createMemoryApiKeyDirectory } from './keys/memoryApiKeyDirectory.js';
import { createMemoryUsageSink, type MemoryUsageSink } from './usage/memoryUsageSink.js';
import { createUsageMeter, type UsageMeter } from './usage/usageMeter.js';
import { createMemoryDataContext, createMemoryEnergySource } from './data/memoryEnergySource.js';

/**
 * What the public composition does, from the outside.
 *
 * This is one of two independent controls, and it is deliberately the weaker
 * one: every internal path answering 404 would *also* be true of an app that
 * mounted the internal router behind an allowlist middleware — right up until
 * someone reordered the middleware. `publicAppGraph.test.ts` carries the other
 * half, that the handlers are not in the app at all. Together they say "these
 * routes are gone, and the app is otherwise working"; neither says it alone,
 * since a completely unwired app passes everything in this file.
 *
 * Nothing here mocks `config/database.js`. It does not need to: if the public
 * graph ever reaches the database, that is a finding rather than a nuisance to
 * be mocked away.
 */

interface Probe {
  status: number;
  contentType: string;
  headers: Headers;
  text: string;
  json(): Record<string, unknown>;
}

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

/** Raw fetch — the content type is half of what is under test, so nothing assumes JSON. */
async function probe(origin: string, p: string, init?: RequestInit): Promise<Probe> {
  const res = await fetch(`${origin}${p}`, init);
  const text = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    headers: res.headers,
    text,
    json: () => JSON.parse(text) as Record<string, unknown>,
  };
}

/**
 * A clean environment for the app under test.
 *
 * `createPublicApp` refuses to build when a forbidden variable is set, and the
 * workstation running this suite may well have `HELIO_WRITE_TOKEN` exported for
 * the ingest scripts. Clearing them here keeps the file hermetic; the refusal
 * itself is asserted below against an injected bag, not against the real
 * process env.
 */
const savedEnv = new Map<string, string | undefined>();
let api: Awaited<ReturnType<typeof listen>>;

/**
 * One seeded key, so this file can reach past the ABL-300 gate.
 *
 * `createPublicApp` requires a key store — there is no way to spell an
 * unauthenticated public app — so every `createPublicApp` call here passes one.
 * The in-memory directory keeps this file free of a database, which is the
 * property the header above describes: if the public graph ever reaches the
 * *energy* database that is a finding, not a nuisance to be mocked away.
 */
const seeded = createMemoryApiKeyDirectory([{ accountName: 'Test Account' }]);
const AUTH = { Authorization: `Bearer ${seeded.keys[0].key}` };

/**
 * A meter, for the same reason a key store is here: `createPublicApp` requires
 * one, because an app that serves paid traffic and bills nobody is not an app
 * anybody meant to build (ABL-301).
 *
 * In-memory, and `flushIntervalMs: 0` so flushing is something a test does
 * rather than something it waits for. It keeps this file free of a database,
 * which is the property the header describes.
 */
function meter(): { meter: UsageMeter; sink: MemoryUsageSink } {
  const sink = createMemoryUsageSink();
  return { meter: createUsageMeter({ sink, flushIntervalMs: 0 }), sink };
}

const mounted = meter();

/**
 * A data context, for the third time and the third reason (ABL-303): an app
 * without one would have no product in it.
 *
 * In-memory and **deliberately empty of rows**. This file's job is the isolation
 * claim — that the internal surface is absent and that everything under `/v1`
 * needs a key — and both are answered by the *routing*, not by the data. An
 * empty database keeps that separation: a 401 here is about the gate, and a 200
 * with `coverage: "out_of_scope"` is about the gate too. What the endpoints
 * actually return, against seeded rows, is `data/*.test.ts` and
 * `routes/*.test.ts`.
 *
 * It is still a real SQLite handle rather than a stub, so if the composition
 * ever reached the *energy* database that would show up as a finding here rather
 * than being mocked away.
 */
function dataContext() {
  const source = createMemoryEnergySource();
  return createMemoryDataContext(source);
}

beforeAll(async () => {
  for (const name of FORBIDDEN_PUBLIC_ENV) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  api = await listen(
    createPublicApp({
      apiKeyDirectory: seeded.directory,
      usageMeter: mounted.meter,
      data: dataContext(),
    })
  );
});

afterAll(async () => {
  await api.close();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

vi.spyOn(console, 'error').mockImplementation(() => {});

/**
 * The internal surface, by path, as ABL-293 §1.1 inventories it.
 *
 * Each entry is a route that really is mounted on `createApp()` — checked
 * against `routes/index.ts:23-59` — so a 404 here is evidence of absence rather
 * than of a typo. The four classes ABL-304 names are all represented: ops,
 * health internals, UI-shaped dashboard routes, and write/ingest.
 */
const INTERNAL_PATHS: ReadonlyArray<{ path: string; method?: string; why: string }> = [
  { path: '/api/ops/status', why: 'host telemetry: platform, disk free, RSS, db_path (§1.2c)' },
  { path: '/api/ops/status/combined', why: 'raw exception text in a 200 body (§1.2a)' },
  { path: '/api/health', why: 'db_path, commit SHA and runtime kind (§1.2b)' },
  { path: '/api/weather/latest?a=1', why: 'unauthenticated, uncapped, SELECT *-shaped (§1.2d)' },
  { path: '/api/dashboard/overview?country=DE', why: 'UI render plan, not a resource' },
  { path: '/api/dashboard/initial?country=DE', why: 'exists only to save the SPA a round trip' },
  { path: '/api/dashboard/map', why: 'closed timeRange enum, a UI shape' },
  { path: '/api/dashboard/timeseries?country=DE', why: 'UI-shaped' },
  { path: '/api/forecasts/net-position', method: 'POST', why: 'write/ingest, HELIO_WRITE_TOKEN-gated' },
  { path: '/api/weather/snapshot', method: 'POST', why: 'write/ingest, HELIO_WRITE_TOKEN-gated' },
  { path: '/api/countries', why: 'a public-candidate resource, but only via /v1 and its contract' },
  { path: '/api/load?country=DE', why: 'uncapped: one request returns ~200k rows (§2d)' },
  { path: '/api/forecasts?country=DE&type=load', why: 'the /api shape is not the /v1 contract' },
  { path: '/api/core-net-position/FR?start=1&end=2', why: 'JAO, gated on legal sign-off' },
  { path: '/api/data-freshness/DE', why: 'ops-shaped; /v1/catalog/coverage replaces it' },
];

describe('the public composition answers nothing internal', () => {
  it.each(INTERNAL_PATHS)('404s $method $path — $why', async ({ path: p, method }) => {
    const res = await probe(api.origin, p, method ? { method } : undefined);

    expect(res.status).toBe(404);
    expect(res.contentType).toContain('application/json');
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'No such resource.' } });
  });

  it('leaks nothing internal in the aggregate of those responses', async () => {
    // One assertion over every body at once, because the leak that matters is
    // the one nobody wrote a case for. `db_path`, `commit` and the SQLite
    // column names are the three ABL-293 §1.2 ranks highest.
    const bodies = await Promise.all(
      INTERNAL_PATHS.map(async ({ path: p, method }) =>
        (await probe(api.origin, p, method ? { method } : undefined)).text
      )
    );
    const all = bodies.join('\n');

    for (const leak of ['db_path', 'commit', 'SQLITE', 'no such column', 'node_modules', '.ts:', 'ENERGY_DB_PATH']) {
      expect(all).not.toContain(leak);
    }
  });

  it('has no SPA fallback, so an unknown path is a 404 and never index.html', async () => {
    // ABL-13 on the private app: `app.get('*')` answered unmatched paths with
    // index.html under a 200. The static branch is not part of this app, so
    // the class of bug is absent rather than fixed.
    const res = await probe(api.origin, '/country/DE');

    expect(res.status).toBe(404);
    expect(res.contentType).toContain('application/json');
    expect(res.text).not.toContain('<!doctype');
  });

  it('404s the /api prefix itself', async () => {
    const res = await probe(api.origin, '/api');
    expect(res.status).toBe(404);
  });
});

describe('the public composition does answer /v1', () => {
  // The positive control. Without it every test above is also satisfied by an
  // app with no routes at all.
  it('serves the discovery root', async () => {
    const res = await probe(api.origin, '/v1');

    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ version: 'v1', status: 'ok' });
  });

  it('carries no provenance on it — no db_path, no commit, no runtime', async () => {
    const body = (await probe(api.origin, '/v1')).json();
    expect(Object.keys(body).sort()).toEqual(['status', 'version']);
  });

  it('404s an unknown path under /v1 with the public envelope, once authenticated', async () => {
    // This used to probe `/v1/observations/load`, which ABL-303 implemented —
    // so it now answers 400 (`zone` is required) rather than 404, and the test
    // moved to a path that is genuinely not a resource. Worth keeping the note:
    // the assertion is about the *not-found envelope*, and pointing it at a real
    // route would have quietly turned it into an assertion about parameter
    // validation the first time somebody made the two agree.
    const res = await probe(api.origin, '/v1/observations/net-position', { headers: AUTH });

    expect(res.status).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'No such resource.' } });
  });

  it('has no net-position resource at all, authenticated or not', async () => {
    // Board decision 2 is open, so net position is out of `/v1` — and it is out
    // by *construction*: there is no route, no `net_position` stream in
    // `data/series.ts`, and no `net_position` type in `data/models.ts`. The
    // 404 above is what that absence looks like from outside; this names why it
    // must stay absent even though ABL-298 closed with JAO authorisation held.
    const forecast = await probe(api.origin, '/v1/forecasts?zone=DE&type=net_position&from=2026-08-01&to=2026-08-02', {
      headers: AUTH,
    });

    expect(forecast.status).toBe(400);
    expect(forecast.json().error.code).toBe('invalid_type');
    // The message lists what *is* offered, and net_position is not in it.
    expect(forecast.json().error.message).not.toContain('net_position');
  });

  it('401s an unimplemented path without a key, so the surface cannot be enumerated', async () => {
    // ABL-300. The gate is mounted between the discovery root and the resource
    // router, so it covers *paths* rather than routes: an unauthenticated caller
    // cannot tell an unimplemented resource from an implemented one, and a
    // route ABL-303 added is authenticated whether or not its author thought
    // about it.
    const res = await probe(api.origin, '/v1/observations/net-position');

    expect(res.status).toBe(401);
    expect(res.json()).toEqual({
      error: {
        code: 'key_missing',
        message: 'This endpoint requires an API key. Send it as: Authorization: Bearer able_live_...',
      },
    });
  });

  it('keeps the discovery root open, and it is the only thing that is', async () => {
    expect((await probe(api.origin, '/v1')).status).toBe(200);
    for (const path of ['/v1/', '/v1/catalog', '/v1/anything/at/all']) {
      const res = await probe(api.origin, path);
      // `/v1/` is the root again after Express strips the mount path; the rest
      // are gated.
      expect(res.status).toBe(path === '/v1/' ? 200 : 401);
    }
  });
});

describe('hardened HTTP configuration', () => {
  it('does not reflect an arbitrary Origin back', async () => {
    // `origin: true` + `credentials: true` on the private app echoes whatever
    // the caller sent. With an empty allowlist the header is simply absent, so
    // no browser origin is granted cross-origin read access.
    const res = await probe(api.origin, '/v1', { headers: { Origin: 'https://evil.example' } });

    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('allows an origin that is on the allowlist, and only that one', async () => {
    const allowlisted = await listen(
      createPublicApp({
        apiKeyDirectory: seeded.directory,
        usageMeter: meter().meter,
        data: dataContext(),
        env: { PUBLIC_CORS_ORIGINS: 'https://docs.example.com, https://app.example.com' },
      })
    );
    try {
      const ok = await probe(allowlisted.origin, '/v1', {
        headers: { Origin: 'https://app.example.com' },
      });
      expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
      // Still never credentialed: the API authenticates with a bearer key.
      expect(ok.headers.get('access-control-allow-credentials')).toBeNull();

      const denied = await probe(allowlisted.origin, '/v1', {
        headers: { Origin: 'https://app.example.com.evil.test' },
      });
      expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await allowlisted.close();
    }
  });

  it('keeps upgrade-insecure-requests, which the private app disables for LAN HTTP', async () => {
    const csp = (await probe(api.origin, '/v1')).headers.get('content-security-policy') ?? '';

    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).toContain("default-src 'none'");
  });

  it('does not advertise the server', async () => {
    expect((await probe(api.origin, '/v1')).headers.get('x-powered-by')).toBeNull();
  });
});

describe('the public app refuses a process holding write or ops capability', () => {
  it.each([...FORBIDDEN_PUBLIC_ENV])('refuses to build when %s is set', (name) => {
    expect(() => createPublicApp({ apiKeyDirectory: seeded.directory, usageMeter: meter().meter, data: dataContext(), env: { [name]: 'set-by-a-deployment' } })).toThrow(name);
  });

  it('never puts the value in the message', () => {
    // An error message is the one place a secret reliably reaches a log file.
    expect(() => createPublicApp({ apiKeyDirectory: seeded.directory, usageMeter: meter().meter, data: dataContext(), env: { HELIO_WRITE_TOKEN: 'super-secret-value' } })).toThrow(
      /HELIO_WRITE_TOKEN/
    );
    try {
      createPublicApp({ apiKeyDirectory: seeded.directory, usageMeter: meter().meter, data: dataContext(), env: { HELIO_WRITE_TOKEN: 'super-secret-value' } });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('super-secret-value');
    }
  });

  it('builds when the environment is clean', () => {
    expect(() => createPublicApp({ apiKeyDirectory: seeded.directory, usageMeter: meter().meter, data: dataContext(), env: {} })).not.toThrow();
  });
});

describe('the meter is mounted where the composition says it is (ABL-301)', () => {
  /** Wait for the response's `close` handler, which does not run inside `fetch`. */
  async function settled(): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      if (mounted.meter.stats().pending > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it('counts an authenticated request against the key that made it', async () => {
    mounted.meter.flush();
    mounted.sink.events.length = 0;

    await probe(api.origin, '/v1/observations/load', { headers: AUTH });
    await settled();
    mounted.meter.flush();

    const recorded = mounted.sink.events.filter((e) => e.routeTemplate !== '/v1');
    expect(recorded.length).toBeGreaterThanOrEqual(1);
    expect(recorded[0].keyId).toBe(seeded.keys[0].record.id);
  });

  it('does not count a request the gate refused', async () => {
    mounted.meter.flush();
    mounted.sink.events.length = 0;

    // The mount order is the assertion: the meter sits *after* `requireApiKey`,
    // so a 401 never reaches it. Metering an unauthenticated request would put
    // rows in the billing table that no invoice could ever explain — and
    // mounting the meter first is the obvious mistake, because it looks like it
    // would give a more complete log.
    const res = await probe(api.origin, '/v1/observations/load');
    expect(res.status).toBe(401);

    await new Promise((resolve) => setTimeout(resolve, 50));
    mounted.meter.flush();
    expect(mounted.sink.events).toHaveLength(0);
  });

  it('does not count the unauthenticated discovery root', async () => {
    mounted.meter.flush();
    mounted.sink.events.length = 0;

    // `publicRootRoutes` is mounted ahead of the gate and ends the chain, so it
    // never reaches the meter. It is the one endpoint with no key behind it, so
    // there is nobody to bill for it.
    expect((await probe(api.origin, '/v1')).status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 50));
    mounted.meter.flush();
    expect(mounted.sink.events).toHaveLength(0);
  });
});

// The structural half — that these handlers are not in the app's import graph
// at all — lives in `publicAppGraph.test.ts`, which reads this app as text and
// never imports it. Keeping it out of this file is deliberate: a violation of
// the isolation tends to make `publicApp.ts` unimportable (`config/database.ts`
// opens SQLite at import time), which would take this whole file down with a
// load error and report "no tests" instead of naming the module that arrived.
