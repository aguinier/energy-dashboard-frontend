import { describe, it, expect } from 'vitest';
import { isCoreNetPositionView, netPositionMapCellState } from './netPositionMapScope';

const core = (countryCode: string | null, hasValue: boolean) =>
  netPositionMapCellState({ metric: 'net_position', scope: 'core', countryCode, hasValue });

const allCoupled = (countryCode: string | null, hasValue: boolean) =>
  netPositionMapCellState({ metric: 'net_position', scope: 'all_coupled', countryCode, hasValue });

describe('netPositionMapCellState', () => {
  it('colours any country that has a value, in either scope', () => {
    expect(core('FR', true)).toBe('ranked');
    expect(allCoupled('FR', true)).toBe('ranked');
  });

  it('separates "outside Core" from "no data" in Core view', () => {
    // Spain is the case that matters: we hold a perfectly good all-coupled
    // net position for it, so reporting a data gap would be false. Poland is
    // in Core, so an empty cell there really is missing data.
    expect(core('ES', false)).toBe('out_of_core');
    expect(core('PL', false)).toBe('no_data');
  });

  it('never claims out_of_core for LU — it shares the DE_LU Core zone', () => {
    // The map draws LU as its own shape, and hatching it in Core view would
    // say Luxembourg is outside the Core region, which is wrong.
    expect(core('LU', false)).toBe('no_data');
    expect(core('LU', true)).toBe('ranked');
  });

  it('classifies every non-Core zone the map draws as out_of_core', () => {
    for (const cc of ['GB', 'CH', 'ES', 'IT', 'NO', 'SE', 'DK', 'GR', 'BG', 'PT', 'IE', 'FI']) {
      expect(core(cc, false)).toBe('out_of_core');
    }
  });

  it('classifies every Core zone with no rows as no_data', () => {
    for (const cc of ['AT', 'BE', 'CZ', 'DE', 'FR', 'HR', 'HU', 'LU', 'NL', 'PL', 'RO', 'SI', 'SK']) {
      expect(core(cc, false)).toBe('no_data');
    }
  });

  it('leaves the all-coupled view exactly as it was before the toggle existed', () => {
    // No country is ever "out of scope" there — the metric covers every zone
    // that publishes one.
    for (const cc of ['ES', 'GB', 'FR', 'PL', null]) {
      expect(allCoupled(cc, false)).toBe('no_data');
    }
  });

  it('never applies the Core distinction to another metric', () => {
    // `scope` is a net-position concept; a load or price cell with no data is
    // just missing, whatever the toggle happens to be set to.
    for (const metric of ['load', 'price', 'renewable_pct'] as const) {
      expect(netPositionMapCellState({ metric, scope: 'core', countryCode: 'ES', hasValue: false }))
        .toBe('no_data');
    }
  });

  it('falls back to no_data for a shape with no country code', () => {
    // ~50 shapes in europe.topojson have no entry in COUNTRY_NAME_MAP; none
    // of them can be judged in or out of Core.
    expect(core(null, false)).toBe('no_data');
  });
});

describe('isCoreNetPositionView', () => {
  it('is true only for the net position metric under the core scope', () => {
    expect(isCoreNetPositionView('net_position', 'core')).toBe(true);
    expect(isCoreNetPositionView('net_position', 'all_coupled')).toBe(false);
    expect(isCoreNetPositionView('load', 'core')).toBe(false);
    expect(isCoreNetPositionView('price', 'all_coupled')).toBe(false);
  });
});
