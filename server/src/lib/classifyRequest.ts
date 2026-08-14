/**
 * Which lane a single HTTP request belongs to, for the `/ops-status` traffic
 * counters (ABL-289).
 *
 * The issue's whole point is the separation: acceptance and prod both sit under
 * constant self-inflicted traffic — the docker healthcheck, the peer poll
 * `peerOpsStatus.ts` fires at the *other* environment every time somebody has
 * `/ops-status` open, and the status page's own 30s refetch — so a naive
 * "requests today" counter reads in the thousands on a box no human visited.
 *
 * - `page`   — an SPA document load. The closest measurable thing to "a person
 *              opened the dashboard": `index.html` is served `no-store`
 *              (`app.ts`), so every visit and every hard refresh produces one.
 * - `api`    — a data call the app made on a visitor's behalf.
 * - `asset`  — hashed JS/CSS, fonts, images, favicon. Counted separately
 *              because one page load fans out into a dozen of these; folding
 *              them into `page` or `api` would inflate both by an arbitrary,
 *              cache-dependent factor.
 * - `automated` — everything we or a machine generate: the health/ops
 *              endpoints, recognised bot/CLI user agents, and the token-gated
 *              ingest writes. Deliberately not called "monitoring": the ingest
 *              POSTs are not monitoring, and naming the lane for only half of
 *              what it holds is how a label starts lying.
 */
export type RequestLane = 'page' | 'api' | 'asset' | 'automated';

export const REQUEST_LANES: readonly RequestLane[] = ['page', 'api', 'asset', 'automated'];

export interface ClassifiableRequest {
  method: string;
  /** `req.path` — the pathname alone, no query string. */
  path: string;
  userAgent: string | undefined;
}

/**
 * Paths that exist to be polled. `/api/health` is the docker healthcheck and
 * ABL-172's acceptance probe; `/api/ops/*` is this very page plus the peer
 * fetch, which means the status page would otherwise be far and away its own
 * biggest "visitor".
 */
function isMonitoringPath(path: string): boolean {
  return path === '/api/health' || path === '/api/ops' || path.startsWith('/api/ops/');
}

/**
 * Substrings that appear in the user agent of things that are not people.
 *
 * Matched case-insensitively against the whole UA. Kept to unambiguous tokens:
 * a false positive here silently *under*-counts visitors, which is the safe
 * direction, but only if the token cannot appear in a real browser UA. `bot`
 * as a bare substring would be too loose against a future browser name, so the
 * crawler entries carry their conventional surrounding punctuation where the
 * convention exists (`bot/`, `bot)`, `-bot`) plus the bare `bot ` form.
 */
const AUTOMATED_UA_PATTERNS: readonly RegExp[] = [
  /\bbot\b/i,
  /bot[/)\-;]/i,
  /crawler/i,
  /spider/i,
  /slurp/i,
  /curl\//i,
  /wget/i,
  /python-requests/i,
  /python-urllib/i,
  /\bgo-http-client\b/i,
  /node-fetch/i,
  /\bundici\b/i,
  /axios\//i,
  /okhttp/i,
  /headlesschrome/i,
  /phantomjs/i,
  /uptime/i,
  /monitor(ing)?[/\s-]/i,
  /pingdom/i,
  /statuscake/i,
  /prometheus/i,
  /blackbox_exporter/i,
];

function isAutomatedUserAgent(userAgent: string | undefined): boolean {
  // No UA at all is not a browser. Every mainstream browser sends one, so an
  // absent header is a socket-level probe, a hand-rolled client, or `fetch`
  // from a script. Counting it as a visitor is the inflating direction.
  if (!userAgent || userAgent.trim() === '') return true;
  return AUTOMATED_UA_PATTERNS.some((re) => re.test(userAgent));
}

/**
 * A path whose last segment carries a file extension other than `.html`.
 *
 * `/assets/index.1a2b3c4d.js` → asset. `/country/DE` → not (no extension).
 * `/index.html` → not, because that *is* the SPA document. The extension has
 * to be short and alphanumeric so a client-side route like `/country/DE.old`
 * or a zone id with a dot does not get mistaken for a file.
 */
const ASSET_EXTENSION = /\.[a-z0-9]{1,8}$/i;

function isAssetPath(path: string): boolean {
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  if (lastSegment === '' || !ASSET_EXTENSION.test(lastSegment)) return false;
  return !/\.html?$/i.test(lastSegment);
}

/** `/api` and everything under it — mirrors `app.ts`'s `isApiPath`. */
function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/**
 * Classify one request. Pure — no clock, no request object, no `res`, so every
 * branch is a table row in `classifyRequest.test.ts`.
 *
 * Order matters. The monitoring paths win over everything (a browser hitting
 * `/api/health` is still a health check), then automated user agents, then the
 * shape of the path.
 */
export function classifyRequest({ method, path, userAgent }: ClassifiableRequest): RequestLane {
  if (isMonitoringPath(path)) return 'automated';
  if (isAutomatedUserAgent(userAgent)) return 'automated';

  // Anything that is not a read is a machine here: the only writes this server
  // accepts are the token-gated weather snapshot (heliocast) and net-position
  // ingest (the workstation's Chronos run). No visitor POSTs to this app.
  const verb = method.toUpperCase();
  if (verb !== 'GET' && verb !== 'HEAD') return 'automated';

  if (isApiPath(path)) return 'api';
  if (isAssetPath(path)) return 'asset';
  return 'page';
}
