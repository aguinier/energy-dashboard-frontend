import { PublicApiError } from '../publicErrors.js';
import { normalizeTimestamp } from '../../utils/timestamp.js';

/**
 * Request parameters: parsed, bounded, and never echoed back.
 *
 * Three separate contracts meet in this file, and each of them is the reason a
 * seemingly harmless shortcut is not taken:
 *
 * **1. The timestamp contract (ABL-293 §2a).** Every timestamp on the wire is
 * RFC 3339 UTC with an explicit `Z`, second precision. Requests accept the same,
 * plus a bare date. No local time, no offsets, no naive timestamps — because a
 * naive timestamp is the one input where being wrong is invisible: it parses,
 * it returns rows, and the rows are shifted by the caller's UTC offset.
 *
 * **2. No message ever reflects an input.** Every error string below is a
 * constant that *describes the expected form*; not one interpolates what the
 * caller actually sent. That is the invariant `publicErrors.ts` inverted the
 * error contract to establish (ABL-293 §1.2e), and a 400 body is the single
 * most likely thing a customer pastes into a public issue tracker. It costs a
 * slightly longer message and it removes the whole class.
 *
 * **3. Every parameter is enumerable, so the request log stays non-personal.**
 * ABL-297's privacy notice §9 and ABL-301 item 4: request parameters are logged
 * per request by the usage meter. So no endpoint on this surface accepts free
 * text or a customer-supplied identifier — a zone is two uppercase letters, a
 * stream is one of three words, a limit is an integer, a timestamp is a
 * timestamp, and a cursor is one we minted. There is nowhere on `/v1` to put a
 * name, an email or a note, which makes "the logs hold no personal data" a
 * property of the parameter grammar rather than a retention promise.
 * `params.test.ts` asserts it parameter by parameter.
 */

/** A 400 whose message is a constant. The only way to fail out of this module. */
function invalid(code: string, message: string): PublicApiError {
  return new PublicApiError(400, code, message);
}

/**
 * Read exactly one value for a query parameter.
 *
 * Express parses `?zone=DE&zone=FR` into an array, and `?zone[]=x` into an
 * object. Both reach a handler typed as `string` and neither is one, so an
 * unguarded `.toUpperCase()` is a 500 a caller can trigger from a URL bar.
 * Repeated parameters are refused rather than silently resolved to the first or
 * last value: a caller who sent two zones asked a question this API cannot
 * answer, and picking one for them answers a different question confidently.
 */
export function singleValue(raw: unknown, name: string, code: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') return raw;
  throw invalid(
    code,
    `The ${name} parameter must be given at most once, as a plain value. ` +
      'Repeated or structured query parameters are not accepted.'
  );
}

/**
 * A bidding-zone code: exactly two uppercase ASCII letters.
 *
 * Validated by **shape, not by membership of a list**, and the distinction
 * matters in both directions. Shape-checking is what keeps the parameter
 * non-personal and un-interpolatable. Membership-checking is deliberately *not*
 * done here: an unknown-but-well-formed zone gets an empty page with
 * `coverage: "no_data"` rather than a 400, because "we hold nothing for XX" and
 * "XX is not a real zone" are answered by `/v1/catalog/zones`, and a 400 would
 * force a client to hardcode our zone list to avoid one.
 */
export function parseZone(raw: unknown): string {
  const value = singleValue(raw, 'zone', 'invalid_zone');
  if (value === undefined || value === '') {
    throw invalid(
      'zone_required',
      'A zone is required. Pass zone=<two-letter code>, for example zone=DE. ' +
        'One zone per request: see /v1/catalog/zones for the codes we hold.'
    );
  }
  const upper = value.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) {
    throw invalid(
      'invalid_zone',
      'The zone parameter must be a two-letter zone code, for example DE. ' +
        'See /v1/catalog/zones for the codes we hold.'
    );
  }
  return upper;
}

/**
 * One instant, as an RFC 3339 UTC timestamp or a bare date.
 *
 * Accepted:
 *   `2026-08-12T14:00:00Z`      the canonical form
 *   `2026-08-12T14:00:00.000Z`  truncated to the second (see below)
 *   `2026-08-12`                interpreted as `2026-08-12T00:00:00Z`
 *
 * Refused: anything without `Z`, anything with a `+01:00`-style offset, and a
 * space separator. Each of those is a request whose meaning depends on
 * information the request does not carry.
 *
 * **Fractional seconds are accepted and truncated, not refused.** The contract
 * is second precision, but `new Date().toISOString()` — the single most common
 * way a client will produce one of these — emits milliseconds. Refusing it
 * would make the most obvious client idiom a 400. Truncation is safe in a way
 * rounding would not be: the stored resolution is 15 minutes at its finest, so
 * no sub-second component can select a different row.
 */
