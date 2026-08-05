import { describe, it, expect, afterEach, vi } from 'vitest';
import { getDateRangeForPreset, getGranularityForPreset } from './useDashboardData';
import { PRESET_SHIFT_HOURS } from '@/lib/constants';
import type { TimeAnchor, Granularity, TimePreset } from '@/types';

// `getDateRangeForPreset` and `getGranularityForPreset` switch on `TimePreset`
// and end in a `default` branch — a trailing 7-day hourly window. `TimePreset`
// is not a `Record` key in either, so before the `never` assertions a preset
// added to the union without a case here compiled clean and silently rendered
// numbers computed over a trailing 7 days beneath that preset's own label
// (`WINDOW_LABEL` would still have named it, being an exhaustive `Record`).
// That is the confidently-wrong-number failure, not a missing chart.
//
// The `never` assertions make that a compile error. These tests are the
// runtime half: every preset must produce a window whose direction and length
// match its name, so a case that regresses into the `default` branch fails
// here even if the union itself never changed.

const HOUR = 60 * 60 * 1000;

interface Expectation {
  anchor: TimeAnchor;
  /** Window length in hours. Day-anchored presets span a calendar day, so allow the 1ms shortfall. */
  hours: number;
  granularity: Granularity;
}

const EXPECTED: Record<TimePreset, Expectation> = {
  '24h': { anchor: 'past', hours: 24, granularity: 'hourly' },
  '7d': { anchor: 'past', hours: 168, granularity: 'hourly' },
  '30d': { anchor: 'past', hours: 720, granularity: 'daily' },
  today: { anchor: 'now', hours: 24, granularity: 'hourly' },
  thisWeek: { anchor: 'now', hours: 168, granularity: 'hourly' },
  next1d: { anchor: 'future', hours: 24, granularity: 'hourly' },
  next24h: { anchor: 'future', hours: 24, granularity: 'hourly' },
  next48h: { anchor: 'future', hours: 48, granularity: 'hourly' },
  next7d: { anchor: 'future', hours: 168, granularity: 'hourly' },
};

const ALL_PRESETS = Object.keys(EXPECTED) as TimePreset[];

afterEach(() => {
  vi.useRealTimers();
});

/** 2026-08-05 13:30 Brussels (CEST, UTC+2). */
function freezeSummer() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2026, 7, 5, 11, 30, 0)));
}

/** 2026-01-14 13:30 Brussels (CET, UTC+1). */
function freezeWinter() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2026, 0, 14, 12, 30, 0)));
}

describe('getDateRangeForPreset', () => {
  it.each(ALL_PRESETS)(
    'gives "%s" a window whose direction and length match its own label, not the default branch',
    (preset) => {
      freezeSummer();
      const now = new Date();
      const { start, end, anchor } = getDateRangeForPreset(preset, 0);
      const expected = EXPECTED[preset];

      expect(anchor).toBe(expected.anchor);
      // Within a second: 'today'/'next1d' end at 23:59:59.999, one ms short of
      // a full day.
      expect((end.getTime() - start.getTime()) / HOUR).toBeCloseTo(expected.hours, 2);

      // Direction relative to now. The default branch always ends at now, so a
      // forward-looking preset that fell through would fail here.
      if (expected.anchor === 'past') {
        expect(end.getTime()).toBeLessThanOrEqual(now.getTime());
      } else if (expected.anchor === 'future') {
        expect(end.getTime()).toBeGreaterThan(now.getTime());
      }
    },
  );

  // The reason ABL-12 does not treat these two as redundant with `24h`/`next24h`:
  // they are market-day aligned, so they line up with day-ahead delivery days
  // rather than with whenever the page happened to load.
  it('anchors "today" and "next1d" to Brussels midnight, unlike the rolling "24h"/"next24h"', () => {
    freezeSummer();
    const today = getDateRangeForPreset('today', 0);
    const next1d = getDateRangeForPreset('next1d', 0);

    // 00:00 CEST == 22:00 UTC the previous calendar day.
    expect(today.start.toISOString()).toBe('2026-08-04T22:00:00.000Z');
    expect(today.end.toISOString()).toBe('2026-08-05T21:59:59.999Z');
    expect(next1d.start.toISOString()).toBe('2026-08-05T22:00:00.000Z');
    expect(next1d.end.toISOString()).toBe('2026-08-06T21:59:59.999Z');

    // The rolling presets start at "now" instead, so they are not the same
    // window and their labels must not be treated as interchangeable.
    expect(getDateRangeForPreset('next24h', 0).start.toISOString()).not.toBe(next1d.start.toISOString());
  });

  it('tracks the CET/CEST offset rather than hardcoding one', () => {
    freezeWinter();
    // 00:00 CET == 23:00 UTC the previous calendar day — one hour later in UTC
    // than the summer case above.
    expect(getDateRangeForPreset('today', 0).start.toISOString()).toBe('2026-01-13T23:00:00.000Z');
    expect(getDateRangeForPreset('next1d', 0).start.toISOString()).toBe('2026-01-14T23:00:00.000Z');
  });
});

