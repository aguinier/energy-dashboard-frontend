import { describe, it, expect } from 'vitest';
import { getPriceWindowEnd } from './priceWindow';

/**
 * ABL-54/ABL-51: "at 18:00 CEST the dashboard shows nothing for tomorrow".
 *
 * The ingest was measured innocent (prod already requests through D+1 on every
 * pass) and the API serves future-dated rows (`server/src/routes/prices.test.ts`).
 * What is left on this side is the window the client asks for: every preset
 * except the forward-looking ones ends at or before now, so without this floor
 * tomorrow's published prices are never requested at all.
 *
 * The property under test is a *market day*, not an hour count: the returned
 * end must reach the last quarter-hour of tomorrow's Brussels day, on 23-, 24-
 * and 25-hour days alike.
 */

/** The last stored instant of a Brussels market day is its 23:45 local slot. */
function lastSlotOfBrusselsDay(isoDayUtcMidnightLocal: string): Date {
  return new Date(isoDayUtcMidnightLocal);
}

describe('getPriceWindowEnd', () => {
  it('never narrows a window that already reaches further', () => {
    const now = new Date('2026-08-07T06:00:00Z');
    const farEnd = new Date('2026-08-14T06:00:00Z'); // the `next7d` preset

    expect(getPriceWindowEnd(farEnd, now)).toEqual(farEnd);
  });

  it('extends a now-anchored window to the end of tomorrow', () => {
    // The `7d` default: end === now. Tomorrow (8 Aug, CEST) runs to 21:45 UTC,
    // so an unextended window would stop 40 hours short of the last published
    // price and the tab would draw nothing past this instant.
    const now = new Date('2026-08-07T06:00:00Z');

    const end = getPriceWindowEnd(now, now);

    expect(end.getTime()).toBeGreaterThan(
      lastSlotOfBrusselsDay('2026-08-08T21:45:00Z').getTime()
    );
    expect(end.toISOString()).toBe('2026-08-08T21:59:59.999Z');
  });

  it('covers the last slot of the 25-hour clocks-back day', () => {
    // 2026-10-25 is 25 hours long: it starts 22:00 UTC on the 24th and ends
    // 23:00 UTC on the 25th, so its final quarter-hour is 22:45 UTC. The old
    // `now + 36h` floor reached exactly 22:45:00 when evaluated at the 10:45
    // UTC publication instant and fell short of it at any earlier moment.
    const publication = new Date('2026-10-24T10:45:00Z');
    const fifteenMinutesEarly = new Date('2026-10-24T10:30:00Z');

    for (const now of [publication, fifteenMinutesEarly]) {
      const end = getPriceWindowEnd(now, now);
      expect(end.getTime()).toBeGreaterThanOrEqual(
        lastSlotOfBrusselsDay('2026-10-25T22:45:00Z').getTime()
      );
    }
  });

  it('covers the last slot of the 23-hour clocks-forward day', () => {
    // 2026-03-29 is 23 hours long: 23:00 UTC on the 28th to 22:00 UTC on the
    // 29th, final quarter-hour 21:45 UTC. The risk here is the mirror of the
    // case above — over-reaching is harmless, under-reaching is not.
    const now = new Date('2026-03-28T11:45:00Z');

    const end = getPriceWindowEnd(now, now);

    expect(end.getTime()).toBeGreaterThanOrEqual(
      lastSlotOfBrusselsDay('2026-03-29T21:45:00Z').getTime()
    );
  });

  it('reaches tomorrow from every hour of the day', () => {
    // The floor must not depend on when the page happens to be loaded. Sweeping
    // a whole day is what catches an off-by-one that only bites near midnight.
    for (let hour = 0; hour < 24; hour++) {
      const now = new Date(Date.UTC(2026, 7, 7, hour, 30));
      const end = getPriceWindowEnd(now, now);

      // Tomorrow in Brussels at this instant, and its last quarter-hour.
      const brusselsToday = new Date(
        now.toLocaleString('en-US', { timeZone: 'Europe/Brussels' })
      );
      const expectedDay = new Date(brusselsToday);
      expectedDay.setDate(expectedDay.getDate() + 1);

      expect(end.getTime()).toBeGreaterThan(now.getTime());
      // Local Brussels calendar date of the returned end is tomorrow's.
      const endBrusselsDate = end.toLocaleDateString('en-CA', {
        timeZone: 'Europe/Brussels',
      });
      const expectedDate = expectedDay.toLocaleDateString('en-CA');
      expect(endBrusselsDate).toBe(expectedDate);
    }
  });
});
