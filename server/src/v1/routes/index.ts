import { Router } from 'express';
import { catalogRouter } from './catalog.js';
import { forecastsRouter } from './forecasts.js';
import { observationsRouter } from './observations.js';
import type { V1DataContext } from '../data/context.js';

/**
 * The authenticated `/v1` resources.
 *
 * Everything mounted here sits **behind** `requireApiKey` — `publicApp.ts`
 * mounts the gate between `routes/root.ts` and this router, so a route added to
 * this file requires a key by construction rather than by its author
 * remembering to ask for one. It also sits behind the usage meter, so a resource
 * added here is billed whether or not its author thought about billing.
 *
 * ## What ABL-303 filled in, and what it did not
 *
 * Eight endpoints across three families:
 *
 * ```
 * GET /v1/observations/load         ?zone=&from=&to=&limit=&cursor=
 * GET /v1/observations/price        ?zone=&from=&to=&limit=&cursor=
 * GET /v1/observations/generation   ?zone=&from=&to=&production_type=&limit=&cursor=
 * GET /v1/forecasts                 ?zone=&type=&from=&to=&horizon=&model=&limit=&cursor=
 * GET /v1/forecasts/latest          ?zone=&type=&model=
 * GET /v1/catalog/zones
 * GET /v1/catalog/models
 * GET /v1/catalog/coverage          ?zone=&stream=[&from=&to=]
 * ```
 *
 * **`/v1/accuracy` is deliberately absent** and is filed as its own issue. It is
 * the only endpoint that joins forecasts to actuals, and that join is a live
 * correctness hazard rather than routine work: ABL-214's two-separator join
 * drops roughly half the rows across the 2025-11 cutover, `energy_load` alone
 * holds 137,113 country-hours where both separator forms exist with **107,047
 * of those pairs disagreeing**, and which of a conflicting pair is authoritative
 * is ABL-215 — an open board decision an accuracy endpoint would have to make
 * silently in order to return a number. Nothing here depends on it.
 *
 * **Net position is absent by construction, not by filter.** There is no
 * `net-position` route, no `net_position` entry in `data/series.ts`, and no
 * `net_position` entry in `data/models.ts` — so serving it would take an
 * addition rather than the removal of a guard. Board decision 2 is open; ABL-298
 * closing (JAO authorisation held) is not a reason to add it, and the ~385k
 * `net_position` forecast rows sitting in the same table make it a one-line
 * mistake that this shape prevents.
 *
 * ## Why this became a factory
 *
 * It used to export a bare `Router`. It now takes a {@link V1DataContext},
 * because these routes need a handle on the energy database and the composition
 * must not choose one — the same reason `requireApiKey` takes an
 * `ApiKeyDirectory` and `createPublicApp` takes a `UsageMeter`. The entrypoint
 * decides what backs each of the three; `publicApp.ts` names only the shapes,
 * and `publicAppGraph.test.ts` still holds `better-sqlite3` out of the module
 * that serves requests.
 *
 * **Every module reachable from this file becomes reachable from the public
 * app**, and that test asserts the resulting graph. Three shared modules are
 * reachable from here by design — `utils/timestamp.ts`, `services/freshness.ts`
 * and `services/loadQuality.ts` — each of them a side-effect-free leaf, each of
 * them holding a rule that must not be reimplemented in a second place. The
 * graph test names them individually and checks that they import nothing.
 */
export function createV1Routes(context: V1DataContext): Router {
  const router = Router();

  router.use('/observations', observationsRouter(context));
  router.use('/forecasts', forecastsRouter(context));
  router.use('/catalog', catalogRouter(context));

  return router;
}
