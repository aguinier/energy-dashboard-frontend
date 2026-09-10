/**
 * Is the window we claim to hold actually *filled*?
 *
 * ABL-632, the defect under ABL-630. `freshness.ts` answers "how new is the
 * newest row we hold" and nothing else, so a stream's verdict rides on a single
 * timestamp. That is enough to catch a pipeline that stops, and blind to one
 * that keeps limping — a single surviving row per pass keeps `MAX` recent and
 * the stream green while everything behind it rots.
 *
 * It went exactly that way. Prod ingest shed most of its rows from 2026-08-30
 * to 2026-09-02 and `GET /api/data-freshness/DE` reported `load: live` for the
 * whole four days. Measured read-only against
 * `/home/clavain/energy-dashboard/data/energy_dashboard.db` on 2026-09-02 21:00
 * UTC — DE `energy_load` is 15-minute, so a complete UTC day is 96 rows:
 *
 * | UTC day    | rows | of | distinct hours |
 * |------------|------|----|----------------|
 * | 2026-08-28 |   96 | 96 | 24             |
 * | 2026-08-29 |   96 | 96 | 24             |
 * | 2026-08-30 |   41 | 96 | 11             |
 * | 2026-08-31 |   81 | 96 | 21             |
 * | 2026-09-01 |   53 | 96 | 14             |
 *
 * The holes are whole-hour blocks, not a thinned-out grid, and `MAX` stayed
 * within hours of `now` throughout. No age threshold can see that. This module
 * asks the other question.
 *
 * The two rules are deliberately orthogonal and neither subsumes the other:
 *
 * - **age** (`freshness.ts`) — has the newest row stopped advancing?
 * - **coverage** (here) — of the days whose data we claim to hold in full, how
 *   much of each is actually there?
 *
 * Coverage consults **no clock**. Every input is data — daily row counts and
 * the days they fall on — so the verdict is reproducible from a fixture and
 * cannot drift as the suite ages. Recency is already somebody else's job.
 */

import type { FreshnessStream } from '../types/index.js';

/**
 * The streams this applies to, named exactly as the fields carrying them in
 * `/api/data-freshness/:cc` (`dataFreshnessService.ts`), for the same reason
 * `DayAheadStreamKey` is: a call site cannot pass the wrong one without it
 * reading wrong.
 */
export type CoverageStreamKey =
  | 'load'
  | 'generation'
  | 'price'
  | 'tsoLoadForecast'
  | 'tsoGenerationForecast';

/** One UTC calendar day (`YYYY-MM-DD`) and how many rows the stream holds in it. */
export interface DailyRowCount {
  day: string;
  rows: number;
}

/**
 * What the endpoint publishes beside a stream's status. Additive: every field
 * is new, and the whole object is `null` whenever the stored data cannot
 * support one, rather than a zero standing in for an answer.
 */
export interface FreshnessCoverage {
  /** First UTC day counted, inclusive (`YYYY-MM-DD`). */
  windowStart: string;
  /** Last UTC day counted, inclusive (`YYYY-MM-DD`). */
  windowEnd: string;
  /** Rows a complete UTC day holds at this stream's native resolution. */
  expectedDailyRows: number;
  /** Rows actually stored across the window. */
  observed: number;
  /** `expectedDailyRows * COVERAGE_WINDOW_DAYS`. Never zero. */
  expected: number;
  /**
   * `observed / expected`, rounded to 4 decimal places. Can exceed 1 — a
   * country that beats its own demonstrated best day is not an error, and
   * clamping would hide duplicate rows rather than report them.
   *
   * `observed` and `expected` are the authoritative integers; this is the
   * convenience quotient. The status verdict is taken from *this* rounded
   * value, so a caller can never see a published ratio that disagrees with the
   * status beside it.
   */
  ratio: number;
}

/**
 * How many complete UTC days the verdict looks at.
 *
 * Two, and the length is a sensitivity trade-off measured against the incident
 * rather than picked for roundness. The degradation ran four days, so a longer
 * window dilutes it back under any threshold worth having: DE `load` over the
 * seven days ending 2026-09-01 pools to 0.83 (four healthy days at 1.00 carry
 * three broken ones), against **0.70** over two days. Shorter than two, and
 * single-day publication jitter — ordinary for IE and LV, see
 * `COVERAGE_MIN_RATIO` — becomes the dominant signal.
 */
