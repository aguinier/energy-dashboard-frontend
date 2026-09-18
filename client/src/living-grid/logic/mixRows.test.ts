import { describe, it, expect } from 'vitest';
import { buildMixBreakdown, stackSegments } from './mixRows';
import { FUEL_COLORS } from './ramps';
import { emptyMix, series } from './testFixture';

function mixOf(values: Partial<Record<string, number | null>>) {
  const mix = emptyMix();
  for (const [fuel, value] of Object.entries(values)) {
    mix[fuel as keyof typeof mix] = series(() => value ?? null);
  }
  return mix;
}

describe('buildMixBreakdown', () => {
  it('shares are of what the zone reported, and sum to one', () => {
    const b = buildMixBreakdown(mixOf({ wind: 300, gas: 100 }), 12);
    const total = b.rows.reduce((s, r) => s + r.share, 0);

    expect(total).toBeCloseTo(1, 10);
    expect(b.totalMw).toBe(400);
  });

  it('sorts descending so the dominant fuel reads first', () => {
    const b = buildMixBreakdown(mixOf({ solar: 100, nuclear: 500, wind: 300 }), 12);

    expect(b.rows.map((r) => r.fuel)).toEqual(['nuclear', 'wind', 'solar']);
  });

  it('carries the colour and label the legend uses', () => {
    const b = buildMixBreakdown(mixOf({ wind: 100 }), 12);

    expect(b.rows[0]).toMatchObject({ label: 'Wind', color: FUEL_COLORS.wind });
  });

  it('drops rows under 0.4 per cent', () => {
    const b = buildMixBreakdown(mixOf({ wind: 1000, solar: 1 }), 12);

    expect(b.rows.map((r) => r.fuel)).toEqual(['wind']);
  });

  it('still counts a dropped row in the total', () => {
    // The row is too small to read, but the megawatts are real and the
    // percentages of the rows that remain must not be inflated by hiding it.
    const b = buildMixBreakdown(mixOf({ wind: 1000, solar: 1 }), 12);

    expect(b.totalMw).toBe(1001);
  });

  it('computes the renewable share over hydro, wind, solar and biomass', () => {
    const b = buildMixBreakdown(mixOf({ wind: 200, solar: 100, hydro: 100, gas: 600 }), 12);

    expect(b.renewableShare).toBeCloseTo(0.4, 10);
  });

  it('reports a zone that reports nothing as empty, not as zero', () => {
    const b = buildMixBreakdown(emptyMix(), 12);

    expect(b.empty).toBe(true);
    expect(b.rows).toEqual([]);
    expect(b.renewableShare).toBeNull();
  });

  it('treats an all-zero hour as empty rather than dividing by zero', () => {
    const b = buildMixBreakdown(mixOf({ wind: 0, solar: 0 }), 12);

    expect(b.empty).toBe(true);
    expect(b.renewableShare).toBeNull();
  });

  it('tells a zone that reported zeros apart from one that reported nothing', () => {
    // Both are `empty` — there is no bar to draw either way — but they are
    // different claims about the zone, and the panel must not answer them with
    // the same sentence. A solar-only zone reports 0 MW every night; saying it
    // published nothing today is false for the other sixteen hours.
    expect(buildMixBreakdown(mixOf({ wind: 0, solar: 0 }), 12).reported).toBe(true);
    expect(buildMixBreakdown(emptyMix(), 12).reported).toBe(false);
  });

  it('counts a fuel reported as pumping as reported, not as absent', () => {
    // Clamped to zero for the share maths, but the zone did publish a number.
    const b = buildMixBreakdown(mixOf({ hydro: -50 }), 12);

    expect(b.empty).toBe(true);
    expect(b.reported).toBe(true);
  });

  it('has nothing reported when the mix is absent altogether', () => {
    expect(buildMixBreakdown(undefined, 12).reported).toBe(false);
  });

  it('survives a missing mix entirely', () => {
    expect(buildMixBreakdown(undefined, 12).empty).toBe(true);
  });

  it('ignores a fuel the country does not report', () => {
    const b = buildMixBreakdown(mixOf({ wind: 100, nuclear: null }), 12);

    expect(b.rows.map((r) => r.fuel)).toEqual(['wind']);
  });
});

describe('stackSegments', () => {
  it('spans the full bar even when small fuels are dropped from the rows', () => {
    const mix = mixOf({ wind: 1000, solar: 1 });
    const total = stackSegments(mix, 12).reduce((s, seg) => s + seg.share, 0);

    expect(total).toBeCloseTo(1, 10);
  });

  it('is empty when there is nothing to stack', () => {
    expect(stackSegments(emptyMix(), 12)).toEqual([]);
    expect(stackSegments(undefined, 12)).toEqual([]);
  });
});
