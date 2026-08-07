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
│       │   │   ├── ModelPicker.tsx       # Registry-driven forecast model selector (see below)
│       │   │   ├── RangeSegment.tsx      # 24h/7d/30d/+24h/+7d range buttons
│       │   │   ├── AbleStatRow.tsx       # Top 4-stat strip (price/load/renewable share/peak)
│       │   │   ├── ForecastMetadataBadge.tsx, CountryBreadcrumb.tsx, SourceTable.tsx, ApiCta.tsx
│       │   │   └── horizonBars.ts, sourceRows.ts, windowLabel.ts  # Pure helpers (each has a .test.ts)
│       │   ├── comparison/           # ComparisonView's heatmap/map/leaderboard/filter bar
│       │   ├── map/                  # EuropeMap.tsx (choropleth) + mapGeometry.ts
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
│           ├── constants.ts, comparisonConstants.ts  # TIME_PRESETS, TAB_FORECAST_TYPE, etc.
│           ├── chartAdapters.ts, chartTicks.ts, colors.ts, divergingScale.ts,
│           │   servedModel.ts, trailingGap.ts, timezone.ts, queryRetry.ts
│
└── server/
    └── src/
        ├── routes/
        │   ├── index.ts               # Mounts every router below /api
        │   ├── dashboard.ts           # /dashboard/overview, /map, /timeseries, /initial
        │   ├── load.ts, prices.ts, renewables.ts  # Actuals
        │   ├── forecast.ts            # /forecasts, /forecasts/models, /forecasts/compare, ...
        │   ├── tsoForecast.ts         # /tso-forecast/* (ENTSO-E official forecasts)
        │   ├── forecastComparison.ts  # /forecast-comparison/:cc, /summary, /best, /rolling, /ml-accuracy
        │   ├── crossCountryComparison.ts  # /cross-country/metrics, /metrics/:forecastType
        │   ├── netPosition.ts, netPositionIngest.ts  # Read + write for the Chronos net-position pipeline
        │   ├── dataFreshness.ts, countries.ts, weather.ts
        ├── services/                  # One service module per route group
        ├── config/
        │   ├── database.ts            # SQLite connection (ENERGY_DB_PATH)
        │   ├── writeDatabase.ts       # Separate writable handle for ingest routes
        │   └── forecastModels.ts      # The model registry — see below
        ├── middleware/                # cache.ts, errorHandler.ts, writeAuth.ts
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
`useForecastModels.ts`'s `resolveSelection`). Leaving it off lets the server
walk its candidate ladder (`resolveModelCandidates`): production model first,
then the other registered ml models, returning the first with rows for that
country. This matters because catboost and xgboost cover **disjoint country
sets** — no country has data from both. Pinning the production model (catboost)
blanks `load` for AT/BE/FR and `price` for BE/DE/ES/FR/PT. The picker labels
whichever model the response's `meta.model` reports actually served, which can
differ from the picker's own selection when the ladder fell back.

`ModelPicker` renders once per active tab (`TAB_FORECAST_TYPE` maps tab ->
forecast type) and stores the choice per type in `selectedModelByType`, so a
choice on one tab never leaks into a type where that model doesn't exist. The
older `showForecast` / `showTSOForecast` / `tsoForecastType` boolean toggles
and the D+1/D+7 button are gone — `LoadTab`/`PriceTab`/`NetPositionTab` derive
`useMl` / `useTso` / `tsoHorizon` straight from the picker's selected model
(`selected.source`, `selected.tsoHorizon`). Those booleans remain in the store
only as unread legacy fields (see State management below).

### 3. Country dashboard tabs

Each tab is self-contained: a batched React Query hook (`useLoadChartData`,
`usePriceChartData`, `useRenewableChartData`, `useNetPositionData`) feeds a
`chartAdapters.ts` adapter, which feeds an `Able*` chart primitive.

- **`LoadTab`** — `AbleLineChart` (actual + one dashed forecast series, ml or
  TSO per the picker) and an `AblePriceHeatmap` of load by hour x day.
