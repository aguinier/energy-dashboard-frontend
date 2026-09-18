/**
 * The arithmetic behind an hour easing into the next one.
 *
 * `ableWorldMap.js` owns the frame loop that drives this; the decisions live
 * here so they can be checked without a DOM, a canvas or a clock. Nothing in
 * this module knows what an hour is — it interpolates maps of numbers and maps
 * of colours between a `from` and a `to`, and leaves the timing to the caller.
 */

/** Zone code to value. Absent keys mean the zone had nothing to show. */
export type NumberMap = Record<string, number>;
export type ColorMap = Record<string, string>;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Eased progress through a tween, from elapsed and total milliseconds.
 *
 * Cubic in-out, matching `easeCubicInOut` on the camera and the
 * `cubic-bezier(0.4,0,0.2,1)` the panel's CSS animations use — close enough
 * that the map and the panel read as one piece of motion.
 *
 * A zero or negative duration lands immediately, which is how reduced motion
 * and a deliberate cut both arrive here. The ends are exact: `0` at the start
 * and `1` once the time is up, so a tween always finishes on the real value
 * rather than near it.
 */
export function easeProgress(elapsedMs: number, durationMs: number): number {
  if (!(durationMs > 0)) return 1;
  const t = clamp01(elapsedMs / durationMs);
  if (t === 0 || t === 1) return t;
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Blend two `#rrggbb` colours in sRGB.
 *
 * The map element has its own copy of this for its palette work; this one is
 * the tested one, and is what the tween uses. Anything it cannot parse falls
 * back to whichever end the tween is nearer, so a malformed colour degrades to
 * a cut rather than to black.
 */
export function lerpColor(from: string, to: string, t: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  if (!a || !b) return t < 0.5 ? from : to;
  const out = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return '#' + out.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

function parseHex(hex: string): [number, number, number] | null {
  if (typeof hex !== 'string' || hex.length !== 7 || hex[0] !== '#') return null;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : [r, g, b];
}

/**
 * Interpolate every key of two maps.
 *
 * **A key on one side only is not eased toward zero — it takes the side that
 * has it.** A zone the other hour has no value for is not a zone at zero: it
 * is a zone with nothing to say, and easing it through the middle of the ramp
 * would draw a measurement that was never taken. This is the same rule the
 * rest of the Living Grid keeps, and the reason the map leaves a zone unfilled
 * rather than colouring it as balanced.
 */
export function lerpNumberMap(from: NumberMap, to: NumberMap, t: number): NumberMap {
  const out: NumberMap = {};
  for (const key of keysOf(from, to)) {
    const a = from[key];
    const b = to[key];
    if (a === undefined) out[key] = b;
    else if (b === undefined) out[key] = a;
    else out[key] = a + (b - a) * t;
  }
  return out;
}

/** The same rule for colours. */
export function lerpColorMap(from: ColorMap, to: ColorMap, t: number): ColorMap {
  const out: ColorMap = {};
  for (const key of keysOf(from, to)) {
    const a = from[key];
    const b = to[key];
    if (a === undefined) out[key] = b;
    else if (b === undefined) out[key] = a;
    else out[key] = lerpColor(a, b, t);
  }
  return out;
}

function keysOf(a: object, b: object): string[] {
  const seen = new Set(Object.keys(a));
  for (const key of Object.keys(b)) seen.add(key);
  return [...seen];
}

/**
 * How long one hour change should take, in ms.
 *
 * Measured on the deployed build in a visible tab: the field rebuild that runs
 * once per step costs ~42 ms of the 900 ms play interval, and a repaint costs
 * ~2 ms, so the tween is not competing for the tick — it is chosen for how it
 * reads. 650 ms spends most of the interval in motion and still comes to rest
 * before the next step, so the hour is legible rather than permanently
 * mid-transition.
 */
export const TWEEN_MS = 650;
