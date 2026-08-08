import { describe, it, expect } from 'vitest';
import {
  DISCLOSE_AFTER_HOURS,
  WITHHOLD_AFTER_HOURS,
  describeReadingFreshness,
  formatAge,
  parseUtcTimestamp,
} from './readingFreshness';

// Fixed "now" so these never drift: 2026-08-07T05:44:05Z, the instant the
// ABL-58 evidence below was measured against the replica.
const NOW = new Date('2026-08-07T05:44:05Z');

describe('parseUtcTimestamp', () => {
  it('reads the space-separated form as UTC', () => {
    expect(parseUtcTimestamp('2026-08-06 23:45:00')).toBe(Date.UTC(2026, 7, 6, 23, 45, 0));
  });

  it("reads the 'T'-separated, zone-less form as UTC, not local", () => {
    // 279,880 rows in energy_load carry this shape, including every GB and UA
    // row. Left to Date.parse it would be read as local time.
    expect(parseUtcTimestamp('2021-06-14T09:00:00')).toBe(Date.UTC(2021, 5, 14, 9, 0, 0));
  });

  it('respects an explicit zone designator', () => {
    expect(parseUtcTimestamp('2026-08-06T23:45:00Z')).toBe(Date.UTC(2026, 7, 6, 23, 45, 0));
    expect(parseUtcTimestamp('2026-08-07T01:45:00+02:00')).toBe(Date.UTC(2026, 7, 6, 23, 45, 0));
  });

  it('returns null rather than NaN for missing or unparseable input', () => {
    expect(parseUtcTimestamp(undefined)).toBeNull();
    expect(parseUtcTimestamp(null)).toBeNull();
    expect(parseUtcTimestamp('')).toBeNull();
    expect(parseUtcTimestamp('   ')).toBeNull();
    expect(parseUtcTimestamp('not a date')).toBeNull();
  });
});

describe('formatAge', () => {
  it('reports hours below two days', () => {
    expect(formatAge(2)).toBe('2h');
    expect(formatAge(32.7)).toBe('33h');
    expect(formatAge(47.4)).toBe('47h');
  });

  it('reports days, months, then years as the gap widens', () => {
    expect(formatAge(72)).toBe('3d');
    expect(formatAge(24 * 45)).toBe('45d');
    expect(formatAge(24 * 120)).toBe('4mo');
    expect(formatAge(24 * 400)).toBe('13mo'); // months run to 24 before switching
    expect(formatAge(24 * 800)).toBe('2y');
    expect(formatAge(45116.7)).toBe('5y'); // GB, measured
    expect(formatAge(38968.7)).toBe('4y'); // UA, measured
  });
});

describe('describeReadingFreshness', () => {
  const at = (isoOrDbForm: string) => describeReadingFreshness(isoOrDbForm, NOW);

  it('shows a reading inside the publication-lag threshold with no caveat', () => {
    const r = describeReadingFreshness(
      new Date(NOW.getTime() - 1.5 * 3_600_000).toISOString(),
      NOW,
    );
    expect(r.usable).toBe(true);
    expect(r.qualifier).toBeNull();
  });

  it('captions but still shows the healthy 6-8h ENTSO-E lag', () => {
    // Measured 2026-08-07: DE 5.7h, FR 5.5h, most of the fleet 6-8h behind.
    const r = at('2026-08-06 23:30:00');
    expect(r.usable).toBe(true);
    expect(r.qualifier).toBe('as of 6h ago');
  });

  it('captions but still shows MK at 33h, matching the chart caption', () => {
    const r = at('2026-08-05 21:00:00');
    expect(r.usable).toBe(true);
    expect(r.qualifier).toBe('as of 33h ago');
  });

  it('withholds GB, five years stale, instead of captioning it', () => {
    // The incident itself: currentLoad 37273 under the label "CURRENT LOAD".
    const r = at('2021-06-14T09:00:00');
    expect(r.usable).toBe(false);
    expect(r.qualifier).toBe('last reading 5y ago');
  });

  it('withholds UA, four and a half years stale', () => {
    const r = at('2022-02-25T13:00:00');
    expect(r.usable).toBe(false);
    expect(r.qualifier).toBe('last reading 4y ago');
  });

  it('withholds a reading with no timestamp at all rather than assuming it is fresh', () => {
    for (const bad of [undefined, null, '', 'not a date']) {
      const r = describeReadingFreshness(bad, NOW);
      expect(r.usable).toBe(false);
      expect(r.ageHours).toBeNull();
      expect(r.qualifier).toBe('age unknown');
    }
  });

  it('treats a future-stamped reading as fresh, not negatively aged', () => {
    const r = describeReadingFreshness(
      new Date(NOW.getTime() + 3 * 3_600_000).toISOString(),
      NOW,
    );
    expect(r.usable).toBe(true);
    expect(r.ageHours).toBe(0);
    expect(r.qualifier).toBeNull();
  });

  it('switches behaviour exactly at the two documented boundaries', () => {
    const hoursAgo = (h: number) =>
      describeReadingFreshness(new Date(NOW.getTime() - h * 3_600_000).toISOString(), NOW);

    expect(hoursAgo(DISCLOSE_AFTER_HOURS - 0.01).qualifier).toBeNull();
    expect(hoursAgo(DISCLOSE_AFTER_HOURS).qualifier).not.toBeNull();
    expect(hoursAgo(DISCLOSE_AFTER_HOURS).usable).toBe(true);

    expect(hoursAgo(WITHHOLD_AFTER_HOURS).usable).toBe(true);
    expect(hoursAgo(WITHHOLD_AFTER_HOURS + 0.01).usable).toBe(false);
  });
});
