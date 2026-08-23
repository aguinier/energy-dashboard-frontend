import { STREAMS } from '../data/series.js';

/**
 * Which `/v1` surface a **refused** request was aimed at, as a template from a
 * fixed table.
 *
 * ## Why this is not `resolveRouteTemplate` from the meter
 *
 * The meter reads `req.route`, which Express sets once a route has matched. That
 * works for metered traffic because a metered request has, by definition, got
 * past the gate and reached the router.
 *
 * A refused request never does. `requireApiKey` calls `next(error)`, which skips
 * every remaining non-error middleware including `createV1Routes`, so `req.route`
 * is unset on **every** row this module writes. Reusing the meter's helper would
 * record the constant `(unmatched)` on all of them — a column that is always the
 * same string, which is worse than no column, because it invites a reader to
 * think it means something.
 *
 * ## Why it is not `req.path` either
 *
 * On a refused request the path is an unauthenticated, caller-controlled string,
 * and this table is fed by exactly the callers we trust least. That is the
 * free-text-shaped value ABL-297 §9(5) says must not reach the log: it explodes
 * the cardinality of every aggregate over the column, and it is the obvious
 * accidental route for a scanner's payload — a traversal string, an injected
 * quote, a URL-encoded credential — to be stored verbatim in a file we hold for
 * thirteen months.
 *
 * So: a **closed set**. Anything not on it is {@link UNRECOGNISED_TARGET}, which
 * is a genuine finding in its own right — a caller aiming at paths that are not
 * ours is a scanner, not a customer with a stale key.
 *
 * ## Keeping the table honest
 *
 * The observation entries are derived from `STREAMS`, the same constant
 * `routes/observations.ts` loops over, so a fourth stream cannot be added
 * without appearing here. The rest are literals, and `requestTarget.test.ts`
 * checks them against the route files as text: a route added to `v1/routes/` and
 * not added here fails that test rather than silently recording as unrecognised.
 *
 * Under-classification is the safe direction either way — a missing entry loses
 * detail, it never invents any, and it can never leak a caller's string.
 *
 * ## Spelling
 *
 * Templates are written `/v1`-prefixed, matching what `usageMeter.ts`'s
 * `resolveRouteTemplate` writes into `usage_events.route_template`. The two
 * tables are read side by side during an investigation and a `/observations/load`
 * here against a `/v1/observations/load` there would be a join somebody has to
 * do in their head at three in the morning.
 */

/** The mount prefix, which the gate sees as `req.baseUrl`. */
const V1 = '/v1';

/** A path that matches no `/v1` route. Not an error — see the header. */
export const UNRECOGNISED_TARGET = '(unrecognised)';

/**
 * Every path template under `/v1`, including the unauthenticated discovery root.
 *
 * The root is here because it is reachable as a refusal even though
 * `routes/root.ts` is mounted ahead of the gate: that router answers `GET /`
 * only, so a `POST /v1/` or a `HEAD /v1/` falls through it and is refused by the
 * gate like anything else.
 */
export const V1_ROUTE_TEMPLATES: readonly string[] = [
  V1,
  ...Object.keys(STREAMS)
    .sort()
    .map((stream) => `${V1}/observations/${stream}`),
  `${V1}/forecasts`,
  `${V1}/forecasts/latest`,
  `${V1}/accuracy`,
  `${V1}/catalog/zones`,
  `${V1}/catalog/models`,
  `${V1}/catalog/coverage`,
];

const TEMPLATE_SET = new Set(V1_ROUTE_TEMPLATES);

/**
 * Classify the gate-relative path Express hands the middleware.
 *
 * Inside `app.use('/v1', …)` the mount prefix is stripped, so `req.path` is
 * `/observations/load` and the bare mount is `/`. Both are re-prefixed here so
 * the caller does not have to know that.
 *
 * One trailing slash is tolerated because Express's own router does
 * (`/v1/accuracy/` matches `/accuracy`), so recording the two differently would
 * split one surface across two rows. Case is **not** folded: `/v1/Accuracy` is
 * not a route this app serves, and a caller trying it is doing something a
 * customer does not do.
 */
export function classifyRequestTarget(gateRelativePath: string): string {
  const path = typeof gateRelativePath === 'string' ? gateRelativePath : '';
  const absolute = path === '' || path === '/' ? V1 : `${V1}${path.startsWith('/') ? '' : '/'}${path}`;
  const trimmed = absolute.length > V1.length && absolute.endsWith('/')
    ? absolute.slice(0, -1)
    : absolute;

  return TEMPLATE_SET.has(trimmed) ? trimmed : UNRECOGNISED_TARGET;
}
