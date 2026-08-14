import { Router } from 'express';

/**
 * The unauthenticated surface of `/v1`, in its entirety.
 *
 * This module exists so that "what can be reached without an API key" is a
 * **file** rather than a consequence of the order two `app.use` lines happen to
 * be in. `publicApp.ts` mounts this, then the gate, then everything else; a
 * resource added to `routes/index.ts` is therefore behind the gate whether or
 * not its author thought about authentication, and a resource added *here* is a
 * deliberate act with a diff somebody reviews. That is the same argument
 * ABL-304 makes for composing the app instead of filtering it, applied to auth:
 * make the mistake unrepresentable rather than unlikely.
 *
 * `publicApp.test.ts` pins the property from the other side — every path under
 * `/v1` other than the discovery root answers 401 without a key, including
 * paths that do not exist. An unauthenticated caller cannot enumerate the
 * surface, and a route ABL-303 adds cannot accidentally be public.
 */
const router = Router();

/**
 * Discovery root. Two constants and nothing else.
 *
 * Unauthenticated on purpose, and it is the only thing that is. A client
 * checking that it is pointed at a `/v1` at all should not need a credential to
 * find out, and this response is the same for everyone — there is nothing in it
 * to authorise. It also keeps the positive control the isolation tests need:
 * without a route that *does* answer, "every internal path 404s" would also be
 * satisfied by an app that was never wired up.
 *
 * It deliberately carries none of what `/api/health` carries — no `db_path`, no
 * `commit`, no `runtime` (`lib/healthProvenance.ts`) — because those are the
 * three fields ABL-293 §1.2(b) flags as the reason `/health` must not be on
 * this surface. It says nothing about whether a key store is configured or
 * reachable either: that is operational state, and answering it to an
 * unauthenticated caller is how a liveness probe becomes reconnaissance.
 *
 * ABL-305 owns whether this endpoint survives into the published OpenAPI
 * document or is replaced by a documented root.
 */
router.get('/', (_req, res) => {
  res.json({ version: 'v1', status: 'ok' });
});

export default router;