export function parseInstant(value: string, name: string): Date {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const full = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value);

  if (!dateOnly && !full) {
    throw invalid(
      `invalid_${name}`,
      `The ${name} parameter must be an RFC 3339 timestamp in UTC with an explicit Z, ` +
        'such as 2026-08-01T00:00:00Z, or a bare date such as 2026-08-01. ' +
        'Local times, UTC offsets and timestamps without a zone are not accepted.'
    );
  }

  const parsed = new Date(dateOnly ? `${value}T00:00:00Z` : value);

  // `2026-02-30` matches the pattern above and is not a date — and **V8 does
  // not reject it**. When the spec's ISO parse fails, V8 falls back to a legacy
  // lenient parser that rolls the overflow forward, so `new Date('2026-02-30')`
  // silently becomes 2026-03-02. A caller who typed the wrong day would receive
  // a perfectly good page of the wrong two days and nothing would say so.
  //
  // Round-tripping the date part is the check: a value that survived the regex
  // and means what it says formats back to itself. Found by a test asserting the
  // refusal, which is the only way this branch was ever going to be noticed.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw invalid(
      `invalid_${name}`,
      `The ${name} parameter is not a real date. Check the day of month and try again.`
    );
  }
  // Truncate to the second: the contract's precision, applied once, here.
  return new Date(Math.floor(parsed.getTime() / 1000) * 1000);
}

/**
 * The longest window one request may ask for.
 *
 * ABL-293 §2d. This bounds worst-case query cost on a 9.4 GB SQLite file where
 * one slow read blocks the whole process — the reason
 * `services/readQueryWorker.ts` exists on the private side. 366 rather than 365
 * so that "a full year" is expressible across a leap year without a caller
 * having to know which kind of year they are in.
 *
 * Note this is a *window* bound, not a row bound. The row cap
 * ({@link MAX_ROW_LIMIT}) is the one that decides how much comes back; this one
 * decides how much has to be looked at.
 */
export const MAX_WINDOW_DAYS = 366;

const MS_PER_DAY = 86_400_000;

/**
 * A requested window: half-open `[from, to)`, timestamp labels the interval
 * start.
 *
 * Half-open is stated in the contract and enforced here, because the
 * alternative fails quietly: a customer summing an inclusive-bounds hourly
 * series over consecutive pages double-counts one hour per page, and the total
 * is wrong by a fraction small enough to look like rounding.
 */
export interface TimeWindow {
  /** Inclusive lower bound, `2026-08-01T00:00:00Z`. */
  fromIso: string;
  /** **Exclusive** upper bound. */
  toIso: string;
  /** Inclusive lower bound in the database's text form: `2026-08-01 00:00:00`. */
  sqlStart: string;
  /**
   * Inclusive upper bound in the database's text form, one second below
   * {@link toIso}.
   *
   * `rangeClause` is a `BETWEEN`, which is inclusive at both ends, and the
   * contract is half-open. Rather than write a second range helper — and give
   * this codebase two ways to bound a timestamp window, which is how ABL-21
   * happened — the exclusive bound is expressed as an inclusive bound one
   * second lower. Safe at second precision because that *is* the precision:
   * there is no representable instant between `toIso - 1s` and `toIso`.
   */
  sqlEndInclusive: string;
}

/**
 * Parse and bound `from`/`to`.
 *
 * **Both are required, deliberately.** A default of "the last 24 hours" would
 * put an implicit clock in the contract, and this API's whole freshness
 * position (ABL-293 §2g) is that the clock must be explicit: a day-ahead series
 * is dated in the future, so "now" is not the end of the data, and a default
 * ending at "now" would silently truncate tomorrow's prices for every caller
 * who did not think about it. Requiring both costs one line in a client and
 * removes an entire class of "why is tomorrow missing".
 */
export function parseWindow(query: Record<string, unknown>): TimeWindow {
  const rawFrom = singleValue(query.from, 'from', 'invalid_from');
  const rawTo = singleValue(query.to, 'to', 'invalid_to');

  if (!rawFrom || !rawTo) {
    throw invalid(
      'window_required',
      'Both from and to are required, as RFC 3339 UTC timestamps or bare dates — ' +
        'for example from=2026-08-01&to=2026-08-08. The window is half-open: ' +
        'from is included, to is not.'
    );
  }

  const from = parseInstant(rawFrom, 'from');
  const to = parseInstant(rawTo, 'to');

  if (to.getTime() <= from.getTime()) {
    throw invalid(
      'empty_window',
      'The to parameter must be strictly after from. The window is half-open, ' +
        'so from equal to to selects nothing.'
    );
  }

  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * MS_PER_DAY) {
    throw invalid(
      'window_too_large',
      `A single request may span at most ${MAX_WINDOW_DAYS} days. ` +
        'Request a narrower window, or page through a longer one with several requests.'
    );
  }

  const fromIso = toIsoSecond(from);
  const toIso = toIsoSecond(to);

  return {
    fromIso,
    toIso,
    sqlStart: normalizeTimestamp(fromIso),
    sqlEndInclusive: normalizeTimestamp(toIsoSecond(new Date(to.getTime() - 1000))),
  };
}

