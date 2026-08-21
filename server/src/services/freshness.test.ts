import { describe, it, expect } from 'vitest';
import {
  parseStoredTimestamp,
  brusselsDayStartUtc,
  classifyMeasuredStream,
  classifyDayAheadStream,
  MEASURED_STALE_AFTER_HOURS,
  ENDED_AFTER_HOURS,
  DAY_AHEAD_REQUIRED_AFTER_UTC_HOUR,
} from './freshness.js';

/**
 * ABL-60. The defect these pin is a claim, not a number: during the 2026-08-06
 * ENTSO-E outage the dashboard drew yesterday's data under a green "live" pulse
 * and said nothing. Every case below is drawn from a measurement against prod
 * or the replica, cited inline, so the thresholds can be re-checked rather than
 * taken on faith.
 */

describe('parseStoredTimestamp — one column, three spellings', () => {
  it('reads both separator forms as the same UTC instant', () => {
    // The same column holds both (CLAUDE.md, "Timestamp storage: two separators
    // in one column"). `new Date` alone parses the space form as LOCAL time, so
    // on any box that is not UTC these two would disagree by the box's offset —
    // silently, and by a whole-hours amount that looks like a plausible lag.
    const withT = parseStoredTimestamp('2026-08-07T05:45:00');
    const withSpace = parseStoredTimestamp('2026-08-07 05:45:00');

    expect(withT?.toISOString()).toBe('2026-08-07T05:45:00.000Z');
    expect(withSpace?.toISOString()).toBe('2026-08-07T05:45:00.000Z');
  });

  it('leaves an explicit offset alone instead of re-stamping it as UTC', () => {
    // 26,405 rows carry a trailing offset, all inside 2025-11-13..28. They
    // already say what they mean; appending `Z` would move them two hours.
    expect(parseStoredTimestamp('2025-11-28T00:00:00+02:00')?.toISOString()).toBe(
      '2025-11-27T22:00:00.000Z',
    );
  });

  it('returns null rather than an Invalid Date', () => {
    // An Invalid Date propagates as NaN hours, and NaN compares false against
    // every threshold — so a garbage row would render as `live`.
    expect(parseStoredTimestamp(null)).toBeNull();
    expect(parseStoredTimestamp('')).toBeNull();
    expect(parseStoredTimestamp('not a timestamp')).toBeNull();
  });
});

