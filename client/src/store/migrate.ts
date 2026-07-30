export const PERSIST_VERSION = 4;

const VALID_VIEWS = new Set(['map', 'country', 'comparison']);

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

  return next;
}