export const COVERAGE_WINDOW_DAYS = 2;

/**
 * The daily row counts a complete UTC day can have, at the three resolutions
 * ENTSO-E publishes: 60, 30 and 15 minutes.
 *
 * Measured across the 34-country fleet on prod over 2026-08-20..29, all five
 * streams: every country's modal daily count is exactly one of these three, and
 * **no day anywhere exceeded 96** — so nothing in the live data inflates a
 * count past its resolution. Countries at 24: BA BG CH LV MD ME PT RS (load);
 * at 48: CY, IE; the rest at 96. `energy_generation` and `energy_price`
 * partition differently again — BE is 24 for generation and 96 for price — which
 * is why resolution is derived per (country, stream) below and not tabulated.
 */
const NATIVE_DAILY_ROWS = [24, 48, 96] as const;

/**
 * How far back to look for evidence of what a complete day looks like.
 *
 * The derivation below takes a **maximum** over this baseline, so the only
 * thing that matters is that at least one healthy day falls inside it. Fourteen
 * days is 3.5x the four-day incident that motivated this file, which is the
 * margin that keeps a *sustained* degradation from redefining "complete" as its
 * own damage and quietly declaring itself healthy.
 */
export const COVERAGE_BASELINE_DAYS = 14;

/**
 * How much of the window must be present before the stream keeps its `live`
 * verdict — **per stream**, following ABL-494's precedent that a fleet-wide
 * freshness constant is wrong whenever the underlying documents differ.
 *
 * They do differ here, structurally: a measured stream arrives hour by hour and
 * is legitimately ragged at the edges, while a day-ahead document is published
 * as a whole market day, so any shortfall in it is a document we did not get.
 *
 * ## Sized against 29 healthy anchor days, not taste
 *
 * Every 2-day window ending on each of 2026-08-01..29 was scored for every
 * country, read-only on prod (~870-990 windows per stream). Windows falling
 * below the threshold, i.e. what these numbers would have called out:
 *
 * | stream                 | threshold | below | of  | countries      |
 * |------------------------|-----------|-------|-----|----------------|
 * | `load`                 | 0.75      |     3 | 986 | MK             |
 * | `generation`           | 0.75      |    34 | 986 | AL, MK         |
 * | `price`                | 0.90      |     2 | 870 | IT             |
 * | `tsoLoadForecast`      | 0.90      |     6 | 986 | IE, MK         |
 * | `tsoGenerationForecast`| 0.90      |    10 | 957 | HR, IE, SI, SK |
 *
 * Most of those are true positives outside the incident window rather than
 * noise — AL's and HR's are 0.00, series that were not being written at all and
 * that the age rule already calls `ended` or `stale`, and IT's are the real
 * 2026-08-12/13 price gap. `applyCoverage` only ever downgrades a `live`
 * stream, so none of them changes a verdict.
 *
 * ## The two thresholds, from the same measurement
 *
 * **0.75 for measured streams.** The worst *healthy* two-day window in the
 * fleet outside MK was IE at 0.81 (2026-08-26/27 — IE runs 30-minute and
 * chronically drops a handful of half-hours), then EE 0.85 and LV 0.88. On the
 * incident, 16 of 34 countries land in 0.50-0.74. So 0.75 sits in a real gap
 * with IE's ordinary raggedness above it and the whole degradation below.
 * Anything from 0.82 up starts accusing IE on its good days; anything below
 * ~0.63 starts letting the incident through.
 *
 * **0.90 for day-ahead streams.** Every complete day of `price`,
 * `tsoLoadForecast` and `tsoGenerationForecast` for every country over
 * 2026-08-16..29 scored exactly 1.00 — a whole document or nothing. 0.90 has an
 * order of magnitude more margin than it needs; the observed failures are
 * 0.50-0.56 (one of the two market days missing outright), never 0.85.
 *
 * ## What this costs the small Balkan zones, measured rather than assumed
 *
 * CLAUDE.md records MK, ME and AL as chronically late and holey, so the obvious
 * worry is a badge that is amber every day for them — the objection
 * `freshnessPill.ts` already sustains against putting an uncalibrated alarm on
 * screen. Measured over the 44 two-day windows ending 2026-07-17..08-29, before
 * the incident:
 *
 * | country / stream | windows | below 0.75 | median | min  |
 * |------------------|--------:|-----------:|-------:|-----:|
 * | MK `load`        |      44 |          3 |   1.00 | 0.50 |
 * | MK `generation`  |      20 |          2 |   1.00 | 0.50 |
 * | ME `load`        |      44 |          0 |   1.00 | 1.00 |
 * | AL `load`        |      44 |          0 |   1.00 | 1.00 |
 * | AL `generation`  |      22 |          1 |   1.00 | 0.50 |
 *
 * So the amber is occasional, not permanent: MK's median two-day window is
 * complete, and the days it drops to 0.50 are days it really did lose a third
 * of its hours. It is late far more often than it is holey, and lateness is the
 * age rule's business — MK `load` is already `stale` on age for about nine hours
 * of every day, its newest row stopping at 21:00 UTC and crossing the 18h
 * threshold at 15:00.
 */
