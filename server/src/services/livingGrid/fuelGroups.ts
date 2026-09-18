/**
 * The 21 A75 generation columns collapsed into the eight fuels the Living Grid
 * legend, donut rings and mix bars are drawn from.
 *
 * This is deliberately NOT `generationService`'s `GENERATION_GROUPS`. That one
 * answers the Generation tab's question with nine families, keeping
 * `hydro_pumped` and `waste` as rows of their own because a stacked area chart
 * can show a signed row and a small one. The Living Grid design fixes eight
 * fuels with eight colours, folds pumped storage into hydro and waste into
 * biomass, and splits fossil into gas and coal — which the nine-family split
 * does not do. Two different questions, two mappings; neither is the other's
 * bug.
 *
 * NEGATIVES ARE CLAMPED, AND THAT IS A DISPLAY DECISION
 *
 * Most of these columns can legitimately go negative: pumped hydro when
 * pumping, and any consumption-only fossil type a country reports as a net
 * figure (the measured list is in `generationService`'s header). A share of
 * generation is undefined for a negative contributor — it would shrink the
 * total it is a part of and tilt every other fuel's percentage. So each member
 * is clamped at zero before summing, which is the same treatment the existing
 * total-generation SQL gives them (`MAX(COALESCE(col, 0), 0)`).
 *
 * Clamping does not erase the difference between "no data" and "zero":
 * a group whose members are ALL NULL stays NULL, and only a group with at
 * least one reported member becomes a number.
 */

export const FUEL_KEYS = [
  'nuclear',
  'hydro',
  'wind',
  'solar',
  'gas',
  'coal',
  'biomass',
  'other',
] as const;

export type FuelKey = (typeof FUEL_KEYS)[number];

export const LIVING_GRID_FUELS: Record<FuelKey, readonly string[]> = {
  nuclear: ['nuclear_mw'],
  hydro: ['hydro_run_mw', 'hydro_reservoir_mw', 'hydro_pumped_mw'],
  wind: ['wind_onshore_mw', 'wind_offshore_mw'],
  solar: ['solar_mw'],
  gas: ['fossil_gas_mw', 'fossil_coal_derived_gas_mw'],
  coal: ['fossil_hard_coal_mw', 'fossil_brown_coal_mw', 'fossil_oil_mw', 'fossil_oil_shale_mw', 'fossil_peat_mw'],
  biomass: ['biomass_mw', 'waste_mw'],
  other: ['geothermal_mw', 'marine_mw', 'other_renewable_mw', 'energy_storage_mw', 'other_mw'],
};

/** Every column the mix query selects — the union of the eight groups. */
export const GENERATION_MW_COLUMNS: readonly string[] = Object.values(LIVING_GRID_FUELS).flat();

/**
 * One zone-hour's raw column readings, as the query returns them. Values are
 * `unknown` because the row also carries the grouping keys, and because
 * anything non-numeric coming back from SQLite must read as "not reported"
 * rather than coerce to a number.
 */
export type GenerationColumns = Record<string, unknown>;

/**
 * Collapse one zone-hour's columns into the eight fuels.
 *
 * Returns `null` for a fuel none of whose columns the country reported, and a
 * clamped sum otherwise.
 */
export function groupFuels(row: GenerationColumns): Record<FuelKey, number | null> {
  const out = {} as Record<FuelKey, number | null>;
  for (const fuel of FUEL_KEYS) {
    let total: number | null = null;
    for (const column of LIVING_GRID_FUELS[fuel]) {
      const raw = row[column];
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      total = (total ?? 0) + Math.max(raw, 0);
    }
    out[fuel] = total;
  }
  return out;
}
