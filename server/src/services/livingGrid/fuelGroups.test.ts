import { describe, it, expect, vi } from 'vitest';
import {
  FUEL_KEYS,
  GENERATION_MW_COLUMNS,
  LIVING_GRID_FUELS,
  groupFuels,
} from './fuelGroups.js';

// `generationService` is imported for one exported constant, but importing it
// pulls in the module that opens ENERGY_DB_PATH at import time. Only the
// constant is read here, so the handle is stubbed rather than opened.
vi.mock('../../config/database.js', () => ({ default: {} }));

const { GENERATION_GROUPS } = await import('../generationService.js');

/** Every column present, all zero — a base to override one field at a time. */
function zeroed(overrides: Record<string, number | null> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const column of GENERATION_MW_COLUMNS) row[column] = 0;
  return { ...row, ...overrides };
}

describe('the eight-fuel mapping', () => {
  it('covers every column the nine-family split covers, and no others', () => {
    // The two mappings answer different questions, but they must partition the
    // same A75 document. A column in one and not the other would be a fuel
    // silently missing from one of the two screens.
    const mine = [...GENERATION_MW_COLUMNS].sort();
    const theirs = Object.values(GENERATION_GROUPS).flat().slice().sort();

    expect(mine).toEqual(theirs);
  });

  it('assigns each column to exactly one fuel', () => {
    const seen = new Set<string>();
    for (const fuel of FUEL_KEYS) {
      for (const column of LIVING_GRID_FUELS[fuel]) {
        expect(seen.has(column)).toBe(false);
        seen.add(column);
      }
    }
    expect(seen.size).toBe(GENERATION_MW_COLUMNS.length);
  });

  it('splits fossil into gas and coal, which the nine-family split does not', () => {
    const row = zeroed({ fossil_gas_mw: 100, fossil_hard_coal_mw: 40, fossil_brown_coal_mw: 60 });
    const mix = groupFuels(row);

    expect(mix.gas).toBe(100);
    expect(mix.coal).toBe(100);
  });

  it('folds pumped storage into hydro and waste into biomass', () => {
    const row = zeroed({
      hydro_run_mw: 10,
      hydro_reservoir_mw: 20,
      hydro_pumped_mw: 30,
      biomass_mw: 5,
      waste_mw: 7,
    });
    const mix = groupFuels(row);

    expect(mix.hydro).toBe(60);
    expect(mix.biomass).toBe(12);
  });

  it('sums both wind columns and the five other-category ones', () => {
    const row = zeroed({
      wind_onshore_mw: 800,
      wind_offshore_mw: 200,
      geothermal_mw: 1,
      marine_mw: 2,
      other_renewable_mw: 3,
      energy_storage_mw: 4,
      other_mw: 5,
    });
    const mix = groupFuels(row);

    expect(mix.wind).toBe(1000);
    expect(mix.other).toBe(15);
  });
});

describe('negatives and nulls', () => {
  it('clamps a pumping hour to zero rather than shrinking hydro', () => {
    // A share of generation is undefined for a negative contributor: left
    // signed, -300 MW of pumping would shrink the total it is a part of and
    // tilt every other fuel's percentage upward.
    const row = zeroed({ hydro_run_mw: 100, hydro_pumped_mw: -300 });

    expect(groupFuels(row).hydro).toBe(100);
  });

  it('clamps a consumption-only fossil type the same way', () => {
    const row = zeroed({ fossil_hard_coal_mw: -50, fossil_brown_coal_mw: 200 });

    expect(groupFuels(row).coal).toBe(200);
  });

  it('returns null for a fuel whose every column is unreported', () => {
    const row = zeroed({ nuclear_mw: null });

    expect(groupFuels(row).nuclear).toBeNull();
  });

  it('keeps a measured zero distinguishable from an unreported fuel', () => {
    // This is the distinction the whole codebase refuses to collapse: Germany
    // genuinely generates 0 MW of nuclear, and Portugal reports nothing at all.
    const measuredZero = groupFuels(zeroed({ nuclear_mw: 0 }));
    const unreported = groupFuels(zeroed({ nuclear_mw: null }));

    expect(measuredZero.nuclear).toBe(0);
    expect(unreported.nuclear).toBeNull();
  });

  it('sums the reported members of a partially-null group', () => {
    const row = zeroed({ wind_onshore_mw: 500, wind_offshore_mw: null });

    expect(groupFuels(row).wind).toBe(500);
  });

  it('nulls every fuel for a country reporting nothing', () => {
    const row: Record<string, unknown> = {};
    for (const column of GENERATION_MW_COLUMNS) row[column] = null;
    const mix = groupFuels(row);

    for (const fuel of FUEL_KEYS) expect(mix[fuel]).toBeNull();
  });

  it('treats a non-numeric or non-finite reading as unreported', () => {
    const row = zeroed({ nuclear_mw: null });
    row.nuclear_mw = Number.NaN;
    expect(groupFuels(row).nuclear).toBeNull();

    row.nuclear_mw = 'not a number';
    expect(groupFuels(row).nuclear).toBeNull();
  });

  it('ignores the grouping keys travelling in the same row', () => {
    const row = { ...zeroed({ solar_mw: 42 }), zone: 'DE', hourKey: '2026-07-01 12' };

    expect(groupFuels(row).solar).toBe(42);
  });
});
