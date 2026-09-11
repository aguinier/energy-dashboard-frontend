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
 * "the pass that could carry it has finished". Two earlier figures were wrong.
 * ~11 minutes, inferred from the per-country fetch stamps of a single pass
 * (00:30:07 → 00:41:18), was wrong by up to 5x. Then 17m–55m10s (ABL-494,
 * `cron_update.log` over 2026-08-18..20), pairing each `Countries to process: 39`
 * with the next `Total countries processed: 36`.
 *
 * **That pairing is unsound, and the number it produced is now 4x low.** An
 * overrunning pass does not delay the next cron minute — the two run
 * **concurrently**, interleaving in one log, so the next
 * `Total countries processed` may belong to an earlier pass. On 2026-09-09 three
 * passes were in flight at once and the 00:30 one did not finish until 09:38.
 *
 * Re-measured over every evening from 2026-08-01 to 09-09 (ABL-712) by
 * attributing each per-country A69 fetch to a pass through the strictly
 * alphabetical order a pass visits countries in — which reproduces ABL-494's
 * 55m10s for the 08-20 13:30 pass, so the two measurements agree where they
 * overlap. The instant the 18:30 pass reaches its **last** country (UA; IS, MT
 * and TR are configured without A69 and skipped):
 *
 * | evenings     | n  | min      | median   | p90      | max      |
 * |--------------|----|----------|----------|----------|----------|
 * | 08-01..08-28 | 27 | 18:37:41 | 18:49:24 | 19:13:52 | 19:50:20 |
 * | 08-29..09-09 |  9 | 18:55:08 | 19:49:19 | 21:58:57 | 22:36:38 |
 *
 * The pass got ~4x slower in late August 2026 and the cause is upstream, not
 * ours: ENTSO-E 503/504/527/599 responses went from 2–6 a day through 08-28 to
 * 500–2000 a day after, and the retries are the duration. Countries are fetched
 * in one sequential loop, so an overrun does not fail uniformly — it lands late
 * on the tail of the alphabet.
 *
 * Three of those evenings (08-31, 09-01, 09-07) stored **no** A69 at all: every
 * fetch in the 18:30 pass errored. Those are real misses, correctly reported at
 * any cutoff hour, and no deadline can or should paper over them.
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
 *   **Since ABL-717, 21:00 UTC is a backstop and our own attempt is the
 *   deadline.** Once a `wind_solar_forecast` attempt for *this* country that
 *   started after upstream's 18:00 Brussels obligation has finished, tomorrow
 *   is required (`classifyDayAheadStream`'s `lastAttemptStart`). Over the period
 *   below, a real miss is flagged at a median of 19:05 rather than 21:00. The
 *   hour now decides only the country no such attempt has reached, whether the
 *   pass is slow, hung, or never ran. On 08-11 and 09-03 no attempt reached 16
 *   and 6 countries all evening, and every one was a real miss. Without the
 *   backstop they would have read `live` until Brussels midnight.
 *
 *   Re-measured by ABL-717 over 2026-08-01..09-10 (the replica's
 *   `data_ingestion_log`, 1,101 country-evenings). The figures are country-hours
 *   of false `stale`, where false means tomorrow did arrive later that same
 *   evening:
 *
 *   | hour   | as the whole rule | as backstop behind the attempt rule |
 *   |--------|-------------------|-------------------------------------|
 *   | 19     | 35.2              | 32.7                                |
 *   | 20     | 1.1               | 0.5                                 |
 *   | **21** | **0.0**           | **0.0**                             |
 *   | 22     | 0.0               | 0.0                                 |
 *
 *   The attempt rule has its own transient, 7.1 country-hours over the same
 *   period: a post-deadline fetch errored or came back without tomorrow, and a
 *   later fetch brought it. Each of those was true when it was said.
 *
 *   **ABL-712's table for this constant (162.9 / 45.4 / 14.9 / 1.9) was wrong,
 *   and the move from 20 to 21 was decided on it.** It counted a fetch that
 *   *stored rows* as one that delivered tomorrow, which is the trap
 *   `ingestLog.ts` documents. On 09-08 and 09-09 the evening fetches stored 684
 *   rows apiece. 684 quarter-hours from a 19:00 window start end at *today's*
 *   21:45, so all 14.9 of its country-hours were real misses. "Arrived" is now
 *   read off each fetch's horizon (window start plus rows times resolution),
 *   never off its row count. 21 is kept, not re-tuned, because it costs 0.0
 *   here. Moving to 20 would buy an hour of warning on a dead-pass evening for
 *   0.5 country-hours, and that trade is its own judgement.
 *
 *   Deliberately not DST-conditional: 21 clears the CET deadline as well, and
 *   the attempt rule reads its obligation off the Brussels calendar.
 *
 * The honest consequence, written down rather than papered over: for `price`
 * and `tsoLoadForecast`, and for A69 until our own post-deadline fetch has
 * looked, we **cannot** distinguish "upstream never published it" from "we have
 * not fetched it yet", so the rule does not pretend to. That is a real bound of
 * a four-passes-a-day ingest, not a workaround. A stream that fails to reach
 * even *today* is still `stale` at any hour.
 *
 * **Moving one of these hours later does not lose a real miss, and that is what
 * makes 20 → 21 affordable.** The instinct — one hour added is one hour of ABL-51
 * detection surrendered — reads the rule as if the requirement expired at
 * midnight. It does not: at 00:00 UTC the day that was never published stops
 * being "tomorrow" and becomes "today", which this rule requires at *every*
 * hour, so the same absent day keeps reading `stale` overnight and onward until
 * data actually arrives (pinned by the UTC-midnight test in
 * `freshness.test.ts`). What a deadline hour buys is therefore **earlier warning
 * during the evening before the market day opens**, not detection — and it is
 * paid for in false `stale` on every country the pass has not reached yet. That
 * is a trade between hours of notice and country-hours of noise, which is why
 * the table above is denominated in both.
 */
export const DAY_AHEAD_REQUIRED_AFTER_UTC_HOUR: Readonly<Record<DayAheadStreamKey, number>> = {
  price: 14,
  tsoLoadForecast: 14,
  tsoGenerationForecast: 21,
};

/**
 * The Brussels wall-clock hour by which upstream must have published tomorrow.
 * Listed only for the day-ahead streams whose requirement our own ingest
 * attempt may bring forward (ABL-717), which today is A69 alone.
 *
 * 18 is Reg. 543/2013 Art. 14.1's deadline for data item 14.1.D, day-ahead
 * wind & solar: 18:00 Brussels D-1, which is 16:00 UTC under CEST and 17:00
 * under CET. It is a legal obligation, not a measurement of anybody's latency,
 * so unlike the hour above it does not rot when a pass slows down.
 *
 * `price` and `tsoLoadForecast` are deliberately absent, so an attempt never
 * moves their requirement and both keep ABL-51's 14:00 tripwire exactly as it
 * was. Keying them here would bring their requirement *forward*: onto the
 * 11:15/12:15 price-only passes for A44, and onto the 13:30 pass for A65. That
 * needs its own evidence about when upstream actually publishes, starting with
 * an SDAC decoupling day, and ABL-717 did not measure it.
 */
export const DAY_AHEAD_PUBLISHED_BY_BRUSSELS_HOUR: Readonly<
  Partial<Record<DayAheadStreamKey, number>>
> = {
  tsoGenerationForecast: 18,
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

/**
 * The UTC instant at which the market day **named by a UTC calendar date**
 * begins in Brussels.
 *
 * This is the sibling of `brusselsDayStartUtc` and the difference between them
 * is ABL-697. Both answer "when does a Brussels day start"; they disagree about
 * *which* day, and only during the hours when the two calendars disagree —
 * 22:00-24:00 UTC under CEST, 23:00-24:00 under CET.
 *
 * `brusselsDayStartUtc(now, 1)` means "the day after the Brussels day `now`
 * falls in". `marketDayStartUtc(now, 1)` means "the day after the UTC date
 * `now` falls in". At 22:30 UTC on the 9th those are the 11th and the 10th.
 *
 * `classifyDayAheadStream` needs the second, because its deadline is a **UTC
 * hour** (`DAY_AHEAD_REQUIRED_AFTER_UTC_HOUR`) and an hour-of-day only names a
 * day together with the calendar it is counted in. Mixing the two made the rule
 * demand D+2 for two hours every night — see that constant for the measurement.
 *
 * The offset is read twice for the same reason `brusselsDayStartUtc` reads it
 * twice: the Brussels offset at 00:00 UTC is not necessarily the offset at the
 * Brussels midnight up to two hours earlier.
 */
export function marketDayStartUtc(now: Date, dayOffset: number): Date {
  const midnightWall = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + dayOffset,
  );

  const guessOffset = offsetMs(new Date(midnightWall));
  const firstGuess = new Date(midnightWall - guessOffset);
  const offsetThere = offsetMs(firstGuess);
  return offsetThere === guessOffset ? firstGuess : new Date(midnightWall - offsetThere);
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
 * **"Today" is the UTC calendar date, not the Brussels one** (`marketDayStartUtc`,
 * ABL-697). The deadline above is a UTC hour, and an hour-of-day names a day
 * only together with the calendar it is counted in; taking the hour from UTC
 * and the day from Brussels made the rule demand D+2 — a market day nobody has
 * ever published — from Brussels midnight until UTC midnight. Measured on prod
 * and CAT alike, that was 33 of 39 countries reading `stale` for two hours
 * every night, on all three day-ahead streams at once.
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
 *
 * **`lastAttemptStart` brings A69's requirement forward, per country (ABL-717).**
 * It is when the newest *finished* ingest attempt at this country's stream
 * began. If that is at or after upstream's publication obligation for tomorrow
 * (`publicationObligationUtc`), tomorrow is required now rather than at the
 * clock hour: we have looked since upstream owed us the day, so a missing day
 * is missing. Until then, the clock hour decides exactly as before. That is
 * what keeps the tail of the alphabet quiet while a slow pass has not reached
 * it, and it is also why omitting the argument is safe: `null` reproduces the
 * pre-ABL-717 rule at every hour. A stream with no obligation listed ignores
 * the argument.
 *
 * The attempt answers only *when we looked*. Whether anything arrived is still
 * `latest`, the table's own `MAX`. A fetch that stored rows is not a fetch that
 * brought tomorrow: on 2026-09-09 DE's evening fetch stored 684 rows, all of
 * them up to today's 21:45.
 */
export function classifyDayAheadStream(
  latest: string | null,
  now: Date,
  stream: DayAheadStreamKey,
  lastAttemptStart: string | null = null,
): FreshnessStream {
  const at = parseStoredTimestamp(latest);
  if (!at) return { latest: null, ageHours: null, status: 'none' };

  const requiredDay =
    now.getUTCHours() >= DAY_AHEAD_REQUIRED_AFTER_UTC_HOUR[stream] ||
    attemptedSinceObligation(stream, now, lastAttemptStart)
      ? 1
      : 0;
  const mustReach = marketDayStartUtc(now, requiredDay);
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

/**
 * The instant upstream must have published the market day
 * `classifyDayAheadStream` would require next, which is tomorrow as named by
 * the UTC date. Returns `null` for a stream whose obligation this module does
 * not key on (`DAY_AHEAD_PUBLISHED_BY_BRUSSELS_HOUR`).
 *
 * It is derived from the start of that very day, so the obligation and the
 * requirement cannot name different days. Naming different days was ABL-697's
 * defect. Brussels midnight is stepped back to the obligation hour of the
 * evening before. A fixed subtraction is exact because both DST switches happen
 * at 01:00 UTC, which is 02:00 or 03:00 in Brussels. That is after midnight, and
 * never between 18:00 and the midnight that follows it. `freshness.test.ts` pins
 * both switch weekends.
 */
export function publicationObligationUtc(now: Date, stream: DayAheadStreamKey): Date | null {
  const hour = DAY_AHEAD_PUBLISHED_BY_BRUSSELS_HOUR[stream];
  if (hour === undefined) return null;
  return new Date(marketDayStartUtc(now, 1).getTime() - (24 - hour) * MS_PER_HOUR);
}

/** Has a finished attempt begun since upstream owed us tomorrow? See `classifyDayAheadStream`. */
function attemptedSinceObligation(
  stream: DayAheadStreamKey,
  now: Date,
  lastAttemptStart: string | null,
): boolean {
  const obligation = publicationObligationUtc(now, stream);
  const attempt = parseStoredTimestamp(lastAttemptStart);
  return obligation !== null && attempt !== null && attempt.getTime() >= obligation.getTime();
}

function classifyAge(ageHours: number): FreshnessStatus {
  if (ageHours > ENDED_AFTER_HOURS) return 'ended';
  return ageHours > MEASURED_STALE_AFTER_HOURS ? 'stale' : 'live';
}
