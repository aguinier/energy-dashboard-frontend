/**
 * Interior data holes in a stacked-mix series (`AbleStackedMix.tsx`).
 *
 * `divergingStack.ts`'s own doc comment already names the convention this
 * builds on: a null value produces a zero-width band at the current baseline,
 * and callers are "expected to... label it as unknown rather than as a number
 * wherever they print values." That covers the tooltip (`AbleStackedMix`
 * already prints `—` for a null cell) but not the drawn area itself — left
 * alone, the smoothed path through a run of zero-width bands reads as a
 * confident dip to zero rather than as "we were not told," which is exactly
 * the "NULL, never 0" defect this codebase's CLAUDE.md names as a Data
 * semantics rule.
 *
 * This module finds the spans that must NOT be bridged with a drawn line, so
 * `AbleStackedMix` can break its area path there and paint a hatched marker
 * instead (`components/map/NoDataHatch.tsx` — the same "not on the scale"
 * texture the choropleths use, reused here for the same reason: a paler fill
 * would read as a small measured value, not as an absence).
 */

/** The subset of `AbleStackedMixPoint` this module needs — avoids importing the component. */
export interface GapSourcePoint {
  future: boolean;
  values: Record<string, number | null>;
}

export interface GroupGap {
  key: string;
  /** Index range into the source array, inclusive. */
  startIndex: number;
  endIndex: number;
}

/**
 * Runs of null for `key`, restricted to points that are not `future`.
 *
 * A future point is null for every group by construction (nothing has
 * happened yet) — `buildGenerationMixSeries`'s own grid-fill for a Today
 * window explicitly pads every group with `null` past "now". That is not a
 * data gap and must never be reported as one; scanning only `!future` points
 * is what keeps the two apart. Only `key`s the caller already knows are drawn
 * (`groups`, upstream) should be passed in — a group that is null at every
 * past point too is "never reported," a different and stronger claim than an
 * interior hole, and is described separately by the caller from the full
 * group list rather than from this per-group scan.
 */
export function computeGroupGaps(points: readonly GapSourcePoint[], keys: readonly string[]): GroupGap[] {
  const gaps: GroupGap[] = [];
  for (const key of keys) {
    let gapStart: number | null = null;
    for (let i = 0; i < points.length; i++) {
      const missing = !points[i].future && points[i].values[key] == null;
      if (missing && gapStart === null) gapStart = i;
      if (!missing && gapStart !== null) {
        gaps.push({ key, startIndex: gapStart, endIndex: i - 1 });
        gapStart = null;
      }
    }
    if (gapStart !== null) gaps.push({ key, startIndex: gapStart, endIndex: points.length - 1 });
  }
  return gaps;
}
