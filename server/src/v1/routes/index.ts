import { Router } from 'express';

/**
 * The authenticated `/v1` resources.
 *
 * Everything mounted here sits **behind** `requireApiKey` — `publicApp.ts`
 * mounts the gate between `routes/root.ts` and this router, so a route added to
 * this file requires a key by construction rather than by its author
 * remembering to ask for one. A handler here can call
 * `requireApiPrincipal(res)` (`v1/auth/apiKeyAuth.ts:79`) and get an account,
 * never `undefined`.
 *
 * ABL-303 fills this in: `/v1/observations/*`, `/v1/forecasts*`, `/v1/accuracy`
 * and `/v1/catalog/*`. Metering (ABL-301) and quotas (ABL-302) go between the
 * gate and these routes, in that order — metering must sit outside the cache or
 * every cached hit goes unbilled (ABL-293 §2c).
 *
 * It is empty rather than absent, and that is worth a line: an unauthenticated
 * request to `/v1/observations/load` gets 401 today because the gate is ahead
 * of this router, and an *authenticated* one gets 404. Those are the two right
 * answers for a resource that does not exist yet, and they are already the
 * answers ABL-303 will inherit.
 *
 * **Every module reachable from this file becomes reachable from the public
 * app**, and `publicAppGraph.test.ts` asserts the resulting graph. So if a
 * resource module reaches back into `routes/`, `services/opsStatus*` or
 * anything holding a write handle, the suite says so by name.
 */
const router = Router();

export default router;
