import { hourLabel } from './format';

/**
 * The footer timeline: where the knob sits, what the ticks say, and whether
 * "Live" is lit.
 */

export const TICK_HOURS = [0, 4, 8, 12, 16, 20, 24] as const;

/** Knob position as a percentage of the track. */
export function progressPercent(hour: number): number {
  return (Math.max(0, Math.min(23, hour)) / 23) * 100;
}

/** Hour under a click at `x` px along a track `width` px wide. */
export function hourAtPosition(x: number, width: number): number {
  if (width <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, x / width));
  return Math.round(ratio * 23);
}

export interface Tick {
  hour: number;
  label: string;
  active: boolean;
}

/**
 * The seven four-hourly tick labels. `24:00` is the closing label of the day
 * and never highlights, since there is no hour 24 to select.
 */
export function ticks(hour: number): Tick[] {
  return TICK_HOURS.map((h) => ({
    hour: h,
    label: h === 24 ? '24:00' : hourLabel(h),
    active: h < 24 && Math.abs(h - hour) < 2,
  }));
}

/**
 * Whether the view is showing "now".
 *
 * The prototype hard-coded 14:00 because its data was invented. Here it is the
 * current hour in the data's own timezone, which the server sends, so the
 * button means what it says on any day at any hour.
 */
export function isLive(hour: number, currentHour: number, isToday: boolean): boolean {
  return isToday && hour === currentHour;
}

/**
 * Hours that are in the future relative to now.
 *
 * Realized streams — flows, generation — simply have no value there, and the
 * UI dims those hours rather than letting an empty bar read as a low one.
 */
export function isFutureHour(hour: number, currentHour: number, isToday: boolean): boolean {
  return isToday && hour > currentHour;
}
