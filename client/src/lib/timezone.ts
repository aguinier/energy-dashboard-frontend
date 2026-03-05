import { toZonedTime, fromZonedTime } from 'date-fns-tz';

const BRUSSELS_TZ = 'Europe/Brussels';

/**
 * Get today's date range in Brussels timezone (00:00:00 - 23:59:59)
 * Returns dates in UTC for database queries
 */
export function getTodayBrussels(referenceDate: Date = new Date()): { start: Date; end: Date } {
  // Get current time in Brussels
  const brusselsNow = toZonedTime(referenceDate, BRUSSELS_TZ);

  // Start of day in Brussels (00:00:00)
  const brusselsStart = new Date(brusselsNow);
  brusselsStart.setHours(0, 0, 0, 0);

  // End of day in Brussels (23:59:59)
  const brusselsEnd = new Date(brusselsNow);
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
export function getNextDayBrussels(referenceDate: Date = new Date()): { start: Date; end: Date } {
  // Get current time in Brussels
  const brusselsNow = toZonedTime(referenceDate, BRUSSELS_TZ);

  // Tomorrow in Brussels
  const brusselsTomorrow = new Date(brusselsNow);
  brusselsTomorrow.setDate(brusselsTomorrow.getDate() + 1);

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
