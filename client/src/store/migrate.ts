export const PERSIST_VERSION = 2;

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

  const layers = next.layers as
    | { tso?: { enabled?: boolean; showAccuracy?: boolean }; ml?: { enabled?: boolean; showAccuracy?: boolean } }
    | undefined;
  if (layers && typeof layers === 'object') {
    next.showTSOForecast = !!layers.tso?.enabled;
    next.showForecast = !!layers.ml?.enabled;
    next.showTSOComparisonMode = !!layers.tso?.showAccuracy;
    next.showComparisonMode = !!layers.ml?.showAccuracy;
  }

  // MAPE was replaced by WAPE (degenerate metric: divided by the signed
  // actual, so negative prices cancelled error, and a near-zero actual could
  // dominate the mean — see crossCountryMetricsService.ts). A persisted
  // 'mape' selection no longer matches a real option in the toggle group.
  if (next.comparisonMetric === 'mape') {
    next.comparisonMetric = 'wape';
  }

  return next;
}
