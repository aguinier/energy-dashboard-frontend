import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { buildFixtureDb } from './test/fixtureDb.js';

/**
 * What the *real* `createApp` does, in both of its modes.
 *
 * The route tests mount a hand-wired app (`test/apiHarness.ts`) that has always
 * had the error handlers attached. That is precisely how ABL-13 hid: the app
 * under test and the app that ships were two different graphs, and only the
 * shipped one dropped `errorHandler` whenever `client/dist` existed. So this
 * file boots `createApp` itself, with a real built-client directory on disk,
 * and asserts the error contract from the outside.
 */

const fixtureDb = buildFixtureDb();
vi.mock('./config/database.js', () => ({ default: fixtureDb }));
vi.mock('./config/writeDatabase.js', async () => (await import('./test/noWriteDb.js')).forbidWriteDb());

const { createApp, resolveClientDist } = await import('./app.js');
const { clearResponseCache } = await import('./test/apiHarness.js');

const SPA_MARKER = '<!doctype html><title>able-spa-fixture</title><div id="root"></div>';
const HASHED_ASSET = 'assets/index.1a2b3c4d.js';

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

/** Raw fetch — the content type is half of what is under test, so nothing here assumes JSON. */
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

/** Throws `AppError('Invalid forecast type…', 400)` before touching the database. */
const THROWS_APP_ERROR = '/api/forecast-comparison/DE/ml-accuracy?forecastType=nonsense';

let distDir: string;
let spa: Awaited<ReturnType<typeof listen>>;
let apiOnly: Awaited<ReturnType<typeof listen>>;

beforeAll(async () => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'able-client-dist-'));
  fs.writeFileSync(path.join(distDir, 'index.html'), SPA_MARKER);
  fs.mkdirSync(path.join(distDir, 'assets'));
  fs.writeFileSync(path.join(distDir, HASHED_ASSET), 'console.log("built")');

  spa = await listen(createApp({ clientDist: distDir }));
  apiOnly = await listen(createApp());
});

afterAll(async () => {
  await spa.close();
  await apiOnly.close();
  fs.rmSync(distDir, { recursive: true, force: true });
});

beforeEach(() => clearResponseCache());

// The handler logs every error it formats; silence it so a passing run stays readable.
vi.spyOn(console, 'error').mockImplementation(() => {});

describe('createApp with a built client — the ABL-13 regressions', () => {
  it('answers a thrown AppError with the JSON error envelope', async () => {
    const res = await probe(spa.origin, THROWS_APP_ERROR);

    expect(res.status).toBe(400);
    expect(res.contentType).toContain('application/json');
    expect(res.json()).toEqual({
      success: false,
      error: 'Invalid forecast type. Must be one of: load, price, solar, wind_onshore, wind_offshore',
      code: 'INVALID_FORECAST_TYPE',
    });
  });

  it('leaks no stack trace, and no filesystem path, on that error', async () => {
    // The shipped body was `<pre>Error: Invalid forecast type…</pre>` followed
    // by ten frames naming absolute paths under the repo root and node_modules.
    const res = await probe(spa.origin, THROWS_APP_ERROR);

    expect(res.text).not.toContain('<pre>');
    expect(res.text).not.toContain('node_modules');
    expect(res.text).not.toContain('.ts:');
    expect(res.text.toLowerCase()).not.toContain('at layer');
    // Nothing beyond the three documented keys can carry a detail out.
    expect(Object.keys(res.json()).sort()).toEqual(['code', 'error', 'success']);
  });

  it('answers an unknown /api path with a JSON 404, not the SPA at HTTP 200', async () => {
    // `app.get('*')` used to swallow these: an endpoint typo came back as
    // index.html under a 200, which is a *success* status carrying HTML into
    // `unwrap()`. See the comment at client/src/services/unwrap.ts:6.
    const res = await probe(spa.origin, '/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.contentType).toContain('application/json');
    expect(res.json()).toEqual({ success: false, error: 'Resource not found', code: 'NOT_FOUND' });
    expect(res.text).not.toContain('able-spa-fixture');
  });

  it('answers a wrong method on a real API route with a JSON 404', async () => {
    // Not caught by `app.get('*')` either — this reached Express's built-in
    // 404, which is also HTML.
    const res = await probe(spa.origin, '/api/countries', { method: 'POST' });

    expect(res.status).toBe(404);
    expect(res.contentType).toContain('application/json');
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('still serves the SPA for a client-side route', async () => {
    const res = await probe(spa.origin, '/country/DE');

    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/html');
    expect(res.text).toContain('able-spa-fixture');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-store, must-revalidate');
  });

  it('still serves a hashed asset as immutable', async () => {
    const res = await probe(spa.origin, `/${HASHED_ASSET}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('built');
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('still routes the API ahead of the static mount', async () => {
    const res = await probe(spa.origin, '/api/health');

    expect(res.status).toBe(200);
    expect((res.json().data as { status: string }).status).toBe('healthy');
  });
});

describe('createApp without a built client', () => {
  it('gives the same error envelope as the SPA build', async () => {
    const withSpa = await probe(spa.origin, THROWS_APP_ERROR);
    const without = await probe(apiOnly.origin, THROWS_APP_ERROR);

    expect(without.status).toBe(withSpa.status);
    expect(without.json()).toEqual(withSpa.json());
  });

  it('gives the same JSON 404 as the SPA build', async () => {
    const res = await probe(apiOnly.origin, '/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('has no SPA fallback to serve', async () => {
    const res = await probe(apiOnly.origin, '/country/DE');

    expect(res.status).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

describe('resolveClientDist', () => {
  it('returns the directory when it holds an index.html', () => {
    expect(resolveClientDist(distDir)).toBe(distDir);
  });

  it('returns null when the directory does not exist', () => {
    expect(resolveClientDist(path.join(distDir, 'nope'))).toBeNull();
  });

  it('returns null for a directory with no index.html', () => {
    // `client/dist` surviving a partial build is the case that made the old
    // two-part existsSync check look necessary; one check covers it.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'able-empty-dist-'));
    try {
      expect(resolveClientDist(empty)).toBeNull();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
