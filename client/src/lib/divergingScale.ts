/**
 * Diverging colour position for a two-sided metric (net position).
 *
 * Every other map metric is sequential: `t = (v - min) / (max - min)`, one hue,
 * more = darker. That is wrong for a signed quantity. On an hour when most of
 * Europe is importing, say [-5000, +2000], the sequential formula puts 0 MW at
 * 71% of the ramp, so a perfectly balanced country is painted as a strong
 * exporter. Zero has to be the midpoint regardless of where the data sits.
 *
 * Two properties matter:
 *
 *   anchored   0 always maps to exactly 0.5, so the sign is never misread.
 *   symmetric  +v and -v land equidistant from the centre, so equal magnitudes
 *              in opposite directions look equally intense.
 *
 * The signed square root compresses extremes. Germany routinely runs ±10 GW
 * while Slovenia moves a couple of hundred MW; on a linear symmetric ramp the
 * small countries all collapse to the near-white midpoint and the map says
 * nothing about them. The root keeps every value's true rank and sign - only
 * the spacing is compressed, and nothing is clipped - so legend ticks still
 * carry real MW.
 */
export function divergingT(value: number, bound: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(bound) || bound <= 0) return 0.5;
  const clamped = Math.max(-bound, Math.min(bound, value));
  const t = 0.5 + 0.5 * Math.sign(clamped) * Math.sqrt(Math.abs(clamped) / bound);
  return Math.max(0, Math.min(1, t));
}

/**
 * Symmetric bound for a set of signed values: the larger absolute extreme, so
 * the domain is [-bound, +bound] and the midpoint is genuinely zero.
 */
export function symmetricBound(min: number, max: number): number {
  const bound = Math.max(Math.abs(min), Math.abs(max));
  return bound > 0 ? bound : 1;
}
