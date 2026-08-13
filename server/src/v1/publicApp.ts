import express, { type Express } from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import { createV1Routes } from './routes/index.js';
import publicRootRoutes from './routes/root.js';
import { requireApiKey } from './auth/apiKeyAuth.js';
import { publicErrorHandler, publicNotFoundHandler } from './publicErrors.js';
import { assertPublicEnvironment, parsePublicCorsOrigins, type PublicEnv } from './publicEnv.js';
import type { ApiKeyDirectory } from './keys/apiKeyStore.js';
import type { UsageMeter } from './usage/usageMeter.js';
import type { V1DataContext } from './data/context.js';

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
   * The meter every authenticated request is counted by (ABL-301).
   *
   * **Required, with no default, for the same reason `apiKeyDirectory` is.** An
   * app composed without a meter is an API that serves paid traffic and bills
   * nobody — the silent under-count ABL-301 exists to prevent — and the failure
   * would be invisible until the first invoice came out as zero. There is no way
   * to spell that app, so it cannot be built by forgetting something.
   *
   * Injected rather than constructed here, so `publicApp.ts` names the *shape*
   * of a meter and `publicIndex.ts` decides what backs it. The concrete store is
   * the only thing that touches `better-sqlite3`, and it is not in this
   * module's graph; `publicAppGraph.test.ts` pins that.
   *
   * The entrypoint owns the meter's lifecycle rather than the app doing it,
   * because the buffer has to be flushed on shutdown and only the entrypoint
   * knows when that is.
   */
  usageMeter: UsageMeter;

  /**
   * The energy data the `/v1` resources read, plus the memoized freshness and
   * catalogue maps built over it (ABL-303).
   *
   * **Required, with no default, for the third time in this options bag** — and
   * the reason has shifted slightly each time, which is worth a line. A missing
   * key store would be an unauthenticated API; a missing meter would be an API
   * that bills nobody; a missing data source would be an API with no product in
   * it. The first two are dangerous, the third is merely useless, but all three
   * are states nobody would choose deliberately, so none of them is spellable.
   *
   * Injected as a type, exactly like the other two, and that is what keeps this
   * module's import graph free of `better-sqlite3` even though `/v1` now reads a
   * 9.4 GB SQLite file on every request. `publicApp.ts` names the *shape* of a
   * data source; `publicIndex.ts` opens one — readonly, on a database owned by
   * `energy-data-gathering`. `publicAppGraph.test.ts` pins both halves.
   *
   * The context also carries the **public base URL**, which is configuration
   * rather than anything derived from a request. That is trap 1 from the ABL-291
   * brief: a `next` link built from `req.get('host')` bakes a `192.168.x`
   * address into a subscriber's client, works perfectly on the LAN, and is
   * discovered only after the API moves.
   */
  data: V1DataContext;

  /**
   * The environment to configure from and to vet. Defaults to `process.env`.
   *
   * Injectable so tests can assert the refusal without mutating a global under
   * a concurrently running file.
   */
  env?: PublicEnv;
}

export function createPublicApp({
  apiKeyDirectory,
  usageMeter,
  data,
  env = process.env,
}: PublicAppOptions): Express {
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

  // Four mounts, and the order is the security property (ABL-300) and the
  // billing property (ABL-301).
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
  //
  // The meter goes **after the gate and before the routes**, and both halves of
  // that matter:
  //
  // - *After* the gate, because a metered request must have a principal to be
  //   metered to. `requireApiPrincipal` throws rather than counting to nobody,
  //   so mounting it on the wrong side fails on the first request instead of
  //   producing an invoice with a hole in it.
  // - *Before* the routes and, when anything adds one, **outside the cache**.
  //   This is the one ordering detail in ABL-293 §2c that is not negotiable:
  //   `cacheMiddleware` returns early on a hit and never reaches the handler, so
  //   a meter mounted inside the cache bills a customer polling a 5-minute-TTL
  //   endpoint for 1 request in 300. **ABL-303 added no cache** — the row cap
  //   and the 366-day window bound query cost directly, and a cache would have
  //   made `freshness.generated_at` lie by up to its TTL unless every handler
  //   computed it, which is why §2g.F requires the handler to stamp it. The
  //   ordering above is what lets one be added later without a billing hole.
  //
  // ABL-302's quota check slots in between the meter and the routes: it needs
  // the count this produces, and a request refused for quota is still a request
  // that was made, so it must be counted before it can be refused.
  app.use('/v1', publicRootRoutes);
  app.use('/v1', requireApiKey({ directory: apiKeyDirectory }));
  app.use('/v1', usageMeter.middleware);
  app.use('/v1', createV1Routes(data));

  // Unconditional and last, in this order — `notFound` first so anything that
  // matched no route becomes a typed 404 rather than reaching Express's HTML
  // default, then the error handler, which Express selects by arity.
  app.use(publicNotFoundHandler);
  app.use(publicErrorHandler);

  return app;
}
