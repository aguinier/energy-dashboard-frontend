import { describe, it, expect } from 'vitest';
import { divergingT, symmetricBound } from './divergingScale';

describe('symmetricBound', () => {
  it('takes the larger absolute extreme so the domain straddles zero', () => {
    expect(symmetricBound(-5000, 2000)).toBe(5000);
    expect(symmetricBound(-800, 9800)).toBe(9800);
  });

  it('never returns zero, which would collapse the scale', () => {
    expect(symmetricBound(0, 0)).toBe(1);
  });
});

describe('divergingT', () => {
  it('puts zero exactly at the midpoint', () => {
    expect(divergingT(0, 5000)).toBe(0.5);
  });

  it('keeps zero at the midpoint even when every value is negative', () => {
    // The whole continent importing must not shift where "balanced" sits.
    const bound = symmetricBound(-5000, -200);
    expect(divergingT(0, bound)).toBe(0.5);
    expect(divergingT(-5000, bound)).toBe(0);
  });

  it('is symmetric: equal magnitudes sit equidistant from centre', () => {
    const above = divergingT(1200, 5000) - 0.5;
    const below = 0.5 - divergingT(-1200, 5000);
    expect(above).toBeCloseTo(below, 12);
  });

  it('maps the extremes to the ends of the ramp', () => {
    expect(divergingT(5000, 5000)).toBe(1);
    expect(divergingT(-5000, 5000)).toBe(0);
  });

  it('keeps small countries visible next to a large outlier', () => {
    // DE at +9800 must not flatten SI (+180) onto the midpoint.
    const bound = symmetricBound(-4200, 9800);
    const si = divergingT(180, bound);
    const linear = 0.5 + 0.5 * (180 / bound);
    expect(si - 0.5).toBeGreaterThan((linear - 0.5) * 3);
  });

  it('preserves order and sign', () => {
    const b = symmetricBound(-4200, 9800);
    const vals = [-4200, -310, -120, 180, 9800];
    const ts = vals.map((v) => divergingT(v, b));
    expect(ts).toEqual([...ts].sort((a, z) => a - z));
    expect(divergingT(-1, b)).toBeLessThan(0.5);
    expect(divergingT(1, b)).toBeGreaterThan(0.5);
  });

  it('clamps out-of-domain values instead of running off the ramp', () => {
    expect(divergingT(99999, 5000)).toBe(1);
    expect(divergingT(-99999, 5000)).toBe(0);
  });

  it('falls back to the midpoint on degenerate input', () => {
    expect(divergingT(NaN, 5000)).toBe(0.5);
    expect(divergingT(100, 0)).toBe(0.5);
  });
});
