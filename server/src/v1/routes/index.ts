import { Router } from 'express';
import { accuracyRouter } from './accuracy.js';
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
 * ## What ABL-373 added: the ninth
 *
 * ```
 * GET /v1/accuracy                  ?zone=&type=&from=&to=&horizon=&model=
 * ```
 *
 * This paragraph used to say `/v1/accuracy` was "deliberately absent" because it
 * is the only endpoint that joins forecasts to actuals and that join is a live
 * correctness hazard: ABL-214's two-separator join drops roughly half the rows
 * across the 2025-11 cutover, `energy_load` alone holds 137,113 country-hours
 * where both separator forms exist with **107,047 of those pairs disagreeing**,
 * and which of a conflicting pair is authoritative is ABL-215 — an open Board
 * decision an accuracy endpoint would have to make silently in order to return a
 * number.
 *
 * All of that is still true. What changed is not the hazard but the handling of
 * it: the join is two `LEFT JOIN`s and a `COALESCE` preferring space (never an
 * `IN(...)`, which fans a conflicting pair out into two observations), and the
 * preference is **published** as `meta.conflict_convention` rather than applied
 * silently — so ABL-215 ruling the other way later is a documented change to a
 * stated convention instead of a correction to numbers a subscriber has already
 * used. `data/accuracyRepo.ts` carries the argument; nothing here depends on
 * ABL-215 closing first.
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
 * app**, and that test asserts the resulting graph. Four shared modules are
 * reachable from here by design — `utils/timestamp.ts`, `services/freshness.ts`,
 * `services/loadQuality.ts` and (ABL-373) `services/wape.ts` — each of them a
 * side-effect-free leaf, each of them holding a rule that must not be
 * reimplemented in a second place. The graph test names them individually and
 * checks that they import nothing.
 */
export function createV1Routes(context: V1DataContext): Router {
  const router = Router();

  router.use('/observations', observationsRouter(context));
  router.use('/forecasts', forecastsRouter(context));
  router.use('/accuracy', accuracyRouter(context));
  router.use('/catalog', catalogRouter(context));

  return router;
}