- **`PriceTab`** — same shape for day-ahead price (ml forecast only; price has
  no TSO forecast in the registry).
- **`GenerationTab`** — `AbleStackedMix` (solar/wind/hydro/biomass, stacked —
  the top chart is still renewables-only) plus an `AbleDonut` and
  `SourceTable` showing window-average share of *generation*
  (`energy_generation`, the full A75 document — see
  `generationService.getRenewableShare`). The donut and table cover the
  **whole** mix: `sourceRows.ts` groups the 21 raw `*_mw` columns into 9 rows
  — Nuclear, Solar, Wind, Hydro, Pumped storage, Fossil (seven sub-types
  collapsed), Biomass, Waste, Other — sorted by magnitude, rendering `—` for a
  type this country does not report and a dimmed right-grown bar for a
  negative one. There is no "unattributed remainder" row: every type is
  measured now, and the gap between generation and load is exports/imports
  plus losses, which is the Net position tab's subject. The donut's percentage
  and the header stat row's "Renewable share" card both read this same
  server-computed ratio of window sums, so they cannot disagree.
  No `ModelPicker` renders here — `TABS_WITH_MODEL_PICKER` in
  `CountryDashboardView.tsx` limits it to the tabs whose chart actually reads a
  selection (`price`, `load`, `net-position`). It used to render and do
  nothing, while `useRenewableChartData` fired five per-type forecast queries
  that no component consumed: six API calls per view, discarded. Both are gone.
  If you add a forecast overlay to this tab, add it back to that set.
- **`NetPositionTab`** — `AbleLineChart` for ENTSO-E day-ahead net position
  plus the Chronos forecast (median, and a p10-p90 band where stored). Handles
  a zone going silent upstream (e.g. GR/IE since 2026-03-14) as an explicit
  "stopped publishing on <date>" state rather than a loading spinner.
- **`ForecastTab`** ("Forecast accuracy") — a 4-stat strip (MAE/MAPE/RMSE/
  samples) from `/tso-forecast/metrics`, measured-only error-by-horizon bars
  (`horizonBars.ts`, ML D+1/D+2 and TSO D+1/D+7 — never extrapolated), and a
  forecast-vs-actual overlay chart. The "Compare forecast models" panel is a
  deliberate placeholder: per-model accuracy needs the accuracy endpoints to
  accept a `model` param, which they do not yet.

### 4. Time navigation

`RangeSegment.tsx` renders five buttons (`24h`, `7d`, `30d`, `+24h`, `+7d`)
that set `timePreset` in the store. The full `TimePreset` union is wider than
what's exposed there:

```typescript
type TimeAnchor = 'past' | 'now' | 'future';

type TimePreset =
  | '24h' | '7d' | '30d' | '90d' | '1y'          // Historical
  | 'today' | 'thisWeek'                          // Around now
  | 'next1d' | 'next24h' | 'next48h' | 'next7d';  // Forecast
```

`useComputedDateRange()` / `getDateRangeForPreset()` (`useDashboardData.ts`)
turn a preset + `timeOffset` into concrete start/end dates; `shiftTimeWindow()`
moves the window by half its duration; `jumpToLive()` resets to `today`/now.

`90d` and `1y` are defined but currently unreachable from the UI (only the
`24h`/`7d`/`30d`/`+24h`/`+7d` buttons are wired up) — worth knowing before
"fixing" a 90-day bug nobody can hit through the app.

### 5. State management

Zustand store (`dashboardStore.ts`) with `persist` to localStorage
(`energy-dashboard-storage`). **The persisted shape is versioned:**
`PERSIST_VERSION` in `store/migrate.ts`, bumped and given a `migratePersisted()`
clause whenever a persisted field's shape or meaning changes — e.g. the v2
migration folds the removed `layers` slice into `showForecast`/`showTSOForecast`
and remaps a stored `comparisonMetric: 'mape'` to `'wape'`. `migratePersisted`
must never throw: `state` is an arbitrary, possibly years-old localStorage blob.
Skipping this step leaves returning users on a shape the current code doesn't
understand — previously a blank tab panel or a view nobody chose.

