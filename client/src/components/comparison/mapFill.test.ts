import { describe, it, expect } from 'vitest';
import { wapeScale } from './accuracyScale';
import { countryFill, usesFlatFill, MEASURED_FLAT_FILL } from './mapFill';

const HATCH = 'url(#no-data-hatch-test)';

// Real load WAPEs, measured 2026-08-05 over the default 30-day window — the
// skewed set accuracyScale.ts documents (21 countries in 2.1..8.3, then NL at
// 30.4). Enough of them to clear MIN_COUNTRIES_FOR_SCALE.
const LOAD = wapeScale([2.1, 3.0, 5.6, 8.1, 8.3, 12.3, 30.4]);

// BE and FR are the only countries with a hydro_total / wind_offshore / biomass
// column, so those sets are two-wide and unrankable.
const THIN = wapeScale([5.6, 8.1]);

const EMPTY = wapeScale([null, undefined, NaN]);

describe('countryFill', () => {
  // The bug this exists to prevent (ABL-23): "not measured" drawn as a paler
  // version of the same mark every measured country wears.
  it.each([
    ['null WAPE — window actuals summed to zero', null],
    ['no entry for this forecast type', undefined],
    ['a non-finite value', NaN],
    ['an infinite value', Infinity],
  ])('hatches a country with %s', (_why, value) => {
    expect(countryFill(value, 'wape', LOAD, HATCH)).toEqual({ kind: 'none', fill: HATCH });
  });

  it('never coerces an unmeasured value into the ranking', () => {
    // A 0 would be a legitimate, best-in-class WAPE. A null must not become one.
    expect(countryFill(0, 'wape', LOAD, HATCH).kind).toBe('ranked');
    expect(countryFill(null, 'wape', LOAD, HATCH).kind).toBe('none');
  });

  it('ranks a measured WAPE on the ramp', () => {
    const best = countryFill(2.1, 'wape', LOAD, HATCH);
    const worst = countryFill(30.4, 'wape', LOAD, HATCH);
    expect(best.kind).toBe('ranked');
    expect(worst.kind).toBe('ranked');
    expect(best.fill).toMatch(/^#[0-9a-f]{6}$/);
    expect(best.fill).not.toBe(worst.fill);
  });

  it('falls back to the flat fill when the set is too thin to rank', () => {
    expect(countryFill(5.6, 'wape', THIN, HATCH)).toEqual({
      kind: 'flat',
      fill: MEASURED_FLAT_FILL,
    });
  });

  it('still hatches an unmeasured country when the set is too thin to rank', () => {
    // Both fall off the ramp, but for opposite reasons — they must not merge.
    expect(countryFill(null, 'wape', THIN, HATCH).kind).toBe('none');
    expect(countryFill(5.6, 'wape', THIN, HATCH).kind).not.toBe('none');
  });

  it('does not rank MAE or RMSE, which are magnitudes rather than scores', () => {
    for (const metric of ['mae', 'rmse'] as const) {
      expect(countryFill(2185.5, metric, LOAD, HATCH)).toEqual({
        kind: 'flat',
        fill: MEASURED_FLAT_FILL,
      });
      expect(countryFill(null, metric, LOAD, HATCH).kind).toBe('none');
    }
  });

  it('hatches every country when nothing at all was measured', () => {
    expect(countryFill(null, 'wape', EMPTY, HATCH).kind).toBe('none');
  });
});

describe('usesFlatFill', () => {
  it('is false on the ordinary WAPE map, where every measured country is ranked', () => {
    expect(usesFlatFill('wape', LOAD)).toBe(false);
  });

  it('is true when WAPE cannot be ranked, or when the metric is a magnitude', () => {
    expect(usesFlatFill('wape', THIN)).toBe(true);
    expect(usesFlatFill('mae', LOAD)).toBe(true);
    expect(usesFlatFill('rmse', LOAD)).toBe(true);
  });

  // The legend key must appear exactly when the fill does, or it explains a
  // mark nobody can see / leaves one unexplained.
  it('agrees with countryFill about whether a flat fill is ever drawn', () => {
    for (const [metric, scale] of [
      ['wape', LOAD],
      ['wape', THIN],
      ['mae', LOAD],
      ['rmse', THIN],
    ] as const) {
      const drawn = countryFill(5.6, metric, scale, HATCH).kind === 'flat';
      expect(usesFlatFill(metric, scale)).toBe(drawn);
    }
  });
});
