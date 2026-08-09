import { describe, it, expect } from 'vitest';
import { drawableRuns } from './seriesSegments';

/** Indices of an unbroken hourly run [from, to). */
const hourly = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => from + i);

describe('drawableRuns', () => {
  it('returns nothing for an empty series', () => {
    expect(drawableRuns([])).toEqual([]);
  });

  it('keeps an unbroken hourly series as one run', () => {
    expect(drawableRuns(hourly(0, 24))).toEqual([hourly(0, 24)]);
  });

  it('breaks an hourly series at a single missing hour', () => {
    // 0..9 present, 10 missing, 11..19 present.
    const present = [...hourly(0, 10), ...hourly(11, 20)];
    expect(drawableRuns(present)).toEqual([hourly(0, 10), hourly(11, 20)]);
  });

  it('breaks an hourly series at a multi-day hole', () => {
    const present = [...hourly(0, 48), ...hourly(216, 264)];
    expect(drawableRuns(present)).toEqual([hourly(0, 48), hourly(216, 264)]);
  });

  it('keeps a daily series on an hourly grid as one run', () => {
    // The `30d` preset fetches daily granularity onto the same hourly grid, so
    // 23 of every 24 slots are legitimately empty. Breaking here would render
    // the window as 30 disconnected dots.
    const daily = Array.from({ length: 30 }, (_, d) => d * 24);
    expect(drawableRuns(daily)).toEqual([daily]);
  });

  it('breaks a daily series only where a whole day is missing', () => {
    // Days 0..9 and 11..19 — day 10 absent, so a 48-slot step.
    const present = [
      ...Array.from({ length: 10 }, (_, d) => d * 24),
      ...Array.from({ length: 9 }, (_, d) => (d + 11) * 24),
    ];
    const runs = drawableRuns(present);
    expect(runs).toHaveLength(2);
    expect(runs[0][runs[0].length - 1]).toBe(9 * 24);
    expect(runs[1][0]).toBe(11 * 24);
  });

  it('does not break a daily series across DST-length days', () => {
    // Brussels clocks-back gives a 25-hour day and clocks-forward a 23-hour
    // one. No sample is missing, so the line must not tear.
    const present = [0, 24, 48, 73, 97, 121, 144, 168];
    expect(drawableRuns(present)).toEqual([present]);
  });

  it('joins two lone points rather than guessing a cadence from one gap', () => {
    expect(drawableRuns([0, 120])).toEqual([[0, 120]]);
  });

  it('keeps an isolated point as its own run', () => {
    const present = [...hourly(0, 10), 40];
    const runs = drawableRuns(present);
    expect(runs).toEqual([hourly(0, 10), [40]]);
  });

  it('covers every input index exactly once, in order', () => {
    const present = [...hourly(0, 5), ...hourly(9, 14), 30, ...hourly(40, 44)];
    expect(drawableRuns(present).flat()).toEqual(present);
  });
});
