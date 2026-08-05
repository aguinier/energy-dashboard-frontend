/**
 * The able data-scale ramp — one definition, shared by every choropleth and
 * every colour-coded metric cell.
 *
 * Deliberately NOT red/green. Red and green are the pair a red-green colour
 * blind viewer cannot separate, and "worst" vs "best" is exactly the
 * distinction that must survive. The ramp runs teal-green -> amber ->
 * terracotta, which separates on hue *and* on lightness, so it still reads as
 * an ordered scale in greyscale.
 *
 * These three constants were EuropeMap's private CLEAN/MEDIUM/DIRTY. They live
 * here now because ComparisonView needs the same ramp, and a second copy is how
 * two views of the same number end up disagreeing about which colour it is.
 */
export const SCALE_CLEAN = '#2C8A6B';
export const SCALE_MEDIUM = '#C99A2A';
export const SCALE_DIRTY = '#8E3D2C';

/**
 * Interpolate between two 6-digit hex colours, returning 6-digit hex.
 *
 * Hex out (rather than `rgb(...)`) so the result composes with `withOpacity`,
 * which builds an 8-digit `#rrggbbaa`.
 */
export function lerpHex(a: string, b: string, t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const ah = parseInt(a.slice(1), 16);
  const bh = parseInt(b.slice(1), 16);
  const mix = (shift: number) => {
    const av = (ah >> shift) & 0xff;
    const bv = (bh >> shift) & 0xff;
    return Math.round(av + (bv - av) * clamped);
  };
  const hex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${hex(mix(16))}${hex(mix(8))}${hex(mix(0))}`;
}

/** `t` 0 -> clean, 0.5 -> medium, 1 -> dirty. Out-of-range `t` is clamped. */
export function rampCleanToDirty(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped < 0.5
    ? lerpHex(SCALE_CLEAN, SCALE_MEDIUM, clamped * 2)
    : lerpHex(SCALE_MEDIUM, SCALE_DIRTY, (clamped - 0.5) * 2);
}
