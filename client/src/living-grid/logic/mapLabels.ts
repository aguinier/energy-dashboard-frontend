/**
 * How a country's code and its number are sized and placed on the map.
 *
 * The handoff drew every label at a constant 11.5 px on screen, anchored to a
 * projected centroid computed once per resize. That makes Luxembourg's label
 * exactly Germany's, keeps it 11.5 px while Germany grows to fill the viewport,
 * and leaves it wherever the centroid is even when the centroid has been panned
 * off-screen. Both decisions move here, where they can be tested.
 */

/** A rectangle in projection px, as `[[x0, y0], [x1, y1]]`. */
export type Rect = [[number, number], [number, number]];

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** The size a mid-sized European country covers on screen at the Europe preset. */
const REF_EXTENT = 96;
const BASE_PX = 11.5;
/**
 * Sub-linear, so the label grows with the country without racing it: four times
 * the area is about 1.9 times the type, not four times.
 */
const GROWTH = 0.45;
/**
 * Measured against the real geometry at the Europe preset, this floor catches
 * the zones under about 50 px across — AL, MK, SI, ME, LU. Lower than this is
 * not readable; higher starts flattening the difference between the small
 * zones, which is the thing worth showing.
 */
const MIN_PX = 9;
const MAX_PX = 26;
/** The selected zone reads a little louder than its neighbours, as it did before. */
const ACTIVE_BOOST = 1.16;

/**
 * The label's font size in CSS px, from how big its country actually is on
 * screen.
 *
 * `screenExtent` is a characteristic on-screen length — the element passes
 * `sqrt(projected area) * k`, which is the side of the square of equal area, so
 * it tracks both zoom (through `k`) and the country's own size. The clamps stop
 * a world-view label from vanishing and a deep-zoom one from swallowing the map.
 */
export function labelFontPx(screenExtent: number, active: boolean): number {
  const size = BASE_PX * Math.pow(Math.max(0, screenExtent) / REF_EXTENT, GROWTH);
  return clamp(size * (active ? ACTIVE_BOOST : 1), MIN_PX, MAX_PX);
}

/**
 * How visible a label is, given the room it has and the room it needs.
 *
 * A ramp rather than a threshold: the handoff dropped labels on a hard boolean
 * at 1.5x the Europe scale, so a slow zoom made a dozen of them blink into
 * existence at one instant. Fading over a band either side of "just fits" costs
 * nothing and removes the pop.
 */
export function fitAlpha(available: number, needed: number): number {
  if (needed <= 0) return 1;
  return clamp((available / needed - 0.85) / 0.3, 0, 1);
}

/**
 * The same ramp for a value crossing a threshold from below — the plant
 * markers, which appeared at full opacity the moment their MW cleared a falling
 * cutoff.
 */
export function fadeIn(value: number, threshold: number, band: number): number {
  if (band <= 0) return value >= threshold ? 1 : 0;
  return clamp((value - threshold) / band, 0, 1);
}

export interface AnchorInput {
  /** The country's resting label position, in projection px. */
  home: [number, number];
  /** The country's bounds in projection px — its mainland, not its territories. */
  bounds: Rect;
  /** The transform in force. */
  transform: { k: number; x: number; y: number };
  /** The element's size in CSS px. */
  size: { w: number; h: number };
  /** Half the label's width and height in CSS px, so it stays wholly on screen. */
  half: { w: number; h: number };
  /** Keep-out from the viewport edge, in CSS px. */
  margin: number;
}

/**
 * Where to draw the label, in projection px, or `null` when its country has
 * nothing on screen to label.
 *
 * The centroid stays home: a country fully in view is labelled exactly where it
 * was before. When only part of it is visible the label slides along to sit
 * over that part, which is a clamp of the home point into the visible slice of
 * the country's bounds — piecewise-linear, so panning slides it smoothly rather
 * than snapping it between positions.
 *
 * A country narrower than its own label has no room to be clamped into; it
 * falls back to the middle of what is visible and the caller's `fitAlpha` is
 * what decides whether that is worth drawing at all.
 */
export function labelAnchor(input: AnchorInput): [number, number] | null {
  const { home, bounds, transform: t, size, half, margin } = input;
  if (!(t.k > 0)) return null;
  // The viewport in projection px, inset so a label never hugs the edge.
  const vx0 = (margin - t.x) / t.k;
  const vy0 = (margin - t.y) / t.k;
  const vx1 = (size.w - margin - t.x) / t.k;
  const vy1 = (size.h - margin - t.y) / t.k;

  const x0 = Math.max(bounds[0][0], vx0);
  const y0 = Math.max(bounds[0][1], vy0);
  const x1 = Math.min(bounds[1][0], vx1);
  const y1 = Math.min(bounds[1][1], vy1);
  if (x1 <= x0 || y1 <= y0) return null;

  // The label's own half-extent, in the same projection units.
  const hw = half.w / t.k;
  const hh = half.h / t.k;
  const fitsX = x1 - x0 >= hw * 2;
  const fitsY = y1 - y0 >= hh * 2;
  return [
    fitsX ? clamp(home[0], x0 + hw, x1 - hw) : (x0 + x1) / 2,
    fitsY ? clamp(home[1], y0 + hh, y1 - hh) : (y0 + y1) / 2,
  ];
}
