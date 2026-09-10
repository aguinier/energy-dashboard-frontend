import { formatDistanceStrict } from 'date-fns';
import type { DataFreshness, FreshnessStream } from '@/types';

/**
 * What the header's ENTSO-E pill should say, and which mark it should wear.
 *
 * ABL-60. The pill used to be a green pulsing dot and a duration, unconditionally.
 * That is an assertion of liveness, and it was false twice over: through the
 * 2026-08-06 ENTSO-E outage it pulsed green over a dashboard drawing yesterday's
 * numbers, and it pulses green today beside GB, whose load stops in June 2021.
 *
 * Pure so the wording can be pinned without a clock or a DOM — this is the
 * whole user-facing surface of the staleness signal, so it is worth asserting
 * exactly rather than eyeballing.
 */

export type FreshnessTone = 'live' | 'stale' | 'ended' | 'none';

export interface FreshnessPill {
  tone: FreshnessTone;
  /** Abbreviated, for the header itself. */
  label: string;
  /** Full sentence, for `title` and screen readers. */
  title: string;
}

/** The animation is a liveness claim; no other verdict earns it. */
export function freshnessPulses(tone: FreshnessTone): boolean {
  return tone === 'live';
}

/**
 * Which streams decide the tone.
 *
 * These three back the primary series on every country tab, so a defect in one
 * of them is a defect in what the user is looking at. The two TSO forecast
 * streams are deliberately excluded: they back an *optional overlay* the user
 * opts into through `ModelPicker`, and their absence already shows as a missing
 * dashed line. Including them would also put an uncalibrated alarm on screen —
 * measured against prod 2026-08-07, BG's `tsoLoadForecast` reached only
 * `2026-08-07 20:00`, so under the day-ahead coverage rule BG would go amber
 * every afternoon whether or not BG's TSO publishes a D+1 forecast at all. A
 * badge that is amber every day is a badge nobody reads.
 */
const TONE_STREAMS = ['load', 'generation', 'price'] as const;

export function describeFreshness(
  freshness: DataFreshness | undefined,
  now: Date = new Date(),
): FreshnessPill {
  if (!freshness) {
    // In flight. Neutral, not green: a pulse before the answer arrives is the
    // same unearned claim in miniature.
    return {
      tone: 'none',
      label: 'ENTSO-E',
      title: 'Checking how current the ENTSO-E data is',
    };
  }

  const streams = TONE_STREAMS.map((key) => ({ key, stream: freshness[key] }));
  const stale = streams.filter(({ stream }) => stream.status === 'stale');
  const ended = streams.filter(({ stream }) => stream.status === 'ended');
  const anyLive = streams.some(({ stream }) => stream.status === 'live');

  // "Nothing held" must not outrank "something is broken", and it must not
  // suppress a stream that is fine either.
  const tone: FreshnessTone =
    stale.length > 0 ? 'stale' : ended.length > 0 ? 'ended' : anyLive ? 'live' : 'none';

  const measuredAge = freshestMeasuredAge(freshness);
  const age = measuredAge === null ? null : humanise(measuredAge, now);

  if (tone === 'none') {
    return {
      tone,
      label: 'ENTSO-E · no data',
      title: 'No ENTSO-E data is held for this country',
    };
  }

  if (tone === 'live') {
    return {
      tone,
      label: age ? `ENTSO-E · ${age} ago` : 'ENTSO-E',
      title: age
        ? `Live data from ENTSO-E — last measured value synced ${age} ago`
        : 'Live data from ENTSO-E',
    };
  }

  if (tone === 'ended') {
    return {
      tone,
      label: 'ENTSO-E · series ended',
      title: `${ended.map(({ key }) => `${key} stopped publishing upstream`).join('; ')}. This is not an ingest alarm.`,
    };
  }

  // Stale. The word carries the state, not the colour: green-vs-amber is the
  // one distinction a colour blind viewer may not get, and this repo has
  // already moved its map scale off a red/green ramp for that reason.
  const measuredStale = stale.some(({ key }) => key === 'load' || key === 'generation');

  // ABL-632. A stream can now be stale because its recent window is full of
  // holes rather than because it stopped, and in that case its newest row is
  // minutes old — so "stale, 1 hour ago" would be a contradiction printed in
  // the header. The age is only the explanation when nothing is missing.
  const gapped = stale.some(({ stream }) => hasGap(stream));

  return {
    tone,
    label: gapped
      ? 'ENTSO-E · gaps in recent data'
      : measuredStale && age
        ? `ENTSO-E · stale, ${age} ago`
        : measuredStale
          ? 'ENTSO-E · stale'
          : 'ENTSO-E · tomorrow missing',
    title: `${[
      ...stale.map(({ key, stream }) => explain(key, stream, now)),
      ...ended.map(({ key }) => `${key} stopped publishing upstream`),
    ].join('; ')}. Charts may be missing recent data.`,
  };
}

/**
 * The age the pill prints: the newest of the two MEASURED streams.
 *
 * Price and the TSO forecasts are excluded because their timestamps sit up to a
 * day in the future by design, so "max of all stamps" produced nonsense like
 * "synced 23 hours ago" while holding tomorrow's prices — and clamping a future
 * stamp to now would mask a genuinely dead pipeline instead.
 */
function freshestMeasuredAge(freshness: DataFreshness): number | null {
  const ages = [freshness.load, freshness.generation]
    .map((s) => s.ageHours)
    .filter((h): h is number => h !== null);

  return ages.length > 0 ? Math.min(...ages) : null;
}

/** `ageHours` back into words, without consulting the clock a second time. */
function humanise(ageHours: number, now: Date): string {
  return formatDistanceStrict(new Date(now.getTime() - ageHours * 3_600_000), now);
}

/**
 * Is this stream short of rows over the window the server scored? ABL-632.
 *
 * Reads the published integers rather than re-deriving a threshold — the
 * verdict is the server's (`services/freshnessCoverage.ts`), and a second copy
 * of the cutoff over here is how two surfaces end up disagreeing about the same
 * stream. `coverage` is absent on an older server and `null` when the data
 * could not support a measurement; neither is a gap.
 */
function hasGap(stream: FreshnessStream): boolean {
  const coverage = stream.coverage;
  return !!coverage && coverage.observed < coverage.expected;
}

function explain(key: string, stream: FreshnessStream, now: Date): string {
  // A gap is stated first and in its own words. "load has not updated for 40
  // minutes" is true and useless next to an amber badge; "load is missing 26 of
  // its last 48 readings" is what the badge is actually about.
  const coverage = stream.coverage;
  if (coverage && hasGap(stream)) {
    return `${key} is missing ${coverage.expected - coverage.observed} of its last ${coverage.expected} readings (${coverage.windowStart} to ${coverage.windowEnd})`;
  }
  if (key === 'price') {
    return 'the day-ahead price does not cover tomorrow';
  }
  const age = stream.ageHours === null ? null : humanise(stream.ageHours, now);
  return age ? `${key} has not updated for ${age}` : `${key} has not updated`;
}
