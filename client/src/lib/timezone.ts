import { toZonedTime, fromZonedTime } from 'date-fns-tz';

const BRUSSELS_TZ = 'Europe/Brussels';

/**
 * Both helpers take `dayOffset` in whole Brussels **calendar** days
 * (-1 = the previous market day). That is deliberately not the same thing as
 * moving the reference instant back 24 hours.
 *
 * A Brussels day is 23, 24 or 25 hours long across a DST boundary, so no fixed
 * hour offset lands on the adjacent market day every time: 24h back from
 * 26 Oct 23:59 CET is still 26 Oct (the 25-hour day), and 25h back from
 * 5 Aug 00:30 skips over 4 Aug entirely. Day-ahead delivery days are calendar
 * days, so the step has to be calendar arithmetic — applied here to the zoned
 * wall-clock fields, before `fromZonedTime` resolves them back to UTC.
 *
 * This is what lets `shiftTimeWindow` move `today`/`next1d` by exactly one
 * market day (PRESET_SHIFT_HOURS, lib/constants.ts) instead of by half a
 * window, which for a day-aligned preset could land on the same day again and
 * render an unchanged chart under a caption claiming a different day.
 */

/**
 * Get today's date range in Brussels timezone (00:00:00 - 23:59:59)
 * Returns dates in UTC for database queries
 */
export function getTodayBrussels(
  referenceDate: Date = new Date(),
  dayOffset: number = 0,
): { start: Date; end: Date } {
  // Get current time in Brussels
  const brusselsNow = toZonedTime(referenceDate, BRUSSELS_TZ);

  // Start of day in Brussels (00:00:00)
  const brusselsStart = new Date(brusselsNow);
  brusselsStart.setDate(brusselsStart.getDate() + dayOffset);
  brusselsStart.setHours(0, 0, 0, 0);

  // End of day in Brussels (23:59:59)
  const brusselsEnd = new Date(brusselsNow);
  brusselsEnd.setDate(brusselsEnd.getDate() + dayOffset);
  brusselsEnd.setHours(23, 59, 59, 999);

  // Convert back to UTC
  return {
    start: fromZonedTime(brusselsStart, BRUSSELS_TZ),
    end: fromZonedTime(brusselsEnd, BRUSSELS_TZ),
  };
}

/**
 * Get next day's date range in Brussels timezone (00:00:00 - 23:59:59)
 * Returns dates in UTC for database queries
 */
export function getNextDayBrussels(
  referenceDate: Date = new Date(),
  dayOffset: number = 0,
): { start: Date; end: Date } {
  // Get current time in Brussels
  const brusselsNow = toZonedTime(referenceDate, BRUSSELS_TZ);

  // Tomorrow in Brussels, plus any whole-day shift
  const brusselsTomorrow = new Date(brusselsNow);
  brusselsTomorrow.setDate(brusselsTomorrow.getDate() + 1 + dayOffset);

  // Start of tomorrow in Brussels (00:00:00)
  const brusselsStart = new Date(brusselsTomorrow);
  brusselsStart.setHours(0, 0, 0, 0);

  // End of tomorrow in Brussels (23:59:59)
  const brusselsEnd = new Date(brusselsTomorrow);
  brusselsEnd.setHours(23, 59, 59, 999);

  // Convert back to UTC
  return {
    start: fromZonedTime(brusselsStart, BRUSSELS_TZ),
    end: fromZonedTime(brusselsEnd, BRUSSELS_TZ),
  };
}
