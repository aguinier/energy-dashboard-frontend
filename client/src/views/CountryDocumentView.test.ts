import { describe, it, expect } from 'vitest';
import { asUtc, hourBucket } from './CountryDocumentView';

/**
 * `asUtc`/`hourBucket` encode a measured timezone hazard: `energy_load
 * .timestamp_utc` is genuinely UTC but is serialised without a zone
 * (`REPLACE(timestamp_utc, ' ', 'T')`, `loadService.ts:18`), while the TSO
 * forecast endpoint's timestamps carry an explicit `Z`
 * (`tsoForecastService.ts:69`). A bare `new Date(...)` on the former is
 * parsed as *local* time, silently wrong by the browser's UTC offset.
 *
 * These cases were verified by hand under `TZ=Europe/Brussels` before this
 * file existed (final whole-branch review, Ruling 4) — committing them here
 * so the verification survives rather than being thrown away.
 */
describe('asUtc', () => {
  it('appends Z to a timestamp with no zone', () => {
    expect(asUtc('2026-08-28T12:00:00')).toBe('2026-08-28T12:00:00Z');
  });

  it('leaves an already-Z-suffixed timestamp alone', () => {
    expect(asUtc('2026-08-28T12:00:00Z')).toBe('2026-08-28T12:00:00Z');
  });

  it('leaves an explicit offset alone', () => {
    expect(asUtc('2026-08-28T12:00:00+02:00')).toBe('2026-08-28T12:00:00+02:00');
  });

  it('leaves a space-separated timestamp with a zone alone, appends otherwise', () => {
    expect(asUtc('2026-08-28 12:00:00')).toBe('2026-08-28 12:00:00Z');
  });
});

describe('hourBucket', () => {
  // The shape `loadService.ts:18` emits: no 'Z', no offset. Without asUtc this
  // would parse as local time and skew the bucket by the runner's UTC offset.
  it('buckets a zone-less timestamp as UTC, not local time', () => {
    expect(hourBucket('2026-08-28T12:00:00')).toBe('2026-08-28T12:00:00.000Z');
  });

  it('buckets an explicit-Z timestamp to the same hour', () => {
    expect(hourBucket('2026-08-28T12:00:00Z')).toBe('2026-08-28T12:00:00.000Z');
  });

  // The pairing the residual strip depends on: quarter-hourly actual load
  // must bucket into the same hour as the day-ahead forecast's on-the-hour
  // point, or buildResidualSeries pairs nothing.
  it('buckets a quarter-hourly actual into its hourly forecast bucket', () => {
    expect(hourBucket('2026-08-28T12:15:00')).toBe('2026-08-28T12:00:00.000Z');
    expect(hourBucket('2026-08-28T12:15:00')).toBe(hourBucket('2026-08-28T12:00:00Z'));
  });

  it('converts an explicit non-UTC offset to its UTC hour', () => {
    expect(hourBucket('2026-08-28T12:00:00+02:00')).toBe('2026-08-28T10:00:00.000Z');
  });

  // CLAUDE.md: every timestamp column can hold both T- and space-separated
  // forms, writer- and era-dependent.
  it('buckets the space-separated form the same as the T-separated one', () => {
    expect(hourBucket('2026-08-28 12:00:00')).toBe('2026-08-28T12:00:00.000Z');
  });
});
