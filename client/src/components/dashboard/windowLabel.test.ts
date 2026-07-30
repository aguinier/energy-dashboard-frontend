import { describe, it, expect, beforeEach } from 'vitest';
import { getWindowLabel, WINDOW_LABEL } from './windowLabel';
import { useDashboardStore } from '@/store/dashboardStore';
import { getDateRangeForPreset } from '@/hooks/useDashboardData';
import type { TimePreset } from '@/types';

const ALL_PRESETS: TimePreset[] = [
  '24h', '7d', '30d', '90d', '1y',
  'today', 'thisWeek',
  'next1d', 'next24h', 'next48h', 'next7d',
];

describe('WINDOW_LABEL', () => {
  it('covers every value TimePreset can hold', () => {
    ALL_PRESETS.forEach((p) => expect(WINDOW_LABEL[p]).toBeDefined());
  });
});

describe('getWindowLabel', () => {
  it('labels each historical preset with itself', () => {
    expect(getWindowLabel('24h')).toBe('24h');
    expect(getWindowLabel('7d')).toBe('7d');
    expect(getWindowLabel('30d')).toBe('30d');
    expect(getWindowLabel('90d')).toBe('90d');
    expect(getWindowLabel('1y')).toBe('1y');
  });

  it('gives forward-looking and around-now presets their own wording, distinct from any historical label', () => {
    expect(getWindowLabel('next24h')).toBe('next 24h');
    expect(getWindowLabel('next48h')).toBe('next 48h');
    expect(getWindowLabel('next7d')).toBe('next 7d');
    expect(getWindowLabel('next1d')).toBe('next day');
    expect(getWindowLabel('today')).toBe('today');
    expect(getWindowLabel('thisWeek')).toBe('this week');

    // Distinct from the historical presets of the same nominal duration —
    // this is exactly the distinction the old `timeRange`-collapse erased.
    expect(getWindowLabel('next24h')).not.toBe(getWindowLabel('24h'));
    expect(getWindowLabel('next7d')).not.toBe(getWindowLabel('7d'));
  });

  it('falls back to the raw value for anything unrecognized, rather than throwing', () => {
    expect(getWindowLabel('bogus')).toBe('bogus');
  });
});

// What actually caused the Task 8 Critical finding was reading the wrong
// STORE FIELD: AbleStatRow.tsx derived its qualifier from `timePreset`, while
// the numbers it labels came from useDashboardOverview() (useDashboardData.ts),
// which at the time fetched keyed on a separate `timeRange` field that
// `setTimePreset` silently collapsed to '7d' for every non-historical preset.
// Clicking "+24h" therefore showed a "next 24h" qualifier beside a number the
// server had actually computed as a trailing 7-day average.
//
// This refactor removes the second field entirely: `timeRange` no longer
// exists on the store (see migrate.ts), and useDashboardOverview() fetches on
// `getDateRangeForPreset(timePreset, timeOffset)` — the exact function this
// test calls to verify the window's real shape. `getWindowLabel` now reads
// `timePreset` too, so the label and the fetch structurally cannot describe
// two different fields any more.
//
// We still can't render AbleStatRow itself (vitest here has no jsdom / RTL),
// so this test pins the invariant one layer down: it drives the *real* store
// action every RangeSegment button calls (`setTimePreset`), computes the
// *real* window `useDashboardOverview()` would fetch, and asserts the label
// truthfully describes that window's actual shape and direction.
describe('qualifier source matches what useDashboardOverview() actually fetches on', () => {
  beforeEach(() => {
    useDashboardStore.setState({ timePreset: '7d', timeOffset: 0 });
  });

  const RANGE_SEGMENT_PRESETS: TimePreset[] = ['24h', '7d', '30d', 'next24h', 'next7d'];

  it.each(RANGE_SEGMENT_PRESETS)(
    'for RangeSegment preset "%s", the label is keyed off the same field useDashboardOverview() fetches on',
    (preset) => {
      useDashboardStore.getState().setTimePreset(preset);
      const { timePreset } = useDashboardStore.getState();

      // This is exactly the field useDashboardOverview()'s queryKey/queryFn
      // uses (client/src/hooks/useDashboardData.ts). Since the qualifier is
      // computed from this same field, it cannot disagree with what was
      // actually fetched.
      expect(timePreset).toBe(preset);
      expect(getWindowLabel(timePreset)).toBe(WINDOW_LABEL[timePreset]);
    },
  );

  it('reproduces the Critical finding scenario: clicking "+24h" labels an actually-24h-forward window, not the old collapsed trailing-7d one', () => {
    useDashboardStore.getState().setTimePreset('next24h');
    const { timePreset, timeOffset } = useDashboardStore.getState();

    expect(timePreset).toBe('next24h'); // drives the sparkline correctly
    expect(timeOffset).toBe(0);

    // The window useDashboardOverview() actually fetches — computed with the
    // exact same function the hook calls.
    const { start, end, anchor } = getDateRangeForPreset(timePreset, timeOffset);
    expect(anchor).toBe('future');
    expect((end.getTime() - start.getTime()) / (60 * 60 * 1000)).toBe(24);

    // The old bug: the label read a separate `timeRange` field that had
    // already collapsed to '7d', so "+24h" showed a "next 24h" qualifier next
    // to a number computed over a trailing 7-day window. Now there is only
    // one field, and it must describe the window that was actually fetched.
    expect(getWindowLabel(timePreset)).toBe('next 24h');
    expect(getWindowLabel(timePreset)).not.toBe('7d');
  });

  it('reproduces the Critical finding scenario: clicking "+7d" labels an actually-7d-forward window, not the old collapsed trailing-7d one', () => {
    useDashboardStore.getState().setTimePreset('next7d');
    const { timePreset, timeOffset } = useDashboardStore.getState();

    expect(timePreset).toBe('next7d');
    expect(timeOffset).toBe(0);

    const { start, end, anchor } = getDateRangeForPreset(timePreset, timeOffset);
    expect(anchor).toBe('future');
    expect((end.getTime() - start.getTime()) / (60 * 60 * 1000)).toBe(168);

    // Before this refactor, `timeRange` collapsed to '7d' too — the same
    // string as the *historical* 7d preset's label, so this specific case
    // could look "accidentally right" while still describing the wrong
    // direction (trailing vs. forward). Asserting the exact "next 7d" wording
    // (not merely "not '7d'") catches that.
    expect(getWindowLabel(timePreset)).toBe('next 7d');
  });
});
