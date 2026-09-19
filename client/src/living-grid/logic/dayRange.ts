import { MINUS } from './format';

/**
 * How far the day control can reach, and what to call where it lands.
 *
 * Every date here is a `YYYY-MM-DD` calendar day, never an instant. The
 * arithmetic runs through `Date.UTC` and reads back with `getUTC*` for the
 * reason `dayLabel` already gives (`format.ts:44-52`): the string names a
 * calendar day, and parsing it in the viewer's timezone would step to the wrong
 * one for anybody west of Greenwich. Comparisons are lexicographic, which is
 * exact for zero-padded ISO dates and needs no parsing at all.
 */

export type DayRelation = 'past' | 'today' | 'future';

/**
 * The reach, in days either side of today.
 *
 * Forward is the ask: seven days is as far as anything could be published.
 * Backward is the same number because this is a *stepper*, not a picker —
 * seven presses is about the practical ceiling of one, and reaching deeper into
 * history wants a calendar, which is a different control.
 */
export const DAY_REACH_FORWARD = 7;
export const DAY_REACH_BACK = 7;

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD`, `days` later. Negative steps back. */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function dayOffset(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (!fy || !fm || !fd || !ty || !tm || !td) return 0;
  const ms = Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd);
  return Math.round(ms / 86_400_000);
}

/** Whether `date` is inside the reach around `today`. */
export function withinReach(date: string, today: string): boolean {
  const offset = dayOffset(today, date);
  return offset >= -DAY_REACH_BACK && offset <= DAY_REACH_FORWARD;
}

/** Whether stepping `delta` days from `date` lands somewhere reachable. */
export function canStepDay(date: string, today: string, delta: number): boolean {
  return withinReach(shiftDate(date, delta), today);
}

export function dayRelation(date: string, today: string): DayRelation {
  if (date === today) return 'today';
  return date < today ? 'past' : 'future';
}

/**
 * `Today` / `Tomorrow` / `+3 days`, the badge under the date.
 *
 * The date alone does not say how far from now it is, and that is the one thing
 * a reader who has stepped four times needs to know. Negative offsets use the
 * house MINUS rather than a hyphen, since this sits in mono type beside the
 * timeline where a hyphen would sit narrow.
 */
export function relativeDayLabel(date: string, today: string): string {
  const offset = dayOffset(today, date);
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  if (offset === -1) return 'Yesterday';
  const magnitude = Math.abs(offset);
  return `${offset > 0 ? '+' : MINUS}${magnitude} days`;
}
