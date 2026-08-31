import type { TimePreset, TimeAnchor } from '@/types';
// `lib/netPositionScope` is a leaf: it imports nothing at all, so this does
// not violate the "loadable by the store alone" note on ANCHOR_FOR_PRESET
// below — it pulls in no hooks and no React Query graph.
import { isNetPositionScope } from '@/lib/netPositionScope';

export const PERSIST_VERSION = 11;

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

  // v7 (ABL-16) — `selectedModelByType` encoded two separate things in one
  // slot: a pinned model id, and `null` for "forecast hidden for this type".
  // Hiding therefore destroyed the pin, so ModelPicker's on-switch had to
  // invent one to restore, and it re-pinned the type's production model. The
  // "Default" dropdown entry wrote a pin too. Either path could pin catboost
  // for a user who never chose it — and the server honours an explicit
  // `model=` strictly (forecastModels.ts `resolveModelCandidates`:
  // `return explicit ? [explicit] : []`), so the chart then went blank on
  // every country catboost has no rows for, permanently and across reloads.
  // Hidden now has its own map, `forecastHiddenByType`.
  //
  // Pins are dropped rather than carried across, deliberately. Under the old
  // picker *every* entry wrote one, so a stored pin is at least as likely to
  // be an artefact of that bug as a deliberate choice, and nothing in the blob
  // distinguishes them. Unpinned is the state that always renders something —
  // the server walks its candidate ladder — and re-pinning is one click. This
  // is also what frees users already trapped, who otherwise had to clear
  // localStorage by hand to get their chart back.
  if (fromVersion < 7) {
    const storedModels = next.selectedModelByType;
    const hiddenByType: Record<string, boolean> = {};
    if (storedModels && typeof storedModels === 'object' && !Array.isArray(storedModels)) {
      for (const [forecastType, value] of Object.entries(storedModels as Record<string, unknown>)) {
        if (value === null) hiddenByType[forecastType] = true;
      }
    }
    next.selectedModelByType = {};
    next.forecastHiddenByType = hiddenByType;
  }

  // v8 (ABL-127) — the portfolio home's persisted default was `all`, which
  // deliberately has no cross-type chart or ranking. Start on load instead:
  // it is a single measurable type with complete coverage, while `all` remains
  // an explicit matrix-only choice in the filter.
  if (fromVersion < 8 && next.comparisonForecastType === 'all') {
    next.comparisonForecastType = 'load';
  }

  // v9 (ABL-203) — `selectedModelByType` held one pin per forecast type.
  // Net position's multi-select picker needs to hold several at once, so
  // every type now stores an array (`selectedModelsByType`). Unlike v7 above,
  // there is no pin/hidden ambiguity to untangle here: by this point any
  // surviving entry is either a genuine pin (a plain string) or already gone,
  // so a single stored pin carries forward as a one-element selection rather
  // than being dropped — a returning user with one net-position model pinned
  // must land on that model selected, not on a blank chart.
  if (fromVersion < 9) {
    const stored = next.selectedModelByType;
    const selectedModelsByType: Record<string, string[]> = {};
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const [forecastType, value] of Object.entries(stored as Record<string, unknown>)) {
        if (typeof value === 'string') selectedModelsByType[forecastType] = [value];
      }
    }
    delete next.selectedModelByType;
    next.selectedModelsByType = selectedModelsByType;
  }

  // v10 (ABL-234) — `netPositionScope` joins `partialize`: which borders the
  // net position map and tab count, 'all_coupled' (every ENTSO-E-coupled
  // border, the only view that existed before) or 'core' (the 12-zone Core
  // flow-based region, from JAO).
  //
  // Unlike the clauses above there is nothing to carry forward — no older
  // field encoded this — so the whole job is refusing a value outside the
  // union. That is not ceremony: the two views can disagree in SIGN (France,
  // 2026-08-09 08:00 UTC: Core -368.9 MW importing vs all-coupled +1,494.6 MW
  // exporting), and an unrecognised persisted string must not be able to
  // leave a reader on a chart whose legend names a scope the query did not
  // use. Coerced to the default rather than to 'core': 'all_coupled' is the
  // view with data for every zone the map draws, and Core capture is off by
  // default in a deployment (see server/src/services/
  // coreNetPositionScheduler.ts), so it is also the view guaranteed to render
  // something.
  if (!isNetPositionScope(next.netPositionScope)) {
    next.netPositionScope = 'all_coupled';
  }

  // Task 9b (PERSIST_VERSION bumped to 11 to reach it at all — see below) —
  // the tab view (`CountryDashboardView.tsx`) is gone, and `activeChartTab`
  // was its selection alone: which of six tabs was showing. The scrolling
  // document that replaced it (`CountryDocumentView.tsx`) has no equivalent —
  // every figure is on screen, or lazily mounted, at once, with no single
  // "current" one — so there is nothing left to validate a stored value
  // against. Drop the key outright, the same treatment `layers` / `timeRange`
  // / `analyticsConfig` above got when their owning feature was removed.
  //
  // Deliberately NOT gated `if (fromVersion < 11)` the way v7/v8/v9 above
  // are gated on their own version: this function already returns before
  // this line whenever `fromVersion >= PERSIST_VERSION` (the top guard), and
  // PERSIST_VERSION *is* 11 — so a `< 11` check on a line that can only ever
  // be reached with `fromVersion < 11` is always true, asserts nothing, and
  // there is no test that could tell it apart from no check at all. The bump
  // to 11 is still real and necessary: it is what makes the persist
  // middleware invoke `migrate()` at all for anyone whose stored blob still
  // says version 10, which is the only thing that gets this deletion to run
  // for them even once.
  delete next.activeChartTab;

  return next;
}