describe('getGranularityForPreset', () => {
  it.each(ALL_PRESETS)('gives "%s" its own granularity rather than inheriting the fallback', (preset) => {
    expect(getGranularityForPreset(preset)).toBe(EXPECTED[preset].granularity);
  });
});

// ============================================================================
// Shifted windows (ABL-12)
// ============================================================================
//
// `offsetHours` was dead until the navigation arrows shipped — nothing called
// `shiftTimeWindow`, so every window was computed at offset 0 and the offset
// path had never actually run. These cover it.
describe('getDateRangeForPreset with a shifted window', () => {
  it.each(ALL_PRESETS)('moves "%s" strictly earlier when stepped back', (preset) => {
    freezeSummer();
    const live = getDateRangeForPreset(preset, 0);
    const back = getDateRangeForPreset(preset, -PRESET_SHIFT_HOURS[preset]);

    // A step that lands on the same window is a click that redraws an
    // identical chart while the caption claims a different period. That is how
    // a half-window step behaved for the two day-aligned presets, which is why
    // the step is stated per preset rather than derived from the length.
    expect(back.start.getTime()).toBeLessThan(live.start.getTime());
    expect(back.end.getTime()).toBeLessThan(live.end.getTime());
  });

  it.each(ALL_PRESETS)('keeps "%s" the same length when shifted', (preset) => {
    freezeSummer();
    const live = getDateRangeForPreset(preset, 0);
    const back = getDateRangeForPreset(preset, -PRESET_SHIFT_HOURS[preset] * 2);
    const lengthOf = (r: { start: Date; end: Date }) => r.end.getTime() - r.start.getTime();

    // Brussels days are 23-25h across a DST boundary, so allow an hour there.
    expect(Math.abs(lengthOf(back) - lengthOf(live))).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('steps "today" back a whole Brussels market day, staying midnight-aligned', () => {
    freezeSummer(); // 2026-08-05 13:30 Brussels
    expect(getDateRangeForPreset('today', -24).start.toISOString()).toBe('2026-08-03T22:00:00.000Z');
    expect(getDateRangeForPreset('today', -24).end.toISOString()).toBe('2026-08-04T21:59:59.999Z');
    expect(getDateRangeForPreset('today', -48).start.toISOString()).toBe('2026-08-02T22:00:00.000Z');
  });

  it('steps "next1d" back a whole market day too', () => {
    freezeSummer();
    // Offset -24 turns "tomorrow" into "today", still midnight-aligned.
    expect(getDateRangeForPreset('next1d', -24).start.toISOString()).toBe('2026-08-04T22:00:00.000Z');
  });

  // The reason `today`/`next1d` shift by calendar days rather than by hours.
  // 25 Oct 2026 is the 25-hour Brussels day (DST ends 03:00 CEST -> 02:00 CET).
  // Standing at 23:00 CET that day, subtracting 24 hours of real time lands on
  // 25 Oct 00:00 CEST — the *same* market day. The old
  // `getTodayBrussels(now - 24h)` therefore returned an identical window for a
  // click that told the user it had moved to the previous day.
  it('crosses the 25-hour DST day instead of landing back on it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 25, 22, 0, 0))); // 25 Oct 23:00 CET

    const live = getDateRangeForPreset('today', 0);
    const back = getDateRangeForPreset('today', -24);

    expect(live.start.toISOString()).toBe('2026-10-24T22:00:00.000Z'); // 25 Oct 00:00 CEST
    // Must be 24 Oct, not 25 Oct again.
    expect(back.start.toISOString()).toBe('2026-10-23T22:00:00.000Z');
    expect(back.start.getTime()).toBeLessThan(live.start.getTime());
  });
});