`timeRange` (legacy) and `timePreset` (current) both persist and both drive
UI, duplicating one concept. This is deliberate, not an oversight: the
`/dashboard/overview|map|initial` endpoints accept `TimeRange` as a closed enum
and compute start/end server-side, with no `start`/`end` passthrough, so the
client can't drop `timeRange` without a backend change first.

```typescript
// Key persisted state properties
selectedCountry: string;
timeRange: TimeRange;                          // legacy, still read by /dashboard/* endpoints
timePreset: TimePreset;
timeAnchor: TimeAnchor;
selectedModelByType: Record<string, string | null>;  // per forecast-type model choice; null = hidden
comparisonMetric: 'wape' | 'mae' | 'rmse';
comparisonForecastType: string;
comparisonTimeRange: '7d' | '30d' | '90d';
```

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
(`fetch_renewable.py` → `query_generation_and_renewable_with_metadata`). Never
add a second request to fill one of them.

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

- **Nothing, for generation — except Albania.** `energy_generation` holds the
  complete ENTSO-E A75 document: nuclear, all seven fossil sub-types (gas,
  hard coal, brown coal, oil, oil shale, peat, coal-derived gas), waste,
  pumped storage and battery storage, ENTSO-E's own unclassified "Other", and
  the renewables — 21 `*_mw` columns. Measured 2026-08-04 against the replica:
  all 34 countries present, 33 of them spanning 2021-01-01 → now. **AL** is
  the sole gap (672 rows, 2026-05-26 → 2026-06-23, nothing since), and it is
  an *upstream publication* gap rather than an unfinished backfill —
  `energy_renewable` holds exactly the same 672 rows — so AL renders as "no
  data" in every window the UI can reach. **It will never fill:** Albania
  publishes no A75 document at all, and the API answers `No matching data
  found for AGGREGATED_GENERATION_PER_TYPE_R3` for every window including
  today (probed on prod with the pipeline's own client, 2026-08-06 and
  2026-08-07). Those 672 June rows are the anomaly, not the gap. Do not file
  a backfill for it.
  What *is* routinely absent is a **production type a given country never
  reports**: that is `NULL`, per column, and must stay NULL rather than become
  0. Measured, `nuclear_mw` is reported by 14 of 34 countries and `marine_mw`
  by 2, against 33 for `wind_onshore_mw` — a country showing `—` for Nuclear
  is normal, not a bug. See "Generation data" above for the NULL/0 and sign
  rules, and `sourceRows.ts` for how the columns reach the UI.
- **A real publication time.** `publication_timestamp_utc` exists on
  `energy_load`, `energy_price`, `energy_renewable` and others (~4.9M non-null
  rows) and **does not mean what its name says**. It is filled from the ENTSO-E
  response's `createdDateTime`, but ENTSO-E builds the document *on request* and
  stamps it with the generation time — so the column records **when we fetched**,
  not when the value was published. Measured: a Belgian day-ahead price for
  21:45 tonight (published ~12:45 CET yesterday) carries a
  `publication_timestamp_utc` of 06:32 this morning, which is when the cron ran.
  Nothing in the client renders it, so it is not currently lying to a user — but
  do not build on it, and do not backfill it. A historical backfill re-queries
  the API and therefore stamps every row with the date the backfill ran, which
  is worse than the NULL it replaces. `net_position` is deliberately left fully
  NULL for this reason. If you need "was this published as day-ahead or
  observed after the fact", derive it from the target timestamp relative to
  fetch time, or from `forecasts.horizon_hours` — not from this column.