describe('brusselsDayStartUtc — calendar days, not 24-hour steps', () => {
  it('finds midnight Brussels on an ordinary summer day', () => {
    const now = new Date('2026-08-07T07:10:00Z');
    expect(brusselsDayStartUtc(now, 0).toISOString()).toBe('2026-08-06T22:00:00.000Z');
    expect(brusselsDayStartUtc(now, 1).toISOString()).toBe('2026-08-07T22:00:00.000Z');
  });

  it('crosses the spring-forward boundary, where the day is 23 hours long', () => {
    // `now` is already CEST (+2); the midnight that starts its day was CET (+1).
    // A single offset read would land an hour out.
    const now = new Date('2026-03-29T12:00:00Z');
    expect(brusselsDayStartUtc(now, 0).toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(brusselsDayStartUtc(now, 1).toISOString()).toBe('2026-03-29T22:00:00.000Z');

    const springDay =
      brusselsDayStartUtc(now, 1).getTime() - brusselsDayStartUtc(now, 0).getTime();
    expect(springDay / 3_600_000).toBe(23);
  });

  it('crosses the clocks-back boundary, where the day is 25 hours long', () => {
    const now = new Date('2026-10-25T12:00:00Z');
    expect(brusselsDayStartUtc(now, 0).toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(brusselsDayStartUtc(now, 1).toISOString()).toBe('2026-10-25T23:00:00.000Z');

    const autumnDay =
      brusselsDayStartUtc(now, 1).getTime() - brusselsDayStartUtc(now, 0).getTime();
    expect(autumnDay / 3_600_000).toBe(25);
  });

  it('handles winter, when Brussels is UTC+1', () => {
    const now = new Date('2026-01-15T09:00:00Z');
    expect(brusselsDayStartUtc(now, 0).toISOString()).toBe('2026-01-14T23:00:00.000Z');
  });
});

describe('classifyMeasuredStream — age is the whole question', () => {
  const now = new Date('2026-08-07T07:10:00Z');

  it('calls the healthy fleet live, including the chronically late publishers', () => {
    // Measured against prod 2026-08-07 07:10 UTC, minutes after a healthy 06:30
    // pass. FR is typical; BG and AL are the slow tail, and both are complete —
    // marking them stale would be a false alarm every single day.
    expect(classifyMeasuredStream('2026-08-07 05:45:00', now).status).toBe('live'); // FR, 1.43h
    expect(classifyMeasuredStream('2026-08-07 01:00:00', now).status).toBe('live'); // BG, 6.18h
    expect(classifyMeasuredStream('2026-08-06 21:45:00', now).status).toBe('live'); // AL, 9.43h
  });

  it('calls a genuinely stalled country stale', () => {
    // MK, 34.18h behind on the same measurement — its newest real row predates
    // the last two days of passes entirely.
    const mk = classifyMeasuredStream('2026-08-05 21:00:00', now);
    expect(mk.status).toBe('stale');
    expect(mk.ageHours).toBeCloseTo(34.17, 1);
  });

  it('separates an active stall from a series that ended upstream', () => {
    const measuredAt = new Date('2026-08-10T12:04:00Z');

    // Production measurement: MK generation was the worst active stall at
    // 111h; AL generation was the youngest permanently ended series at 1,143h.
    expect(classifyMeasuredStream('2026-08-05 21:00:00', measuredAt).status).toBe('stale');
    expect(classifyMeasuredStream('2026-06-23 21:00:00', measuredAt).status).toBe('ended');
    expect(classifyMeasuredStream('2021-06-14T09:00:00', measuredAt).status).toBe('ended');
    expect(classifyMeasuredStream('2022-02-25T13:00:00', measuredAt).status).toBe('ended');
  });

  it('self-clears the ended verdict as soon as a newer row lands', () => {
    const endedAt = new Date(now.getTime() - (ENDED_AFTER_HOURS + 1) * 3_600_000);
    const liveAt = new Date(now.getTime() - 1 * 3_600_000);

    expect(classifyMeasuredStream(endedAt.toISOString(), now).status).toBe('ended');
    expect(classifyMeasuredStream(liveAt.toISOString(), now).status).toBe('live');
  });

  it('distinguishes "we hold nothing" from "what we hold is old"', () => {
    // A country with no rows gets no health verdict at all. Reporting `stale`
    // would assert an outage where there was never a series.
    expect(classifyMeasuredStream(null, now)).toEqual({
      latest: null,
      ageHours: null,
      status: 'none',
    });
  });

  it('flips exactly at the threshold, not before', () => {
    const at = (hours: number) =>
      new Date(now.getTime() - hours * 3_600_000).toISOString().slice(0, 19);

    expect(classifyMeasuredStream(at(MEASURED_STALE_AFTER_HOURS - 0.01), now).status).toBe('live');
    expect(classifyMeasuredStream(at(MEASURED_STALE_AFTER_HOURS + 0.01), now).status).toBe('stale');
  });

  it('leaves a wide gap between the slowest healthy country and the threshold', () => {
    // Not a tuned edge: on the 2026-08-07 measurement every healthy country was
    // under 9.5h and the next value up was MK at 34.2h, so any threshold in
    // that band selects the same set. If someone narrows this constant to
    // "tighten" detection, this is the case that should stop them.
    expect(MEASURED_STALE_AFTER_HOURS).toBeGreaterThan(9.5);
    expect(MEASURED_STALE_AFTER_HOURS).toBeLessThan(34);
  });

  it('sizes ended beyond active stalls and below the youngest ended series', () => {
    expect(ENDED_AFTER_HOURS).toBeGreaterThan(6 * 111.1);
    expect(ENDED_AFTER_HOURS).toBeLessThan(1143.1);
  });
});

describe('classifyDayAheadStream — coverage, not age', () => {
  it('does not demand tomorrow before the ingest could possibly hold it', () => {
    // 07:10 UTC: the auction has not published, let alone been fetched.
    // Requiring tomorrow here would light the pill up every morning — a false
    // alarm that teaches people to ignore the real one.
    const morning = new Date('2026-08-07T07:10:00Z');
    expect(classifyDayAheadStream('2026-08-07 21:45:00', morning, 'price').status).toBe('live');
  });

  it('catches ABL-51: the afternoon comes and tomorrow is still missing', () => {
    // 16:00 UTC (18:00 CEST) is when the board member looked. `energy_price`
    // reached only to the end of today's market day, and the dashboard said
    // nothing at all.
    const evening = new Date('2026-08-07T16:00:00Z');
    expect(classifyDayAheadStream('2026-08-07 21:45:00', evening, 'price').status).toBe('stale');
  });

  it('is satisfied once tomorrow has arrived', () => {
    const evening = new Date('2026-08-07T16:00:00Z');
    expect(classifyDayAheadStream('2026-08-08 21:45:00', evening, 'price').status).toBe('live');
  });

  it('never marks a healthy non-Brussels bidding zone stale', () => {
    // The reason the bound is the day's START. BG is UTC+3: a complete tomorrow
    // for BG ends 2026-08-08 20:45 UTC, two hours before Brussels' does. Testing
    // the day's end in Brussels terms would call a complete BG stale; testing
    // its start cannot, because any full market day is ~24h long and the spread
    // between European market timezones is at most 3h.
    const evening = new Date('2026-08-07T16:00:00Z');
    expect(classifyDayAheadStream('2026-08-08 20:45:00', evening, 'price').status).toBe('live'); // BG (EET)
    expect(classifyDayAheadStream('2026-08-08 22:45:00', evening, 'price').status).toBe('live'); // PT (WET)
  });

  it('still catches a stream that has fallen behind even before the cutoff', () => {
    // Before the cutoff we require today, and this one does not even reach that.
    const morning = new Date('2026-08-07T07:10:00Z');
    expect(classifyDayAheadStream('2026-08-05 21:45:00', morning, 'price').status).toBe('stale');
  });

  it('calls a long-ended day-ahead series ended rather than permanently stale', () => {
    const now = new Date('2026-08-10T12:04:00Z');

    // GB and UA generation forecasts ended with their other upstream series.
    expect(classifyDayAheadStream('2021-06-14 23:30:00', now, 'price').status).toBe('ended');
    expect(classifyDayAheadStream('2022-02-25 21:00:00', now, 'price').status).toBe('ended');
  });

  it('switches its requirement exactly at the cutoff hour, for every stream', () => {
    const onlyToday = '2026-08-07 21:45:00';

    for (const stream of ['price', 'tsoLoadForecast', 'tsoGenerationForecast'] as const) {
      const cutoff = DAY_AHEAD_REQUIRED_AFTER_UTC_HOUR[stream];
      const justBefore = new Date(`2026-08-07T${String(cutoff - 1).padStart(2, '0')}:59:00Z`);
      const justAfter = new Date(`2026-08-07T${String(cutoff).padStart(2, '0')}:00:00Z`);

      expect(classifyDayAheadStream(onlyToday, justBefore, stream).status).toBe('live');
      expect(classifyDayAheadStream(onlyToday, justAfter, stream).status).toBe('stale');
    }
  });

  it('reports a negative age for a future-dated row without calling it a defect', () => {
    // Age is reported for completeness and is meaningless here; the status must
    // not be derived from it. A day-ahead price is legitimately ~14h "in front"
    // of now, which under the measured rule would read as impossibly fresh.
    const morning = new Date('2026-08-07T07:10:00Z');
    const stream = classifyDayAheadStream('2026-08-07 21:45:00', morning, 'price');
    expect(stream.ageHours).toBeLessThan(0);
    expect(stream.status).toBe('live');
  });

  it('distinguishes "we hold nothing" from "what we hold is behind"', () => {
    expect(classifyDayAheadStream(null, new Date('2026-08-07T16:00:00Z'), 'price')).toEqual({
      latest: null,
      ageHours: null,
      status: 'none',
    });
  });
});

/**
 * ABL-494. The deadline is a property of the ENTSO-E *document*, not of the
 * afternoon. One shared 14:00 UTC cutoff made every country's A69 generation
 * forecast read `stale` from 14:00 until the 18:30 pass landed — a structural
 * false alarm, fleet-wide, every single day. Measured 2026-08-20 by raw HTTP
 * probes against ENTSO-E: at 15:24 UTC the API returned Acknowledgement 999,
 * "No matching data found for GENERATION_FORECAST_WIND_SOLAR [14.1.D]", for DE
 * — upstream did not have tomorrow either, so the alarm was definitionally a
 * false positive.
 *
 * These cases pin both directions: the fix, and the ABL-51 protection it must
 * not spend.
 */
describe('classifyDayAheadStream — the deadline is per document class', () => {
  // A69 is due 18:00 Brussels D-1 (Reg. 543/2013 Art. 14.1) = 16:00 UTC under
  // CEST, and our next A69-capable pass after 13:30 is 18:30. 15:00 UTC sits in
  // the window where "we do not have tomorrow" carries no information at all.
  const midAfternoon = new Date('2026-08-20T15:00:00Z');
  const onlyToday = '2026-08-20 21:45:00';

  it('stops calling A69 stale in the window where nobody has published it yet', () => {
    expect(classifyDayAheadStream(onlyToday, midAfternoon, 'tsoGenerationForecast').status).toBe(
      'live',
    );
  });

  it('leaves the auction result judged at 14:00 as before', () => {
    // Same row, same instant, different document: the SDAC auction published
    // ~10:45 UTC and the 13:30 pass has been and gone, so a price that reaches
    // only today is genuinely our miss. This is the ABL-51 case and it must not
    // move.
    expect(classifyDayAheadStream(onlyToday, midAfternoon, 'price').status).toBe('stale');
  });

  it('leaves the A65 load forecast judged at 14:00 as before', () => {
    // Also measured 2026-08-20: DE/FR/ES/IT/PL all held tomorrow's A65 at both
    // 15:17 and 16:32 UTC while their A69 was absent. A65 clears 14:00, so
    // relaxing it would only cost detection.
    expect(classifyDayAheadStream(onlyToday, midAfternoon, 'tsoLoadForecast').status).toBe('stale');
  });

  it('still catches a genuinely missing A69 tomorrow once our own pass has landed', () => {
    // 20:30 UTC: the 18:30 pass is over even on the slowest day measured. Nothing
    // upstream and nothing in our schedule excuses a missing tomorrow now — this
    // is the ABL-51 protection, intact, six hours later in the day.
    const evening = new Date('2026-08-20T20:30:00Z');
    expect(classifyDayAheadStream(onlyToday, evening, 'tsoGenerationForecast').status).toBe(
      'stale',
    );
  });

  it('does not accuse the ingest while a slow 18:30 pass is still running', () => {
    // The reason the hour is 20 and not 19. Measured pass durations run 16m55s
    // to 55m10s (CEO, ABL-494), so 18:30 + worst case ends 19:25 — and because
    // countries are fetched in one alphabetical loop, a 19:00 cutoff would fire
    // on the tail of the alphabet on exactly the slow days. This case is what
    // stops someone tightening it back.
    const duringOverrun = new Date('2026-08-20T19:30:00Z');
    expect(classifyDayAheadStream(onlyToday, duringOverrun, 'tsoGenerationForecast').status).toBe(
      'live',
    );
  });

  it('keeps catching an A69 stream that does not even reach today', () => {
    // Inside the relaxed window the weaker requirement still bites, so a dead
    // stream is never excused by the time of day.
    expect(
      classifyDayAheadStream('2026-08-18 21:45:00', midAfternoon, 'tsoGenerationForecast').status,
    ).toBe('stale');
  });

  it('pins the A44/A65 deadline at 14, where its own derivation put it', () => {
    expect(DAY_AHEAD_REQUIRED_AFTER_UTC_HOUR.price).toBe(14);
    expect(DAY_AHEAD_REQUIRED_AFTER_UTC_HOUR.tsoLoadForecast).toBe(14);
  });

  it('sizes the A69 deadline past the slowest measured 18:30 pass, CET included', () => {
    // Art. 14.1 is 16:00 UTC under CEST and 17:00 UTC under CET, so upstream
    // availability alone would allow 18. Our own ingest is the binding
    // constraint: the 18:30 pass has been measured from 16m55s to 55m10s, ending
    // as late as 19:25, so the first hour that cannot fire mid-pass is 20.
    const worstPassEndsAtUtcHour = 18.5 + (55 + 10 / 60) / 60; // 19.42
    expect(DAY_AHEAD_REQUIRED_AFTER_UTC_HOUR.tsoGenerationForecast).toBeGreaterThan(
      worstPassEndsAtUtcHour,
    );
    // And inside the same UTC day, so the overnight 00:30/06:30 passes still
    // leave a real miss visible for hours rather than minutes.
    expect(DAY_AHEAD_REQUIRED_AFTER_UTC_HOUR.tsoGenerationForecast).toBeLessThan(24);
  });
});