export const COVERAGE_MIN_RATIO: Readonly<Record<CoverageStreamKey, number>> = {
  load: 0.75,
  generation: 0.75,
  price: 0.9,
  tsoLoadForecast: 0.9,
  tsoGenerationForecast: 0.9,
};

/**
 * How far a stream's best observed day may sit from a legal resolution before
 * we admit we cannot tell what "complete" means for it.
 *
 * The low bound carries IE, whose best 30-minute day over 2026-08-20..29 was 46
 * of 48 (0.958) — it never publishes a whole one. The high bound absorbs a
 * handful of duplicate rows without moving the verdict: the two-separator
 * duplicates ABL-211 is still closing out (CH 1,783, PL 69) inflate a count by a
 * few, not by a factor. Beyond these bounds the answer is `null`, never a
 * guessed resolution — a wrong `expected` would publish a wrong ratio, which is
 * the failure mode this repo treats as an incident.
 */
const RESOLUTION_TOLERANCE = { min: 0.75, max: 1.15 } as const;

/**
 * What a complete UTC day of this stream holds, as the country's own data
 * demonstrates it.
 *
 * Derived from the **maximum** daily count rather than the mode or the median,
 * and that choice is what survives a long outage: one healthy day anywhere in
 * the baseline pins the resolution, where a mode drifts to the damaged value as
 * soon as the damage outnumbers the health. The cost of a maximum — that a
 * duplicate-inflated day would raise the bar — is bounded by snapping to a legal
 * resolution and by `RESOLUTION_TOLERANCE`.
 *
 * Returns `null` when the best day observed is not recognisably one of the
 * three ENTSO-E resolutions. A stream that has never had a plausible day in the
 * baseline is one we cannot score, and saying so is the honest answer; guessing
 * would put a fabricated denominator under a published ratio.
 */
export function resolveExpectedDailyRows(counts: readonly DailyRowCount[]): number | null {
  let best = 0;
  for (const { rows } of counts) {
    if (Number.isFinite(rows) && rows > best) best = rows;
  }
  if (best <= 0) return null;

  // Nearest legal resolution; ties break to the larger, which is the reading
  // that flags rather than the one that reassures.
  let candidate: number = NATIVE_DAILY_ROWS[0];
  for (const slots of NATIVE_DAILY_ROWS) {
    if (Math.abs(best - slots) <= Math.abs(best - candidate)) candidate = slots;
  }

  const fit = best / candidate;
  return fit >= RESOLUTION_TOLERANCE.min && fit <= RESOLUTION_TOLERANCE.max ? candidate : null;
}

