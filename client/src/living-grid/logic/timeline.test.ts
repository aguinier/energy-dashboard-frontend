import { describe, it, expect } from 'vitest';
import { hourAtPosition, isFutureHour, isLive, progressPercent, ticks } from './timeline';

describe('progressPercent', () => {
  it('spans the track from the first hour to the last', () => {
    expect(progressPercent(0)).toBe(0);
    expect(progressPercent(23)).toBe(100);
  });

  it('is monotonic in between', () => {
    expect(progressPercent(12)).toBeGreaterThan(progressPercent(11));
    expect(progressPercent(12)).toBeLessThan(progressPercent(13));
  });
});

describe('hourAtPosition', () => {
  it('maps the ends of the track to the ends of the day', () => {
    expect(hourAtPosition(0, 460)).toBe(0);
    expect(hourAtPosition(460, 460)).toBe(23);
  });

  it('maps the middle to the middle of the day', () => {
    expect(hourAtPosition(230, 460)).toBe(12);
  });

  it('clamps a click that lands outside the track', () => {
    expect(hourAtPosition(-40, 460)).toBe(0);
    expect(hourAtPosition(900, 460)).toBe(23);
  });

  it('survives a zero-width track rather than returning NaN', () => {
    // The footer measures its track from the DOM, and that measurement is 0
    // on the first paint before layout.
    expect(hourAtPosition(10, 0)).toBe(0);
  });
});

describe('ticks', () => {
  it('labels every four hours, closing the day at 24:00', () => {
    expect(ticks(12).map((t) => t.label)).toEqual([
      '00:00', '04:00', '08:00', '12:00', '16:00', '20:00', '24:00',
    ]);
  });

  it('highlights the tick nearest the selected hour', () => {
    const active = ticks(12).filter((t) => t.active).map((t) => t.hour);

    expect(active).toEqual([12]);
  });

  it('highlights nothing when the hour sits between ticks', () => {
    expect(ticks(14).some((t) => t.active)).toBe(false);
  });

  it('never highlights the closing label', () => {
    // There is no hour 24 to select, so lighting it would offer something the
    // slider cannot reach.
    expect(ticks(23).find((t) => t.hour === 24)?.active).toBe(false);
  });
});

describe('isLive', () => {
  it('is true only on today, at the current hour', () => {
    expect(isLive(14, 14, true)).toBe(true);
    expect(isLive(13, 14, true)).toBe(false);
  });

  it('is never true on another day', () => {
    // The prototype hard-coded 14:00 because its data was invented; a past day
    // has no "now" to be at.
    expect(isLive(14, 14, false)).toBe(false);
  });
});

describe('isFutureHour', () => {
  it('marks hours after now on today', () => {
    expect(isFutureHour(18, 14, true)).toBe(true);
    expect(isFutureHour(14, 14, true)).toBe(false);
    expect(isFutureHour(9, 14, true)).toBe(false);
  });

  it('marks nothing on a completed day', () => {
    expect(isFutureHour(23, 14, false)).toBe(false);
  });
});