/** `2026-08-01T00:00:00Z` — always second precision, always `Z`. */
export function toIsoSecond(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

/**
 * The hard cap on rows in one response. All endpoints, all plans (ABL-293 §2d).
 *
 * Not a default a plan can raise. The cap is what makes per-request pricing
 * mean anything — without it, `GET /v1/observations/load` over seven years
 * returns ~200,000 rows for one billing unit, and 30 such requests are the
 * entire European load history. It is also, per §2d, the single most expensive
 * thing on the ABL-293 list to retrofit: introducing it after a customer has
 * built against an uncapped response turns one billed request into twenty-one
 * and arrives as a bill increase they did not agree to.
 *
 * ABL-302 owns quotas and rate limits and has not landed. This cap does not
 * wait for it: the cap is a term of the contract, the quota is enforcement of a
 * plan, and shipping the endpoints without the cap would mean shipping the
 * defect the cap exists to prevent.
 */
export const MAX_ROW_LIMIT = 10_000;

/**
 * `?limit=` — an integer in `[1, MAX_ROW_LIMIT]`, defaulting to the cap.
 *
 * A caller asking for more than the cap gets the cap rather than a 400. Refusing
 * would be pedantry: they asked for as much as possible and that is what they
 * get, with `meta.row_limit` stating what was actually applied and
 * `meta.truncated` saying whether it bit.
 */
export function parseLimit(raw: unknown): number {
  const value = singleValue(raw, 'limit', 'invalid_limit');
  if (value === undefined || value === '') return MAX_ROW_LIMIT;

  if (!/^\d{1,7}$/.test(value)) {
    throw invalid(
      'invalid_limit',
      `The limit parameter must be a whole number between 1 and ${MAX_ROW_LIMIT}.`
    );
  }
  const parsed = Number(value);
  if (parsed < 1) {
    throw invalid(
      'invalid_limit',
      `The limit parameter must be a whole number between 1 and ${MAX_ROW_LIMIT}.`
    );
  }
  return Math.min(parsed, MAX_ROW_LIMIT);
}

/**
 * A parameter that must be one of a fixed set.
 *
 * The message lists the accepted values — which are constants from this
 * codebase, never the caller's input — so a typo is a five-second fix instead
 * of a documentation hunt. This is the shape every non-timestamp, non-numeric
 * parameter on `/v1` takes, which is what keeps the logged parameter set
 * enumerable.
 */
export function parseEnum<T extends string>(
  raw: unknown,
  name: string,
  allowed: readonly T[],
  { required }: { required: boolean }
): T | undefined {
  const value = singleValue(raw, name, `invalid_${name}`);
  if (value === undefined || value === '') {
    if (!required) return undefined;
    throw invalid(
      `${name}_required`,
      `The ${name} parameter is required. Accepted values: ${allowed.join(', ')}.`
    );
  }
  const lower = value.toLowerCase();
  if (!(allowed as readonly string[]).includes(lower)) {
    throw invalid(
      `invalid_${name}`,
      `The ${name} parameter must be one of: ${allowed.join(', ')}.`
    );
  }
  return lower as T;
}

/**
 * A comma-separated subset of a fixed set, or `undefined` for "all of them".
 *
 * Used by `?production_type=`. An unknown member is a 400 rather than an
 * ignored filter: silently dropping `production_type=nucular` returns all 21
 * types, which reads as success and bills as success.
 */
export function parseEnumList<T extends string>(
  raw: unknown,
  name: string,
  allowed: readonly T[]
): T[] | undefined {
  const value = singleValue(raw, name, `invalid_${name}`);
  if (value === undefined || value === '') return undefined;

  const requested = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');

  if (requested.length === 0) {
    throw invalid(
      `invalid_${name}`,
      `The ${name} parameter must name at least one value. Accepted values: ${allowed.join(', ')}.`
    );
  }
  for (const entry of requested) {
    if (!(allowed as readonly string[]).includes(entry)) {
      throw invalid(
        `invalid_${name}`,
        `The ${name} parameter accepts a comma-separated subset of: ${allowed.join(', ')}.`
      );
    }
  }
  // De-duplicated, order preserved: `?production_type=solar,solar` is a caller
  // mistake that should not double a column in the response.
  return [...new Set(requested)] as T[];
}
