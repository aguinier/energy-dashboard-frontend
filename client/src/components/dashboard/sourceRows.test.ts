import { describe, it, expect } from 'vitest';
import { buildSourceRows } from './sourceRows';
import type { RenewableMix } from '@/types';

const MIX: RenewableMix = {
  solar: 6000, wind_onshore: 4000, wind_offshore: 800,
  hydro: 4000, biomass: 200, geothermal: 0, other: 0, total: 15000,
};

describe('buildSourceRows', () => {
  it('emits only measured sources', () => {
    const { rows } = buildSourceRows(MIX, 40000);
    expect(rows.map((r) => r.key)).toEqual(['solar', 'wind', 'hydro', 'biomass']);
  });

  it('sums onshore and offshore wind', () => {
    const { rows } = buildSourceRows(MIX, 40000);
    expect(rows.find((r) => r.key === 'wind')!.mw).toBe(4800);
  });

  it('expresses percentages as share of load', () => {
    const { rows } = buildSourceRows(MIX, 40000);
    expect(rows.find((r) => r.key === 'solar')!.pctOfLoad).toBeCloseTo(15, 5);
  });

  it('reports the unattributed remainder rather than naming it', () => {
    const { unattributedMw } = buildSourceRows(MIX, 40000);
    expect(unattributedMw).toBe(25000);
  });

  it('clamps a negative remainder to zero', () => {
    const { unattributedMw } = buildSourceRows(MIX, 10000);
    expect(unattributedMw).toBe(0);
  });

  it('returns a null remainder when load is unknown', () => {
    const { unattributedMw } = buildSourceRows(MIX, null);
    expect(unattributedMw).toBeNull();
  });
});
