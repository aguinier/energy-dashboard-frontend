import { Router } from 'express';

/**
 * The public `/v1` router — the only router the public app mounts.
 *
 * ABL-304 builds the composition; the resources go in behind it:
 * `/v1/observations/*`, `/v1/forecasts*`, `/v1/accuracy` and `/v1/catalog/*`
 * are ABL-303, with auth (ABL-300), metering (ABL-301) and quotas (ABL-302)
 * ahead of them in the stack, in that order — metering must sit outside the
 * cache or every cached hit goes unbilled (ABL-293 §2c).
 *
 * **Every module reachable from this file becomes reachable from the public
 * app**, and `publicApp.test.ts` asserts the resulting graph. So a new resource
 * is added by importing a `v1/routes/*` module here, and if that module reaches
 * back into `routes/`, `services/opsStatus*` or anything holding a write
 * handle, the suite says so by name.
 */
const router = Router();

/**
 * Discovery root. Two constants and nothing else.
 *
 * It exists so the isolation tests have a positive control: without a route
 * that *does* answer, "every internal path 404s" is also satisfied by an app
 * that was never wired up, and the test would pass while proving nothing. It
 * deliberately carries none of what `/api/health` carries — no `db_path`, no
 * `commit`, no `runtime` (`lib/healthProvenance.ts`) — because those are the
 * three fields ABL-293 §1.2(b) flags as the reason `/health` must not be on
 * this surface.
 *
 * ABL-305 owns whether this endpoint survives into the published OpenAPI
 * document or is replaced by a documented root; it is listed here rather than
 * invented there.
 */
router.get('/', (_req, res) => {
  res.json({ version: 'v1', status: 'ok' });
});

export default router;
