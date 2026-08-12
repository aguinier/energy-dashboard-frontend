import express, { type Express } from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import v1Routes from './routes/index.js';
import publicRootRoutes from './routes/root.js';
import { requireApiKey } from './auth/apiKeyAuth.js';
import { publicErrorHandler, publicNotFoundHandler } from './publicErrors.js';
import { assertPublicEnvironment, parsePublicCorsOrigins, type PublicEnv } from './publicEnv.js';
import type { ApiKeyDirectory } from './keys/apiKeyStore.js';

/**
 * The public application, composed from scratch.
 *
 * This is a **second app**, not a filtered view of the first. `createApp()`
 * mounts one router tree at `/api` (`app.ts:88`) holding all 52 handlers —
 * ops status, health provenance, the two ingest `POST`s, the UI-shaped
 * dashboard routes, weather. None of them is imported here, and there is no
 * line in this file's dependency graph that could route to one whatever the
 * middleware order is. `publicApp.test.ts` asserts that graph by name.
 *
 * Why not a filter: an allowlist middleware is a list someone has to remember
 * to update. When they do not, the failure is silent and the failure mode is
 * "an ops endpoint became public" — noticed, if at all, in a log. Composition
 * makes the mistake unrepresentable instead of unlikely (ABL-293 §2f).
 *
 * **Deliberately absent, each one load-bearing:**
 *
 * - **`routes/index.js`** — with it, the whole internal surface. Without it,
 *   `/api/*` is not a route on this app at all; it 404s like any other unknown
 *   path, and so do `/api/ops/status`, `/api/health` and
 *   `POST /api/forecasts/net-position`.
 * - **The static mount and SPA fallback** (`app.ts:91-124`). No `express.static`
 *   and no `app.get('*')`, so the entire "unmatched path answers 200 index.html"
 *   class of bug (ABL-13) cannot occur here — `publicNotFoundHandler` is the only
 *   catch-all.
 * - **A body parser.** There is no `POST` on this surface, so no
 *   `express.json()` — which also means the 4 MB ingest exception at
 *   `app.ts:83` has nothing to attach to. A body cannot be parsed because
 *   nothing parses one, not because a route rejects it.
 * - **`config/writeDatabase.js`.** `getWriteDb()` is not reachable, so an
 *   ingest write from this process is impossible by absent capability rather
 *   than by a check that returned false.
 *
 * The public process is expected to be exactly that — a separate process on its
 * own port, run from `publicIndex.ts`. The private app keeps 3001 and keeps
 * every internal route exactly as it is, unchanged and unrisked by this issue.
 * That separation is what makes composing early cheap: nothing in `app.ts`,
 * `routes/` or `middleware/` is modified by ABL-304.
 */

export interface PublicAppOptions {
  /**
   * The store the API-key gate authenticates against (ABL-300).
   *
   * **Required, with no default**, and that is the point: an app built without
   * a key store would be an unauthenticated public API, so there is no way to
   * spell one. The type is {@link ApiKeyDirectory} — read-only by construction,
   * so the composition cannot issue, rotate or revoke a key even by mistake;
   * that capability lives on `ApiKeyAdminStore` and is held only by the keys
   * CLI.
   *
   * Injected rather than opened here, which is also what keeps
   * `better-sqlite3` out of this module's import graph: `publicApp.ts` names
   * the *shape* of a key store, and `publicIndex.ts` decides which one. The
   * type-only import above is erased by `tsc`, so it is not a runtime edge —
   * `publicAppGraph.test.ts` pins that.
   */
  apiKeyDirectory: ApiKeyDirectory;

  /**
   * The environment to configure from and to vet. Defaults to `process.env`.
   *
   * Injectable so tests can assert the refusal without mutating a global under
   * a concurrently running file.
   */
  env?: PublicEnv;
}

export function createPublicApp({ apiKeyDirectory, env = process.env }: PublicAppOptions): Express {
  // First, before anything is wired: refuse to exist in a process that was
  // handed a write or ops capability. See FORBIDDEN_PUBLIC_ENV for why this is
  // a startup failure rather than a warning.
  assertPublicEnvironment(env);

  const app = express();

  // Express advertises itself by default; the private app leaves helmet to
  // remove it, and this states it locally so the guarantee does not depend on
  // helmet's defaults staying as they are.
  app.disable('x-powered-by');

  app.use(
    helmet({
      // Note what is *not* here: `app.ts:63-71` nulls out
      // `upgrade-insecure-requests` so the dashboard can be served over plain
      // HTTP on the LAN. That exception is exactly the kind of "depends on
      // plain HTTP" decision ABL-291 brief §2 says must not travel into the
      // public profile, so this composition keeps helmet's default. It costs
      // nothing on the LAN today: the directive governs subresource loading in
      // a browsing context, and a JSON response has no subresources.
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          // Nothing is ever loaded from this origin — it answers JSON only.
          'default-src': ["'none'"],
          'frame-ancestors': ["'none'"],
        },
      },
    })
  );

  app.use(
    cors({
      // An allowlist, replacing `origin: true` + `credentials: true`
      // (`app.ts:72-75`), which reflects any Origin the caller sends and then
      // permits credentialed requests against it. Empty by default: no browser
      // origin gets cross-origin read access until one is named.
      origin: parsePublicCorsOrigins(env.PUBLIC_CORS_ORIGINS),
      // Authentication on this surface is `Authorization: Bearer <api key>`
      // (ABL-300), never a cookie, so credentialed CORS is never needed — and
      // `credentials: true` is the half of the old pair that makes a reflected
      // origin dangerous.
      credentials: false,
      // Reads only. The public surface has no write verb, and saying so here
      // means a preflight for one is refused before any route matching happens.
      methods: ['GET', 'HEAD', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
      // Named now so that when ABL-302 starts sending these, a browser client
      // can already read them; a header a browser cannot see is a quota a
      // browser client cannot respect.
      exposedHeaders: [
        'RateLimit-Limit',
        'RateLimit-Remaining',
        'RateLimit-Reset',
        'Retry-After',
        'Quota-Limit-Month',
        'Quota-Remaining-Month',
      ],
    })
  );

  app.use(compression());

  // Three mounts, and the order is the security property (ABL-300).
  //
  // `publicRootRoutes` is the entire unauthenticated surface — one discovery
  // endpoint returning two constants. It is a separate module rather than the
  // first route inside `v1Routes` so that "what needs no key" is a file
  // somebody edits deliberately, not a consequence of which line came first.
  //
  // `requireApiKey` then gates **everything else under `/v1`**, including paths
  // that match no route. So an unauthenticated caller gets 401 rather than 404
  // from `/v1/observations/load`, which means the surface cannot be enumerated
  // without a key — and, more usefully, a resource ABL-303 adds to `v1Routes`
  // is authenticated whether or not its author thought about it.
  //
  // CORS is deliberately ahead of the gate: the `cors` middleware answers a
  // preflight `OPTIONS` itself and ends the chain, so a browser's preflight —
  // which by specification carries no `Authorization` header — is never 401'd.
  // ABL-301's meter and ABL-302's quota check slot in after the gate, in that
  // order, both of them outside the cache (ABL-293 §2c).
  app.use('/v1', publicRootRoutes);
  app.use('/v1', requireApiKey({ directory: apiKeyDirectory }));
  app.use('/v1', v1Routes);

  // Unconditional and last, in this order — `notFound` first so anything that
  // matched no route becomes a typed 404 rather than reaching Express's HTML
  // default, then the error handler, which Express selects by arity.
  app.use(publicNotFoundHandler);
  app.use(publicErrorHandler);

  return app;
}
