/**
 * Timing for the zone panel's draw-on entry.
 *
 * One place decides how long the panel takes to arrive, so the sparkline, the
 * bars and the figures cannot disagree about it. Every function returns a CSS
 * `animation` shorthand, or `undefined` when motion is reduced — the caller
 * then simply omits the property and the element renders in its final state.
 *
 * The stagger is derived from the group's size rather than fixed per item. The
 * app's older charts use constants (`i * 0.06s`, `i * 0.08s`) chosen for small
 * groups; at 24 price bars the same constant would run for 1.4 s, nearly three
 * times the budget. Scaling means a row of 8 and a row of 24 both finish
 * together, which is what makes the panel read as one arrival.
 */

/** How long the whole panel takes to arrive, in milliseconds. */
export const DRAW_MS = 500;

/** The share of the budget one staggered item spends animating. */
const ITEM_SHARE = 0.6;

/** Matches the easing the app's existing chart animations use. */
const EASE = 'cubic-bezier(0.4,0,0.2,1)';

/** The hours a full day covers, as spanned by the sparkline. */
const LAST_HOUR = 23;

function shorthand(keyframes: string, durationMs: number, delayMs: number): string {
  // `both` matters: without it a delayed item paints its final state and then
  // snaps back to the start when its turn comes.
  return `${keyframes} ${round(durationMs)}ms ${EASE} ${round(delayMs)}ms both`;
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

export interface DrawOnDelayed {
  /** 0-based position in the group. */
  index: number;
  /** How many items the group has. */
  count: number;
  /** Keyframes to run, e.g. `chartGrow`. */
  keyframes: string;
  /** True when the reader asked for reduced motion. */
  reduced?: boolean;
}

/**
 * One item of a staggered group — the mix rows, the price bars, the figures.
 *
 * Each item animates for the same length of time; only the start is staggered,
 * and the spread is whatever the budget has left over. The last item therefore
 * finishes exactly on budget for any count.
 */
export function drawOnDelayed({ index, count, keyframes, reduced }: DrawOnDelayed): string | undefined {
  if (reduced) return undefined;
  const duration = DRAW_MS * ITEM_SHARE;
  const spread = DRAW_MS - duration;
  const steps = Math.max(1, count - 1);
  const delay = count <= 1 ? 0 : (Math.min(index, steps) / steps) * spread;
  // A group of one has nothing to stagger against, so it takes the whole budget
  // rather than finishing early for no reason.
  return shorthand(keyframes, count <= 1 ? DRAW_MS : duration, delay);
}

export interface DrawOnSweep {
  /** First hour this run covers. */
  startHour: number;
  /** Last hour this run covers, inclusive. */
  endHour: number;
  keyframes: string;
  reduced?: boolean;
}

/**
 * One run of the sparkline, timed by the hours it actually covers.
 *
 * The reveal is a sweep across the day, so a run's share of the budget is its
 * share of the day. A gap costs the time its hours are worth and draws nothing
 * during it, which is the whole reason the runs are separate paths: a single
 * dash-offset sweep measures geometric length, and the jump across a hole has
 * none, so it would skip the gap instantly.
 */
export function drawOnSweep({ startHour, endHour, keyframes, reduced }: DrawOnSweep): string | undefined {
  if (reduced) return undefined;
  const from = Math.max(0, Math.min(LAST_HOUR, startHour));
  const to = Math.max(from, Math.min(LAST_HOUR, endHour));
  const delay = (from / LAST_HOUR) * DRAW_MS;
  // A one-hour run spans no time at all; give it the width of a single hour so
  // it appears rather than being instantaneous.
  const span = Math.max(to - from, 1) / LAST_HOUR;
  return shorthand(keyframes, Math.min(span * DRAW_MS, DRAW_MS - delay), delay);
}
