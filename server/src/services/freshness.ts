/**
 * Is what the dashboard is drawing actually current?
 *
 * ABL-60. On 2026-08-06 the 13:30 UTC ingest pass met an ENTSO-E outage — 484
 * HTTP 503s, 0 of 30 countries stored, every document type — and nothing
 * anywhere said so. The dashboard went on rendering yesterday's numbers under a
 * green pulsing "live" dot, and the outage was found only because a board
 * member noticed tomorrow's price was missing (ABL-51).
 *
 * That is this repo's recurring defect wearing a different hat: not a wrong
 * number in a chart, but a wrong claim *about* the chart. A stale series drawn
 * without comment asserts "this is current", and that assertion was false for
 * most of a day.
 *
 * The two rules below are the smallest honest statements the stored data can
 * support. Both are pure so they can be tested without a database or a clock,
 * and both return a status the caller renders rather than a boolean nobody can
 * audit.
 */

/** What we are willing to say about one stream of one country. */
export type FreshnessStatus =
  /** New enough that no scheduled ingest pass can have been missed. */
  | 'live'
  /** Provably behind: at least one scheduled pass stored nothing for it. */
  | 'stale'
  /** No rows at all. Not a health verdict — we have never held this stream. */
  | 'none';

export interface FreshnessStream {
  /** Newest *usable* stored timestamp, verbatim from the database. */
  latest: string | null;
  /**
   * `now - latest`, in hours, signed. **Negative is normal for a day-ahead
   * stream** — tomorrow's auction result is dated up to ~46h into the future by
   * design — which is exactly why those streams cannot be judged by age and get
   * `classifyDayAheadStream` instead.
   */
  ageHours: number | null;
  status: FreshnessStatus;
}

/**
 * How old a *measured* series may get before a pass has certainly been missed.
 *
 * Sized from measurement, not taste. Full ingest passes run at 00:30, 06:30,
 * 13:30 and 18:30 UTC (`../energy-data-gathering/docker/crontab`, described at
 * `docker/Dockerfile:22`), so the longest scheduled gap is **7h** (06:30 →
 * 13:30). On top of that sits each TSO's own publication lag, which varies a
 * lot: measured against prod 2026-08-07 07:10 UTC, minutes after a healthy
 * 06:30 pass, 31 of 34 countries sat 0.93-3.18h behind, while BG sat 6.18h and
 * AL/ME ~9.2-9.4h behind — chronically late, but complete.
 *
 * So the slowest healthy country can legitimately reach 9.4 + 7 = **16.4h**
 * before its next pass. 18h clears that with margin, and it is not a tuned
 * edge: on the same measurement every healthy country was under 9.5h and the
 * next value up was MK at 34.2h, so **any threshold from 9.5h to 34h selects
 * exactly the same set** (MK, GB, UA stale; the other 31 live).
 *
 * Known limit, stated rather than papered over: because AL's ordinary 9.4h
 * overlaps a fast publisher's age after one missed pass (FR would reach ~15.4h),
 * no single fleet-wide threshold separates "chronically late" from "missed one
 * pass". This rule therefore catches a *sustained* outage, not every single
 * dropped pass. Doing better needs a per-country baseline the database cannot
 * currently supply — `publication_timestamp_utc` is rewritten on every re-fetch,
 * so it dates the last pass that touched a row, not the pass that first stored
 * it (ABL-60, point 2). That is an ingest-side fix, tracked separately.
 */
export const MEASURED_STALE_AFTER_HOURS = 18;

/**
 * The UTC hour after which tomorrow's day-ahead result must be in the database.
 *
 * The auction publishes ~12:45 Brussels (10:45 UTC in summer), but publication
 * upstream is not the same as arrival here: the first ingest pass that can
 * carry it is 11:15 UTC, and the last full pass of the afternoon starts 13:30
 * UTC and takes ~11 minutes end to end (measured from the per-country fetch
 * stamps of a single pass, 00:30:07 → 00:41:18). 14:00 UTC is therefore the
 * first hour at which "tomorrow is missing" means *we* are missing it rather
 * than *nobody has published it yet* — the distinction between a defect and a
 * time of day, which a naive "it is the afternoon, where is tomorrow" check
 * gets wrong every morning.
 */
export const DAY_AHEAD_REQUIRED_AFTER_UTC_HOUR = 14;

const BRUSSELS_TZ = 'Europe/Brussels';
const MS_PER_HOUR = 3_600_000;

