import type { GenerationMix } from '@/types';
import { GENERATION_GROUP_COLORS, type GenerationGroupKey } from './generationSeries';
import { isSolarPartial, SOLAR_PARTIAL_QUALIFIER } from './solarCoverageNote';

export interface SourceRow {
  /**
   * The same nine families the trend chart stacks - see
   * `generationSeries.ts`, which owns the grouping, the labels and the
   * palette so all three marks on this tab agree.
   */
  key: GenerationGroupKey;
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
  /**
   * Share of this window's total measured generation, signed - NOT share of
   * load (see `buildSourceRows` for why). Null exactly when `mw` is null, or
   * when `totalMw` is zero/negative and a share cannot be expressed.
   */
  pctOfGeneration: number | null;
  color: string;
}

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
 * ## Share of generation, not share of load
 *
 * Rows used to be expressed as a share of load, back when this panel showed
 * *measured renewables plus an unknown remainder of load* (nuclear and
 * fossil weren't ingested at all). That framing breaks now that the whole
 * mix is measured: a country that exports (France, routinely) generates
 * more than it consumes, so nuclear alone can read over 100% of load - a
 * "share" that can exceed 100% isn't a share of anything meaningful, and
 * the rows no longer sum to a sensible total.
 *
 * So this now reports each row's share of **total measured generation**
 * (`totalMw`) instead. That also retires the old "remainder" (`loadMw -
 * measured`, clamped at 0): it used to answer "how much of load can't we
 * explain", a question that made sense only when most of the mix was
 * unmeasured. Now that all 21 types are ingested, the gap between
 * generation and load is exports/imports plus losses - a real quantity, but
 * a *different* one, already served by the Net position tab. Relabelling
 * the old remainder as that would be wrong, so it's gone rather than
 * repurposed; this function no longer takes `loadMw` at all.
 *
 * ## The denominator
 *
 * `totalMw` is the sum of *positive* rows only, not the net sum including
 * negatives. Two reasons:
 *
 *  1. A negative row (pumped storage charging, a stray consumption-only
 *     fossil reading) is a draw, not production - it was never generated,
 *     so it shouldn't shrink the base every other row is measured against.
 *     Dividing by a net figure would make every positive row's share swing
 *     with how much a country happened to be pumping that window, which
 *     has nothing to do with the *mix* of what was produced.
 *  2. It keeps this total identical to what the donut (`AbleDonut`) sums
 *     internally - it can only draw non-negative slices, so it naturally
 *     totals the positive rows. Picking the same definition here means the
 *     table and the donut can never silently disagree, the exact class of
 *     bug ("header said 36%, donut said 0%") the A75 UI audit flagged.
 *
 * A negative row still gets a correctly negative `pctOfGeneration` (it's
 * still divided by `totalMw`), so the positive rows alone sum to 100% and a
 * negative row reads as "drew back N% of what was produced" rather than
 * partitioning a pie together with the positive rows.
 */
export function buildSourceRows(
  mix: GenerationMix | undefined,
): { rows: SourceRow[]; totalMw: number | null } {
  // The Solar row carries its own qualifier when this country reports only the
  // grid-metered part of its fleet (ABL-325). Derived from the mix itself
  // rather than passed in by the caller, so the value cannot be rendered
  // without the caveat - `solarCoverageNote.ts` owns the rule and the wording.
  const solarLabel = isSolarPartial(mix?.solar_coverage)
    ? `Solar (${SOLAR_PARTIAL_QUALIFIER})`
    : 'Solar';

  const raw: Array<[SourceRow['key'], string, number | null]> = [
    ['nuclear', 'Nuclear', mix?.nuclear ?? null],
    ['solar', solarLabel, mix?.solar ?? null],
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

  // Null when the mix itself hasn't loaded yet (nothing measured at all -
  // distinct from "measured, and it happens to sum to zero or less").
  const totalMw = mix == null ? null : raw.reduce((a, [, , mw]) => a + Math.max(0, mw ?? 0), 0);

  const rows: SourceRow[] = raw
    .map(([key, label, mw]) => ({
      key,
      label,
      mw,
      pctOfGeneration: mw == null ? null : totalMw && totalMw > 0 ? (mw / totalMw) * 100 : null,
      color: GENERATION_GROUP_COLORS[key],
    }))
    // Largest contributors first, by magnitude, so the mix reads at a
    // glance; types this country doesn't report sink to the bottom.
    .sort((a, b) => Math.abs(b.mw ?? 0) - Math.abs(a.mw ?? 0));

  return { rows, totalMw };
}
