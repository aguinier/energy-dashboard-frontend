import { describe, it, expect } from 'vitest';
import { DRAW_MS, drawOnDelayed, drawOnSweep } from './drawOn';

/** Pull the two millisecond figures out of an `animation` shorthand. */
function timings(shorthand: string | undefined): { dur: number; delay: number } {
  const ms = (shorthand ?? '').match(/(\d+(?:\.\d+)?)ms/g) ?? [];
  // NaN when a figure is missing, which fails the assertion loudly rather than
  // quietly passing a zero.
  return { dur: parseFloat(ms[0] ?? ''), delay: parseFloat(ms[1] ?? '') };
}

describe('drawOnDelayed', () => {
  it('renders nothing to animate when motion is reduced', () => {
    expect(drawOnDelayed({ index: 3, count: 8, keyframes: 'chartGrow', reduced: true })).toBeUndefined();
  });

  it('names the keyframes it was given', () => {
    expect(drawOnDelayed({ index: 0, count: 8, keyframes: 'chartGrow' })).toContain('chartGrow');
  });

  it('starts the first item immediately', () => {
    expect(timings(drawOnDelayed({ index: 0, count: 8, keyframes: 'k' })).delay).toBe(0);
  });

  it('finishes the last item on budget, whatever the count', () => {
    // The stagger has to scale with the count or a 24-bar row would run long:
    // the fixed per-item delays used elsewhere in the app assume small groups.
    for (const count of [1, 2, 8, 24]) {
      const last = timings(drawOnDelayed({ index: count - 1, count, keyframes: 'k' }));

      expect(last.delay + last.dur).toBeCloseTo(DRAW_MS, 6);
    }
  });

  it('orders the items, so they arrive one after another', () => {
    const delays = [0, 1, 2, 3].map((i) => timings(drawOnDelayed({ index: i, count: 4, keyframes: 'k' })).delay);

    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(new Set(delays).size).toBe(4);
  });

  it('holds the start state until an item\'s turn', () => {
    // Without `both` a delayed item paints its final state, then jumps back to
    // the start when the animation begins.
    expect(drawOnDelayed({ index: 2, count: 4, keyframes: 'k' })).toContain('both');
  });

  it('survives a single-item group without dividing by zero', () => {
    const only = timings(drawOnDelayed({ index: 0, count: 1, keyframes: 'k' }));

    expect(only.delay).toBe(0);
    expect(only.dur).toBeCloseTo(DRAW_MS, 6);
  });
});

describe('drawOnSweep', () => {
  it('renders nothing to animate when motion is reduced', () => {
    expect(drawOnSweep({ startHour: 0, endHour: 23, keyframes: 'chartDraw', reduced: true })).toBeUndefined();
  });

  it('gives a whole day the whole budget', () => {
    const t = timings(drawOnSweep({ startHour: 0, endHour: 23, keyframes: 'chartDraw' }));

    expect(t.delay).toBe(0);
    expect(t.dur).toBeCloseTo(DRAW_MS, 6);
  });

  it('spends real time on a gap, so the sweep does not jump it', () => {
    // A run covering the back half of the day starts halfway through the
    // budget. The hours before it are empty, and stay empty for their share.
    const t = timings(drawOnSweep({ startHour: 12, endHour: 23, keyframes: 'chartDraw' }));

    // Precision 2: the shorthand rounds to 3 decimals so the CSS reads cleanly.
    expect(t.delay).toBeCloseTo(DRAW_MS * (12 / 23), 2);
    expect(t.delay + t.dur).toBeCloseTo(DRAW_MS, 2);
  });

  it('gives a single-hour run a positive duration rather than none', () => {
    const t = timings(drawOnSweep({ startHour: 5, endHour: 5, keyframes: 'chartDraw' }));

    expect(t.dur).toBeGreaterThan(0);
  });
});