/**
 * Read a stored timestamp as the UTC instant it is.
 *
 * Three shapes reach this, and the naive `new Date(value)` mishandles two of
 * them:
 *
 * - `2026-08-07T05:45:00` and `2026-08-07 05:45:00` — the same column holds
 *   both separators (see CLAUDE.md, "Timestamp storage: two separators in one
 *   column"). V8 parses the `T` form as UTC and the space form as **local
 *   time**, so on a UTC+2 box the identical instant would read two hours apart.
 * - `2025-11-28T00:00:00+02:00` — 26,405 rows across `energy_price`,
 *   `energy_load` and `energy_renewable` carry a trailing offset, all inside
 *   2025-11-13..28. Those already say what they mean and must be left alone.
 *
 * Returns `null` for anything unparseable rather than an Invalid Date, so a
 * caller cannot accidentally arithmetic its way to `NaN` hours and render it.
 */
export function parseStoredTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;

  const normalized = value.replace(' ', 'T');
  // A bare instant is UTC. Anything already carrying `Z` or `±HH:MM` is not
  // ours to reinterpret.
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized);
  const parsed = new Date(hasZone ? normalized : `${normalized}Z`);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The UTC instant at which a Brussels calendar day begins.
 *
 * Calendar arithmetic on the zoned wall clock, not a fixed hour count, for the
 * reason `client/src/lib/timezone.ts` already documents: a Brussels day is 23,
 * 24 or 25 hours long across a DST boundary, so no hour offset lands on the
 * adjacent market day every time. The second `offsetMs` read is what handles
 * stepping *across* the boundary — the offset at the target midnight is not
 * necessarily the offset at `now`.
 */
export function brusselsDayStartUtc(now: Date, dayOffset: number): Date {
  const offset = offsetMs(now);
  const wall = new Date(now.getTime() + offset);
  const midnightWall = Date.UTC(
    wall.getUTCFullYear(),
    wall.getUTCMonth(),
    wall.getUTCDate() + dayOffset,
  );

  const firstGuess = new Date(midnightWall - offset);
  const offsetThere = offsetMs(firstGuess);
  return offsetThere === offset ? firstGuess : new Date(midnightWall - offsetThere);
}

/** Brussels' UTC offset at a given instant, in milliseconds. */
function offsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BRUSSELS_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);

  const field = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // Some ICU builds spell midnight as hour 24 under hour12:false.
  const asIfUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour') % 24,
    field('minute'),
    field('second'),
  );

  return asIfUtc - at.getTime();
}

/**
 * A stream of measurements — `energy_load`, `energy_generation`.
 *
 * These are strictly backward-looking: a measured hour cannot be published
 * before it happens, so "how old is the newest one" is the whole question and
 * `MEASURED_STALE_AFTER_HOURS` answers it.
 */
export function classifyMeasuredStream(latest: string | null, now: Date): FreshnessStream {
  const at = parseStoredTimestamp(latest);
  if (!at) return { latest: null, ageHours: null, status: 'none' };

  const ageHours = (now.getTime() - at.getTime()) / MS_PER_HOUR;
  return {
    latest,
    ageHours,
    status: ageHours > MEASURED_STALE_AFTER_HOURS ? 'stale' : 'live',
  };
}

/**
 * A day-ahead publication — `energy_price`, the two TSO forecast tables.
 *
 * Age is meaningless here and applying the measured rule to these would be the
 * mirror of the bug this file exists for: a healthy day-ahead price is dated up
 * to ~46h in the *future*, so it would read as impossibly fresh forever, and a
 * genuinely missing tomorrow would never show. ABL-51 was exactly that miss.
 *
 * The question is coverage, not age: does the newest stored row reach into the
 * market day it should? Before `DAY_AHEAD_REQUIRED_AFTER_UTC_HOUR` we require
 * only that it reaches today; after, that it reaches tomorrow.
 *
 * The bound is the **start** of the required Brussels day rather than its end,
 * and that is what makes one Brussels-framed test correct for every bidding
 * zone from WET to EET. A zone's own market day is 23-25h long, so a zone that
 * has published the required day in full has a newest row at least ~20h past
 * that day's local start — far more than the ≤3h spread between European market
 * timezones. Testing the day's *end* in Brussels terms would instead mark BG
 * (UTC+3, whose day ends 2h before Brussels') stale while it was complete.
 */
export function classifyDayAheadStream(latest: string | null, now: Date): FreshnessStream {
  const at = parseStoredTimestamp(latest);
  if (!at) return { latest: null, ageHours: null, status: 'none' };

  const requiredDay = now.getUTCHours() >= DAY_AHEAD_REQUIRED_AFTER_UTC_HOUR ? 1 : 0;
  const mustReach = brusselsDayStartUtc(now, requiredDay);

  return {
    latest,
    ageHours: (now.getTime() - at.getTime()) / MS_PER_HOUR,
    status: at.getTime() >= mustReach.getTime() ? 'live' : 'stale',
  };
}
