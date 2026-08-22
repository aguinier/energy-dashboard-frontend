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
import type { AuthFailureRecorder } from './security/authFailureRecorder.js';
import type { UsageMeter } from './usage/usageMeter.js';
import type { PlanGate } from './quota/planGate.js';
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
   * Where refused requests are recorded (ABL-530).
   *
   * **Required, with no default, and the fifth in this bag** — the reason has
   * shifted each time, and this one is the only capability whose absence was the
   * *actual* state of the deployed shape rather than a hypothetical. An app
   * composed without it authenticates correctly and leaves no trace of anyone
   * who failed to: no row, no counter, and the only log line is
   * `publicErrors.ts`'s `console.error` on a body whose every message is a
   * constant, so it says a 401 happened and nothing about who, from where, or
   * against which prefix (ABL-524 §1.2–1.3). The honest answer to "would we
   * notice a credential-stuffing campaign" was no.
   *
   * That could not be fixed by moving the meter. The meter is mounted behind the
   * gate because a metered request must have a principal, and a refused request
   * has none; `usage_events` could not hold such a row either, since `account_id`
   * and `key_id` are both `NOT NULL`. So this is a second, narrower record with
   * its own table, in the same file, under the same retention job.
   *
   * Injected as a type, like the four below, so this module still names only
   * shapes: the recorder ultimately appends rows to a SQLite file and none of
   * that is in this module's import graph. `publicAppGraph.test.ts` pins it —
   * `createPublicApp`'s module list is **unchanged** by ABL-530.
   */
  authFailureRecorder: AuthFailureRecorder;

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
   * The plan quota and per-minute rate limit every authenticated request is
   * checked against (ABL-302).
   *
   * **Required, with no default, for the same reason the two above are**, and the
   * reason is the sharpest one yet because it is commercial rather than
   * technical. An app composed without this gate serves every plan the same
   * unlimited service: Explorer's 1,000 requests and Professional's 500,000 buy
   * identical access, the €0 tier is the €249 tier, and nothing in the process
   * would say so — the meter would keep counting happily and the invoices would
   * keep coming out right, which is what makes it silent. There is no way to
   * spell that app.
   *
   * Injected as a type, like the other three, so this module still names only
   * shapes: the gate ultimately counts rows in a SQLite file, and none of that
   * is in this module's import graph. `publicAppGraph.test.ts` pins it.
   *
   * What this gate does **not** do is as load-bearing as what it does: it refuses
   * requests with a 429 and it never changes an account's state. ABL-297's
   * requirement on ABL-302 — from a Board decision, and written into the AUP —
   * is that suspension is never fully automated. See `quota/planGate.ts` for how
   * that is held by construction rather than by policy.
   */
  planGate: PlanGate;

  /**
   * The energy data the `/v1` resources read, plus the memoized freshness and
   * catalogue maps built over it (ABL-303).
   *
   * **Required, with no default, for the fourth time in this options bag** — and
   * the reason has shifted slightly each time, which is worth a line. A missing
   * key store would be an unauthenticated API; a missing meter would be an API
   * that bills nobody; a missing plan gate would be an API where every plan buys
   * the same thing; a missing data source would be an API with no product in it.
   * The first three are dangerous, the fourth is merely useless, but all four are
   * states nobody would choose deliberately, so none of them is spellable.
   *
   * Injected as a type, exactly like the other three, and that is what keeps this
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
  authFailureRecorder,
  usageMeter,
  planGate,
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
      // Named by ABL-304 in advance so that when ABL-302 started sending these,
      // a browser client could already read them; a header a browser cannot see
      // is a quota a browser client cannot respect. ABL-302 sends all six and
      // adds a seventh.
      //
      // The list is duplicated from `quota/planGate.ts`'s two header tables, and
      // `publicApp.test.ts` asserts the two agree. Importing the tables instead
      // would put `planGate.ts` in this module's runtime graph — and with it the
      // rate limiter, the quota counter and `usageStore.ts` — to save retyping
      // seven strings. The composition names shapes and chooses no
      // implementation; a test is the cheaper way to keep two lists honest.
      exposedHeaders: [
        'RateLimit-Limit',
        'RateLimit-Remaining',
        'RateLimit-Reset',
        'Retry-After',
        'Quota-Limit-Month',
        'Quota-Remaining-Month',
        // ABL-302. A soft overage a customer cannot observe is a bill arriving
        // without warning, so the figure that will be invoiced is on every
        // response of a plan that can accrue one.
        'Quota-Overage-Month',
      ],
    })
  );

  app.use(compression());

  // Five mounts, and the order is the security property (ABL-300), the billing
  // property (ABL-301) and the commercial one (ABL-302).
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
  //   endpoint for 1 request in 300. **No cache has been added** — the row cap
  //   and the 366-day window bound query cost directly, and a cache would have
  //   made `freshness.generated_at` lie by up to its TTL unless every handler
  //   computed it, which is why §2g.F requires the handler to stamp it. The
  //   ordering above is what lets one be added later without a billing hole.
  //
  // **ABL-302's gate went exactly where ABL-301 reserved for it** — between the
  // meter and the routes — and both sides of that position are load-bearing:
  //
  // - *After the meter*, because a request refused for quota is still a request
  //   that was made. The meter's `close` listener is registered before the gate
  //   runs, so a 429 is recorded with its status, its route and its key, which is
  //   what abuse detection and a billing dispute both read from. Mounted the
  //   other way round, the traffic that most needs to be visible would be the
  //   only traffic that left no trace.
  // - *Before the routes*, because the point of a quota is to refuse work before
  //   it is done. A gate after the router would run a 366-day query against a
  //   9.4 GB database and then decline to send the answer.
  //
  // A resource added to `v1Routes` is therefore rate-limited and quota-checked
  // whether or not its author thought about either, which is the same property
  // the gate above it gives for authentication and the meter gives for billing.
  // The gate records what it refuses (ABL-530). Note where that recording is
  // *not*: there is no sixth `app.use` for it, because a middleware ahead of the
  // gate could only observe that a 401 happened — the cause is flattened into a
  // constant message by the time a response handler sees it, and whether the
  // caller had proven a secret is not recoverable from the wire at all. The
  // recorder is handed to the gate so that the record is written at the line
  // that knows the answer.
  app.use('/v1', publicRootRoutes);
  app.use('/v1', requireApiKey({ directory: apiKeyDirectory, recorder: authFailureRecorder }));
  app.use('/v1', usageMeter.middleware);
  app.use('/v1', planGate.middleware);
  app.use('/v1', createV1Routes(data));

  // Unconditional and last, in this order — `notFound` first so anything that
  // matched no route becomes a typed 404 rather than reaching Express's HTML
  // default, then the error handler, which Express selects by arity.
  app.use(publicNotFoundHandler);
  app.use(publicErrorHandler);

  return app;
}