- **Uniform freshness across zones.** Every actuals table is a mirror of what
  each TSO publishes *when it publishes it*, so "country X is N hours behind
  country Y" is normally upstream cadence, not a broken ingest. The cron
  (`30 0,6,13,18` in the `energy-data-gathering` container) refetches a rolling
  **7-day** window every run and upserts everything it gets, so any hole inside
  that window self-heals as soon as the TSO fills it — and a hole that persists
  across several runs is a hole upstream. Measured 2026-08-07 05:43 UTC, prod
  DB vs. a live probe with the pipeline's own client: MK `energy_load` newest
  `2026-08-05 21:00` in both, MK `energy_generation` newest `2026-08-05 21:00`
  in both, AL `energy_load` newest `2026-08-06 21:45` in both — identical
  timestamp for timestamp, including MK's two interior gaps (25h and 49h). The
  small Balkan zones are chronically late and holey: MK `energy_load` has rows
  on 30 of the 46 UTC dates from 2026-06-23 to 2026-08-07, including a 7-day
  hole 07-07 → 07-13, against 45 of 45 for DE. Two zones are dead outright —
  GB stops at `2021-06-14` and UA at `2022-02-25`. **Before filing a
  "table X is stale for country Y" bug, probe upstream**, and judge freshness
  by `MAX(timestamp_utc)` on prod, never by `data_ingestion_log`: that table
  records an `INSERT OR REPLACE` rowcount, so rewriting rows that already
  existed logs as inserts and a healthy ingest looks identical to a five-day
  upstream stall.
- **Forecast horizons beyond ~D+2.** `forecasts.horizon_hours` runs roughly
  2-64h depending on model (catboost tops out at 63h, xgboost at 64h) — there
  is no stored forecast for D+3 and beyond. `ForecastTab`'s error-by-horizon
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
and `production` if it should be the default). `ModelPicker` and
`resolveModelCandidates`'s fallback ladder both read this registry directly —
nothing else needs to change for the model to appear and be servable.

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
  | '24h' | '7d' | '30d' | '90d' | '1y'
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

```typescript
type TSOForecastType = 'day_ahead' | 'week_ahead';

interface TSOLoadForecastDataPoint {
  timestamp: string;
  forecast_value_mw: number;
  forecast_min_mw: number | null;    // Week-ahead only: daily min
  forecast_max_mw: number | null;    // Week-ahead only: daily max
  forecast_type: 'day_ahead' | 'week_ahead';
  publication_timestamp_utc?: string;
}

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
- Use React Query DevTools (enabled in dev mode)
- Check server console for database query logs and the connected `ENERGY_DB_PATH`
- If acceptance is pointed at prod (`client/.env.local`'s `API_PROXY_TARGET`),
  a server-side fix won't show up until prod is redeployed — verify against a
  local server first

## Common Issues

**"Cannot connect to database":**
- Verify the SQLite file at `ENERGY_DB_PATH` (or `server/.env`'s value) exists
- Without `ENERGY_DB_PATH` set, the server defaults to `/data/energy_dashboard.db`, which won't exist on a workstation checkout

**A country's load/price forecast is blank:**
- Check whether a specific model is pinned in `ModelPicker` — catboost and
  xgboost cover disjoint country sets, so a pinned model with no data for that
  country renders nothing. Clear the pin (select the type's default again) to
  let the server's candidate ladder try the other registered model.
- Confirm the model is actually registered in `server/src/config/forecastModels.ts`

**TSO forecasts not showing:**
- In `ModelPicker`, select a `TSO ·` entry for that forecast type. `load` has
  both D+1 and D+7 registered; `solar`/`wind_onshore`/`wind_offshore` have D+1
  only; `price`/`renewable`/`biomass`/`hydro_total`/`net_position` have no TSO
  model at all — check `forecastModels.ts` before assuming a bug
- The Generation tab has no `ModelPicker` at all — `TABS_WITH_MODEL_PICKER` in
  `CountryDashboardView.tsx` limits it to `price`/`load`/`net-position`, so
  there is no forecast overlay to switch on there; it renders actuals only
  (see Country dashboard tabs above)
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
- Verify date range calculation in `useComputedDateRange()`
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
