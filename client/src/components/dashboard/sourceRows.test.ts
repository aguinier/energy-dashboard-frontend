import { describe, it, expect } from 'vitest';
import { buildSourceRows } from './sourceRows';
import type { GenerationMix } from '@/types';

// Roughly the real France window quoted in the A75 plan (2026-07-29): a
// nuclear-heavy mix with real fossil, waste, and a country that does not
// report geothermal or brown coal at all.
const FR_MIX: GenerationMix = {
  nuclear: 40346.23,
  solar: 18866.4,
  wind_onshore: 2568.73,
  wind_offshore: 0,
  hydro_run: 3000,
  hydro_reservoir: 1000,
  hydro_pumped: -1827.98,
  fossil_gas: 1131.62,
  fossil_hard_coal: -1.21,
  fossil_brown_coal: null,
  fossil_oil: 33.42,
  fossil_oil_shale: null,
  fossil_peat: null,
  fossil_coal_derived_gas: null,
  biomass: 200,
  geothermal: null,
  marine: null,
  other_renewable: null,
  energy_storage: null,
  waste: 402.32,
  other: null,
};

describe('buildSourceRows', () => {
  it('emits nuclear and fossil as their own rows, not an unnamed remainder', () => {
    const { rows } = buildSourceRows(FR_MIX, 45000);
    const keys = rows.map((r) => r.key);
    expect(keys).toContain('nuclear');
    expect(keys).toContain('fossil');
    expect(rows.find((r) => r.key === 'nuclear')!.mw).toBe(40346.23);
  });

  it('covers all nine grouped rows', () => {
    const { rows } = buildSourceRows(FR_MIX, 45000);
    expect(rows.map((r) => r.key).sort()).toEqual(
      ['biomass', 'fossil', 'hydro', 'hydroPumped', 'nuclear', 'other', 'solar', 'waste', 'wind'].sort(),
    );
  });

  it('sums onshore and offshore wind', () => {
    const { rows } = buildSourceRows(FR_MIX, 45000);
    expect(rows.find((r) => r.key === 'wind')!.mw).toBe(2568.73);
  });

  it('sums hydro run-of-river and reservoir, but keeps pumped storage separate', () => {
    const { rows } = buildSourceRows(FR_MIX, 45000);
    expect(rows.find((r) => r.key === 'hydro')!.mw).toBe(4000);
    expect(rows.find((r) => r.key === 'hydroPumped')!.mw).toBe(-1827.98);
  });

  it('collapses the seven fossil types into one row, nulls contributing nothing', () => {
    const { rows } = buildSourceRows(FR_MIX, 45000);
    // gas 1131.62 + hard_coal -1.21 + oil 33.42; brown_coal/oil_shale/peat/coal_derived_gas absent
    expect(rows.find((r) => r.key === 'fossil')!.mw).toBeCloseTo(1163.83, 2);
  });

  it('reports a type this country never sends as null on its row, not zero', () => {
    const { rows } = buildSourceRows(FR_MIX, 45000);
    // FR reports none of geothermal/marine/other_renewable/energy_storage/other this window.
    const other = rows.find((r) => r.key === 'other')!;
    expect(other.mw).toBeNull();
    expect(other.pctOfLoad).toBeNull();
  });

  it('keeps a reported negative value negative (pumped storage net-consuming)', () => {
    const { rows } = buildSourceRows(FR_MIX, 45000);
    const pumped = rows.find((r) => r.key === 'hydroPumped')!;
    expect(pumped.mw).toBeLessThan(0);
    expect(pumped.pctOfLoad).toBeLessThan(0);
  });

  it('orders rows by descending magnitude', () => {
    const { rows } = buildSourceRows(FR_MIX, 45000);
    const magnitudes = rows.map((r) => Math.abs(r.mw ?? 0));
    expect(magnitudes).toEqual([...magnitudes].sort((a, b) => b - a));
    expect(rows[0].key).toBe('nuclear'); // 40346.23, the largest by far
  });

  it('expresses percentages as share of load', () => {
    const { rows } = buildSourceRows(FR_MIX, 40000);
    expect(rows.find((r) => r.key === 'solar')!.pctOfLoad).toBeCloseTo((18866.4 / 40000) * 100, 5);
  });

  it('reports the remainder rather than naming it', () => {
    // Load well above total measured generation (~65.7 GW here) so the
    // remainder is genuinely positive, not clamped by the zero floor below.
    const { rows, remainderMw } = buildSourceRows(FR_MIX, 90000);
    const measured = rows.reduce((a, r) => a + (r.mw ?? 0), 0);
    expect(remainderMw).toBeCloseTo(90000 - measured, 5);
  });

  it('clamps a negative remainder to zero (measured generation exceeding load is a surplus, not "unexplained")', () => {
    const { remainderMw } = buildSourceRows(FR_MIX, 1000);
    expect(remainderMw).toBe(0);
  });

  it('returns a null remainder when load is unknown', () => {
    const { remainderMw } = buildSourceRows(FR_MIX, null);
    expect(remainderMw).toBeNull();
  });

  it('returns all-null rows when mix has not loaded yet, remainder equal to the full unmeasured load', () => {
    const { rows, remainderMw } = buildSourceRows(undefined, 40000);
    expect(rows.every((r) => r.mw === null)).toBe(true);
    // Nothing measured yet, so nothing is subtracted from load - this value
    // is not meant to be rendered while the query is still loading;
    // GenerationTab gates on isLoading before it ever reaches the table.
    expect(remainderMw).toBe(40000);
  });

  it('treats a reported zero as measured, not absent', () => {
    const mix: GenerationMix = { ...FR_MIX, wind_offshore: 0 };
    const { rows } = buildSourceRows(mix, 45000);
    // wind_onshore 2568.73 + wind_offshore 0 (reported, not absent) = 2568.73, same as onshore alone here
    expect(rows.find((r) => r.key === 'wind')!.mw).toBe(2568.73);
  });
});
