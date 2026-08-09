/**
 * Splitting a charted series into the runs it is honest to draw a line through.
 *
 * `AbleLineChart` lays every series onto an hourly grid (`buildSeriesGrid`,
 * chartAdapters.ts) and then drops the empty slots before building the path,
 * which joins whatever survives into ONE continuous stroke. That is fine across
 * a slot the series never claimed to fill, and wrong across a slot it did: a
 * missed forecast run gets drawn as a smooth dashed line spanning the hours the
 * model produced nothing for, which is the same species of defect as every
 * other confidently-wrong mark in this dashboard — a rendered claim with no
 * measurement under it.
 *
 * Telling those two apart needs the series' own cadence, because the grid is
 * always hourly but the data is not: `getGranularityForPreset`
 * (useDashboardData.ts:155) fetches `30d` at DAILY granularity, so 23 of every
 * 24 slots are legitimately empty and a "break on any empty slot" rule would
 * render that window as ~30 disconnected dots. So the step is measured from the
 * data rather than assumed.
 */

/**
 * Group the indices at which a series has a value into contiguous drawable
 * runs, breaking wherever two consecutive present points sit further apart than
 * the series' own sampling step.
 *
 * The step is the MEDIAN distance between present points, and the break
 * threshold is `1.5x` it. Both halves are deliberate:
 *
 * - **Median, not a constant.** It reads the cadence the data declares —
 *   1 slot for an hourly series, 24 for a daily one on the same hourly grid —
 *   so one rule covers every preset with nothing to calibrate per window.
 * - **1.5x, not exact equality.** A day is not always 24 hours. On the Brussels
 *   clocks-back day a daily series steps 25 slots, and on clocks-forward 23; an
 *   exact-equality rule would tear the line twice a year at a boundary where no
 *   sample is missing at all. The factor is a tolerance for irregular-but-
 *   intended spacing, not a judgement about how large a hole may be bridged —
 *   a genuinely missing sample is >= 2x the step and breaks under any factor
 *   below 2.
 *
 * Fewer than three present points carry no cadence to measure, so they are
 * returned as one run: with two points there is no way to tell a sampling
 * interval from a gap, and connecting them is what the chart did before.
 *
 * @param presentIndices Ascending indices into the series that hold a value.
 * @returns One array of indices per drawable run, in order. Never empty runs.
 */
export function drawableRuns(presentIndices: number[]): number[][] {
  if (presentIndices.length === 0) return [];
  if (presentIndices.length < 3) return [presentIndices.slice()];

  const steps: number[] = [];
  for (let i = 1; i < presentIndices.length; i++) {
    steps.push(presentIndices[i] - presentIndices[i - 1]);
  }

  const sorted = steps.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // A degenerate median (duplicate indices) would make every gap a break;
  // fall back to joining rather than shattering the line.
  if (!(median > 0)) return [presentIndices.slice()];
  const maxBridged = median * 1.5;

  const runs: number[][] = [[presentIndices[0]]];
  for (let i = 1; i < presentIndices.length; i++) {
    if (steps[i - 1] > maxBridged) runs.push([]);
    runs[runs.length - 1].push(presentIndices[i]);
  }
  return runs;
}
