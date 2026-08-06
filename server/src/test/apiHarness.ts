import type { Server } from 'node:http';
import { createApp } from '../app.js';
import { cache } from '../middleware/cache.js';

/**
 * The real application, in its API-only mode.
 *
 * This used to hand-mirror the wiring — `/api` router, `notFoundHandler`,
 * `errorHandler` — under a comment claiming it was wired "the way
 * `src/index.ts` wires the API surface". It was not, and that gap *was* ABL-13:
 * the shipped app dropped both error handlers whenever `client/dist` existed,
 * while every route test went on asserting against a copy that kept them. Two
 * graphs means the tests can only ever pin the one nobody deploys, so this
 * calls `createApp` instead and the copy is gone.
 *
 * Mounting the real router — rather than the one router under test — is the
 * other half of the point. It pins the actual mount paths, which router wins a
 * colliding prefix, and the 404/500 envelopes a client really sees.
 *
 * `createApp`'s other mode, serving the built client, is covered by
 * `src/app.test.ts`; it needs an index.html on disk, which is not something a
 * route test should have to arrange.
 *
 * Nothing in this file touches a database. The caller mocks
 * `../config/database.js` before importing this module, and the router graph
 * picks the mock up.
 */
export function createApiApp() {
  return createApp();
}

export interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface TestApi {
  /** GET a path relative to `/api`, e.g. `dashboard/overview?country=DE`. */
  get(path: string): Promise<JsonResponse>;
  close(): Promise<void>;
}

/**
 * Start the API on an ephemeral port and return a `get` bound to it.
 *
 * Port 0 rather than a fixed one so parallel test files never collide.
 */
export async function startTestApi(): Promise<TestApi> {
  const app = createApiApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server did not bind a port');
  const base = `http://127.0.0.1:${addr.port}/api`;

  return {
    async get(path: string) {
      const res = await fetch(`${base}/${path}`);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Empty the response cache.
 *
 * `cacheMiddleware` is a module-level singleton keyed on the request URL, so
 * without this a later test can be served an earlier test's body — and, worse,
 * a deliberately broken route can go on returning the correct cached answer.
 * Call it in `beforeEach`.
 */
export function clearResponseCache(): void {
  cache.clear();
}