/** `YYYY-MM-DD` shifted by whole UTC days. */
function shiftDay(day: string, byDays: number): string {
  const at = Date.parse(`${day}T00:00:00Z`);
  return new Date(at + byDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The days the verdict is taken over: the `COVERAGE_WINDOW_DAYS` UTC days
 * ending **the day before** the newest day the stream has any row in.
 *
 * Skipping the newest day is what keeps this from accusing a healthy pipeline
 * of the hole it is still filling. The newest day is partial by construction —
 * for a measured stream because the hours have not happened yet, for a
 * day-ahead one because the market day runs 22:00-22:00 UTC (21:00 for the EET
 * zones, 23:00 for WET), so its last UTC day always holds a fraction. Measured
 * on prod: every day-ahead stream's terminal UTC day scores 0.88-0.96 in
 * perfect health, purely from that boundary.
 *
 * The cost is stated plainly: a hole opening today is not caught until today
 * has a successor. On the incident's shape — days at 0.43, 0.84, 0.55 — that is
 * one day of delay against four days of blindness.
 *
 * Anchored on the data, not on `now`, so nothing here depends on when it runs.
 */
export function coverageWindowDays(counts: readonly DailyRowCount[]): string[] | null {
  let newest: string | null = null;
  for (const { day, rows } of counts) {
    if (rows > 0 && (newest === null || day > newest)) newest = day;
  }
  if (newest === null) return null;

  const end = shiftDay(newest, -1);
  const days: string[] = [];
  for (let i = COVERAGE_WINDOW_DAYS - 1; i >= 0; i -= 1) days.push(shiftDay(end, -i));
  return days;
}

/**
 * The coverage measurement, or `null` when the data cannot support one.
 *
 * `null` — not `0`, and not an invented denominator — for a stream with no
 * rows, or one whose baseline never showed a legal resolution. `observed: 0`
 * with a real `expected` beside it is a different statement and is published as
 * such: it means we know what a complete window looks like and hold none of it.
 */
export function computeCoverage(counts: readonly DailyRowCount[]): FreshnessCoverage | null {
  const days = coverageWindowDays(counts);
  const expectedDailyRows = resolveExpectedDailyRows(counts);
  if (!days || expectedDailyRows === null) return null;

  const expected = expectedDailyRows * COVERAGE_WINDOW_DAYS;
  // Unreachable while NATIVE_DAILY_ROWS and COVERAGE_WINDOW_DAYS are positive,
  // and asserted anyway: a zero denominator here would publish `Infinity` or
  // `NaN` as a ratio, which is the confidently-wrong number in its purest form.
  if (expected <= 0) return null;

  const byDay = new Map(counts.map(({ day, rows }) => [day, rows]));
  const observed = days.reduce((sum, day) => sum + (byDay.get(day) ?? 0), 0);

  return {
    windowStart: days[0]!,
    windowEnd: days[days.length - 1]!,
    expectedDailyRows,
    observed,
    expected,
    ratio: Math.round((observed / expected) * 10_000) / 10_000,
  };
}

/**
 * Attach the measurement, and degrade the verdict when it earns it.
 *
 * **Only `live` is ever downgraded.** `stale` is already the alarm, and `ended`
 * and `none` are the two verdicts `freshness.ts` is explicit are not ingest
 * alarms at all — a series upstream stopped publishing years ago has no
 * coverage to lose, and overwriting its terminal verdict with a fresh accusation
 * would re-create the noise ABL-60 sized `ENDED_AFTER_HOURS` to avoid. Measured
 * consequence: AL `generation` and HR `tsoGenerationForecast` both score 0.00
 * over the baseline sweep and both keep their existing verdict here.
 *
 * The measurement is published either way. A stream can read `live` with a
 * coverage of 0.80 beside it, and that is the intended shape — the number is
 * the evidence, the status is the judgement, and ABL-632 happened because the
 * evidence was not on the wire at all.
 */
export function applyCoverage(
  stream: FreshnessStream,
  counts: readonly DailyRowCount[],
  key: CoverageStreamKey,
): FreshnessStream {
  const coverage = computeCoverage(counts);
  if (!coverage) return { ...stream, coverage: null };

  const degraded = stream.status === 'live' && coverage.ratio < COVERAGE_MIN_RATIO[key];
  return { ...stream, coverage, status: degraded ? 'stale' : stream.status };
}
