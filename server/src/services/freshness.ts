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

import type { FreshnessStream, FreshnessStatus } from '../types/index.js';

export type { FreshnessStream, FreshnessStatus } from '../types/index.js';

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
 * How old a formerly-held series must be before it is no longer an actionable
 * ingest alarm.
 *
 * Sized against the full 39-country production fleet on 2026-08-10 12:04 UTC.
 * The slowest healthy measured stream was 11.1h old; the worst active stall was
 * MK generation at 111.1h. The next measured stream was AL generation at
 * 1,143.1h, followed by UA/GB load at 39,047h/45,195h. Day-ahead streams showed
 * the same gap: the worst active miss was CH generation forecast at 87.1h,
 * while UA/GB stopped 39,039h/45,181h ago.
 *
 * Thirty days is therefore over 6x the worst active stall, over 65x the
 * slowest healthy lag, and spans at least 102 longest scheduled ingest gaps.
 * It selects only the five known ended series on that measurement and leaves a
 * 423h margin below the youngest one (AL generation). This is deliberately a
 * high-confidence terminal verdict, not a quicker stale alarm.
 *
 * It is derived solely from the newest usable row, so it self-clears: as soon
 * as upstream publishes a newer row, the same classifier returns live (or
 * stale during the normal catch-up window) without a country exception.
 */
export const ENDED_AFTER_HOURS = 30 * 24;

/**
 * Which day-ahead stream is being judged. Named exactly as the field that
 * carries it in `/api/data-freshness/:cc` (`dataFreshnessService.ts`), so a
 * call site cannot pass the wrong one without it reading wrong.
 */
export type DayAheadStreamKey = 'price' | 'tsoLoadForecast' | 'tsoGenerationForecast';

/**
 * The UTC hour after which tomorrow's day-ahead result must be in the database,
 * **per stream** — because the three day-ahead streams are three different
 * ENTSO-E documents with three different publication deadlines.
 *
 * One shared 14 was wrong for A69 and produced a structural false-stale window
 * fleet-wide every afternoon (ABL-494). Measured 2026-08-20 by raw HTTP probes
 * against ENTSO-E, none of our client code involved: at 15:24 UTC the API
 * answered Acknowledgement 999, "No matching data found for
 * GENERATION_FORECAST_WIND_SOLAR [14.1.D]", for DE's tomorrow — nobody held it,
 * and we were calling ourselves stale for not holding it either. At 16:32 UTC
 * DE/FR/ES/IT/PL/NL all had it upstream and we still did not, because our last
 * A69-capable pass was 13:30 UTC. Same rule, same instant, same countries: the
 * A65 stream passed and the A69 stream failed, so the split is per document
 * class, not per country.
 *
 * **How long an ingest pass actually takes**, because every hour below is
 * "the pass that could carry it has finished". This file used to say ~11
 * minutes, inferred from the per-country fetch stamps of a single pass
 * (00:30:07 → 00:41:18). That was wrong by up to 5x. Measured on prod from
 * `cron_update.log`, pairing each `Countries to process: 39` with its
 * `Total countries processed: 36` (CEO, ABL-494, 2026-08-20):
 *
 * | pass         | 08-18 18:30 | 08-19 00:30 | 06:30  | 13:30  | 18:30  | 08-20 00:30 | 06:30  | 13:30      |
 * |--------------|-------------|-------------|--------|--------|--------|-------------|--------|------------|
 * | duration     | 16m55s      | 23m00s      | 29m46s | 29m19s | 20m40s | 18m55s      | 23m43s | **55m10s** |
 *
 * The floor is ~17m and the observed maximum is 55m. Countries are fetched in
 * one sequential alphabetical loop, so an overrun does not fail uniformly — it
 * lands late on the tail of the alphabet. In that 55-minute pass NL was fetched
 * 14:07, PL 14:12, SE 14:19, SI 14:22, SK 14:23, UA 14:25, all after 14:00.
 *
 * - **`price`** — A44, the SDAC auction result (`../energy-data-gathering/config.py`,
 *   `ENTSOE_API_CONFIG['price']`). The auction publishes ~12:45 Brussels (10:45
 *   UTC in summer), but publication upstream is not the same as arrival here:
 *   the first ingest pass that can carry it is 11:15 UTC, and the last full pass
 *   of the afternoon starts 13:30 UTC. 14:00 UTC is the first hour at which
 *   "tomorrow is missing" usually means *we* are missing it rather than *nobody
 *   has published it yet* — the distinction between a defect and a time of day,
 *   which a naive "it is the afternoon, where is tomorrow" check gets wrong
 *   every morning. **Residual, stated rather than papered over:** on the table
 *   above 14:00 does not clear every 13:30 pass, so on a slow day the tail of
 *   the alphabet can read `stale` for a few minutes. 14 is kept deliberately: it
 *   is the ABL-51 tripwire, a board member found that miss because nothing else
 *   did, and widening it trades a rare few-minute false positive for a
 *   permanently later real-miss detection. Whether the shared floor should move
 *   to 15 is its own judgement with its own evidence, not a drive-by change
 *   inside this one.
 * - **`tsoLoadForecast`** — A65/A01, data item 6.1
 *   (`config.py`, `load_forecast_day_ahead`), also published around midday
 *   Brussels. 14 is empirically right for it: DE/FR/ES/IT/PL all reached
 *   tomorrow at both 15:17 and 16:32 UTC on the same 2026-08-20 probe. Same
 *   residual as `price`, kept for the same reason.
 * - **`tsoGenerationForecast`** — A69/A01, data item **14.1.D**, day-ahead wind
 *   & solar (`config.py`, `wind_solar_forecast`). Its deadline is ~6h later than
 *   the auction's: Reg. 543/2013 Art. 14.1 requires publication by 18:00
 *   Brussels D-1 — 16:00 UTC under CEST, 17:00 UTC under CET. The last
 *   A69-capable ingest pass before that is 13:30 UTC (the 11:15/12:15 passes run
 *   `--types price` and carry no A69), and the next is **18:30 UTC**.
 *
 *   That the horizon moves at the 18:30 pass is measured, not inferred: DE's
 *   stored A69 row count per pass repeats identically across 08-18/19/20 and the
 *   arithmetic closes at 15-minute resolution — `704` at 13:30 (08-13 13:45 →
 *   08-20 21:45 = 7d x 96 + 32, newest row **today**) and `780` at 18:30 (08-13
 *   18:45 → 08-21 21:45, newest row **tomorrow**). The early publishers' `800`
 *   is `704 + 96`, exactly one extra market day, which is their whole advantage;
 *   at 13:30 that set is NL, BE, AT, GR, HR, HU, LT, LU, NO and RO, not just
 *   NL/BE.
 *
 *   **20:00 UTC, not 19:00**, is therefore the first safe hour: 18:30 plus the
 *   observed worst case of 55m10s ends at **19:25**, so a 19:00 cutoff would
 *   re-create this very bug — smaller and later, on the tail of the alphabet,
 *   on exactly the slow days when the ingest least deserves an accusation.
 *   20:00 clears the worst measured pass with ~35 minutes to spare. Deliberately
 *   not DST-conditional: 20 clears the CET deadline as well, so one number is
 *   correct year-round.
 *
 * The honest consequence, written down rather than papered over: between 14:00
 * and 20:00 UTC we genuinely **cannot** distinguish "upstream never published
 * A69" from "we have not fetched it yet", so this rule does not pretend to. That
 * is a real bound of a four-passes-a-day ingest, not a workaround. Two things
 * survive inside that window: a stream that fails to reach even *today* is still
 * `stale` at any hour, and from 20:00 UTC a genuinely absent tomorrow is caught
 * for the rest of the day — the ABL-51 protection this file exists for.
 */
