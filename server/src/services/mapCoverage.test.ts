import { describe, expect, it } from 'vitest';
import {
  MAP_WINDOW_COVERAGE_HOURS,
  applyWindowCoverage,
  reachesWindow,
} from './mapCoverage.js';
import { timestampRange } from '../utils/timestamp.js';
import type { MapDataPoint } from '../types/index.js';

const WINDOW_END = '2026-09-10 09:00:00';
const range = timestampRange('2026-08-11T09:00:00Z', '2026-09-10T09:00:00Z');

describe('reachesWindow', () => {
  it('accepts a country publishing right up to the window end', () => {
    expect(reachesWindow('2026-09-10 08:00:00', WINDOW_END)).toBe(true);
  });

  it('accepts the slowest healthy publishers measured on prod 2026-09-10', () => {
    // AL renewable_pct at 32.0h and LV load at 13.2h behind the frontier. Both
    // averages are ~96-99% covered and are real information.
    expect(reachesWindow('2026-09-09 01:00:00', WINDOW_END)).toBe(true); // 32h
    expect(reachesWindow('2026-09-09 19:48:00', WINDOW_END)).toBe(true); // 13.2h
  });

  it('withholds the three streams that had stopped on prod 2026-09-10', () => {
    expect(reachesWindow('2026-08-30 22:30:00', WINDOW_END)).toBe(false); // IE, 247.8h
    expect(reachesWindow('2026-09-06 00:48:00', WINDOW_END)).toBe(false); // MK, 105.2h
    expect(reachesWindow('2026-09-04 21:00:00', WINDOW_END)).toBe(false); // PT, 130h
  });

  it('is inclusive at the cutoff and exclusive just past it', () => {
    expect(reachesWindow('2026-09-08 09:00:00', WINDOW_END)).toBe(true); // exactly 48h
    expect(reachesWindow('2026-09-08 08:59:00', WINDOW_END)).toBe(false);
  });

  it('reads both stored separator forms as the same instant', () => {
    expect(reachesWindow('2026-09-10T08:00:00', WINDOW_END)).toBe(
      reachesWindow('2026-09-10 08:00:00', WINDOW_END)
    );
    expect(reachesWindow('2026-08-30T22:30:00', WINDOW_END)).toBe(false);
  });

  it('treats a bare stored timestamp as UTC, not as the host timezone', () => {
    // On a UTC+2 box a local-time reading of the bare form would place this row
    // two hours earlier and flip the verdict at the boundary.
    expect(reachesWindow('2026-09-08 09:30:00', WINDOW_END)).toBe(true);
    expect(reachesWindow('2026-09-08 07:30:00', WINDOW_END)).toBe(false);
  });

  it('judges against the window end, not against now', () => {
    // A window that closed a year ago: every country in it is ancient relative
    // to `now`, and all of them still cover their own window.
    const historicEnd = '2025-09-10 09:00:00';
    expect(reachesWindow('2025-09-10 08:00:00', historicEnd)).toBe(true);
  });

  it('withholds rather than paints when either side is unparseable', () => {
    expect(reachesWindow(null, WINDOW_END)).toBe(false);
    expect(reachesWindow('', WINDOW_END)).toBe(false);
    expect(reachesWindow('not-a-timestamp', WINDOW_END)).toBe(false);
    expect(reachesWindow('2026-09-10 08:00:00', 'not-a-timestamp')).toBe(false);
  });

  it('covers a row newer than the window end', () => {
    expect(reachesWindow('2026-09-11 00:00:00', WINDOW_END)).toBe(true);
  });

  it('exposes the cutoff it was sized to', () => {
    expect(MAP_WINDOW_COVERAGE_HOURS).toBe(48);
  });
});

describe('applyWindowCoverage', () => {
  const rows: MapDataPoint[] = [
    { country_code: 'FR', country_name: 'France', value: 51234, timestamp: '2026-09-10 08:00:00' },
    { country_code: 'IE', country_name: 'Ireland', value: 3849, timestamp: '2026-08-30 22:30:00' },
  ];

  it('keeps a covered country untouched apart from the ISO stamp', () => {
    const [fr] = applyWindowCoverage(rows, range);
    expect(fr).toEqual({
      country_code: 'FR',
      country_name: 'France',
      value: 51234,
      timestamp: '2026-09-10T08:00:00Z',
    });
    expect(fr.coverage).toBeUndefined();
  });

  it('nulls a stopped country and says why, instead of dropping or zeroing it', () => {
    const [, ie] = applyWindowCoverage(rows, range);
    expect(ie.value).toBeNull();
    expect(ie.value).not.toBe(0);
    expect(ie.coverage).toBe('ended');
    // The row survives so the client can say which kind of blank this is.
    expect(applyWindowCoverage(rows, range)).toHaveLength(2);
  });

  it('carries the last published instant on the withheld row', () => {
    const [, ie] = applyWindowCoverage(rows, range);
    expect(ie.timestamp).toBe('2026-08-30T22:30:00Z');
  });

  it('does not mutate its input', () => {
    applyWindowCoverage(rows, range);
    expect(rows[1].value).toBe(3849);
    expect(rows[1].timestamp).toBe('2026-08-30 22:30:00');
  });

  it('stamps a timestamp that already carries a zone without doubling it', () => {
    const [row] = applyWindowCoverage(
      [{ country_code: 'PL', country_name: 'Poland', value: 20000, timestamp: '2026-09-10T08:00:00+02:00' }],
      range
    );
    expect(row.timestamp).toBe('2026-09-10T08:00:00+02:00');
    expect(row.value).toBe(20000);
  });

  it('withholds a row with no timestamp at all', () => {
    const [row] = applyWindowCoverage(
      [{ country_code: 'XX', country_name: 'Nowhere', value: 1 }],
      range
    );
    expect(row.value).toBeNull();
    expect(row.coverage).toBe('ended');
  });
});
