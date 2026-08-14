import type { Router } from 'express';

/**
 * What is actually mounted, read off the Express router tree.
 *
 * This is the half of the drift check that catches the failure the other half
 * cannot: **a route that exists and is in no published document.** Validating
 * response bodies against schemas proves the documented endpoints are honest;
 * it says nothing about an endpoint nobody documented. On a paid surface those
 * are the interesting ones — an undocumented resource is one we are serving,
 * billing for, and have made no commitment about.
 *
 * ## Why it reads internals, and why that is safe here
 *
 * Express does not expose a route table, so this walks `router.stack`. That is
 * an internal shape, and the usual objection is that it can change under you.
 * The mitigation is the design rule this module follows throughout:
 * **{@link listRoutes} throws rather than returning less.**
 *
 * A route inventory that silently returns fewer routes than exist is worse than
 * no inventory — it reports "every route is documented" precisely when it has
 * stopped being able to see them. So an unrecognised layer shape, an
 * undecodable mount path or a parameterised mount is an error with a message,
 * not a skipped entry. If Express 5 reshapes the stack, this fails loudly on the
 * next test run.
 *
 * A parameterised mount (`router.use('/:id', …)`) is refused for the same
 * reason rather than approximated: `/v1` has no path parameters today — every
 * parameter is a query parameter, which is what keeps the request log
 * enumerable and non-personal — so a path parameter appearing is a contract
 * change that should stop and be looked at.
 */

export interface MountedRoute {
  /** Full path from the base, e.g. `/v1/observations/load`. */
  path: string;
  /** Lowercase HTTP methods, sorted — `['get']`. */
  methods: string[];
}

/** The minimum of Express's Layer we depend on, named so the casts below are visible. */
interface LayerLike {
  name?: string;
  regexp?: RegExp & { fast_slash?: boolean };
  route?: { path?: unknown; methods?: Record<string, boolean> };
  handle?: unknown;
}

interface RouterLike {
  stack?: unknown;
}

/**
 * Every `(path, methods)` pair reachable through `router`, mounted at `base`.
 *
 * Sorted by path, so a diff against the document's path list reads as a diff
 * rather than as a reordering.
 */
export function listRoutes(router: Router, base: string): MountedRoute[] {
  const found = new Map<string, Set<string>>();
  walk(router as unknown as RouterLike, normalise(base), found);

  return [...found.entries()]
    .map(([path, methods]) => ({ path, methods: [...methods].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function walk(router: RouterLike, prefix: string, found: Map<string, Set<string>>): void {
  const stack = router.stack;
  if (!Array.isArray(stack)) {
    throw new Error(
      `routeInventory: expected a router with a .stack array at "${prefix || '/'}" — ` +
        'Express internals have changed and this inventory can no longer see the route table.'
    );
  }

  for (const entry of stack as LayerLike[]) {
    if (entry.route !== undefined) {
      const routePath = entry.route.path;
      if (typeof routePath !== 'string') {
        throw new Error(
          `routeInventory: route at "${prefix || '/'}" has a non-string path (${typeof routePath}). ` +
            'Array and RegExp route paths are not supported; spell them out.'
        );
      }
      const methods = Object.entries(entry.route.methods ?? {})
        .filter(([, enabled]) => enabled)
        .map(([method]) => method.toLowerCase())
        // `HEAD` is answered from the `GET` handler by Express itself and is not
        // a separate operation in OpenAPI, so it is dropped. Nothing else is:
        // `router.all(...)` would surface as `_all` and fail the comparison
        // against the document, which is the correct outcome for a route that
        // quietly answers every verb.
        .filter((method) => method !== 'head');

      if (methods.length === 0) {
        throw new Error(`routeInventory: route "${prefix}${routePath}" declares no methods.`);
      }

      const full = join(prefix, routePath);
      const set = found.get(full) ?? new Set<string>();
      for (const method of methods) set.add(method);
      found.set(full, set);
      continue;
    }

    // A nested router: recurse under its mount path. Anything else is plain
    // middleware with no routes of its own.
    if (isRouterLike(entry.handle)) {
      walk(entry.handle, join(prefix, mountPathOf(entry)), found);
    }
  }
}

function isRouterLike(handle: unknown): handle is RouterLike {
  return (
    typeof handle === 'function' && Array.isArray((handle as unknown as RouterLike).stack)
  );
}

/**
 * Recover a nested router's mount path from the regexp Express compiled for it.
 *
 * Only two shapes are accepted: mounted at `/` (`fast_slash`), or mounted at a
 * literal path with no parameters. Everything else throws — see the module note
 * on why an unreadable mount must not become an empty string.
 */
function mountPathOf(layer: LayerLike): string {
  const regexp = layer.regexp;
  if (regexp === undefined) {
    throw new Error('routeInventory: a nested router layer carries no regexp to decode.');
  }
  if (regexp.fast_slash === true) return '';

  // `^\/observations\/?(?=\/|$)` — a literal segment path, escaped.
  const literal = /^\^((?:\\\/[A-Za-z0-9_\-.~]+)+)\\\/\?\(\?=\\\/\|\$\)$/.exec(regexp.source);
  if (literal === null) {
    throw new Error(
      `routeInventory: cannot decode mount path from ${regexp.source}. ` +
        'Parameterised and pattern mounts are not supported on /v1 — every parameter here ' +
        'is a query parameter, and a path parameter appearing is a contract change.'
    );
  }
  return literal[1].replace(/\\\//g, '/');
}

function join(prefix: string, path: string): string {
  const tail = path === '/' ? '' : normalise(path);
  const joined = `${prefix}${tail}`;
  return joined === '' ? '/' : joined;
}

/** `/v1/` -> `/v1`; `v1` -> `/v1`; `/` -> ``. */
function normalise(path: string): string {
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  const trimmed = withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
  return trimmed;
}
