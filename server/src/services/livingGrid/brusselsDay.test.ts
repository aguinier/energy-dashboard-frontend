import { describe, it, expect } from 'vitest';
import {
  brusselsDayWindow,
  currentHourInGridTimezone,
  isValidDate,
  todayInGridTimezone,
  GRID_TIMEZONE,
} from './brusselsDay.js';

/**
 * The Living Grid day is a Europe/Brussels calendar day, and the two DST days
 * are the reason this module exists rather than being four lines of `Date.UTC`.
 * Both are pinned here with their real 2026 transition dates.
 */
describe('brusselsDayWindow — an ordinary day', () => {
  it('maps a CEST day to 24 hours starting at 22:00 UTC the day before', () => {
    const w = brusselsDayWindow('2026-07-01');

    expect(w.date).toBe('2026-07-01');
    expect(w.timezone).toBe(GRID_TIMEZONE);
    expect(w.hoursUtc).toHaveLength(24);
    expect(w.hoursUtc[0]).toBe('2026-06-30T22:00:00Z');
    expect(w.hoursUtc[23]).toBe('2026-07-01T21:00:00Z');
    expect(w.hoursUtc.every((h) => h !== null)).toBe(true);
  });

  it('maps a CET day to 24 hours starting at 23:00 UTC the day before', () => {
    const w = brusselsDayWindow('2026-01-15');

    expect(w.hoursUtc[0]).toBe('2026-01-14T23:00:00Z');
    expect(w.hoursUtc[23]).toBe('2026-01-15T22:00:00Z');
  });

  it('bounds the window to the END of the last hour, not its start', () => {
    // Load, price and generation publish every 15 minutes. Bounding at the
    // last hour's :00 would average that hour over one reading instead of
    // four — a silent quarter-hour truncation at the edge of every day.
    const w = brusselsDayWindow('2026-07-01');

    expect(w.startUtc).toBe('2026-06-30T22:00:00Z');
    expect(w.endUtc).toBe('2026-07-01T21:59:59Z');
  });

  it('emits hour keys in the UTC form the SQL groups by', () => {
    const w = brusselsDayWindow('2026-07-01');

    expect(w.hourKeys[0]).toBe('2026-06-30 22');
    expect(w.hourKeys[2]).toBe('2026-07-01 00');
    expect(w.hourKeys[23]).toBe('2026-07-01 21');
  });
});

describe('brusselsDayWindow — the day that is 23 hours long', () => {
  it('leaves local 02:00 null on spring-forward and keeps 24 slots', () => {
    // 2026-03-29: the clock jumps 02:00 -> 03:00. Local 02:00 does not exist.
    const w = brusselsDayWindow('2026-03-29');

    expect(w.hoursUtc).toHaveLength(24);
    expect(w.hoursUtc[2]).toBeNull();
    expect(w.hourKeys[2]).toBeNull();
    expect(w.hoursUtc.filter((h) => h === null)).toHaveLength(1);
  });

  it('keeps every other hour resolvable and monotonic across the gap', () => {
    const w = brusselsDayWindow('2026-03-29');

    expect(w.hoursUtc[1]).toBe('2026-03-29T00:00:00Z');
    // 03:00 local is 01:00 UTC — the offset changed, so the UTC instant does
    // NOT advance two hours across the hole.
    expect(w.hoursUtc[3]).toBe('2026-03-29T01:00:00Z');
  });
});

describe('brusselsDayWindow — the day that is 25 hours long', () => {
  it('keeps the FIRST occurrence of the repeated hour', () => {
    // 2026-10-25: the clock falls back 03:00 -> 02:00, so local 02:00 happens
    // twice — once at 00:00 UTC (CEST) and again at 01:00 UTC (CET). Taking
    // the earlier one keeps the hour index a function; renumbering the day
    // would desynchronise this zone's hour 2 from every other zone's.
    const w = brusselsDayWindow('2026-10-25');

    expect(w.hoursUtc).toHaveLength(24);
    expect(w.hoursUtc[2]).toBe('2026-10-25T00:00:00Z');
    expect(w.hoursUtc.every((h) => h !== null)).toBe(true);
  });

  it('spans 25 real hours between the first and last slot', () => {
    const w = brusselsDayWindow('2026-10-25');
    const first = Date.parse(w.hoursUtc[0]!);
    const last = Date.parse(w.hoursUtc[23]!);

    // 23 slots apart on the clock, 24 hours apart in real time: the repeated
    // hour is inside the span even though it has no slot of its own.
    expect((last - first) / 3_600_000).toBe(24);
  });
});

describe('isValidDate', () => {
  it('accepts a real calendar date', () => {
    expect(isValidDate('2026-09-17')).toBe(true);
    expect(isValidDate('2024-02-29')).toBe(true);
  });

  it('rejects a malformed or impossible one', () => {
    for (const bad of ['', '2026-9-17', '17-09-2026', '2026-02-31', '2026-13-01', 'today', '2026-09-17T00:00']) {
      expect(isValidDate(bad)).toBe(false);
    }
  });

  it('makes brusselsDayWindow throw RangeError on a bad date', () => {
    expect(() => brusselsDayWindow('2026-02-31')).toThrow(RangeError);
    expect(() => brusselsDayWindow('nonsense')).toThrow(RangeError);
  });
});

describe('the current instant in Brussels', () => {
  it('reads the date and hour from a fixed instant', () => {
    // 2026-07-01T21:30:00Z is 23:30 CEST — still the 1st locally.
    const instant = new Date('2026-07-01T21:30:00Z');

    expect(todayInGridTimezone(instant)).toBe('2026-07-01');
    expect(currentHourInGridTimezone(instant)).toBe(23);
  });

  it('rolls the local date over before UTC midnight', () => {
    // 22:30 UTC is already 00:30 on the 2nd in Brussels. A UTC-keyed "today"
    // would serve the wrong day for the last two hours of every summer evening.
    const instant = new Date('2026-07-01T22:30:00Z');

    expect(todayInGridTimezone(instant)).toBe('2026-07-02');
    expect(currentHourInGridTimezone(instant)).toBe(0);
  });
});
