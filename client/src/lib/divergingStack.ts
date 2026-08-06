/**
 * Stacking for a series whose members can legitimately be negative.
 *
 * ## Why this exists
 *
 * The Generation tab stacks nine production families (ABL-44). Two of them go
 * negative for real, measured reasons: pumped storage is negative whenever a
 * country is charging — a routine, hours-long state for FR, DE and ES — and a
 * consumption-only type makes the fossil family negative outright (France's
 * `Fossil Hard coal` is reported as consumption with no offsetting generation
 * reading).
 *
 * A plain cumulative stack over signed values misdraws them. Each layer's
 * baseline is the running total, so one negative member drags every band above
 * it downward and the top of the stack stops being the total. Nothing errors;
 * the chart just quietly shows the wrong heights for the *positive* series
 * too.
 *
 * The two easy alternatives both lie outright:
 *
 *  - **Clamp negatives to zero.** Draws a country pulling 300 MW off the grid
 *    as one doing nothing. That is the fabrication class this dashboard exists
 *    to avoid.
 *  - **Drop the negative-capable series.** Loses pumped storage entirely,
 *    including the hours it is generating, and puts the chart back out of step
 *    with the by-source table beside it, which does show it.
 *
 * So: a diverging stack (d3's `stackOffsetDiverging`, in a dozen lines and
 * without the dependency). Positives stack up from the zero baseline,
 * negatives stack down from it, in one fixed key order. The zero line is
 * drawn, and `stackExtent` only reaches below it when something actually is
 * negative — so a series with no negatives is laid out exactly as a plain
 * stack would lay it out.
 *
 * It is continuous as a member crosses zero: at the crossing that member's own
 * band has zero width and contributes ~0 to both accumulators, so the bands
 * around it do not jump.
 */

export interface StackBand<K extends string = string> {
  key: K;
  /** Baseline edge of the band, in data units. */
  y0: number;
  /** Outer edge. `y1 - y0` is exactly this key's value, sign included. */
  y1: number;
}

/**
 * One point's bands, in the given key order (bottom of the stack first).
 *
 * A **null** value produces a zero-width band at the current baseline — the
 * one place "not reported" is drawn the same as a measured zero. Callers are
 * expected to bound that by excluding a key that is null at *every* point from
 * `keys` altogether (see `buildGenerationMixSeries`), so what remains is a
 * hole inside an otherwise-reported series, and to label it as unknown rather
 * than as a number wherever they print values.
 */
export function divergingStack<K extends string>(
  keys: readonly K[],
  values: Readonly<Partial<Record<K, number | null>>>,
): Array<StackBand<K>> {
  let up = 0;
  let down = 0;
  return keys.map((key) => {
    const v = values[key] ?? 0;
    if (v < 0) {
      const y0 = down;
      down += v;
      return { key, y0, y1: down };
    }
    const y0 = up;
    up += v;
    return { key, y0, y1: up };
  });
}

/**
 * The y-domain a diverging stack needs: the highest positive total and the
 * lowest negative total across every point. `min` is 0 when nothing is
 * negative, which is what keeps the ordinary country's axis unchanged.
 */
export function stackExtent<K extends string>(
  points: ReadonlyArray<{ values: Readonly<Partial<Record<K, number | null>>> }>,
  keys: readonly K[],
): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const p of points) {
    let up = 0;
    let down = 0;
    for (const key of keys) {
      const v = p.values[key] ?? 0;
      if (v < 0) down += v;
      else up += v;
    }
    if (up > max) max = up;
    if (down < min) min = down;
  }
  return { min, max };
}
