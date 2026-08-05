import { describe, it, expect } from 'vitest';
import { QUICK_ACCESS_PRESETS, PRESET_GROUPS, REACHABLE_PRESETS } from './timePresets';
import { WINDOW_LABEL } from './windowLabel';
import type { TimePreset } from '@/types';

// Adding a `TimePreset` touches six places. Five are compile errors: three
// `Record<TimePreset, …>` maps (`PRESET_SHIFT_HOURS`, `WINDOW_LABEL`,
// `ANCHOR_FOR_PRESET`) name the missing key directly, and two `never` guards
// (`getDateRangeForPreset`, `getGranularityForPreset`) reject the new value.
//
// The sixth — giving the preset a control — cannot be typed. A preset with no
// button is unreachable, not ill-typed, which is exactly how `today`,
// `thisWeek`, `next1d` and `next48h` sat in the union for as long as they did
// (ABL-12). These tests are that missing check.
//
// `WINDOW_LABEL` is the runtime enumeration of `TimePreset` here: it is an
// exhaustive `Record<TimePreset, string>`, so the compiler already guarantees
// its key set is the whole union, and reading it back gives this test the
// union at runtime without a second hand-maintained list to drift.
const ALL_PRESETS = Object.keys(WINDOW_LABEL) as TimePreset[];

const PICKER_ITEMS = [
  ...QUICK_ACCESS_PRESETS,
  ...PRESET_GROUPS.flatMap((g) => g.items),
];

describe('the time picker covers TimePreset', () => {
  it.each(ALL_PRESETS)('"%s" is reachable from some control', (preset) => {
    expect(REACHABLE_PRESETS.has(preset)).toBe(true);
  });

  it('has no control for a value that is not a TimePreset', () => {
    // The reverse direction: a button wired to a preset that has since been
    // removed from the union would set state nothing else understands, and
    // `getDateRangeForPreset` would serve its `default` 7-day window.
    for (const item of PICKER_ITEMS) {
      expect(ALL_PRESETS).toContain(item.value);
    }
  });

  it('keeps REACHABLE_PRESETS in step with what is actually rendered', () => {
    expect([...REACHABLE_PRESETS].sort()).toEqual(
      [...new Set(PICKER_ITEMS.map((i) => i.value))].sort(),
    );
  });
});

describe('picker labels', () => {
  // The market-day presets are not the rolling ones: `today` is the Brussels
  // calendar day, `24h` is the trailing 24 hours from now; `next1d` is
  // tomorrow's delivery day, `next24h` is the next 24 hours. Four distinct
  // windows, so four distinct labels — a shared label would invite reading a
  // number computed over one window as if it came from the other.
  it('never gives two presets the same label within one group', () => {
    for (const group of PRESET_GROUPS) {
      const labels = group.items.map((i) => i.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
    const quick = QUICK_ACCESS_PRESETS.map((i) => i.label);
    expect(new Set(quick).size).toBe(quick.length);
  });

  it('distinguishes the market-day presets from the rolling ones', () => {
    const labelFor = (v: TimePreset) =>
      PICKER_ITEMS.filter((i) => i.value === v).map((i) => i.label);

    for (const marketDay of ['today', 'next1d'] as const) {
      for (const rolling of ['24h', 'next24h'] as const) {
        for (const a of labelFor(marketDay)) {
          expect(labelFor(rolling)).not.toContain(a);
        }
      }
    }
  });

  it('gives every item a non-empty label', () => {
    for (const item of PICKER_ITEMS) {
      expect(item.label.trim().length).toBeGreaterThan(0);
    }
  });
});
