import type { TimePreset } from '@/types';

// The categorised time picker's contents — quick access / historical / around
// now / forecast. This was the `TIME_PRESETS` design spec in lib/constants.ts,
// written down but never wired to a control (ABL-4 kept it deliberately while
// the product decision sat with the CEO). ABL-12 answered "build it", so it is
// live code now and lives beside the component that renders it.
//
// Two things changed on the way in:
//
//   - It is typed against `TimePreset`, so it can no longer drift from the
//     union the way the spec object had. The spec listed `90d` and `1y`, which
//     ABL-4 had already removed from `TimePreset`; as an untyped `as const`
//     blob nothing said so. They are not re-added here — ABL-12 was about the
//     four *unreachable* presets (`today`/`thisWeek`/`next1d`/`next48h`), and
//     re-adding a 90d/1y window is a separate question about granularity and
//     query cost, not a wiring job.
//   - Every `TimePreset` value now appears in at least one group, and
//     `timePresets.test.ts` enforces that. This was the one failure mode of
//     the six in `types/index.ts` that no compiler check could catch: a preset
//     with no control is unreachable, not ill-typed. It is a test failure now.
export interface TimePresetItem {
  value: TimePreset;
  label: string;
}

export interface TimePresetGroup {
  id: string;
  label: string;
  items: readonly TimePresetItem[];
}

// Shown inline in the control bar. Deliberately short labels — this row sits
// next to the tab strip and the model picker at h-8.
//
// "Today"/"Tomorrow" rather than "24h"/"+24h": these two are Brussels market
// days (`getTodayBrussels`/`getNextDayBrussels`), i.e. the day-ahead delivery
// days, not a rolling window from whenever the page loaded. The rolling
// equivalents (`24h`, `next24h`) are genuinely different windows and live in
// the groups below under their own names.
export const QUICK_ACCESS_PRESETS: readonly TimePresetItem[] = [
  { value: '7d', label: '7d' },
  { value: 'today', label: 'Today' },
  { value: 'next1d', label: 'Tomorrow' },
  { value: 'next7d', label: '+7d' },
];

// Shown in the "More" popover, grouped by what the window is anchored to.
export const PRESET_GROUPS: readonly TimePresetGroup[] = [
  {
    id: 'historical',
    label: 'Historical',
    items: [
      { value: '24h', label: 'Last 24 hours' },
      { value: '7d', label: 'Last 7 days' },
      { value: '30d', label: 'Last 30 days' },
    ],
  },
  {
    id: 'aroundNow',
    label: 'Around now',
    items: [
      { value: 'today', label: 'Today (market day)' },
      { value: 'thisWeek', label: 'This week (-3d to +4d)' },
    ],
  },
  {
    id: 'forecast',
    label: 'Forecast',
    items: [
      { value: 'next1d', label: 'Tomorrow (market day)' },
      { value: 'next24h', label: 'Next 24 hours' },
      { value: 'next48h', label: 'Next 48 hours' },
      { value: 'next7d', label: 'Next 7 days' },
    ],
  },
];

/** Every preset the UI can actually set. Asserted exhaustive over `TimePreset`. */
export const REACHABLE_PRESETS: ReadonlySet<TimePreset> = new Set<TimePreset>([
  ...QUICK_ACCESS_PRESETS.map((i) => i.value),
  ...PRESET_GROUPS.flatMap((g) => g.items.map((i) => i.value)),
]);
