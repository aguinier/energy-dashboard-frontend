import { Router } from 'express';
import { toWireChangelog } from './changelogEntry.js';
import { renderChangelogHtml } from './changelogHtml.js';
import type { ChangelogReader } from './changelogStore.js';

/**
 * The change log's two representations, at a URL that is **deliberately outside
 * `/v1`**.
 *
 *     /changelog        HTML, for a subscriber who opens the URL we named
 *     /changelog.json   the same entries, for one who wants to watch for notices
 *
 * ## Why not `/v1/changelog`
 *
 * §9.3 commits us to giving six months' notice before retiring a major API
 * version, **through this change log**. A change log mounted under `/v1` would be
 * withdrawn by the very event it exists to announce, and the announcement would
 * be served from a path that stops existing on the date it is announcing. That is
 * a defect which costs nothing to avoid today and cannot be fixed later without
 * breaking the one property ABL-532 asks for: a URL that does not have to change.
 *
 * It is also the cleaner thing for the documentation site to absorb (ABL-522
 * Constraint 4) — one redirect from one stable path, rather than a
 * version-scoped one that has to be re-pointed at `/v2` and then explained.
 *
 * ## Unauthenticated, and what that does not weaken
 *
 * The second unauthenticated thing on this surface, after the `/v1` discovery
 * root — and a deliberate one, in its own module, for the reason `routes/root.ts`
 * gives: what needs no key should be a file somebody edits on purpose. A change
 * log behind an API key would be unreadable by exactly the person most likely to
 * need it, including a prospective subscriber deciding whether our change
 * behaviour is acceptable.
 *
 * It is not mounted under `/v1`, so ABL-300's property — every path under `/v1`
 * answers 401 rather than 404, including paths that do not exist, so the surface
 * cannot be enumerated without a key — is untouched. `publicApp.test.ts` pins
 * that `/v1/changelog` still answers 401.
 *
 * ## `Cache-Control: no-store`
 *
 * Part of the publish path rather than a header habit. §9.3.2 requires a
 * correction's entry to be published *at the same time* as the change is served,
 * and a proxy or browser holding a cached copy for an hour would defer exactly
 * that. The whole point of publishing from a table instead of a build artifact is
 * that a new entry is visible on the next request; a cache would give that back.
 */
export function createChangelogRoutes({ reader }: { reader: ChangelogReader }): Router {
  const router = Router();

  router.get('/changelog', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('text/html; charset=utf-8').send(renderChangelogHtml(reader.list()));
  });

  router.get('/changelog.json', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(toWireChangelog(reader.list()));
  });

  return router;
}
