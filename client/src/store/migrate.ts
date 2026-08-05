import type { TimePreset, TimeAnchor } from '@/types';

export const PERSIST_VERSION = 6;

const VALID_VIEWS = new Set(['map', 'country', 'comparison']);

// Anchor implied by each preset, mirroring `setTimePreset` (dashboardStore.ts),
// and — via its keys — the set of values `TimePreset` can still hold.
//
// Typed `Record<TimePreset, TimeAnchor>` so the compiler names any preset added
// to the union without a decision here (`client/src/types/index.ts:115`). It
// used to be a `Record<string, string>` listing only the non-past presets, with
// a `?? 'past'` default and a hand-maintained `VALID_TIME_PRESETS` literal
// beside it: a new preset was then silently reset to '7d' on the next version
// bump, or silently anchored 'past'. Neither failed a build or a test.
//
// The literal was kept separate to avoid importing anything into this module —
// it must stay loadable by the store alone, with no pull on the hooks/React
// Query graph. That still holds: `@/types` declares only types (no runtime
// exports at all), so `import type` erases entirely and adds no edge.
const ANCHOR_FOR_PRESET: Record<TimePreset, TimeAnchor> = {
  '24h': 'past',
  '7d': 'past',
  '30d': 'past',
  today: 'now',
  thisWeek: 'now',
  next1d: 'future',
  next24h: 'future',
  next48h: 'future',
  next7d: 'future',
};

const VALID_TIME_PRESETS = new Set<string>(Object.keys(ANCHOR_FOR_PRESET));

// Real tab values, read off the `TabsTrigger` elements in
// CountryDashboardView.tsx — NOT their visible labels. `renewables` renders
// as "Generation" and `analytics` renders as "Forecast accuracy".
const VALID_CHART_TABS = new Set(['price', 'load', 'renewables', 'net-position', 'analytics']);

/**
 * Bring persisted state forward. Without this a shape change left returning
 * users on state the code no longer understands — a stale `currentView` sent
 * fresh sessions straight into a country view they never chose, and an
 * invalid `activeChartTab` rendered a completely blank tab panel with no
 * chart and no fallback message.
 *
 * `state` comes from arbitrary, possibly years-old localStorage blobs, so
 * every field is treated as untrusted: this must never throw on garbage.
 */
export function migratePersisted(state: Record<string, unknown>, fromVersion: number): Record<string, unknown> {
  if (fromVersion >= PERSIST_VERSION) return state;

  const next = { ...state };

  if (typeof next.currentView !== 'string' || !VALID_VIEWS.has(next.currentView)) {
    next.currentView = 'map';
  }

  if (typeof next.activeChartTab !== 'string' || !VALID_CHART_TABS.has(next.activeChartTab)) {
    next.activeChartTab = 'load';
  }

  // `layers` (a `{ tso, ml }` blob) predates the per-tab model picker. Every
  // chart has since moved to `useModelSelection` as its single source of
  // truth for which forecast overlay to show (Load: Task 22; Price: the
  // price-picker fix), and nothing anywhere writes to `layers` any more —
  // it, and the four booleans this used to derive from it
  // (showForecast/showTSOForecast/showComparisonMode/showTSOComparisonMode),
  // are dead: no live chart reads them for whether to render a forecast.
  //
  // Deriving from it was actively harmful, not just redundant: `layers.ml`
  // defaulted to `enabled: false` and nothing could ever set it `true`, so
  // this clause unconditionally overwrote `showForecast` with `false` on
  // every migration — clobbering a value the *current* code had legitimately
  // set moments earlier (e.g. jumping to a future time preset sets
  // `showForecast: true` directly, with no `layers` involved at all). A
  // returning user could lose a forecast they had on simply because a stale
  // `layers` fossil happened to still be sitting in their persisted blob.
  //
  // The fix is to stop deriving anything from it and just drop the dead key
  // so it stops shallow-merging back into state on every load.
  delete next.layers;

  // MAPE was replaced by WAPE (degenerate metric: divided by the signed
  // actual, so negative prices cancelled error, and a near-zero actual could
  // dominate the mean — see crossCountryMetricsService.ts). A persisted
  // 'mape' selection no longer matches a real option in the toggle group.
  if (next.comparisonMetric === 'mape') {
    next.comparisonMetric = 'wape';
  }

  // `timeRange` (the legacy '24h'|'7d'|'30d'|'90d'|'1y' enum, hand-synced
  // from `timePreset` in `setTimePreset`) is gone — `/dashboard/overview` and
  // `/dashboard/map` now take an explicit `start`/`end` window computed from
  // `timePreset`/`timeOffset` via `getDateRangeForPreset`, the same source
  // every other hook already used, and the header stat's qualifier
  // (windowLabel.ts) reads `timePreset` again now that it can't disagree
  // with what was actually fetched. Nothing declares or reads `timeRange` any
  // more; left in a persisted blob it would just keep re-appearing (a stale,
  // inert field) every time this migration's shallow merge ran. Drop it so
  // it doesn't outlive the field it described.
  delete next.timeRange;

  // `analyticsConfig` (the `{ forecastType, selectedProviders, selectedHorizons,
  // timeRange, rollingWindow }` blob) was the last holder of a nested
  // `timeRange` field, now that the top-level one above is gone. It backed
  // the analytics dashboard (ForecastAnalyticsPanel, AccuracyTrendChart, and
  // friends under components/analytics/), which was removed as dead code —
  // no barrel importer remained. Its store actions
  // (setAnalyticsForecastType/toggleAnalyticsProvider/toggleAnalyticsTSOHorizon/
  // toggleAnalyticsMLHorizon/setAnalyticsTimeRange/setAnalyticsRollingWindow/
  // resetAnalyticsConfig) are gone too — nothing calls them. Drop the blob so
  // it doesn't outlive the slice it configured.
  delete next.analyticsConfig;

  // `90d` and `1y` are no longer `TimePreset` values (ABL-4): nothing in the
  // UI could set them, and `getDateRangeForPreset` / `WINDOW_LABEL` /
  // `PRESET_SHIFT_HOURS` no longer carry a branch for either. A returning
  // user can still have one persisted from a build that did, and the persist
  // middleware shallow-merges old state over the defaults — so an unmigrated
  // '90d' would survive into a store the code no longer understands: the
  // header qualifier would fall through to the raw string ("90d"), no
  // TimePicker button would read as active, and `getDateRangeForPreset`
  // would quietly serve the `default` 7-day window while the page claimed 90
  // days. Reset anything outside the union to the store's own default.
  //
  // The anchor is re-derived rather than trusted: it is persisted separately
  // and only `setTimePreset` keeps the pair consistent, so a blob written by
  // any other path can carry a mismatched one.
  if (typeof next.timePreset !== 'string' || !VALID_TIME_PRESETS.has(next.timePreset)) {
    next.timePreset = '7d';
  }
  // `timePreset` is guaranteed to be in the union by the check above, so this
  // lookup always hits; the `?? 'past'` guards the cast, not a real gap.
  next.timeAnchor = ANCHOR_FOR_PRESET[next.timePreset as TimePreset] ?? 'past';

  return next;
}
