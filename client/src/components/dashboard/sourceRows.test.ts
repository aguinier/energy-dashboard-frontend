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

// Sum of the positive rows only: nuclear + solar + wind + hydro + fossil
// (gas + oil, hard_coal is negative and excluded) + biomass + waste.
// hydroPumped (-1827.98) and fossil_hard_coal (-1.21, folded into the
// fossil row's 1163.83) are excluded/net out of the positive total.
const FR_POSITIVE_TOTAL = 40346.23 + 18866.4 + 2568.73 + 4000 + 1163.83 + 200 + 402.32;

describe('buildSourceRows', () => {
  it('emits nuclear and fossil as their own rows, not an unnamed remainder', () => {
    const { rows } = buildSourceRows(FR_MIX);
    const keys = rows.map((r) => r.key);
    expect(keys).toContain('nuclear');
    expect(keys).toContain('fossil');
    expect(rows.find((r) => r.key === 'nuclear')!.mw).toBe(40346.23);
  });

  it('covers all nine grouped rows', () => {
    const { rows } = buildSourceRows(FR_MIX);
    expect(rows.map((r) => r.key).sort()).toEqual(
      ['biomass', 'fossil', 'hydro', 'hydroPumped', 'nuclear', 'other', 'solar', 'waste', 'wind'].sort(),
    );
  });

  it('sums onshore and offshore wind', () => {
    const { rows } = buildSourceRows(FR_MIX);
    expect(rows.find((r) => r.key === 'wind')!.mw).toBe(2568.73);
  });

  it('sums hydro run-of-river and reservoir, but keeps pumped storage separate', () => {
    const { rows } = buildSourceRows(FR_MIX);
    expect(rows.find((r) => r.key === 'hydro')!.mw).toBe(4000);
    expect(rows.find((r) => r.key === 'hydroPumped')!.mw).toBe(-1827.98);
  });

  it('collapses the seven fossil types into one row, nulls contributing nothing', () => {
    const { rows } = buildSourceRows(FR_MIX);
    // gas 1131.62 + hard_coal -1.21 + oil 33.42; brown_coal/oil_shale/peat/coal_derived_gas absent
    expect(rows.find((r) => r.key === 'fossil')!.mw).toBeCloseTo(1163.83, 2);
  });

  it('reports a type this country never sends as null on its row, not zero', () => {
    const { rows } = buildSourceRows(FR_MIX);
    // FR reports none of geothermal/marine/other_renewable/energy_storage/other this window.
    const other = rows.find((r) => r.key === 'other')!;
    expect(other.mw).toBeNull();
    expect(other.pctOfGeneration).toBeNull();
  });

  it('keeps a reported negative value negative (pumped storage net-consuming)', () => {
    const { rows } = buildSourceRows(FR_MIX);
    const pumped = rows.find((r) => r.key === 'hydroPumped')!;
    expect(pumped.mw).toBeLessThan(0);
    expect(pumped.pctOfGeneration).toBeLessThan(0);
  });

  it('orders rows by descending magnitude', () => {
    const { rows } = buildSourceRows(FR_MIX);
    const magnitudes = rows.map((r) => Math.abs(r.mw ?? 0));
    expect(magnitudes).toEqual([...magnitudes].sort((a, b) => b - a));
    expect(rows[0].key).toBe('nuclear'); // 40346.23, the largest by far
  });

  it('expresses percentages as share of total measured generation, not load', () => {
    const { rows, totalMw } = buildSourceRows(FR_MIX);
    expect(totalMw).toBeCloseTo(FR_POSITIVE_TOTAL, 2);
    // France exports, so generation exceeds load; a share-of-generation
    // basis keeps every row's percentage under 100% regardless of that -
    // this is exactly the bug the share-of-load framing had (nuclear could
    // read >100%).
    const nuclear = rows.find((r) => r.key === 'nuclear')!;
    expect(nuclear.pctOfGeneration).toBeCloseTo((40346.23 / FR_POSITIVE_TOTAL) * 100, 5);
    expect(nuclear.pctOfGeneration!).toBeLessThan(100);
  });

  it('divides negative rows by the same total the positive rows sum to', () => {
    const { rows, totalMw } = buildSourceRows(FR_MIX);
    const pumped = rows.find((r) => r.key === 'hydroPumped')!;
    expect(pumped.pctOfGeneration).toBeCloseTo((-1827.98 / totalMw!) * 100, 5);
  });

  it('sums the positive rows to exactly 100% of totalMw', () => {
    const { rows, totalMw } = buildSourceRows(FR_MIX);
    const positiveShareSum = rows
      .filter((r) => r.mw != null && r.mw > 0)
      .reduce((a, r) => a + r.pctOfGeneration!, 0);
    const positiveMwSum = rows
      .filter((r) => r.mw != null && r.mw > 0)
      .reduce((a, r) => a + r.mw!, 0);
    expect(positiveMwSum).toBeCloseTo(totalMw!, 5);
    expect(positiveShareSum).toBeCloseTo(100, 5);
  });

  it('returns all-null rows and a null total when mix has not loaded yet', () => {
    const { rows, totalMw } = buildSourceRows(undefined);
    expect(rows.every((r) => r.mw === null)).toBe(true);
    expect(rows.every((r) => r.pctOfGeneration === null)).toBe(true);
    // Not meant to be rendered while the query is still loading -
    // GenerationTab gates on isLoading before it ever reaches the donut/table.
    expect(totalMw).toBeNull();
  });

  it('treats a reported zero as measured, not absent', () => {
    const mix: GenerationMix = { ...FR_MIX, wind_offshore: 0 };
    const { rows } = buildSourceRows(mix);
    // wind_onshore 2568.73 + wind_offshore 0 (reported, not absent) = 2568.73, same as onshore alone here
    expect(rows.find((r) => r.key === 'wind')!.mw).toBe(2568.73);
  });

  it('returns a zero (not null) total, and null percentages, when nothing measured is positive', () => {
    // Every type either unreported or non-positive: nothing to take a share of.
    const allNonPositive: GenerationMix = {
      nuclear: null,
      solar: null,
      wind_onshore: null,
      wind_offshore: null,
      hydro_run: null,
      hydro_reservoir: null,
      hydro_pumped: -50,
      fossil_gas: null,
      fossil_hard_coal: null,
      fossil_brown_coal: null,
      fossil_oil: null,
      fossil_oil_shale: null,
      fossil_peat: null,
      fossil_coal_derived_gas: null,
      biomass: null,
      geothermal: null,
      marine: null,
      other_renewable: null,
      energy_storage: null,
      waste: null,
      other: null,
    };
    const { rows, totalMw } = buildSourceRows(allNonPositive);
    expect(totalMw).toBe(0);
    const pumped = rows.find((r) => r.key === 'hydroPumped')!;
    expect(pumped.mw).toBe(-50);
    // Can't express a share of a non-positive total - null (a dash in the
    // UI), not a divide-by-zero Infinity/NaN or a misleading 0%.
    expect(pumped.pctOfGeneration).toBeNull();
  });
});
