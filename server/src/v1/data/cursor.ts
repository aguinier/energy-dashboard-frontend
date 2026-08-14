import { createHash } from 'node:crypto';
import { PublicApiError } from '../publicErrors.js';

/**
 * Cursor pagination, keyed on the last timestamp served.
 *
 * **Not offset pagination**, and the reason is in this database rather than in
 * taste (ABL-293 §2a): these tables are upserted by a cron four times a day, so
 * an `OFFSET 10000` taken between two passes silently skips rows that were
 * inserted behind the cursor and repeats rows that moved. The customer sees
 * neither — they see a page that is quietly missing an hour, which is the exact
 * failure class this repo keeps finding.
 *
 * A cursor on `(zone, timestamp)` cannot do that: page two starts strictly
 * after the last timestamp page one actually returned, whatever happened to the
 * table in between.
 *
 * ## What is in the token, and why it is not just a timestamp
 *
 * A bare timestamp cursor works right up until somebody edits the rest of the
 * URL. `…?zone=DE&from=A&to=B&cursor=<ts>` re-sent as `…?zone=FR&…&cursor=<ts>`
 * is a request this API would happily answer — with FR rows starting at a
 * timestamp DE happened to end on, presented as page two of a DE series. So the
 * token carries a **fingerprint of the query it was minted for**, and a cursor
 * presented against a different query is a 400 rather than a plausible answer.
 *
 * The token is opaque on purpose: base64url of a small JSON object, with no
 * promise about its contents. Clients follow `links.next`; nothing else is
 * supported, and stating that here is what keeps the internals changeable.
 *
 * It is **not** encrypted and does not need to be — it holds a timestamp the
 * caller already has and a hash of parameters the caller already sent. It is
 * also not a capability: it grants nothing, and every request carrying one still
 * goes through the key gate and the meter.
 */

/** Version prefix inside the token, so an old cursor can be refused rather than misread. */
const CURSOR_VERSION = 1;

interface CursorPayload {
  v: number;
  /** Fingerprint of the query this cursor belongs to. */
  q: string;
  /** The last timestamp served, in the database's text form. */
  t: string;
}

function invalidCursor(): PublicApiError {
  return new PublicApiError(
    400,
    'invalid_cursor',
    'The cursor parameter is not a cursor this API issued for this query. ' +
      'Cursors are opaque and belong to the exact query that produced them: ' +
      'follow links.next rather than constructing or editing one.'
  );
}

/**
 * Fingerprint the query a page belongs to.
 *
 * Built from **parsed** values rather than the raw query string, so
 * `?zone=de&limit=100` and `?limit=100&zone=DE` are recognised as the same
 * query — which they are. Building it from the raw string instead would make
 * `links.next` break whenever a client's HTTP library reordered parameters,
 * and that failure would arrive as "your pagination is flaky".
 *
 * Truncated to 16 hex characters: this is an integrity check against a
 * hand-edited URL, not a signature against an adversary — there is no secret in
 * it and it protects nothing an authenticated caller could not simply ask for
 * directly.
 */
export function queryFingerprint(resource: string, parts: Record<string, string | number>): string {
  const canonical = Object.keys(parts)
    .sort()
    .map((key) => `${key}=${parts[key]}`)
    .join('&');
  return createHash('sha256').update(`${resource}?${canonical}`).digest('hex').slice(0, 16);
}

export function encodeCursor(fingerprint: string, lastTimestamp: string): string {
  const payload: CursorPayload = { v: CURSOR_VERSION, q: fingerprint, t: lastTimestamp };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Read a cursor, or throw a 400.
 *
 * Returns the timestamp the next page must start strictly after, or `undefined`
 * when no cursor was sent.
 *
 * Every failure path is the same 400 with the same message — a malformed token,
 * a token for a different query and a token from a future version are all "this
 * is not your cursor". Distinguishing them would describe our encoding to
 * somebody who is, by definition, not using `links.next`.
 */
export function decodeCursor(raw: unknown, fingerprint: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw === '') throw invalidCursor();

  let payload: CursorPayload;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    payload = JSON.parse(json) as CursorPayload;
  } catch {
    throw invalidCursor();
  }

  if (
    payload === null ||
    typeof payload !== 'object' ||
    payload.v !== CURSOR_VERSION ||
    typeof payload.q !== 'string' ||
    typeof payload.t !== 'string' ||
    payload.q !== fingerprint
  ) {
    throw invalidCursor();
  }

  // The timestamp is bound into a `?` parameter and compared as text, never
  // interpolated — but it is still caller-controlled input reaching a query, so
  // the shape is checked rather than trusted. `2026-08-01 00:00:00`, the
  // normalised form this module mints.
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(payload.t)) throw invalidCursor();

  return payload.t;
}