export const DAY_AHEAD_REQUIRED_AFTER_UTC_HOUR: Readonly<Record<DayAheadStreamKey, number>> = {
  price: 14,
  tsoLoadForecast: 14,
  tsoGenerationForecast: 20,
};

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
    status: classifyAge(ageHours),
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
 * market day it should? Before that stream's own
 * `DAY_AHEAD_REQUIRED_AFTER_UTC_HOUR` we require only that it reaches today;
 * after, that it reaches tomorrow.
 *
 * `stream` is required rather than defaulted, and that is the ABL-494 fix: the
 * three documents publish hours apart, so a stream that silently inherited
 * another's deadline would read `stale` every afternoon between the two — which
 * is exactly what A69 did under the single shared constant. A new day-ahead
 * stream must therefore name its own deadline before it can be classified.
 *
 * The bound is the **start** of the required Brussels day rather than its end,
 * and that is what makes one Brussels-framed test correct for every bidding
 * zone from WET to EET. A zone's own market day is 23-25h long, so a zone that
 * has published the required day in full has a newest row at least ~20h past
 * that day's local start — far more than the ≤3h spread between European market
 * timezones. Testing the day's *end* in Brussels terms would instead mark BG
 * (UTC+3, whose day ends 2h before Brussels') stale while it was complete.
 */
export function classifyDayAheadStream(
  latest: string | null,
  now: Date,
  stream: DayAheadStreamKey,
): FreshnessStream {
  const at = parseStoredTimestamp(latest);
  if (!at) return { latest: null, ageHours: null, status: 'none' };

  const requiredDay = now.getUTCHours() >= DAY_AHEAD_REQUIRED_AFTER_UTC_HOUR[stream] ? 1 : 0;
  const mustReach = brusselsDayStartUtc(now, requiredDay);
  const ageHours = (now.getTime() - at.getTime()) / MS_PER_HOUR;

  return {
    latest,
    ageHours,
    status:
      ageHours > ENDED_AFTER_HOURS
        ? 'ended'
        : at.getTime() >= mustReach.getTime()
          ? 'live'
          : 'stale',
  };
}

function classifyAge(ageHours: number): FreshnessStatus {
  if (ageHours > ENDED_AFTER_HOURS) return 'ended';
  return ageHours > MEASURED_STALE_AFTER_HOURS ? 'stale' : 'live';
}
