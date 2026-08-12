import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { createPublicApp } from './publicApp.js';
import { FORBIDDEN_PUBLIC_ENV } from './publicEnv.js';

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

beforeAll(async () => {
  for (const name of FORBIDDEN_PUBLIC_ENV) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  api = await listen(createPublicApp());
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

  it('404s an unknown path under /v1 with the public envelope', async () => {
    const res = await probe(api.origin, '/v1/observations/load');

    expect(res.status).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'No such resource.' } });
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
      createPublicApp({ env: { PUBLIC_CORS_ORIGINS: 'https://docs.example.com, https://app.example.com' } })
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
    expect(() => createPublicApp({ env: { [name]: 'set-by-a-deployment' } })).toThrow(name);
  });

  it('never puts the value in the message', () => {
    // An error message is the one place a secret reliably reaches a log file.
    expect(() => createPublicApp({ env: { HELIO_WRITE_TOKEN: 'super-secret-value' } })).toThrow(
      /HELIO_WRITE_TOKEN/
    );
    try {
      createPublicApp({ env: { HELIO_WRITE_TOKEN: 'super-secret-value' } });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('super-secret-value');
    }
  });

  it('builds when the environment is clean', () => {
    expect(() => createPublicApp({ env: {} })).not.toThrow();
  });
});

// The structural half — that these handlers are not in the app's import graph
// at all — lives in `publicAppGraph.test.ts`, which reads this app as text and
// never imports it. Keeping it out of this file is deliberate: a violation of
// the isolation tends to make `publicApp.ts` unimportable (`config/database.ts`
// opens SQLite at import time), which would take this whole file down with a
// load error and report "no tests" instead of naming the module that arrived.
