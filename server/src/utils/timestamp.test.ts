import { describe, it, expect } from 'vitest';
import { normalizeTimestamp, toIsoUtc } from './timestamp.js';

describe('normalizeTimestamp', () => {
  it('converts an ISO instant to SQLite text form', () => {
    expect(normalizeTimestamp('2025-12-27T00:00:00.000Z')).toBe('2025-12-27 00:00:00');
  });

  it('leaves an already-normalized value alone', () => {
    expect(normalizeTimestamp('2025-12-27 00:00:00')).toBe('2025-12-27 00:00:00');
  });
});

describe('toIsoUtc', () => {
  // Both shapes really are in the table - see the module comment.
  it('stamps the zone on the space-separated form', () => {
    expect(toIsoUtc('2026-08-06 23:45:00')).toBe('2026-08-06T23:45:00Z');
  });

  it("stamps the zone on the 'T'-separated form (GB/UA's rows)", () => {
    expect(toIsoUtc('2021-06-14T09:00:00')).toBe('2021-06-14T09:00:00Z');
  });

  it('parses back to the same instant regardless of the reader\'s timezone', () => {
    // The point of the whole helper: no local-time reinterpretation.
    expect(Date.parse(toIsoUtc('2021-06-14T09:00:00')!)).toBe(Date.UTC(2021, 5, 14, 9, 0, 0));
    expect(Date.parse(toIsoUtc('2021-06-14 09:00:00')!)).toBe(Date.UTC(2021, 5, 14, 9, 0, 0));
  });

  it('does not double-stamp a value that already carries a zone', () => {
    expect(toIsoUtc('2026-08-06T23:45:00Z')).toBe('2026-08-06T23:45:00Z');
    expect(toIsoUtc('2026-08-06T23:45:00+02:00')).toBe('2026-08-06T23:45:00+02:00');
  });

  it('returns undefined for a missing or blank value', () => {
    expect(toIsoUtc(undefined)).toBeUndefined();
    expect(toIsoUtc(null)).toBeUndefined();
    expect(toIsoUtc('')).toBeUndefined();
    expect(toIsoUtc('   ')).toBeUndefined();
  });
});
