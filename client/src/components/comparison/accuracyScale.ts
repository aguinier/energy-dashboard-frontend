import { rampCleanToDirty, SCALE_MEDIUM } from '@/lib/dataScale';

/**
 * Colouring WAPE across countries.
 *
 * The old scale was absolute: fixed per-type "excellent"/"good" cutoffs
 * (load 3%/5%, price 12%/18%) in `METRIC_THRESHOLDS`. Measured against the real
 * database on 2026-08-05 over the default 30-day window, no country reached
 * either load cutoff except NO (2.1) and FI (3.0), and only IT cleared the
 * price one — so 21 of 24 load cells and 23 of 24 price cells rendered the same
 * red, and the leaderboard's status badge said "Needs Improvement" for all 24
 * countries at once, from 9.9% to 76.8%. A signal with one value carries no
 * information; worse, it read as a verdict the numbers had not earned.
 *
 * Those cutoffs were never calibrated against anything, so picking new ones
 * would just move an arbitrary line. The scale is now **relative to the
 * countries on screen**, the way `EuropeMap` already colours every metric, and
 * on the same colourblind-safe teal -> amber -> terracotta ramp.
 *
 * **The position is a rank, not a magnitude**, and that is deliberate. The
 * obvious choice — normalise into the observed min..max, as `EuropeMap` does —
 * was tried first and does not work on this data, because WAPE across countries
 * is heavily skewed. Real load WAPEs on 2026-08-05: 21 of the 24 sit between
 * 2.1% and 8.3%, then EE 12.3 and NL 30.4. Against a 2.1..30.4 range those 21
 * countries all land in the first fifth of the ramp and render as the same
 * teal — the non-discriminating signal this replaces, in a friendlier colour.
 * Ranking spreads them across the whole ramp, and is what the column is for:
 * "who forecasts this best" is an ordering question.
 *
 * The cost is that colour distance no longer means error distance — the step
 * from #21 to #22 looks like the step from #1 to #2 even though it is 18
 * percentage points rather than one. That is why every caller prints the WAPE
 * itself next to the colour, and why equal values share a rank and therefore a
 * colour.
 *
 * Rank **per forecast type, never across types**. A 7% load WAPE and a 90% wind
 * WAPE are not the same amount of wrong, and a shared ordering would rank every
 * load country above every wind country and call it a finding.
 */

/**
 * Below this many measured countries a ranking is noise, not a distribution:
 * with two values the colour says only "this one is larger", which the printed
 * number already said, while implying a spread that was never measured. Such a
 * set gets no colour at all.
 */
export const MIN_COUNTRIES_FOR_SCALE = 3;

export interface WapeScale {
  /** Measured WAPEs, ascending. Position in here is the rank. */
  sorted: number[];
  /** Lowest measured WAPE in the set (best). `NaN` when nothing is measured. */
  min: number;
  /** Highest measured WAPE in the set (worst). `NaN` when nothing is measured. */
  max: number;
  /** How many countries carried a usable WAPE. */
  count: number;
  /** False when the set is too small to rank within — see above. */
  usable: boolean;
}

function isMeasured(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Build the ranking for one forecast type from that type's values.
 *
 * `null`/`undefined`/non-finite entries are dropped rather than coerced: a
 * country WAPE could not be computed for (window actuals summed to zero) has no
 * position in this ordering, and folding it in as 0 would hand it first place.
 */
export function wapeScale(values: readonly unknown[]): WapeScale {
  const sorted = values.filter(isMeasured).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { sorted, min: NaN, max: NaN, count: 0, usable: false };
  }
  return {
    sorted,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    count: sorted.length,
    usable: sorted.length >= MIN_COUNTRIES_FOR_SCALE,
  };
}

/**
 * Colour for one WAPE on a scale, or `null` when it must not be coloured —
 * an unmeasurable value, or a set too thin to rank within.
 *
 * Ties share a position, so two countries with the same WAPE always get the
 * same colour. A degenerate set (every country identical) resolves to the
 * ramp's midpoint rather than to either end, because no country is better or
 * worse than another there.
 */
export function wapeColor(value: unknown, scale: WapeScale): string | null {
  if (!scale.usable || !isMeasured(value)) return null;
  if (scale.max === scale.min) return SCALE_MEDIUM;
  // First occurrence, so ties land on the same rung of the ramp.
  const position = scale.sorted.indexOf(value);
  if (position === -1) {
    // Not one of the ranked values — fall back to where it sits by magnitude
    // rather than dropping the colour, since the caller already knows it is
    // measured. Clamped by rampCleanToDirty.
    return rampCleanToDirty((value - scale.min) / (scale.max - scale.min));
  }
  return rampCleanToDirty(position / (scale.count - 1));
}
