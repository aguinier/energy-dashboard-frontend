import { getNextDayBrussels } from './timezone';

/**
 * The end instant a Price-tab fetch must reach, whatever window the preset asks
 * for.
 *
 * Day-ahead auctions publish the WHOLE of the next market day at ~12:45
 * Brussels time, so `energy_price` legitimately holds rows dated in the future
 * and the price window always has to extend past a now-anchored preset's end.
 * Every caller that shares the `['prices', …]` query key MUST use this — the
 * key doesn't encode the window, so two hooks with different windows silently
 * poison each other's cache. That bug hid tomorrow's prices even after the
 * chart itself was fixed.
 *
 * The floor is **the end of tomorrow's Brussels market day**, not a fixed hour
 * count. It used to be `now + 36h`, which was *just* sufficient and only by
 * coincidence: the gap from the earliest plausible publication to the last
 * quarter-hour of the next market day is 35h15m on an ordinary day, and
 * exactly 36h00m on the 25-hour clocks-back day (2026: publication 10:45 UTC on
 * 24 Oct, last row 22:45 UTC on 25 Oct). A published-early auction on that one
 * day would have dropped the day's final row. Naming the market day states the
 * reason instead of leaving a constant that has to be re-derived to be trusted,
 * and it is DST-safe by construction because `getNextDayBrussels` is.
 *
 * `end` still wins when the preset already reaches further out (`next7d`), so
 * this only ever widens a window, never narrows one.
 *
 * @param end   the preset's own window end
 * @param now   injectable for tests; defaults to the current instant
 */
export function getPriceWindowEnd(end: Date, now: Date = new Date()): Date {
  const endOfTomorrowBrussels = getNextDayBrussels(now).end;
  return new Date(Math.max(end.getTime(), endOfTomorrowBrussels.getTime()));
}
