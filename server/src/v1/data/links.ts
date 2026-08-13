import type { PublicEnv } from '../publicEnv.js';

/**
 * Where a `links.next` URL comes from — and, more importantly, where it does
 * **not** come from.
 *
 * ABL-291 brief §2, restated as trap 1 on ABL-303: *"pagination/next-link URLs
 * must not be constructed from the request host, or a `192.168.x` address ends
 * up hard-coded in a subscriber's client."*
 *
 * That is not a hypothetical shaped by this deployment, it is the *default*
 * shape of the obvious implementation. `${req.protocol}://${req.get('host')}${req.originalUrl}`
 * is what every framework tutorial writes, it works perfectly on the LAN, and
 * the day the API moves it keeps working — for us. The subscriber's client has
 * by then followed a `next` link to `http://192.168.86.36:3002/…`, stored it,
 * retried it, and put it in a support ticket.
 *
 * So the base URL is **configuration**, and there is no code path that can read
 * it off a request. Two consequences worth stating because they look like
 * omissions:
 *
 * - **Unset means relative.** `links.next` is emitted as `/v1/observations/load?…`
 *   rather than being invented. A relative link is correct against whatever
 *   origin the client already used and cannot bake in an address; an absolute
 *   link built from a guess is wrong in a way that survives a redeployment.
 *   Relative is therefore the safe default, not a degraded mode — and the LAN
 *   runs with `PUBLIC_BASE_URL` unset today.
 * - **Nothing in `v1/routes/` or `v1/data/` touches `req.host`,
 *   `req.hostname`, `req.protocol` or the `Host` header.** `links.test.ts`
 *   asserts that by reading the sources, because the property worth having is
 *   "there is no such line", not "the line we have is currently correct".
 */

/**
 * Validate and normalise `PUBLIC_BASE_URL`.
 *
 * Returns `null` when unset — see above. Throws when set to something that
 * cannot be a base URL, at **startup** rather than on the first paginated
 * response: a misconfigured base URL that only manifests on page two of a
 * three-page result is a bug that reaches a customer before it reaches us.
 *
 * A path prefix is allowed (`https://api.example.com/energy`), because a
 * gateway may well mount us under one. A query string or fragment is not: both
 * would be silently dropped when we append our own query, so accepting them
 * would mean accepting configuration we do not honour.
 */
export function resolvePublicBaseUrl(env: PublicEnv): string | null {
  const raw = (env.PUBLIC_BASE_URL ?? '').trim();
  if (raw === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      'PUBLIC_BASE_URL is not a valid absolute URL. It must be the origin subscribers reach ' +
        'this API on, for example https://api.example.com. Leave it unset to emit relative ' +
        'links instead — never a value derived from the request host (ABL-291 brief §2).'
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('PUBLIC_BASE_URL must be an http or https URL.');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(
      'PUBLIC_BASE_URL must not carry a query string or fragment: pagination appends its own ' +
        'query, so either would be silently discarded.'
    );
  }

  // Trailing slashes are stripped so that joining is unambiguous — `.../` plus
  // `/v1/...` would otherwise produce a double slash, which some gateways treat
  // as a different path.
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

/** A query value that is present, or one that should be left out entirely. */
export type LinkParams = Record<string, string | number | undefined>;

/**
 * Build a link to one of our own paths.
 *
 * `path` is always a literal from this codebase (`/v1/observations/load`), never
 * anything derived from the request — so a caller cannot steer a `next` link at
 * a path of their choosing. Values are URL-encoded; keys are literals too.
 *
 * `undefined` values are omitted rather than serialised as `key=undefined`,
 * which is what makes it safe to hand this the whole parameter bag including
 * the optional ones.
 */
export function buildLink(baseUrl: string | null, path: string, params: LinkParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    query.set(key, String(value));
  }
  const suffix = query.toString();
  return `${baseUrl ?? ''}${path}${suffix === '' ? '' : `?${suffix}`}`;
}
