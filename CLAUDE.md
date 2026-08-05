# CLAUDE.md - Frontend Module

This file provides guidance to Claude Code (claude.ai/code) when working with the Energy Dashboard frontend.

## Project Overview

The frontend is a React + TypeScript web dashboard for visualizing European energy market data. It consists of:
- **client/** - React SPA (Vite, Tailwind CSS, Recharts)
- **server/** - Express.js API server (better-sqlite3)

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS
- **Charts**: Recharts
- **State Management**: Zustand (with localStorage persistence, versioned migrations)
- **Data Fetching**: TanStack Query (React Query)
- **Backend**: Express.js, better-sqlite3
- **Database**: SQLite (shared with the `energy-data-gathering` sibling module)

**Database Schema:** See [`../energy-data-gathering/database_structure.md`](../energy-data-gathering/database_structure.md) for complete database documentation.

## Quick Start

```bash
npm install
npm run dev
```

Runs client and server together (`concurrently`). The server needs a local
`server/.env` with `ENERGY_DB_PATH` set — see `server/.env.example` and
**Database Connection** below; without it the server falls back to
`/data/energy_dashboard.db`, which does not exist on a workstation checkout.

- Frontend: http://localhost:5173
- API Server: http://localhost:3001

## Project Structure

```
energy-dashboard-frontend/
├── client/
│   └── src/
│       ├── views/                    # Top-level routed views
│       │   ├── MapView.tsx               # Landing page — Europe choropleth
│       │   ├── CountryDashboardView.tsx  # Per-country tabs (price/load/generation/net position/forecast accuracy)
│       │   └── ComparisonView.tsx        # Cross-country accuracy heatmap/map/leaderboard
│       ├── components/
│       │   ├── charts/               # Recharts-based primitives, shared across tabs
│       │   │   ├── AbleLineChart.tsx     # Line + forecast overlay (load, price, net position)
│       │   │   ├── AbleStackedMix.tsx    # Stacked area — generation mix
│       │   │   ├── AbleDonut.tsx         # Generation-mix share donut
│       │   │   ├── AblePriceHeatmap.tsx  # Hour x day heatmap (load, price)
│       │   │   ├── AbleAccuracyBars.tsx  # Measured-error-by-horizon bars
│       │   │   ├── AbleSparkline.tsx     # Stat-tile sparklines
│       │   │   └── ChartWrapper.tsx      # Card wrapper used by the map view
│       │   ├── dashboard/            # Country-view composition
│       │   │   ├── PriceTab.tsx, LoadTab.tsx, GenerationTab.tsx,
│       │   │   │   NetPositionTab.tsx, ForecastTab.tsx  # One file per tab
│       │   │   ├── AbleCard.tsx          # Card shell all five tabs wrap their charts in
│       │   │   ├── ModelPicker.tsx       # Registry-driven forecast model selector (see below)
│       │   │   ├── RangeSegment.tsx      # 24h/7d/30d/+24h/+7d range buttons
│       │   │   ├── AbleStatRow.tsx       # Top 4-stat strip (price/load/renewable share/peak)
│       │   │   ├── CountryBreadcrumb.tsx, SourceTable.tsx, ApiCta.tsx
│       │   │   ├── ForecastMetadataBadge.tsx  # ORPHANED — no importer (see State management)
│       │   │   └── horizonBars.ts, sourceRows.ts, windowLabel.ts  # Pure helpers (each has a .test.ts)
│       │   ├── comparison/           # ComparisonView's heatmap/map/leaderboard/filter bar
│       │   ├── map/                  # EuropeMap.tsx (choropleth), MapMetricSelector.tsx, mapGeometry.ts
│       │   ├── layout/               # AbleHeader.tsx
│       │   └── ui/                   # shadcn/radix primitives (button, card, tabs, select, ...)
│       ├── hooks/
│       │   ├── useDashboardData.ts       # Bulk of the React Query hooks
│       │   ├── useLoadChartData.ts, usePriceChartData.ts, useRenewableChartData.ts,
│       │   │   useNetPositionData.ts     # Per-tab batched-query hooks
│       │   ├── useForecastModels.ts      # Registry query + model-selection resolution
│       │   └── useCountries.ts, usePrefetch.ts, useAnimatedValue.ts
│       ├── services/
│       │   ├── api.ts                    # Axios API functions
│       │   └── unwrap.ts                 # `ApiResponse<T>` unwrapping + error shape
│       ├── store/
│       │   ├── dashboardStore.ts         # Zustand state (persisted, versioned)
│       │   ├── migrate.ts                # PERSIST_VERSION + migratePersisted()
│       │   └── themeStore.ts
│       ├── types/
│       │   └── index.ts                  # TypeScript interfaces
│       └── lib/
│           ├── constants.ts, comparisonConstants.ts  # TAB_FORECAST_TYPE, MAP_METRICS, etc.
│           ├── chartAdapters.ts, chartTicks.ts, chartSummary.ts, colors.ts,
│           │   divergingScale.ts, servedModel.ts, trailingGap.ts, timezone.ts,
│           │   queryRetry.ts, netPositionProvenance.ts, formatters.ts,
│           │   providerRegistry.ts, utils.ts
│
└── server/
    └── src/
        ├── routes/
        │   ├── index.ts               # Mounts every router below /api
        │   ├── dashboard.ts           # /dashboard/overview, /map, /timeseries, /initial
        │   ├── load.ts, prices.ts, renewables.ts, generation.ts  # Actuals
        │   ├── forecast.ts            # /forecasts, /forecasts/models, /forecasts/compare, ...
        │   ├── tsoForecast.ts         # /tso-forecast/* (ENTSO-E official forecasts)
        │   ├── forecastComparison.ts  # /forecast-comparison/:cc, /summary, /best, /rolling, /ml-accuracy
        │   ├── crossCountryComparison.ts  # /cross-country/metrics, /metrics/:forecastType
        │   ├── netPosition.ts, netPositionIngest.ts  # Read + write for the Chronos net-position pipeline
        │   ├── dataFreshness.ts, countries.ts, weather.ts
        ├── services/                  # One service module per route group
        ├── config/
        │   ├── database.ts            # SQLite connection (ENERGY_DB_PATH)
        │   ├── writeDatabase.ts       # Separate writable handle, opened lazily —
        │   │                          #   used by netPositionIngest.ts and weather.ts
        │   └── forecastModels.ts      # The model registry — see below
        ├── middleware/                # cache.ts, errorHandler.ts, writeAuth.ts
        ├── utils/                     # timestamp.ts (normalizeTimestamp)
        └── types/
```

## Database Connection

The server reads `ENERGY_DB_PATH` and opens that SQLite file **readonly**:

```typescript
// server/src/config/database.ts
const dbPath = process.env.ENERGY_DB_PATH || '/data/energy_dashboard.db';
const db = new Database(dbPath, { readonly: true });
```

For local dev, copy `server/.env.example` to `server/.env` and set
`ENERGY_DB_PATH` to your machine's replica (`tsx watch --env-file-if-exists=.env`
loads it automatically). In Docker/production `ENERGY_DB_PATH` comes from the
container instead, and the built bundle (`npm start`) does not read `server/.env`.

**`client/.env.local`'s `API_PROXY_TARGET`** controls where the Vite dev
server proxies `/api` (`client/vite.config.ts`) — copy `client/.env.example`
to override it. Unset, it proxies to `http://localhost:3001` (your local
server). The acceptance/workstation environment instead points it at prod
(`http://192.168.86.36:3001`) so the client runs without a local database —
**which means server-side changes are invisible there until prod is
redeployed.** To exercise a server change, unset `API_PROXY_TARGET` (or point
it at `http://localhost:3001`) and run the local server against
`ENERGY_DB_PATH`.

## Key Features

### 1. Views

Three top-level views, switched via `currentView` in the store (`map` | `country` | `comparison`):
- **`MapView`** — landing page, a Europe choropleth (`EuropeMap.tsx`) with a floating metric selector.
- **`CountryDashboardView`** — five tabs per country: Price, Load, Generation, Net position, Forecast accuracy.
- **`ComparisonView`** — cross-country accuracy heatmap / map / leaderboard, filtered by forecast type and metric.

### 2. Forecast model selection

`server/src/config/forecastModels.ts` is the registry: which models (`catboost`,
`xgboost`, TSO day-ahead/week-ahead, the net-position Chronos run, ...) may
serve which forecast type, and which one is `production` for that type. **A
model must be listed there to be served at all.**

**The client sends `model=` only when the user explicitly picked one** in
`ModelPicker` (`client/src/components/dashboard/ModelPicker.tsx`, driven by
`useForecastModels.ts`'s `resolveSelection` — `requestModelId` is set from an
id the user actually chose and from nothing else, `useForecastModels.ts:62`).
Leaving it off lets the server walk its candidate ladder
(`resolveModelCandidates`, `forecastModels.ts:180-190`): production model
first, then the other registered ml models, returning the first with rows for
that country.

This matters because catboost and xgboost barely overlap. Measured against
`energy_dashboard.db` on 2026-08-05: for `load` the sets are strictly
**disjoint** (catboost 21 countries, xgboost AT/BE/FR, none with both); for
`price` they are near-disjoint but not fully — catboost 19, xgboost 6, and
**AT is served by both**. Pinning the production model (catboost) blanks
`load` for AT/BE/FR and `price` for BE/DE/ES/FR/PT. The picker labels whichever
model the response's `meta.model` reports actually served, which can differ
from the picker's own selection when the ladder fell back.

(`forecastModels.ts:168` still asserts the sets are fully disjoint, as measured
on 2026-07-26. That comment is now stale for `price`; the behaviour it
justifies — ordered rather than absolute preference — is unaffected.)

**A pin cannot be cleared from the UI.** Every dropdown entry calls
`setSelectedModel(forecastType, m.id)` (`ModelPicker.tsx:99`), including the
one badged "Default", and the on/off button re-pins `selected?.id` when it
switches the forecast back on (`ModelPicker.tsx:56`). Once the user has touched
the picker for a type, `selectedModelByType[type]` holds a concrete id
permanently, `requestModelId` is set, and the server honours an explicit
request strictly — "if you asked for xgboost and it has nothing, you get
nothing, not a silent substitution" (`forecastModels.ts:177`, implemented at
`:183-185`). Only the untouched initial state (`selectedModelByType: {}`,
`dashboardStore.ts:202`) or clearing localStorage returns a type to the
candidate ladder.

**Accuracy by model.** The accuracy endpoints also accept `model`, but resolve
it through `resolveAccuracyModel` rather than `resolveModel`/`resolveModelCandidates`
— **deliberately stricter**: an unregistered id is rejected with a 400, not
degraded to the production model, and a tso id on an ml-accuracy route (or the
reverse) is rejected too. The leniency that is right for a chart — a stale
bookmark still draws the trusted series — would answer "how accurate is
xgboost?" with catboost's numbers. Which endpoints:

- `/forecast-comparison/:cc/ml-accuracy`, `/:cc`, `/:cc/rolling`, `/:cc/best`
  take an **ml** model id; it pins the ml side only, never the TSO metrics.
  `/:cc/summary` does not take one — it spans five forecast types at once, and
  one id cannot be valid for all of them.
- `/tso-forecast/accuracy/load/:cc` and `/accuracy/generation/:cc` take a
  **tso** id, where the model *is* the horizon (`tso-d1` = day-ahead, `tso-d7`
  = week-ahead). `model` and `forecastType` are two spellings of one choice, so
  a disagreement is a 400 (`MODEL_HORIZON_CONFLICT`) rather than one side
  quietly winning.

Omitting `model` leaves every one of these exactly as it was: unpinned, the
latest run per target timestamp whichever model produced it. `meta.model` is
then `null` — it does **not** name the production model, because the unpinned
query really is model-agnostic.

Because coverage is disjoint, "this model has no rows for this country" is a
normal answer. `meta.coverage` on `/ml-accuracy` distinguishes `served` /
`no_model_coverage` / `no_paired_actuals`, so a country pinned to a model that
does not serve it reads as *no coverage* and never as a flawless 0% error.

`ModelPicker` renders once per active tab (`TAB_FORECAST_TYPE` maps tab ->
forecast type) and stores the choice per type in `selectedModelByType`, so a
choice on one tab never leaks into a type where that model doesn't exist. The
older `showForecast` / `showTSOForecast` / `tsoForecastType` boolean toggles
and the D+1/D+7 button are gone — `LoadTab`/`PriceTab`/`NetPositionTab` derive
`useMl` / `useTso` / `tsoHorizon` straight from the picker's selected model
(`selected.source`, `selected.tsoHorizon`, `useLoadChartData.ts:89-91`). Those
booleans remain in the store as legacy persisted fields, but they are not
uniformly dead — see State management below for which are still read.

### 3. Country dashboard tabs

Each tab is self-contained: a batched React Query hook (`useLoadChartData`,
`usePriceChartData`, `useRenewableChartData`, `useNetPositionData`) feeds a
`chartAdapters.ts` adapter, which feeds an `Able*` chart primitive.

- **`LoadTab`** — `AbleLineChart` (actual + one dashed forecast series, ml or
  TSO per the picker) and an `AblePriceHeatmap` of load by hour x day.
- **`PriceTab`** — same shape for day-ahead price (ml forecast only; price has
  no TSO forecast in the registry).
- **`GenerationTab`** — `AbleStackedMix` (solar/wind/hydro/biomass, stacked)
  plus an `AbleDonut` and `SourceTable` showing window-average share of
  *generation* (`energy_generation`, the full A75 document — see
  `generationService.getRenewableShare`). The donut's percentage and the
  header stat row's "Renewable share" card both read this same server-computed
  ratio of window sums, so they cannot disagree.
  No `ModelPicker` renders here — `TABS_WITH_MODEL_PICKER`
  (`CountryDashboardView.tsx:56`, applied at `:115`) limits it to the tabs
  whose chart actually reads a selection (`price`, `load`, `net-position`). It
  used to render and do nothing, while `useRenewableChartData` fired five
  per-type ML forecast queries plus a TSO one that no component consumed: six
  API calls per view, discarded (`useRenewableChartData.ts:18-28`). Both are
  gone. If you add a forecast overlay to this tab, add it back to that set.
- **`NetPositionTab`** — `AbleLineChart` for ENTSO-E day-ahead net position
  plus the Chronos forecast (median, and a p10-p90 band where stored). Handles
  a zone going silent upstream as an explicit "stopped publishing on <date>"
  state rather than a loading spinner. GR and IE are the live examples: their
  continuous series ends `2026-03-14 22:00`, but both got a single-day
  reappearance (`2026-07-23 22:00` → `2026-07-24 21:00`), and the date the tab
  prints is `MAX(timestamp_utc)` (`netPositionService.ts:291`) — so it now
  reads 2026-07-24, not the March date. Measured 2026-08-05; they are the only
  two countries whose `net_position` stops before 2026-08.
- **`ForecastTab`** ("Forecast accuracy") — a 4-stat strip (MAE/MAPE/RMSE/
  samples) from `/tso-forecast/metrics`, measured-only error-by-horizon bars
  (`horizonBars.ts`, ML D+1/D+2 and TSO D+1/D+7 — never extrapolated), and a
  forecast-vs-actual overlay chart. The "Compare forecast models" panel is
  still a placeholder, but the server side it was waiting on now exists — the
  accuracy endpoints accept `model` (see "Accuracy by model" below). What is
  left is client work: the panel itself, and a hook that sends the picker's
  selection to `/forecast-comparison/*`. Note the placeholder's on-screen text
  (`ForecastTab.tsx:222-225`) still tells the user "the accuracy endpoints do
  not accept a model parameter" — that sentence is now false, and should be
  deleted with the panel work.

### 4. Time navigation

`RangeSegment.tsx` (`client/src/components/dashboard/RangeSegment.tsx:7-13`)
renders five buttons (`24h`, `7d`, `30d`, `+24h`, `+7d`) that set `timePreset`
in the store. It is the **only** writer of `timePreset` anywhere in the client.
The `TimePreset` union is still wider than what it exposes:

```typescript
type TimeAnchor = 'past' | 'now' | 'future';

type TimePreset =
  | '24h' | '7d' | '30d'                          // Historical
  | 'today' | 'thisWeek'                          // Around now
  | 'next1d' | 'next24h' | 'next48h' | 'next7d';  // Forecast
```

`getDateRangeForPreset()` (`useDashboardData.ts:29`) turns a preset +
`timeOffset` into concrete start/end dates.

**Unreachable presets and dead time-navigation actions.** `90d` and `1y` used
to be in this union with no button to set them; they were removed outright
(ABL-4) rather than wired up. Four values are still unreachable —
`today`, `thisWeek`, `next1d`, `next48h` — and they are unreachable for a
different reason: the store actions that would set them have lost their
callers. `jumpToLive()` (`dashboardStore.ts:166`, sets `today`) and
`shiftTimeWindow()` (`dashboardStore.ts:153`) are **called from nowhere** in
`client/src`, so `timeOffset` is always `0` and `isLive` is never `true`
(nothing reads `isLive` either). Those four keep market-aligned window logic
(`getTodayBrussels`/`getNextDayBrussels`, `lib/timezone.ts`) that a restored
live/now control would need, so they were kept pending a product decision on
the time picker — see `TIME_PRESETS` in `lib/constants.ts`, an unbuilt design
spec kept deliberately and not wired to this union.

Adding a preset back means touching six places. Five are a compile error if you
miss them, by two mechanisms:

- Keyed `Record<TimePreset, …>`, so the missing key is named directly:
  `PRESET_DURATIONS_HOURS` (`lib/constants.ts:50`), `WINDOW_LABEL`
  (`dashboard/windowLabel.ts:23`), and `ANCHOR_FOR_PRESET`
  (`store/migrate.ts:21`), whose keys `VALID_TIME_PRESETS` derives from.
- A `const unhandled: never = preset` in the `default` branch, so the new value
  is reported as not assignable to `never`: `getDateRangeForPreset`
  (`useDashboardData.ts:103`) and `getGranularityForPreset`
  (`useDashboardData.ts:144`).

The sixth — the button in `RangeSegment` — still fails silently, and always
will: a preset with no control is unreachable, not ill-typed. That gap is
exactly what ABL-12 is about.

Until ABL-12 those last three failed silently, which mattered: both functions
`default` to a trailing 7-day hourly window, so a preset with no `case` compiled
clean and rendered a last-7-days window beneath its own (correct, exhaustively
keyed) `WINDOW_LABEL` caption — a confidently mislabelled window. `migrate.ts`
separately reset any preset missing from a hand-maintained `VALID_TIME_PRESETS`
literal to `7d` on the next `PERSIST_VERSION` bump; that literal is now derived,
so it cannot drift from the union.

### 5. State management

Zustand store (`dashboardStore.ts`) with `persist` to localStorage
(`energy-dashboard-storage`). **The persisted shape is versioned:**
`PERSIST_VERSION` in `store/migrate.ts` (currently `6`, `migrate.ts:3`), bumped
with a matching clause in `migratePersisted()` whenever a persisted field's
shape or meaning changes. `migratePersisted` must never throw: `state` is an
arbitrary, possibly years-old localStorage blob. Skipping this step leaves
returning users on a shape the current code doesn't understand — previously a
blank tab panel or a view nobody chose.

It is **not** a per-version switch. `migrate.ts:51` short-circuits only on
`fromVersion >= PERSIST_VERSION`; below that, *every* clause runs for *any*
older blob, so each clause must be safe to apply to a blob that never had the
field. The clauses today coerce an unknown `currentView` / `activeChartTab` /
`timePreset` back to a valid value (`migrate.ts:130` for the last), remap a
stored `comparisonMetric: 'mape'` to `'wape'` (`:88`), and **delete** three
dead keys: `layers` (`:82`), `timeRange` (`:102`), `analyticsConfig` (`:114`).
Note `layers` is deleted, not folded into `showForecast`/`showTSOForecast` as
an earlier version did — that folding unconditionally overwrote `showForecast`
with `false` on every migration, clobbering a value the current code had
legitimately set moments earlier.

**`timeRange` is gone.** This section used to say `timeRange` (the legacy
closed enum) and `timePreset` both persisted and both drove UI, and that the
`/dashboard/*` endpoints forced it. Neither is true any more: nothing in
`client/src` declares or reads a `timeRange` field, there is no `TimeRange`
type in `client/src/types/index.ts` at all (the enum survives only server-side,
`server/src/types/index.ts:187`), `useDashboardOverview` sends an explicit
`start`/`end` computed by `getDateRangeForPreset` (`useDashboardData.ts:157`,
and `useMapData` likewise at `:194`), and `migratePersisted` deletes a stored
`timeRange` outright (`store/migrate.ts:102`). `timePreset` is the single field
describing the window. (`comparisonTimeRange`, a separate `'7d'|'30d'|'90d'`
field for `ComparisonView`, is unrelated and does still exist.)

Nor was there ever a *backend* blocker forcing it to stay. The
`/dashboard/overview|map|initial` endpoints take an explicit `start`/`end`
window and let it **win** over the legacy enum whenever both are present
(`server/src/routes/dashboard.ts:49`, `:76`, `:138`; `timeRange` is consulted
only as the fallback, via `getTimeRangeDates` in `dashboardService.ts:6`, and
each site carries a comment explaining the backward compatibility). That
passthrough predates ABL-4: the blocker this file described — "the client can't
drop `timeRange` without a backend change first" — had already been removed
when it was written.

Note `timePreset` is validated on migration against `VALID_TIME_PRESETS`
(`store/migrate.ts:33`, checked at `:130`) and `timeAnchor` is re-derived from
it (`:135`), because the two persist separately and only `setTimePreset` keeps
them in step. `VALID_TIME_PRESETS` is no longer a hand-maintained literal — it
is `Object.keys(ANCHOR_FOR_PRESET)`, and `ANCHOR_FOR_PRESET` is keyed
`Record<TimePreset, TimeAnchor>`, so it cannot drift from the union.

```typescript
// The COMPLETE persisted set — `partialize`, dashboardStore.ts:279-302.
// Anything absent here (timeOffset, isLive, servedModelByType, …) is
// session-only and resets on reload.
currentView: AppView;                                // 'map' | 'country' | 'comparison'
selectedCountry: string;
timePreset: TimePreset;
timeAnchor: TimeAnchor;
mapMetric: MetricType;
activeChartTab: string;              // price|load|renewables|net-position|analytics
selectedModelByType: Record<string, string | null>;  // per forecast-type model choice; null = hidden
comparisonCountries: string[];
sidebarOpen: boolean;
showForecast: boolean;               // legacy — see below
showComparisonMode: boolean;
showTSOForecast: boolean;
tsoForecastType: TSOForecastType;
showTSOComparisonMode: boolean;
visibleRenewableTypes: string[];
selectedMLHorizons: number[];
comparisonMetric: 'wape' | 'mae' | 'rmse';
comparisonForecastType: string;
comparisonTimeRange: '7d' | '30d' | '90d';
```

The legacy forecast fields are **not uniformly dead**. Before deleting one,
check which group it is in:

- **Live.** `showComparisonMode` / `showTSOComparisonMode` gate the comparison
  queries (`useLoadChartData.ts:148`, `:189`; `usePriceChartData.ts:117`);
  `selectedMLHorizons` drives the multi-horizon fetch
  (`useLoadChartData.ts:107`, `:153`).
- **Written, and read only by dead code.** `showForecast`. `setTimePreset`
  still sets it `true` for future presets (`dashboardStore.ts:150`) and
  `useLatestForecast` gates its query on it (`useDashboardData.ts:276`, `:284`)
  — but that hook's only consumer, `ForecastMetadataBadge.tsx`, is imported by
  nothing, so it has no on-screen effect today.
- **No reader at all.** `showTSOForecast`, `tsoForecastType`,
  `visibleRenewableTypes`, `sidebarOpen`, `comparisonCountries`.

Careful with the name `showForecast`: `useLoadChartData`/`usePriceChartData`
declare *local* consts of that name derived from the picker
(`selected?.source === 'ml'`, `useLoadChartData.ts:89`;
`usePriceChartData.ts:61`), which shadow the store field. A grep hit is not
necessarily a store read.

`servedModelByType` (which model actually served the last response, per type)
is deliberately **not** persisted — it describes the last network response,
not a preference.

### 6. Cross-country comparison metrics

`ComparisonView` and `/api/cross-country/metrics` use **WAPE**
(`100 * sum|actual - forecast| / sum|actual|`, `crossCountryMetricsService.ts`),
not MAPE, for the cross-country heatmap/leaderboard. Plain MAPE divides each
point by its own (signed) actual, so negative day-ahead prices cancelled error
instead of adding to it, and one near-zero actual could dominate the whole
mean — measured BE solar MAPE was 148458% before the fix. WAPE returns `null`
(not `0`) when the window's actuals sum to zero, so a country never renders as
a flawless "0% error."

Per-country TSO/ML accuracy (`ForecastTab`, `/tso-forecast/metrics`,
`/forecast-comparison/*`) still reports **MAPE**, but only over points with a
positive actual (`mapeSamples` in the response, always <= `dataPoints`) and
returns `null` rather than `0` when no point qualified — e.g. solar overnight,
where every actual is legitimately zero.

## Generation data

Two tables, both written from **one** A75 fetch per country per window
(`../energy-data-gathering/src/fetch_renewable.py` →
`ENTSOEClient.query_generation_and_renewable_with_metadata`,
`../energy-data-gathering/src/entsoe_client.py:1187`). Never add a second
request to fill one of them.

- **`energy_generation`** — the whole document. 21 `*_mw` columns, one per
  ENTSO-E production type. Prefer this for anything new.
- **`energy_renewable`** — the older, narrower table: 8 renewable columns, with
  pumped storage folded into `hydro_reservoir_mw`. **Frozen.** The dashboard,
  the forecast job and several backfill scripts read it. It is derived from the
  *pre-netting* flatten specifically so its values are unchanged; deriving it
  from `energy_generation` shifts `hydro_reservoir_mw` (measured 1520 → 1410)
  because of that folding. It is now redundant and worth retiring, but that is
  its own migration.

Three things to know before touching this:

- **`NULL` ≠ `0`.** A type a country does not report is `NULL` — we do not know.
  A measured zero (solar overnight) is `0.0`. `energy_generation` deliberately
  has **no `DEFAULT 0`**, and the mapping avoids `fillna(0)`. Note
  `groupby().sum()` collapses an all-NaN group to `0.0` unless you pass
  `min_count=1`.
- **Values can be negative, legitimately.** ENTSO-E reports `Actual Aggregated`
  and `Actual Consumption` separately; the full mapping nets them
  (`aggregated - consumption`), so `hydro_pumped_mw` is negative while pumping
  and a consumption-only type (French `Fossil Hard coal`) is negative outright.
  An earlier version skipped every Consumption series, which recorded France as
  a net pumped-storage *generator* at +26 MW while it was pumping 285-349 MW.
- **Share of generation, not of load.** `generationService.getRenewableShare` is
  the single definition — renewable output over total *positive* generation, as
  a ratio of window sums. Three separate implementations existed before
  (`renewableService`'s join, plus inline `AVG/AVG` SQL in the header and the
  map), disagreeing with each other. Share-of-load is wrong here: a net
  exporter generates more than it consumes, so single rows read over 100%.

## Data the database does not have

- **Nothing, for generation.** This entry used to say nuclear and fossil were
  unavailable. They are not: `energy_generation` holds the complete ENTSO-E
  A75 document — nuclear, every fossil type, waste, storage and the renewables
  — backfilled to 2021-01-01 across 34 countries. See "Generation data" below.
- **A real publication time.** `publication_timestamp_utc` exists on eight
  tables and **does not mean what its name says**. It is filled from the ENTSO-E
  response's `createdDateTime`, but ENTSO-E builds the document *on request* and
  stamps it with the generation time — so the column records **when we fetched**,
  not when the value was published. Measured: a Belgian day-ahead price for
  21:45 tonight (published ~12:45 CET yesterday) carries a
  `publication_timestamp_utc` of 06:32 this morning, which is when the cron ran.
  Nothing in the client renders it, so it is not currently lying to a user — but
  do not build on it, and do not backfill it. A historical backfill re-queries
  the API and therefore stamps every row with the date the backfill ran, which
  is worse than the NULL it replaces. If you need "was this published as
  day-ahead or observed after the fact", derive it from the target timestamp
  relative to fetch time, or from `forecasts.horizon_hours` — not from this
  column.

  Non-null counts, measured 2026-08-05 — **13,619,060** in total, not the
  ~4.9M this entry used to claim (that figure covers only the three tables it
  happened to name):

  | table | non-null | rows |
  |---|---|---|
  | `energy_generation` | 3,160,657 | 3,160,657 |
  | `energy_generation_forecast` | 3,033,167 | 3,033,167 |
  | `energy_load` | 2,746,776 | 2,760,216 |
  | `energy_load_forecast` | 2,430,020 | 2,430,020 |
  | `energy_price` | 1,430,549 | 1,530,298 |
  | `energy_renewable` | 811,955 | 811,955 |
  | `net_position` | 5,936 | 644,658 |
  | `crossborder_flows` | 0 | 3,540,460 |

  **`net_position` is no longer fully NULL, and this doc used to say it was.**
  As of 2026-08-05 it carries 5,936 stamps — every one written on or after
  2026-07-31 13:31, for target timestamps from 2026-07-24 onward, i.e. exactly
  the cron-run-time pathology described above. The writer is the sibling
  module (`../energy-data-gathering/src/db.py:1096-1109`), not this repo: our
  own net-position ingest route writes `forecasts`/`forecast_quantiles`
  (`netPositionIngestService.ts:72`, `:78`), never `net_position`. Escalated to
  the CEO under ABL-3 — do not treat "net_position is a clean NULL" as an
  invariant you can rely on. `crossborder_flows` still is.
- **Forecast horizons beyond ~D+2.** `forecasts.horizon_hours` runs roughly
  2-64h depending on model — there is no stored forecast for D+3 and beyond.
  Re-measured 2026-08-05: catboost 2-63h, xgboost 2-64h, chronos-2-V010 40-64h
  (the three registered ml models); the unregistered/stale ones sit inside that
  envelope too (chronos-bolt-small 1-60h, lightgbm 4-54h, tso_raw and
  tso_corrected 24-46h). `ForecastTab`'s error-by-horizon
  bars only ever render measured `ML D+1` (0-30h), `ML D+2` (24-54h), `TSO
  D+1`, and `TSO D+7`; a previous version multiplied the measured D+1 error by
  fixed factors to fabricate D+3/D+5/D+7 bars, which is why they were removed
  rather than kept.

## Common Development Tasks

### Adding a New API Endpoint

1. Add route in `server/src/routes/index.ts` or create new router file
2. Add service function in `server/src/services/`
3. Add types in both `server/src/types/index.ts` and `client/src/types/index.ts`
4. Add API function in `client/src/services/api.ts`
5. Create React Query hook in `client/src/hooks/useDashboardData.ts` (or a
   per-tab hook alongside `useLoadChartData.ts` if it's chart-specific)

### Adding a New Chart Feature

1. Update store state in `client/src/store/dashboardStore.ts` — if it's
   persisted, add it to `partialize` and bump `PERSIST_VERSION` with a
   `migratePersisted()` clause in `store/migrate.ts`
2. Add/extend a hook if fetching new data (`useDashboardData.ts` or the
   relevant per-tab hook)
3. Update the tab component (`client/src/components/dashboard/*Tab.tsx`) and,
   if needed, the underlying `Able*` chart primitive in `components/charts/`
4. Add UI toggle in the tab or in `ModelPicker`/`RangeSegment` as appropriate

### Adding a model to the forecast registry

Register it in `server/src/config/forecastModels.ts` (`FORECAST_MODELS[type].models`,
and `production` if it should be the default). `ModelPicker`,
`resolveModelCandidates`'s fallback ladder and `resolveAccuracyModel`'s
validation all read this registry directly — nothing else needs to change for
the model to appear, be servable, and be measurable by name.

### Modifying TSO or ML forecast display

Key files:
- `server/src/config/forecastModels.ts` — which models exist per type
- `server/src/services/tsoForecastService.ts`, `mlForecastService.ts`,
  `forecastService.ts` — database queries
- `client/src/components/dashboard/ModelPicker.tsx` — selection UI
- `client/src/components/dashboard/LoadTab.tsx`, `PriceTab.tsx`,
  `NetPositionTab.tsx` — where the selected model's data actually renders

## TypeScript Types

### Time Navigation Types

```typescript
type TimeAnchor = 'past' | 'now' | 'future';

type TimePreset =
  | '24h' | '7d' | '30d'
  | 'today' | 'thisWeek'
  | 'next1d' | 'next24h' | 'next48h' | 'next7d';

interface DataFreshness {
  load: string | null;
  price: string | null;
  generation: string | null;
  tsoLoadForecast: string | null;
  tsoGenerationForecast: string | null;
}
```

### Forecast Model Registry Types

```typescript
type ForecastSource = 'ml' | 'tso';

interface ForecastModel {
  id: string;                 // wire id, e.g. 'catboost', 'tso-d7'
  label: string;               // 'able-ml · catboost'
  source: ForecastSource;
  modelName?: string;          // forecasts.model_name, for ml models
  tsoHorizon?: 'day_ahead' | 'week_ahead';  // for tso models
}

interface ForecastTypeConfig {
  production: string;          // default model id for this forecast type
  models: ForecastModel[];
}

type ForecastModelRegistry = Record<string, ForecastTypeConfig>;
```

### TSO Forecast Types

The client and server declarations are **not** mirror images here — check which
side you are on.

```typescript
// client/src/types/index.ts:172 — note the third member; the server's
// TSOForecastType (server/src/types/index.ts:168) is identical.
type TSOForecastType = 'day_ahead' | 'week_ahead' | 'all';

// client/src/types/index.ts:174. The server's TSOLoadForecastDataPoint
// (server/src/types/index.ts:170) has NO min/max fields; the two the client
// adds are populated by the week-ahead branch of the query
// (tsoForecastService.ts:56-57, NULL on the day-ahead branches).
interface TSOLoadForecastDataPoint {
  timestamp: string;
  forecast_value_mw: number;
  forecast_min_mw: number | null;    // Week-ahead only: daily min
  forecast_max_mw: number | null;    // Week-ahead only: daily max
  forecast_type: string;             // not narrowed to the union
  publication_timestamp_utc: string | null;   // required, nullable — not optional
}

// server-only: server/src/types/index.ts:177 (and a duplicate at
// tsoForecastService.ts:18). There is no client counterpart.
interface TSOGenerationForecastDataPoint {
  timestamp: string;
  solar_mw: number | null;
  wind_onshore_mw: number | null;
  wind_offshore_mw: number | null;
  total_forecast_mw: number | null;
}

interface TSOForecastAccuracyDataPoint {
  timestamp: string;
  forecast_value: number;
  actual_value: number;
  error: number;
  error_pct: number;
}

// Accuracy metrics — null fields mean "not measurable in this window", not zero
interface TSOForecastAccuracyMetrics {
  mae: number | null;
  mape: number | null;      // covers only points with a positive actual
  rmse: number | null;
  dataPoints: number;
  mapeSamples: number;      // count of points MAPE was computed over; <= dataPoints
}
```

## Debugging Tips

- Check browser DevTools Network tab for API responses
- There is **no** React Query DevTools here — `@tanstack/react-query-devtools`
  is not a dependency of `client/package.json` and no source file mounts it.
  Inspect query state through the Network tab or a temporary log instead.
- The server logs the connected `ENERGY_DB_PATH` at startup
  (`config/database.ts:15`) and again if the write handle opens
  (`config/writeDatabase.ts:29`). It does **not** log queries — there is no
  per-query logging to check
- If acceptance is pointed at prod (`client/.env.local`'s `API_PROXY_TARGET`),
  a server-side fix won't show up until prod is redeployed — verify against a
  local server first

## Common Issues

**"Cannot connect to database":**
- Verify the SQLite file at `ENERGY_DB_PATH` (or `server/.env`'s value) exists
- Without `ENERGY_DB_PATH` set, the server defaults to `/data/energy_dashboard.db`, which won't exist on a workstation checkout

**A country's load/price forecast is blank:**
- Check whether a specific model is pinned in `ModelPicker` — catboost and
  xgboost coverage barely overlaps (see Forecast model selection), so a pinned
  model with no data for that country renders nothing.
- **Selecting the type's "Default" entry does not clear the pin — it creates
  one.** Every dropdown entry calls `setSelectedModel` with a concrete id
  (`ModelPicker.tsx:99`), and an explicit request is honoured strictly
  (`forecastModels.ts:183-185`). There is no UI path back to the unpinned
  candidate ladder; clear `selectedModelByType` out of the
  `energy-dashboard-storage` localStorage key instead.
- Confirm the model is actually registered in `server/src/config/forecastModels.ts`

**TSO forecasts not showing:**
- In `ModelPicker`, select a `TSO ·` entry for that forecast type. `load` has
  both D+1 and D+7 registered; `solar`/`wind_onshore`/`wind_offshore` have D+1
  only; `price`/`renewable`/`biomass`/`hydro_total`/`net_position` have no TSO
  model at all — check `forecastModels.ts` before assuming a bug
- Note the picker does not render on the Generation or Forecast-accuracy tabs
  at all (`TABS_WITH_MODEL_PICKER`, `CountryDashboardView.tsx:56`, applied at
  `:115`), so there is no "picker that does nothing" to hit there
- Check the API response has data for the selected country
- Verify database tables have data: `energy_load_forecast`, `energy_generation_forecast`

**Week-ahead (D+7) band not showing:**
- Select "ENTSO-E TSO · D+7" in `ModelPicker` for the Load tab — there is no
  separate D+1/D+7 toggle anymore, the picker's selection controls it
- Verify min/max data exists for that country (week-ahead is daily granularity
  at `T12:00:00Z` timestamps; the band needs `forecast_min_mw`/`forecast_max_mw`)

**Chart not updating:**
- React Query caches data - check `staleTime` settings
- Force refetch with `refetch()` from hook
- Clear localStorage to reset Zustand state

**Time navigation not working:**
- Check `timePreset` and `timeAnchor` in store
- Verify date range calculation in `getDateRangeForPreset()`
  (`useDashboardData.ts:29`) — there is no `useComputedDateRange()`, despite
  what this file claimed until ABL-4
- A preset with no `case` there is a compile error since ABL-12 (`never` guard
  in the `default` branch), so this is caught by `tsc -b` rather than by
  reading — but the `default` still resolves to a 7-day window at runtime, for
  the unvalidated string a same-version persisted blob can carry
- Nothing calls `shiftTimeWindow`/`jumpToLive`, so `timeOffset` is always 0 —
  confirm the preset you are testing can actually be set before debugging deeper
- Bump `PERSIST_VERSION` and add a `migratePersisted()` clause if you changed
  the shape of anything in `partialize`

**Data freshness not showing:**
- Verify `/api/data-freshness/:countryCode` endpoint is responding
- Check that database has data for selected country

**A query that filters/joins on `date(timestamp_utc)` or `strftime(...)` is slow:**
- SQLite cannot use an index through a function of the indexed column, so a
  predicate like `date(r.timestamp_utc) = date(l.timestamp_utc)` degrades to a
  full scan of the joined table per row. The old `getRenewablePercentage`
  (`energy_renewable` joined to `energy_load`, since removed - renewable
  share is now `generationService.getRenewableShare`, a join-free ratio of
  window sums over `energy_generation`) hit this: 51s for a 30-day window,
  0.009s after switching to a direct `r.timestamp_utc = l.timestamp_utc`
  equality join. Grouping/formatting output with `date()`/`strftime()` is
  fine — only filtering or joining on a function of the timestamp column
  defeats the index.
