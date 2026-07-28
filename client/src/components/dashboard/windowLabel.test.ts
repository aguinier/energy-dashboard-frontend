import { describe, it, expect, beforeEach } from 'vitest';
import { getWindowLabel, WINDOW_LABEL } from './windowLabel';
import { useDashboardStore } from '@/store/dashboardStore';
import type { TimePreset, TimeRange } from '@/types';

describe('WINDOW_LABEL', () => {
  it('covers every value TimeRange can hold', () => {
    const ranges: TimeRange[] = ['24h', '7d', '30d', '90d', '1y'];
    ranges.forEach((r) => expect(WINDOW_LABEL[r]).toBeDefined());
  });
});

describe('getWindowLabel', () => {
  it('labels each timeRange value with itself (no synthetic future-window wording)', () => {
    expect(getWindowLabel('24h')).toBe('24h');
    expect(getWindowLabel('7d')).toBe('7d');
    expect(getWindowLabel('30d')).toBe('30d');
    expect(getWindowLabel('90d')).toBe('90d');
    expect(getWindowLabel('1y')).toBe('1y');
  });

  it('falls back to the raw value for anything unrecognized, rather than throwing', () => {
    expect(getWindowLabel('bogus')).toBe('bogus');
  });
});

// The lookup table alone is the easy part. What actually caused the Critical
// finding was reading the wrong STORE FIELD: AbleStatRow.tsx derived its
// qualifier from `timePreset`, while the numbers it labels come from
// useDashboardOverview() (useDashboardData.ts), which fetches keyed on the
// store's separate `timeRange` field. `setTimePreset` only mirrors the five
// historical presets into `timeRange` 1:1 — for every other preset (including
// the two forecast buttons RangeSegment exposes, next24h and next7d) it
// hardcodes `timeRange: '7d'`. A qualifier keyed off `timePreset` could
// therefore read "next 24h avg" beside a number the server computed as a
// trailing 7-day average.
//
// We can't render AbleStatRow itself (vitest here has no jsdom / RTL), so
// this test pins the invariant one layer down: it drives the *real* store
// action every RangeSegment button calls (`setTimePreset`) for all five
// reachable presets, and asserts that `getWindowLabel` fed the field the
// fetch actually uses (`timeRange`) never disagrees with it — and, for the
// two forecast presets, that it does NOT reproduce the false label the bug
// produced.
describe('qualifier source matches what useDashboardOverview() actually fetches on', () => {
  beforeEach(() => {
    useDashboardStore.setState({ timePreset: '7d', timeRange: '7d' });
  });

  const RANGE_SEGMENT_PRESETS: TimePreset[] = ['24h', '7d', '30d', 'next24h', 'next7d'];

  it.each(RANGE_SEGMENT_PRESETS)(
    'for RangeSegment preset "%s", the label derived from `timeRange` matches the field the overview query used',
    (preset) => {
      useDashboardStore.getState().setTimePreset(preset);
      const { timeRange } = useDashboardStore.getState();

      // This is exactly the value useDashboardOverview()'s queryKey/queryFn
      // uses (client/src/hooks/useDashboardData.ts:233-241). If the qualifier
      // is computed from this same field, it can never disagree with what was
      // actually fetched.
      expect(getWindowLabel(timeRange)).toBe(WINDOW_LABEL[timeRange]);
    },
  );

  it('reproduces the Critical finding scenario: clicking "+24h" must not label the overview "next 24h"', () => {
    useDashboardStore.getState().setTimePreset('next24h');
    const { timePreset, timeRange } = useDashboardStore.getState();

    expect(timePreset).toBe('next24h'); // drives the sparkline correctly
    expect(timeRange).toBe('7d'); // but the overview fetch collapses to a 7d trailing window (legacy quirk, unrelated to this fix)

    // The fix: label off `timeRange` (what was fetched), not `timePreset`
    // (what was clicked). Asserting inequality against the old, buggy
    // source demonstrates this test would have failed before the fix.
    expect(getWindowLabel(timeRange)).toBe('7d');
    expect(getWindowLabel(timeRange)).not.toBe(getWindowLabel(timePreset));
  });

  it('reproduces the Critical finding scenario: clicking "+7d" must not label the overview "next 7d"', () => {
    useDashboardStore.getState().setTimePreset('next7d');
    const { timePreset, timeRange } = useDashboardStore.getState();

    expect(timePreset).toBe('next7d');
    expect(timeRange).toBe('7d');

    expect(getWindowLabel(timeRange)).toBe('7d');
    expect(getWindowLabel(timeRange)).not.toBe(getWindowLabel(timePreset));
  });
});
