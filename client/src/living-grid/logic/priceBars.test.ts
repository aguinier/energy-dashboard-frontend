import { describe, it, expect } from 'vitest';
import { buildPriceBars } from './priceBars';
import { PRICE_RAMP } from './ramps';
import { series } from './testFixture';

describe('buildPriceBars', () => {
  it('always returns a bar per hour', () => {
    expect(buildPriceBars(series(() => 50), 12)).toHaveLength(24);
  });

  it('scales height within the zone own day', () => {
    const bars = buildPriceBars(series((h) => (h === 6 ? 100 : 50)), 0);

    // 18 + share * 46: the peak is full height, half the peak is halfway.
    expect(bars[6].height).toBeCloseTo(64, 5);
    expect(bars[0].height).toBeCloseTo(41, 5);
  });

  it('marks the current hour and nothing else', () => {
    const bars = buildPriceBars(series(() => 50), 9);

    expect(bars.filter((b) => b.current).map((b) => b.hour)).toEqual([9]);
  });

  it('gives a missing hour no bar rather than a zero-height one', () => {
    // A gap and a €0 hour must not look the same; the bar is absent.
    const bars = buildPriceBars(series((h) => (h === 4 ? null : 60)), 0);

    expect(bars[4].value).toBeNull();
    expect(bars[4].height).toBe(0);
  });

  it('colours against the cross-zone scale when given one', () => {
    // The map and this panel must agree: a zone at the cheap end of Europe is
    // the cheap colour here too, even if its own day was flat.
    const bars = buildPriceBars(series(() => 10), 0, { scaleMin: 10, scaleMax: 200 });

    expect(bars[0].color).toBe(PRICE_RAMP[0]);
  });

  it('falls back to the zone own range with no scale given', () => {
    const bars = buildPriceBars(series((h) => (h === 0 ? 10 : 200)), 0);

    expect(bars[0].color).toBe(PRICE_RAMP[0]);
    expect(bars[1].color).toBe(PRICE_RAMP[PRICE_RAMP.length - 1]);
  });

  it('handles a negative price without inverting the bar', () => {
    // Negative day-ahead prices are ordinary here. The bar shrinks toward the
    // baseline rather than being drawn upside down.
    const bars = buildPriceBars(series((h) => (h === 3 ? -40 : 80)), 0);

    expect(bars[3].height).toBeGreaterThan(0);
    expect(bars[3].height).toBeLessThan(bars[0].height);
  });

  it('keeps the cheapest hour the shortest bar when the low beats the high in magnitude', () => {
    // −60 is further from zero than +40, so a magnitude-based height would
    // draw the cheapest hour of the day as the tallest bar on the chart.
    const bars = buildPriceBars(series((h) => (h === 0 ? -60 : 40)), 0);

    expect(bars[0].height).toBeLessThan(bars[1].height);
  });

  it('survives a flat day without dividing by zero', () => {
    const bars = buildPriceBars(series(() => 50), 0);

    expect(bars.every((b) => Number.isFinite(b.height))).toBe(true);
  });

  it('survives an absent series', () => {
    const bars = buildPriceBars(undefined, 0);

    expect(bars).toHaveLength(24);
    expect(bars.every((b) => b.value === null)).toBe(true);
  });
});
