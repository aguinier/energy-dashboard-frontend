/**
 * Skill vs the seasonal-naive (D-7) baseline, for the same forecast pairs a
 * displayed WAPE already covers.
 *
 * This mirrors `score_against_baseline` in the ABL-129 scorecard
 * (`energy-forecast/src/evaluation/scorecard.py:158`) rather than inventing a
 * second definition: the baseline is the actual value from exactly the same
 * hour seven days earlier (`aligned_point_baselines`,
 * `energy-forecast/src/baselines.py:297`), and both the model's WAPE and the
 * baseline's WAPE are computed on the identical pair intersection — only rows
 * where the actual, the model forecast, AND the D-7 baseline are all present.
 * That intersection can be a *subset* of the pairs the plain WAPE beside it
 * uses (a row can be missing its D-7 baseline even though it has an actual
 * and a forecast); it is never a superset, and `n` is reported so the caller
 * can see how large that subset is rather than trusting a lone percentage.
 */

export interface SkillVsSeasonalNaive {
  /** Pairs with an actual, a model forecast, AND a D-7 baseline — never larger than the WAPE's own sample. */
  n: number;
  /** `null` when not measurable: no pairs, or the baseline's own WAPE is 0/undefined. */
  skillPct: number | null;
  /** The seasonal-naive baseline's own WAPE over the same intersection, for context. `null` alongside `skillPct`. */
  baselineWape: number | null;
}

export interface SkillAggregates {
  /** Count of rows where the D-7 baseline is present (actual/forecast presence is already guaranteed upstream). */
  n: number;
  /** SUM(|actual|) over those rows — the shared WAPE denominator. */
  actualAbsSum: number;
  /** SUM(|actual - forecast|) over those rows. */
  modelErrAbsSum: number;
  /** SUM(|actual - baseline|) over those rows. */
  baselineErrAbsSum: number;
}

/**
 * `100 * (1 - model_wape / baseline_wape)`, computed on the intersection the
 * caller already restricted `SkillAggregates` to. Positive means the model
 * beat the naive baseline; negative means the naive baseline would have done
 * better — a forecast that loses to "the same hour last week" is a failure,
 * not a small number, and callers should render it as one.
 */
export function computeSkillVsSeasonalNaive(agg: SkillAggregates): SkillVsSeasonalNaive {
  const { n, actualAbsSum, modelErrAbsSum, baselineErrAbsSum } = agg;
  if (n === 0 || actualAbsSum === 0) {
    return { n, skillPct: null, baselineWape: null };
  }
  const modelWape = (100 * modelErrAbsSum) / actualAbsSum;
  const baselineWape = (100 * baselineErrAbsSum) / actualAbsSum;
  if (baselineWape === 0) {
    return { n, skillPct: null, baselineWape: round2(baselineWape) };
  }
  const skillPct = 100 * (1 - modelWape / baselineWape);
  return { n, skillPct: round2(skillPct), baselineWape: round2(baselineWape) };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
