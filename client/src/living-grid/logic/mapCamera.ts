/**
 * The map camera's arithmetic.
 *
 * `ableWorldMap.js` owns the d3 zoom behaviour and the rAF loop; this module
 * owns the numbers they need, so the decisions are testable without a DOM, a
 * projection or a wheel event. Nothing here touches d3 — the element passes in
 * plain numbers and applies whatever comes back.
 */

/** The element's `scaleExtent`, as `[min, max]`. */
export type ScaleExtent = [number, number];

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * How far one wheel event moves the scale, per `WheelEvent.deltaMode`.
 *
 * These are the handoff's own numbers, kept exactly: 0 is pixel mode (trackpads
 * and most mice), 1 is line mode (Firefox), 2 is page mode. Changing them would
 * change how far a notch travels; the point of the smoothing below is to change
 * only how that travel is *delivered*.
 */
const WHEEL_UNIT = [0.003, 0.12, 1] as const;

/**
 * The scale a wheel event is asking for, from the scale it is asking about.
 *
 * d3-zoom applies this exponent to the current transform and repaints in the
 * same frame, which on a wheel mouse is a 35% jump per notch. Here it
 * accumulates into a target the loop eases toward instead, so holding the wheel
 * down still compounds — each event multiplies the target, not the current
 * scale — and the gesture keeps its momentum.
 */
export function wheelTargetScale(
  target: number,
  deltaY: number,
  deltaMode: number,
  extent: ScaleExtent,
): number {
  const unit = WHEEL_UNIT[deltaMode] ?? WHEEL_UNIT[0];
  return clamp(target * Math.exp(-deltaY * unit), extent[0], extent[1]);
}

/**
 * One frame of an exponential approach from `current` to `target`.
 *
 * In log space, so that zooming out feels like zooming in: scale is
 * multiplicative, and a linear lerp on `k` would make the two directions
 * visibly different. `tau` is the time constant in seconds — the step is
 * `1 - e^(-dt/tau)` of the remaining ratio, which makes the result depend only
 * on elapsed time and not on how many frames it arrived in. A dropped frame
 * therefore lands in the same place, rather than leaving the camera behind.
 *
 * `tau <= 0` is the reduced-motion path and returns the target outright.
 */
export function smoothScale(current: number, target: number, dt: number, tau: number): number {
  if (tau <= 0 || dt <= 0) return target;
  const ratio = target / current;
  // Within a tenth of a percent there is no pixel left to travel, and easing
  // forever would keep the rAF loop marking the canvases dirty.
  if (Math.abs(Math.log(ratio)) < 0.001) return target;
  return current * Math.pow(ratio, 1 - Math.exp(-dt / tau));
}

/** A d3 zoom transform, as the element stores it. */
export interface Transform {
  k: number;
  x: number;
  y: number;
}

export interface ReframeInput {
  /** The transform in force before the resize. */
  transform: Transform;
  /** The element's size before the resize, in CSS px. */
  from: { w: number; h: number };
  /** The element's size after it. */
  to: { w: number; h: number };
  /**
   * The projection's scale before and after the refit. `fitSize` changes it,
   * which is what moves the world under a transform that did not change.
   */
  projScale: { from: number; to: number };
  /**
   * Where the old viewport's centre lands in the *new* projection, in
   * projection px. The element computes it as `newProj(oldProj.invert(centre))`.
   */
  anchor: [number, number];
  extent: ScaleExtent;
}

/**
 * The transform that survives a resize with the view intact.
 *
 * `resize()` re-runs `proj.fitSize()` for the new box, so every projected
 * coordinate moves. Today the element only re-frames when the reader has not
 * touched the map; when they have, the transform is left alone and the
 * geography slides out from under them — open the zone panel after panning and
 * you are looking somewhere else.
 *
 * Holding the on-screen scale fixed means `projScale * k` is invariant, and
 * putting `anchor` back at the new centre holds the place. The scale clamp can
 * bite when a large shrink would need more zoom than the extent allows, in
 * which case the place is still centred and only the magnification gives.
 */
export function reframeTransform(input: ReframeInput): Transform {
  const { transform, projScale, anchor, extent, to } = input;
  const k = clamp((projScale.from * transform.k) / projScale.to, extent[0], extent[1]);
  return { k, x: to.w / 2 - k * anchor[0], y: to.h / 2 - k * anchor[1] };
}

/**
 * A box change this large in one step is a panel or a pane arriving, not a
 * reader nudging the window edge.
 */
export const RESIZE_ANIMATE_PX = 80;

/**
 * Whether a resize should be animated or applied outright.
 *
 * The discriminator is the size of the step, not the quiet around it. Timing
 * was the obvious approach and does not work: one `resize()` re-paths every
 * country four times over, which was measured at roughly a second on a
 * throttled tab — longer than any settle window worth having — so the gap
 * between two resizes is mostly the cost of the first one and says nothing
 * about whether a burst is in progress.
 *
 * The step size says it plainly. The zone panel is 380 px wide, so opening or
 * closing it clears this by a wide margin; dragging a window edge moves it a
 * few px at a time and stays under. The first framing of all has nothing to
 * animate from, and reduced motion never animates.
 */
export function shouldAnimateResize(deltaPx: number, first: boolean, reduced: boolean): boolean {
  if (reduced || first) return false;
  return deltaPx >= RESIZE_ANIMATE_PX;
}
