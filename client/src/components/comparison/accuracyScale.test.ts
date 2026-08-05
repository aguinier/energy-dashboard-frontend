import { describe, it, expect } from 'vitest';
import { SCALE_CLEAN, SCALE_DIRTY, SCALE_MEDIUM } from '@/lib/dataScale';
import { MIN_COUNTRIES_FOR_SCALE, wapeColor, wapeScale } from './accuracyScale';

describe('wapeScale', () => {
  it('sorts the measured values and takes min/max from them', () => {
    const s = wapeScale([7.3, 2.1, 30.4, 6.8]);
    expect(s.sorted).toEqual([2.1, 6.8, 7.3, 30.4]);
    expect(s.min).toBe(2.1);
    expect(s.max).toBe(30.4);
    expect(s.count).toBe(4);
    expect(s.usable).toBe(true);
  });

  it('drops null WAPE rather than treating it as a perfect 0', () => {
    // WAPE is null when the window's actuals summed to zero. Folding that in
    // as 0 would hand the country the best colour on the scale and drag the
    // range's floor down for everyone else.
    const s = wapeScale([null, 12, 20, 40, undefined, NaN]);
    expect(s.min).toBe(12);
    expect(s.count).toBe(3);
  });

  it('is unusable when nothing is measured', () => {
    expect(wapeScale([]).usable).toBe(false);
    expect(wapeScale([null, undefined, NaN]).count).toBe(0);
  });

  it(`is unusable below ${MIN_COUNTRIES_FOR_SCALE} countries`, () => {
    // biomass in the live data is BE and FR only. Painting one teal and the
    // other terracotta implies a distribution that was never measured.
    expect(wapeScale([3.5, 67]).usable).toBe(false);
    expect(wapeScale([3.5, 67, 20]).usable).toBe(true);
  });
});

describe('wapeColor', () => {
  const scale = wapeScale([2.1, 7.3, 30.4]);

  it('puts the best country at the clean end and the worst at the dirty end', () => {
    expect(wapeColor(2.1, scale)).toBe(SCALE_CLEAN.toLowerCase());
    expect(wapeColor(30.4, scale)).toBe(SCALE_DIRTY.toLowerCase());
  });

  it('discriminates between countries the old absolute thresholds tied', () => {
    // The bug this replaces: load thresholds were excellent<3 / good<5, so
    // every value at or above 5 returned the same red — 6.2% and 30.4% were
    // literally the same colour. Distinct inputs must now give distinct
    // colours.
    const loadScale = wapeScale([2.1, 3.0, 4.8, 5.6, 6.2, 7.3, 8.3, 30.4]);
    const colors = [5.6, 6.2, 7.3, 8.3, 30.4].map((v) => wapeColor(v, loadScale));
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('spreads a skewed distribution across the whole ramp', () => {
    // The real load WAPEs for 2026-08-05: 21 of 24 sit in 2.1..8.3, then
    // EE 12.3 and NL 30.4. A min..max magnitude scale pins those 21 into the
    // first fifth of the ramp and renders them as one indistinguishable teal —
    // the same non-discriminating signal this replaces. Ranking must not.
    const real = [
      2.1, 3.0, 4.8, 5.6, 5.6, 5.7, 5.8, 6.2, 6.4, 6.8, 6.8, 6.8, 6.8, 6.9,
      7.1, 7.3, 7.3, 7.7, 7.8, 8.1, 8.3, 11.5, 12.3, 30.4,
    ];
    const s = wapeScale(real);
    const distinct = new Set(real.map((v) => wapeColor(v, s)));
    // 24 countries with 5 duplicate readings (5.6 twice, 6.8 four times,
    // 7.3 twice) -> 19 distinct values, and every one gets its own shade.
    expect(distinct.size).toBe(19);
    // ...and the median country lands mid-ramp rather than hard against the
    // clean end, which is what the magnitude scale got wrong.
    expect(wapeColor(6.9, s)).not.toBe(wapeColor(2.1, s));
  });

  it('gives tied countries the same colour', () => {
    const s = wapeScale([2.1, 6.8, 6.8, 6.8, 30.4]);
    expect(wapeColor(6.8, s)).toBe(wapeColor(6.8, s));
    expect(new Set([2.1, 6.8, 30.4].map((v) => wapeColor(v, s))).size).toBe(3);
  });

  it('is monotonic in hue — a worse WAPE never gets a cleaner colour', () => {
    // The ramp turns in RGB space (teal -> amber brightens, amber ->
    // terracotta darkens), so no single channel is monotonic. Hue is: it runs
    // ~160 degrees down to ~10 without reversing, which is what makes the
    // scale readable as an ordered one.
    const hue = (hex: string) => {
      const v = parseInt(hex.slice(1), 16);
      const r = ((v >> 16) & 0xff) / 255, g = ((v >> 8) & 0xff) / 255, b = (v & 0xff) / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      if (d === 0) return 0;
      const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return h * 60;
    };
    const values = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const s = wapeScale(values);
    const hues = values.map((v) => hue(wapeColor(v, s)!));
    expect(hues[0]).toBeGreaterThan(150);
    expect(hues[hues.length - 1]).toBeLessThan(20);
    for (let i = 1; i < hues.length; i++) expect(hues[i]).toBeLessThanOrEqual(hues[i - 1]);
  });

  it('returns null for an unmeasurable value instead of a colour', () => {
    expect(wapeColor(null, scale)).toBeNull();
    expect(wapeColor(undefined, scale)).toBeNull();
    expect(wapeColor(NaN, scale)).toBeNull();
  });

  it('returns null on a scale too thin to rank within', () => {
    expect(wapeColor(3.5, wapeScale([3.5, 67]))).toBeNull();
  });

  it('gives a degenerate range the midpoint, not an end', () => {
    // Every country identical: none is better or worse, so neither the "best"
    // nor the "worst" colour is true of any of them.
    expect(wapeColor(9, wapeScale([9, 9, 9]))).toBe(SCALE_MEDIUM);
  });

  it('ranks within a forecast type, never across types', () => {
    // load 2..30 and wind 62..191 are separate scales; 30.4 is the worst load
    // in its set and 62.4 the best wind in its own, so both sit at their own
    // end of the ramp. A shared scale would make every load cell teal and
    // every wind cell terracotta and call that a finding.
    const load = wapeScale([2.1, 7.3, 30.4]);
    const wind = wapeScale([62.4, 90.6, 191.2]);
    expect(wapeColor(30.4, load)).toBe(SCALE_DIRTY.toLowerCase());
    expect(wapeColor(62.4, wind)).toBe(SCALE_CLEAN.toLowerCase());
  });
});
