import type { GenerationMix } from '@/types';

export interface SourceRow {
  key: 'nuclear' | 'solar' | 'wind' | 'hydro' | 'hydroPumped' | 'fossil' | 'biomass' | 'waste' | 'other';
  label: string;
  /**
   * MW, window average. Null when this country's A75 document never reports
   * any of this row's constituent production types in the window - a gap,
   * not a measured zero (see the global constraint in the A75 plan). Can be
   * negative for `hydroPumped` (net pumping is normal) and, rarely, `fossil`
   * (a consumption-only reading such as `fossil_hard_coal_mw` with no
   * offsetting generation reading in the window).
   */
  mw: number | null;
  /** Share of load, signed. Null exactly when `mw` is null. */
  pctOfLoad: number | null;
  color: string;
}

const COLORS: Record<SourceRow['key'], string> = {
  nuclear: '#C2665A',
  solar: '#F0B92B',
  wind: '#4D89C9',
  hydro: '#2FA39C',
  hydroPumped: '#7FBFB9',
  fossil: '#6B6459',
  biomass: '#73A35F',
  waste: '#A98F5D',
  other: '#B7AFA0',
};

/**
 * Sums the non-null members of a group. Null only when every member is
 * null - i.e. this country's A75 document reports none of them, the
 * group-level "not reported" case the UI must show as a gap. A null member
 * mixed with reported ones simply contributes nothing to the sum, the same
 * way a country that reports gas but not brown coal should not have its
 * fossil total treated as partially unknown.
 */
function sumOrNull(values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => v != null);
  if (present.length === 0) return null;
  return present.reduce((a, v) => a + v, 0);
}

/**
 * Generation by source, straight from the complete A75 document
 * (`energy_generation`) rather than the 8-column renewable-only narrowing
 * `energy_renewable` carries. The 21 raw `*_mw` columns are grouped into 9
 * rows so a country's mix reads at a glance without hiding any of them:
 *
 *   nuclear, solar, wind (onshore+offshore), hydro (run+reservoir),
 *   hydro pumped storage (kept separate - it is a store, not a source, and
 *   is routinely negative), a collapsed fossil family (gas, hard coal,
 *   brown coal, oil, oil shale, peat, coal-derived gas), biomass, waste,
 *   and a small "other" bucket (geothermal, marine, other renewable,
 *   energy storage, and ENTSO-E's own "Other" type).
 *
 * Nuclear and fossil used to be discarded entirely (not ingested), so this
 * function reported measured renewables plus an unnamed remainder of load.
 * Both tables are now populated from the same A75 fetch, so the remainder
 * below is what's left after all 21 types are accounted for, not just 4 -
 * normally small, often exactly 0. It is clamped at 0: this function answers
 * "how much of load is unexplained by what we measured", which cannot be
 * negative by definition - a window where measured generation exceeds load
 * is a net-export surplus, a different claim this function does not make.
 */
export function buildSourceRows(
  mix: GenerationMix | undefined,
  loadMw: number | null,
): { rows: SourceRow[]; remainderMw: number | null } {
  const raw: Array<[SourceRow['key'], string, number | null]> = [
    ['nuclear', 'Nuclear', mix?.nuclear ?? null],
    ['solar', 'Solar', mix?.solar ?? null],
    ['wind', 'Wind', mix ? sumOrNull([mix.wind_onshore, mix.wind_offshore]) : null],
    ['hydro', 'Hydro', mix ? sumOrNull([mix.hydro_run, mix.hydro_reservoir]) : null],
    ['hydroPumped', 'Pumped storage', mix?.hydro_pumped ?? null],
    [
      'fossil',
      'Fossil',
      mix
        ? sumOrNull([
            mix.fossil_gas,
            mix.fossil_hard_coal,
            mix.fossil_brown_coal,
            mix.fossil_oil,
            mix.fossil_oil_shale,
            mix.fossil_peat,
            mix.fossil_coal_derived_gas,
          ])
        : null,
    ],
    ['biomass', 'Biomass', mix?.biomass ?? null],
    ['waste', 'Waste', mix?.waste ?? null],
    [
      'other',
      'Other',
      mix ? sumOrNull([mix.geothermal, mix.marine, mix.other_renewable, mix.energy_storage, mix.other]) : null,
    ],
  ];

  const rows: SourceRow[] = raw
    .map(([key, label, mw]) => ({
      key,
      label,
      mw,
      pctOfLoad: mw == null ? null : loadMw && loadMw > 0 ? (mw / loadMw) * 100 : 0,
      color: COLORS[key],
    }))
    // Largest contributors first, by magnitude, so the mix reads at a
    // glance; types this country doesn't report sink to the bottom.
    .sort((a, b) => Math.abs(b.mw ?? 0) - Math.abs(a.mw ?? 0));

  const measured = rows.reduce((a, r) => a + (r.mw ?? 0), 0);
  const remainderMw = loadMw == null ? null : Math.max(0, loadMw - measured);

  return { rows, remainderMw };
}
