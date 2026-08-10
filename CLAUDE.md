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
│       │   ├── CountryDashboardView.tsx  # Per-country tabs plus forecast-quality drill-down
│       │   └── ComparisonView.tsx        # Forecast-quality portfolio: matrix, type-local ranking/map, evidence disclosure
│       ├── components/
│       │   ├── charts/               # Recharts-based primitives, shared across tabs
│       │   │   ├── AbleLineChart.tsx     # Line + forecast overlay (load, price, net position)
│       │   │   ├── AbleStackedMix.tsx    # Diverging stacked area — generation mix
│       │   │   ├── AbleDonut.tsx         # Generation-mix share donut
│       │   │   ├── AblePriceHeatmap.tsx  # Hour x day heatmap (load, price)
│       │   │   ├── AbleAccuracyBars.tsx  # Measured-error-by-horizon bars
│       │   │   ├── AbleSparkline.tsx     # Stat-tile sparklines
│       │   │   └── ChartWrapper.tsx      # Card wrapper used by the map view
│       │   ├── dashboard/            # Country-view composition
│       │   │   ├── PriceTab.tsx, LoadTab.tsx, GenerationTab.tsx,
│       │   │   │   NetPositionTab.tsx, ForecastTab.tsx  # One file per tab
│       │   │   ├── AbleCard.tsx          # Card shell dashboard chart compositions wrap their charts in
│       │   │   ├── ModelPicker.tsx       # Registry-driven forecast model selector (see below)
│       │   │   ├── ForecastGapNotice.tsx # "<model> has no forecast here" + clear-the-pin button
│       │   │   ├── TimePicker.tsx        # categorised presets + window nav
│       │   │   ├── AbleStatRow.tsx       # Top 4-stat strip (price/load/renewable share/peak)
│       │   │   ├── CountryBreadcrumb.tsx, SourceTable.tsx, ApiCta.tsx
│       │   │   ├── ForecastMetadataBadge.tsx  # ORPHANED — no importer (see State management)
│       │   │   ├── ModelComparisonPanel.tsx    # "Compare forecast models" table (ForecastTab)
│       │   │   ├── generationSeries.ts   # The nine A75 families: grouping, palette,
│       │   │   │                         #   stack order, series builder (GenerationTab)
│       │   │   └── horizonBars.ts, sourceRows.ts, windowLabel.ts, modelComparison.ts
│       │   │                                   # Pure helpers (each has a .test.ts)
│       │   ├── comparison/           # ComparisonView's heatmap/map/leaderboard/filter bar
│       │   │   └── accuracyScale.ts, leaderboardRows.ts, mapFill.ts
│       │   │                                   # Pure helpers (each has a .test.ts)
│       │   ├── map/                  # EuropeMap.tsx (choropleth), MapMetricSelector.tsx,
│       │   │                         #   mapGeometry.ts, NoDataHatch.tsx (the shared no-data mark)
│       │   ├── layout/               # AbleHeader.tsx, freshnessPill.ts (pure, .test.ts)
│       │   └── ui/                   # shadcn/radix primitives (button, card, tabs, select, ...)
│       ├── hooks/
│       │   ├── useDashboardData.ts       # Bulk of the React Query hooks
│       │   ├── useLoadChartData.ts, usePriceChartData.ts,
│       │   │   useNetPositionData.ts     # Per-tab batched-query hooks
│       │   ├── useForecastModels.ts      # Registry query + model-selection resolution
│       │   ├── useModelComparison.ts     # Per-model accuracy, one query per registered model
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
│           │   dataScale.ts, divergingScale.ts, divergingStack.ts, servedModel.ts,
│           │   forecastGap.ts, trailingGap.ts, timezone.ts,
│           │   queryRetry.ts, netPositionProvenance.ts, formatters.ts,
│           │   providerRegistry.ts, utils.ts
│
└── server/
    └── src/
        ├── app.ts                     # createApp() — the whole middleware graph, no listen()
        ├── index.ts                   # Detects the built client, calls createApp, listens
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
        │   ├── freshness.ts           # Pure: is a stream live / stale / never held
        │   ├── loadQuality.ts         # Pure: the impossible-zero load rule
        │   └── degenerateForecast.ts  # Pure: collapsed-to-zero net position
        ├── config/
        │   ├── database.ts            # SQLite connection (ENERGY_DB_PATH)
        │   ├── writeDatabase.ts       # Separate writable handle, opened lazily —
        │   │                          #   used by netPositionIngest.ts and weather.ts
        │   └── forecastModels.ts      # The model registry — see below
        ├── middleware/                # cache.ts, errorHandler.ts, writeAuth.ts
        ├── utils/                     # timestamp.ts (normalizeTimestamp)
        ├── docs/                      # claudeMdCitations.ts — checks this file's
        │                              #   own `file:line` citations (see Testing)
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
- **`CountryDashboardView`** — four top-level country tabs: Price, Load, Generation and Net position. Forecast-quality country detail is entered from the portfolio, not carried as a competing tab (`client/src/views/CountryDashboardView.tsx:121`).
- **`ComparisonView`** — the Forecast quality portfolio home: a type-local ranking/map for the default `load` type leads the page, followed by disclosed error evidence and the country × forecast-type matrix as the explicit all-types view (`client/src/views/ComparisonView.tsx:26`).

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

**A pin is clearable, and "pinned" is not "shown" (ABL-16).** The server still
honours an explicit request strictly — "if you asked for xgboost and it has
nothing, you get nothing, not a silent substitution" (`forecastModels.ts:177`).
That strictness is correct; what was wrong was that the client could only ever
*add* a pin. Two things changed, both client-side:

- The dropdown's **"Default"** entry calls `clearSelectedModel(forecastType)`
  instead of `setSelectedModel(…, m.id)`; the other entries still pin. Absent
  from `selectedModelByType` is the only state that reaches the candidate
  ladder, so it has to be reachable by a click.
- **Hidden moved out of `selectedModelByType` into its own
  `forecastHiddenByType`.** They shared one slot (`null` meant hidden), so
  switching the overlay off destroyed the pin and switching it back on had to
  fabricate one — it re-pinned the production model, pinning catboost for users
  who never chose it. The on/off button now writes only
  `setForecastHidden(forecastType, …)`, and a pin survives an off/on cycle
  untouched.

`resolveSelection(registry, forecastType, pinnedId, hidden)` takes the two as
separate arguments for the same reason. The v7 migration splits an old blob and
**drops every stored pin**: under the old picker every entry wrote one, so a
stored pin cannot be told apart from an artefact of the bug, and unpinned is
the state that always renders something. That is also what frees users already
trapped.

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

### 2b. Staleness disclosure in the header stat row

`AbleStatRow`'s four tiles are not the same kind of number, and that governs
how each handles missing/old data. Three are **aggregates over the selected
window** (day-ahead price, renewable share, peak demand): their queries are
bounded, so a window with no rows yields `null` and the tile renders `—` on its
own. "Current load" is the one **instantaneous** tile, and its query in
`getDashboardOverview` is deliberately **not** window-bounded — `TimePicker`
exposes the forward presets (`next24h`/`next7d`, and the `Tomorrow`/`+7d` quick
buttons), and `getDateRangeForPreset` starts those windows at now, so bounding
it would blank the tile for all 34 countries the moment the user looks forward.
Verified: under `next7d`, DE still reads `40.76 GW` while its three windowed
siblings correctly read `—`. (It *is* filtered by `measuredLoadClause()`, the
ABL-35 impossible-zero guard — "the latest measurement we hold" means the
latest one that is not a placeholder.)

Because the value is unbounded in time, **the number alone says nothing about
whether it describes now** — which is how GB rendered a 2021-06-14 reading as
`CURRENT LOAD 37.27 GW` for five years (ABL-58). So the age travels with it:
`DashboardOverview.dataTimestamp` is that row's own `timestamp_utc`, and
`client/src/lib/readingFreshness.ts` decides between three outcomes —

| age | outcome |
|---|---|
| `< 2h` | show bare (normal ENTSO-E publication lag) |
| `2h – 48h` | show with an `as of 6h ago` caveat beside the label |
| `> 48h`, or no parseable timestamp | **withhold** the number, label `last reading 5y ago` |

The 2h line is the same one `trailingGap.ts` and `chartSummary.ts` already draw,
so the page doesn't define "stale" three ways. The 48h line is two diurnal
cycles: below it a caveat is honest (the healthy fleet runs 6-8h behind, MK 33h),
above it no caveat rescues the number, because the user reads the figure first.

Two related traps this fixed: `timestamp_utc` is UTC by name but the stored text
does not say so *and comes in two shapes* — measured 2026-08-07, `energy_load`
holds 2,485,282 space-separated rows and 279,880 `'T'`-separated ones, and every
GB/UA row is the `'T'` form, which a browser parses as **local** time. The
server now stamps the `Z` (`toIsoUtc`, `server/src/utils/timestamp.ts`) and the
client parser accepts both, because acceptance is routinely proxied at a
not-yet-redeployed prod (`API_PROXY_TARGET`). And an absent/unparseable
timestamp **withholds** rather than assuming freshness — the failure being fixed
is a number presented as current on no evidence.

**This is not the same signal as the header pill** (section 7). The pill reports
the *pipeline's* health per stream from `/api/data-freshness/:cc`, with its own
threshold (`MEASURED_STALE_AFTER_HOURS`, 18h) sized from the ingest schedule.
This rule governs one *rendered reading*, and is stricter (48h, and it withholds
rather than annotates) because a stat tile leads with the figure. Two read
paths, two thresholds, on purpose — a stale pill still leaves a 6h-old number
worth showing, and a five-year-old number is not rescued by a pill beside it.

### 3. Country dashboard tabs

Each tab is self-contained: a React Query hook (`useLoadChartData`,
`usePriceChartData`, `useNetPositionData`, `useGenerationSeries`) feeds an
adapter — `chartAdapters.ts` for the line charts, `dashboard/generationSeries.ts`
for the stacked mix — which feeds an `Able*` chart primitive.

- **`LoadTab`** — `AbleLineChart` (actual + one dashed forecast series, ml or
  TSO per the picker) and an `AblePriceHeatmap` of load by hour x day.

  **An `energy_load` row of exactly `0.0` is withheld everywhere, because a
  national grid never draws 0 MW** (ABL-35). This is the same "published a
  placeholder as a measurement" defect as GR's net position below, in a
  different table, and it was live: measured read-only against the replica
  2026-08-06, **543 of 2,762,517 rows are exactly `0.0`** across 11 countries
  (BA 277, MK 99, ME 73, ES 46, PL 25, MD 10, RO 5, AL 4, NL 2, RS 1, SI 1) and
  **0 rows are negative**. It is ongoing, not historical — the newest were SI at
  `2026-08-06 00:00` and MK at `2026-08-02 21:00`.

  **Where they come from, and why this guard still earns its keep** (ABL-50).
  At least MK's are manufactured by our own ingest. An ENTSO-E `Period`
  declares a resolution over an interval, implying N positions, but may carry
  fewer than N `Point` elements; entsoe-py 0.8.0 forward-fills the gap and
  `energy-data-gathering` stored the expansion as `data_quality = 'actual'`.
  MK's document for `2026-08-01T22:00Z` carries **one** Point — `position 1,
  quantity 0.0` — and 24 rows were written. `src/published_points.py` in the
  sibling module now refuses a row that is both forward-filled and exactly
  `0.0`, so MK stores 1 row instead of 24 (verified through the real fetch
  path, 2026-08-06).
  **That fix is not deployed** — it is stacked behind the pending
  `energy-data-gathering` main deploy decision, so the count on the replica
  keeps growing until it ships. And it does not make this read-side guard
  redundant even then: MK's `position 1` **was** genuinely published as `0.0`,
  so it is still stored on purpose, and `measuredLoadClause()` is the only
  thing keeping it off a chart. The two rules are complementary, not
  duplicative — do not remove this one when the ingest fix lands.

  They are provably not measurements: MK's three affected days are `0.0` for all
  22-24 hours while MK's surrounding daily peak is 543-717 MW. What that put on
  screen — **MK and SI both had an impossible zero as their newest stored row,
  so the header stat tile read a confident `0 MW`**; `getLoadStats` reported
  `min_load: 0` for both over a 30-day window; and MK's 30-day mean read
  330.7 MW against a true 378.5 MW, understated by 12.6%.

  `services/loadQuality.ts` is the rule (pure, colocated test). Two properties
  matter, and both are the *opposite* of the net-position rule below:

  - **Per row, not per series.** A load is strictly positive, so a single zero
    is impossible on its own and can be judged alone. A net position is signed
    and legitimately crosses zero, so only its series maximum carries
    information. Withholding MK's whole series would destroy 56,510 good
    readings to suppress 99 bad ones.
  - **Exactly zero, not a magnitude floor.** 24 rows sit in `0 < load < 10` MW
    (MK 17 with a minimum of 0.01, BA 6, ME 1) and are probably false too, but
    `0.0` needs no calibration to be disprovable while any cutoff above it is a
    number nobody has justified. That grey zone is deliberately still served.

  `measuredLoadClause()` is applied at every `energy_load` read site —
  `loadService.ts` (5), `dashboardService.ts` (4: current load, peak demand,
  the map choropleth, the timeseries daily average) and
  `dataFreshnessService.ts` (1). That last one was the hole, closed by ABL-60:
  the freshness endpoint dated the *pipeline's health* from a raw
  `MAX(timestamp_utc)`, so a placeholder could certify the ingest as current.
  Measured on the replica 2026-08-07, SI's raw MAX was `2026-08-07 00:15` with
  `load_mw = 0` against a guarded MAX of `00:00`. `loadActualGuard()` covers
  the accuracy joins, which are generic over forecast type and so must apply it
  **only** to `load`: a `0.0` is ordinary for solar overnight, for still wind,
  and for a zero-clearing price, and a blanket `> 0` there would delete real
  measurements and bias every renewable metric upward. That path was affected
  too — joining the 543 rows to the forecast tables, ES 104 and SI 8 pair with a
  stored ML load forecast and MK 72 / ES 46 / ME 25 / PL 25 / MD 9 / AL 4 / NL 2
  / RS 1 / SI 1 pair with a TSO one, each scoring a 100% error against a number
  nobody took, with SI's and MK's inside the default 30-day window.

  Known gap, filed separately: `energy_renewable` has the same signature and is
  **not** guarded, because there the rule is genuinely ambiguous — AT is exactly
  `0.0` across solar, wind *and* hydro for all 96 rows of 2025-11-15 and 11-16,
  sandwiched between days at 1,724-2,071 MW (impossible), while MD's near-zero
  days sit inside a genuine 2-282 MW range and cannot be told apart by
  magnitude. Do not extend `measuredLoadClause` to it without sizing that first.
- **`PriceTab`** — same shape for day-ahead price (ml forecast only; price has
  no TSO forecast in the registry).

  **This is the one tab whose actuals are legitimately dated in the future.**
  The day-ahead auction publishes the *whole* of the next market day at ~12:45
  Brussels, so `energy_price` holds rows past now by design. Every preset
  except the forward-looking ones ends at or before now, so without a floor the
  tab would never ask for tomorrow at all — measured against a local server on
  a probe database, 2026-08-07: the `7d` preset's own window returns **0** of
  tomorrow's 96 quarter-hour rows, and the floored window returns all 96.
  `lib/priceWindow.ts`'s `getPriceWindowEnd` is that floor and **every caller
  sharing the `['prices', …]` query key must use it** — the key does not encode
  the window, so two hooks with different windows poison each other's cache
  (`useDashboardData.ts`'s `usePriceData`, `usePriceChartData.ts`).

  The floor is *the end of tomorrow's Brussels market day*, not an hour count.
  It was `now + 36h`, which was sufficient only by coincidence: the gap from
  the earliest plausible publication to the last quarter-hour of the next
  market day is 35h15m on an ordinary day and exactly **36h00m** on the
  25-hour clocks-back day (2026: publication 10:45 UTC on 24 Oct, last row
  22:45 UTC on 25 Oct), so an auction published early on that one day would
  have dropped the day's final row. `lib/priceWindow.test.ts` pins the 23-,
  24- and 25-hour days. `lib/chartTicks.ts`'s `SHORT_SPAN_HOURS` is still 36
  and is now unrelated to anything — its comment used to flag the two as a
  coincidence worth watching, and there is no longer a second 36 to watch.

  **The ingest side already fetches D+1 and always has** — this is worth
  knowing before re-diagnosing a "tomorrow is missing" report as a window bug.
  `../energy-data-gathering`'s `config.ENTSOE_API_CONFIG['price']` has carried
  `is_dayahead: True` since its initial commit, `scripts/update.py`
  auto-enables `include_dayahead` from that flag, and prod's request URL on
  2026-08-06 was literally `documentType=A44&…&periodEnd=202608080000` — the
  end of D+1 — on all four passes. See ABL-54.
- **`GenerationTab`** — `AbleStackedMix` (the full mix, stacked) plus an
  `AbleDonut` and `SourceTable` showing window-average share of *generation*.
  **All three marks now read `energy_generation` through one grouping** (ABL-44).
  Until then the chart alone came from the frozen, renewable-only
  `energy_renewable` and drew four families, while the donut and table beside
  it drew the whole A75 document — one card, two different mixes, and no
  nuclear or fossil band at all for countries that are mostly both (France
  reads 70.8% nuclear in the table and had none on the chart).

  The 21 `*_mw` columns collapse into **nine** families, stated server-side in
  `generationService.GENERATION_GROUPS` and mirrored by
  `dashboard/generationSeries.ts`'s `WIRE_FIELD` and by `buildSourceRows`:
  nuclear, solar, wind, hydro, pumped storage, fossil, biomass, waste, other.
  `/generation/series` is the trend endpoint (`getGenerationSeries`),
  `/generation/mix` the window average. Over a single bucket spanning the
  window the two return the same numbers group for group — asserted in both
  `generationService.test.ts` and `routes/generation.test.ts` — which is what
  keeps the chart and the donut from disagreeing. The palette, labels and
  stack order live once in `generationSeries.ts` and all three marks import
  them; three private copies had already drifted (solar was `#D9A114` in two
  and `#F0B92B` in the table).

  Three properties are load-bearing:

  - **A group nobody reports is not drawn.** Per bucket, each group is
    `CASE WHEN AVG(a) IS NULL AND AVG(b) IS NULL THEN NULL ELSE
    COALESCE(AVG(a),0) + COALESCE(AVG(b),0) END` — `sumOrNull` in SQL. Both
    halves matter: `AVG(a + b)` propagates one unreported member's NULL and
    deletes a real reading beside it (FR's `hydro_reservoir_mw` at 02:00),
    while `AVG(COALESCE(a,0) + COALESCE(b,0))` charges a bucket for the rows a
    column is simply absent from. `buildGenerationMixSeries` then drops a group
    that is null at *every* point from the series, the legend and the tooltip,
    so a country gets no swatch above an invisible band. Measured on the
    replica over 7d, this is common, not an edge case: **DE, AT, PT, PL, IT and
    GR report no nuclear**, SE no biomass/waste/pumped storage, GR no
    biomass/nuclear/waste.
  - **Negatives are stacked below zero, never clamped.** Pumped storage is
    negative while charging and a consumption-only fossil type is negative
    outright. `lib/divergingStack.ts` (d3's `stackOffsetDiverging`, in a dozen
    lines, with the argument in its header) puts positives above the baseline
    and negatives below it; the axis only reaches below zero when something
    really is negative, so SE — which has no negatives at all — is laid out
    exactly as a plain stack would lay it out. Measured over 7d, **11 of 12
    countries checked have negative pumped storage**, DE as deep as −6.25 GW.
  - **The storage groups are stacked FIRST, adjacent to the baseline, and that
    is correctness rather than taste.** In a diverging stack a group that flips
    sign jumps by however much is stacked beneath it. `hydroPumped` and `other`
    (which carries `energy_storage_mw`) flip constantly at the stored
    15-minute resolution — FR `other` 144 times in a week, `hydroPumped` 23,
    DE 40, ES 16 — and the first cut of ABL-44 ordered them last, which
    teleported a band across the whole 64 GW height of France's stack ~170
    times and read as a generation collapse that never happened.
    `dashboard/generationSeries.test.ts` pins the ordering.

  No `ModelPicker` renders here — `TABS_WITH_MODEL_PICKER`
  (`CountryDashboardView.tsx:56`, applied at `:116`) limits it to the tabs
  whose chart actually reads a selection (`price`, `load`, `net-position`). It
  used to render and do nothing, while `useRenewableChartData` fired five
  per-type ML forecast queries plus a TSO one that no component consumed: six
  API calls per view, discarded. Both are gone, and so is that hook — ABL-44
  moved its last consumer onto `useGenerationSeries`, taking
  `chartAdapters.adaptRenewableMixSeries` with it. If you add a forecast
  overlay to this tab, add it back to that set.
- **`NetPositionTab`** — `AbleLineChart` for ENTSO-E day-ahead net position
  plus the Chronos forecast (median, and a p10-p90 band where stored). Handles
  a zone going silent upstream as an explicit "stopped publishing on <date>"
  state rather than a loading spinner. GR and IE are the live examples, and
  **this entry used to give the wrong date for both**: it said their continuous
  series ends `2026-03-14 22:00`. Re-measured 2026-08-06, it ends
  **`2025-09-30 21:00`** — the last hour of the CEST market day 2025-09-30.
  Everything after that is scraps, a handful of isolated market days
  (2026-02-14→16, 02-26, 03-01→02, 03-14, 07-24). Both zones stop in exact
  lockstep at the same hour, out of 22; they are still the only two whose
  `net_position` stops before 2026-08.

  **Those scraps are not "a backfill or a passing cron window happening to
  catch a day", which is what this entry used to claim — most of GR's are rows
  we manufactured** (ABL-38 root-caused it, ABL-55 fixed the cause). ENTSO-E
  occasionally emits a sparse A25 document: a `Period` declaring 22-24 hourly
  positions that carries **one** `<Point>`. entsoe-py 0.8.0 forward-fills that
  point across the whole declared period, and the ingest stored the expansion.
  When the single point is `quantity=0`, a full day of measured-looking `0.0`
  MW lands in `net_position`. Raw XML, fetched 2026-08-07: GR's document for
  `2026-07-23T22:00Z` declares `PT60M` over 24 positions and carries one Point,
  `position 1, quantity 0`.

  **The two zones are not symmetric, and this matters when reading the tab.**
  Measured on the replica 2026-08-07:

  - **GR — 192 of 192 post-break rows are exactly `0.0`**, every one
    fabricated, across 13 UTC-day buckets. GR has published no real net
    position since 2025-09-30. Its own `crossborder_flows` show a median net
    *export* of 1,142 MW over those same hours.
  - **IE — only 2026-03-14 is fabricated** (23 rows, plus 1 spill row on
    03-13 = 24). Its other post-break days carry genuine values, up to 738.8
    MW, so IE's newest *usable* day is 2026-07-24, not 2025-09-30.

  The ingest guard is `../energy-data-gathering/src/published_points.py`
  (`drop_unpublished_zeros_series`, wired at
  `../energy-data-gathering/src/entsoe_client.py:1941`), shared
  with the load path rather than reimplemented — this was the same defect's
  second occurrence, after ABL-50. It refuses a row only when it is **both**
  forward-filled **and** exactly `0.0`. Do not tighten that to "store only
  published Points": measured 2026-08-07, healthy A25 documents are routinely
  sparse under `curveType=A03` (PT 2026-02-18 carries 7 Points for 47 declared
  positions, ES 2026-02-08 carries 51 for 112) because an interconnector held
  at a flat 500/1500 MW is encoded as one Point plus a hold. The strict rule
  would delete over half of PT's and ES's genuine rows.

  **The fix is NOT deployed — verified against prod 2026-08-07, not inferred.**
  `/app/src/published_points.py` does not exist in the running
  `energy-data-gathering` container and `/app/src/entsoe_client.py` contains
  zero references to either guard function. The image was built **2026-07-31
  06:54Z** and has been up 7 days, so *every* ingest fix merged since is
  missing from prod — `12c5a6b` (ABL-50 load guard), `1dc6e99` (this one),
  `6299e98` (ABL-54 day-ahead price window), `4e99322` and `941d258`
  (crossborder). Tracked on **ABL-71**. Do not read ABL-63 as having shipped
  any of them: it deployed the *dashboard-frontend* container, so the ABL-55
  merge being an ancestor of this module's local main says nothing about prod.
  Note this cuts both ways for ABL-54 — its **client** half is live and its
  **ingest** half is not.

  Deployed or not, the guard only stops *new* fabrications: the
  **216** already-stored rows (GR 192, IE 24) are still in the table, and
  deleting them is a separate CEO decision (**ABL-67**, blocked on the board),
  not yet taken. So the read-side guards below remain the only thing keeping
  those rows off a chart — do not remove them when the ingest fix ships.

  The date the tab prints is **not** `MAX(timestamp_utc)` any more — see
  `getLastSeen`, which takes the newest *usable* day. That matters because GR's
  series does not stop, it degenerates: see the actuals rule below.

  **A forecast series that has collapsed to zero is withheld, not drawn**
  (ABL-25). GR's stored `chronos-2-V010` net position is numerically zero:
  measured 2026-08-06, 168 rows with every median between `2.3e-11` and
  `4.6e-7` MW and the whole p10-p90 band inside `0.0038` MW — and **not one
  exactly `0.0`**, so an `= 0` guard catches none of them. Charted, that is a
  flat line at 0 MW under a hairline band, which reads as an unusually
  *confident* forecast; and nothing contradicts it, because GR publishes no
  actuals in a recent window and pairs no points into any accuracy metric. So
  the chart was the only place the number appeared at all.

  `services/degenerateForecast.ts` is the rule, as a pure function with a
  colocated test: a series is degenerate when the largest `|value|` across
  every median **and stored quantile** is under `DEGENERATE_SERIES_MAX_ABS_MW`
  (1 MW). Three properties matter.
  - **The maximum over the series, never a single point.** A real net position
    crosses zero, and genuine rows go as low as 0.0094 MW (ES) — judging
    point-by-point would delete the interesting part of the chart.
  - **The threshold is sized from measurement.** The quietest genuine
    single-day window in the whole table is SI on 2026-07-29 at 16.7 MW, so 1
    MW sits an order of magnitude below anything real and six orders above
    GR's largest value. All 19 other countries stay `served` (verified against
    a local server on the replica, 2026-08-06).
  - **Including the band makes the rule stricter, on purpose.** A median
    hugging zero under a ±3 GW p10-p90 is a real statement about a hard
    window, and stays served.

  `getNetPositionForecast` returns `forecast: []` with
  `meta.forecast_coverage: 'degenerate_zero'` and
  `meta.degenerate_forecast: { points, max_abs_mw }` — the vocabulary is
  deliberately parallel to `MLAccuracyCoverage`. `vintages` and `has_band`
  empty out with the series (both are documented as describing what is *in*
  `forecast`, and the client captions the chart from them, so leaving them
  populated just relocates the false claim into the subtitle). `model_name`
  stays: naming who produced the unusable rows is the honest half of the
  answer, and it is what separates this from the no-rows case, where
  `model_name` is `null`. The tab prints the reason via
  `dashboard/degenerateForecastNote.ts` (pure, colocated test) rather than
  drawing nothing — filtering the rows out silently would trade a confidently
  wrong chart for a mysteriously missing one.

  **The same rule now covers the ACTUALS, and that was the more serious of the
  two** (ABL-35). GR's `net_position` did not stop on 2025-10-01 — it turned
  into exact `0.0` and stayed there: measured 2026-08-06, **192 of 192** rows
  published since are exactly zero, written by 7 independent fetch batches
  between 2026-02 and 2026-07. Unlike the forecast these *are* exact zeros, so
  the two cases need different guards and neither implies the other.

  They are provably false, from our own database: joining those same hours to
  GR's `crossborder_flows` gives a **median net physical export of 1,142 MW**
  (max 1,657; 187 of 192 hours above 100 MW). Greece was moving better than a
  gigawatt across its borders while the tab drew a flat line at 0 MW under the
  label "ENTSO-E day-ahead" — a measurement, not a gap, and wrong by a
  gigawatt. Controls: BG and BE have **zero** exact-`0.0` hours in 7,438.

  The threshold is sized independently for actuals and lands in the same place.
  Over all **26,882** country-days in `net_position` with ≥20 hours, exactly
  **9** are degenerate (8 GR days plus IE 2026-03-14) and every one has a daily
  max of exactly `0.000000`; the next quietest day in the table is IE
  2023-09-01 at **92.3 MW**. Every threshold between 0.5 and 50 MW selects the
  same 9, so 1 MW is not a tuned edge. Verified against a local server on the
  replica (2026-08-06): of 39 countries, **GR alone** is withheld, 21 are
  `served`, 17 have no `net_position` at all.

  `classifyActualSeries` is the rule and `getNetPositionActualSeries` applies
  it, returning `actual: []` with `meta.actual_coverage: 'degenerate_zero'` and
  `meta.degenerate_actual: { points, max_abs_mw }` — the same vocabulary as the
  forecast half, on its own field, because a country can have either defect
  alone. `dashboard/degenerateForecastNote.ts`'s `describeDegenerateActual`
  prints it, and it deliberately does **not** say "stopped publishing": ENTSO-E
  is still returning rows, and blaming an ended series would be the wrong story
  told confidently.

  **`getLastSeen` dates the outage from the newest usable day, not the newest
  row.** A bare `MAX(timestamp_utc)` dated GR at 2026-07-24 — the last day it
  published a *number*. The last day it published a *measurement* is
  2025-09-30, so the tab was off by ten months, under a sentence asserting the
  series had ended upstream. The filter is per calendar **day** (a day whose
  largest `|value|` is inside the floor is not a day this zone published), not
  per row: a real net position crosses zero, and stepping back over every
  zero-crossing hour would misdate healthy zones. Measured over the whole
  table, it changes the answer for exactly one zone.

  Known gap, filed separately: with both series withheld, GR's card is now
  entirely an empty state — which is correct, but it means the preset button
  says "30d" beside a card with no axis at all. `AbleLineChart`'s day-marker
  derivation (`AbleLineChart.tsx:241`) was the reason the pre-ABL-35 24-hour
  version carried no dates either.
- **`ForecastTab`** ("Forecast accuracy") — a 4-stat strip (MAE/MAPE/RMSE/
  samples) from `/tso-forecast/metrics`, measured-only error-by-horizon bars
  (`horizonBars.ts`, ML D+1/D+2 and TSO D+1/D+7 — never extrapolated), a
  forecast-vs-actual overlay chart, and the **"Compare forecast models"** panel
  (`ModelComparisonPanel.tsx` + `useModelComparison.ts`, ABL-6). That panel is
  no longer a placeholder, and the sentence it used to print — "the accuracy
  endpoints do not accept a model parameter" — is gone; it had been false since
  ABL-5.

  The panel lists **every** model the registry declares for this tab's forecast
  type (`TAB_FORECAST_TYPE.analytics` → `load`), one row each, and measures each
  by name: ml models via `/forecast-comparison/:cc/ml-accuracy` pinned to
  `horizon=1`, tso models via `/tso-forecast/accuracy/load/:cc`. The ml horizon
  pin is load-bearing — unpinned, that endpoint blends every stored horizon
  (2-63h), so a model whose runs skew short would beat one whose runs skew long
  for reasons that are not about the model. Adding a model to
  `forecastModels.ts` adds a row with no client change.

  It is a table, not bars, and that is a correctness choice: a bar chart has no
  honest mark for "this model does not serve this country", and with disjoint
  catboost/xgboost coverage that is the common case, not an edge case. Measured
  against a local server on 2026-08-05 over a 7d window: FR reads catboost
  `no_model_coverage` / xgboost MAPE 6.62, DE is the mirror (catboost 9.25,
  xgboost none). A row with zero paired points renders a sentence — "No data —
  this model does not forecast DE." — and **no metric cell of any kind**, so it
  cannot read as a flawless 0%. The mapping is a pure helper
  (`modelComparison.ts`, with `.test.ts`), and the panel's rendered HTML is
  asserted too (`ModelComparisonPanel.test.tsx`, `renderToString` — no DOM
  needed, so it runs in the default node environment).

  Two limits worth knowing. The TSO accuracy route reports no `coverage`
  classification, so an empty TSO window stays "no forecast/actual pairs in this
  window" rather than claiming that TSO does not publish for the country. And a
  tso model registered for a type this client has no accuracy route for
  (solar/wind live on `/tso-forecast/accuracy/generation/:cc`, which nothing
  here calls) still gets a row, saying it was not measured — wire that route
  into `useModelComparison.ts`'s `isMeasurable` if you need it.

  Nothing is persisted for this panel, so no `PERSIST_VERSION` bump was needed:
  it compares every registered model rather than a user-chosen subset.

### 4. Time navigation

`TimePicker.tsx` (`client/src/components/dashboard/TimePicker.tsx`) is the
**only** writer of `timePreset` anywhere in the client. It renders four quick
buttons (`7d`, `Today`, `Tomorrow`, `+7d`), a `More` popover holding the rest
grouped by anchor, and the window navigation — back/forward arrows
(`shiftTimeWindow`) and `Now` (`jumpToLive`). Its contents are data, in
`dashboard/timePresets.ts`. Every value of the union is reachable from it:

```typescript
type TimeAnchor = 'past' | 'now' | 'future';

type TimePreset =
  | '24h' | '7d' | '30d'                          // Historical
  | 'today' | 'thisWeek'                          // Around now
  | 'next1d' | 'next24h' | 'next48h' | 'next7d';  // Forecast
```

`getDateRangeForPreset()` (`useDashboardData.ts:47`) turns a preset +
`timeOffset` into concrete start/end dates.

**Shifted windows.** `timeOffset` is real as of ABL-12 — the arrows write it,
and it is `<= 0` always: `shiftTimeWindow` clamps forward navigation at the
live position, so a window never runs past now into a region with no actuals
(or past the ~D+2 horizon anything is stored for). One click moves the window
by `PRESET_SHIFT_HOURS` (`lib/constants.ts`), which states a step per preset
rather than deriving half the window length. That derivation was wrong for
`today` and `next1d`: they are Brussels **market days**, and half of 24h
re-derived the same calendar day about half the time — a click that redrew an
identical chart under a caption claiming a different day. Those two step one
whole day, applied as calendar arithmetic (`dayOffset`, `lib/timezone.ts`),
because no fixed hour count steps a Brussels day across DST: 24h back from
26 Oct 23:59 CET is still 26 Oct on the 25-hour day.

**A shifted window must never wear a now-anchored label.** Every preset label
("7d", "next 24h") claims a window anchored to now, and that claim expires the
moment the window moves. `describeWindow()` (`dashboard/windowLabel.ts`)
returns the preset name at offset 0 and the window's own bounds otherwise;
`AbleStatRow` reads both `timePreset` and `timeOffset` through it. Bounds are
formatted in the **viewer's** timezone, matching the chart axes and the "times
in <zone>" caption — a Brussels-formatted caption over a locally-formatted
axis would disagree with itself.

Adding a preset means touching six places. All six now fail loudly:

- Keyed `Record<TimePreset, …>`, so the missing key is named directly:
  `PRESET_SHIFT_HOURS` (`lib/constants.ts:20`), `WINDOW_LABEL`
  (`dashboard/windowLabel.ts:23`), and `ANCHOR_FOR_PRESET`
  (`store/migrate.ts:21`), whose keys `VALID_TIME_PRESETS` derives from.
- A `const unhandled: never = preset` in the `default` branch, so the new value
  is reported as not assignable to `never`: `getDateRangeForPreset`
  (`useDashboardData.ts:121`) and `getGranularityForPreset`
  (`useDashboardData.ts:162`).
- The sixth — giving the preset a **control** — cannot be typed: a preset with
  no button is unreachable, not ill-typed, which is how four of them sat in the
  union until ABL-12. It is a **test** failure instead:
  `dashboard/timePresets.test.ts` asserts `REACHABLE_PRESETS` covers every key
  of `WINDOW_LABEL` (itself compiler-guaranteed to be the whole union).

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
`PERSIST_VERSION` in `store/migrate.ts` (currently `7`, `migrate.ts:3`), bumped
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
stored `comparisonMetric: 'mape'` to `'wape'` (`:88`), **delete** three dead
keys — `layers` (`:82`), `timeRange` (`:102`), `analyticsConfig` (`:114`) —
and split `selectedModelByType`'s pin/hidden conflation into
`forecastHiddenByType`, dropping every stored pin (`:155-163`, ABL-16).
Note `layers` is deleted, not folded into `showForecast`/`showTSOForecast` as
an earlier version did — that folding unconditionally overwrote `showForecast`
with `false` on every migration, clobbering a value the current code had
legitimately set moments earlier.

**`timeRange` is gone.** This section used to say `timeRange` (the legacy
closed enum) and `timePreset` both persisted and both drove UI, and that the
`/dashboard/*` endpoints forced it. Neither is true any more: nothing in
`client/src` declares or reads a `timeRange` field, there is no `TimeRange`
type in `client/src/types/index.ts` at all (the enum survives only server-side,
`server/src/types/index.ts:219`), `useDashboardOverview` sends an explicit
`start`/`end` computed by `getDateRangeForPreset` (`useDashboardData.ts:175`,
and `useMapData` likewise at `:212`), and `migratePersisted` deletes a stored
`timeRange` outright (`store/migrate.ts:102`). `timePreset` is the single field
describing the window. (`comparisonTimeRange`, a separate `'7d'|'30d'|'90d'`
field for `ComparisonView`, is unrelated and does still exist.)

Nor was there ever a *backend* blocker forcing it to stay. The
`/dashboard/overview|map|initial` endpoints take an explicit `start`/`end`
window and let it **win** over the legacy enum whenever both are present
(`server/src/routes/dashboard.ts:49`, `:76`, `:138`; `timeRange` is consulted
only as the fallback, via `getTimeRangeDates` in `dashboardService.ts:14`, and
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
selectedModelByType: Record<string, string>;         // per forecast-type PIN; absent = server ladder
forecastHiddenByType: Record<string, boolean>;       // overlay switched off, per type; absent = shown
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
  `useLatestForecast` gates its query on it (`useDashboardData.ts:303`, `:312`)
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

**Colouring a WAPE is a ranking, never a grade** (ABL-19). All three tabs
colour through `components/comparison/accuracyScale.ts`: `wapeScale()` collects
one forecast type's measured values, `wapeColor()` places a country at its
**rank** within them on the shared teal → amber → terracotta ramp
(`lib/dataScale.ts`, the same three stops `EuropeMap` uses).

Three properties are load-bearing:

- **Per forecast type, never across types.** A 7% load WAPE and a 90% wind WAPE
  are not the same amount of wrong. The heatmap builds one scale per column
  (`ComparisonHeatmap.tsx`), the map one per selected type, the leaderboard one
  per table.
- **Rank, not magnitude.** Value-normalising into min..max was tried first and
  fails on this data: measured 2026-08-05, 21 of the 24 load WAPEs sit in
  2.1-8.3% and then NL is 30.4%, so a magnitude scale pins those 21 into the
  first fifth of the ramp as one indistinguishable teal. Every caller prints the
  WAPE next to the colour, because colour distance no longer means error
  distance.
- **Fewer than `MIN_COUNTRIES_FOR_SCALE` (3) measured countries gets no colour
  at all.** With two values the colour only restates which number is bigger
  while implying a spread nobody measured. Live example: the `hydro_total`,
  `wind_offshore` and `biomass` heatmap columns hold BE and FR only.

**"Not measured" is a hatch, never a paler fill** (ABL-23). WAPE is `null`
whenever the window's actuals sum to zero, and most of the ~51 shapes in
`europe.topojson` carry no entry at all — on the default 30-day window, measured
2026-08-05, `load` and `price` cover 24 countries, `renewable`/`solar`/
`wind_onshore` 4, and `wind_offshore`/`hydro_total`/`biomass` 2. So "we did not
measure this" is the *majority* state of that map, not an edge case.

Both choropleths render it with the same diagonal hatch, defined once in
`components/map/NoDataHatch.tsx` (`NoDataHatchPattern` for the map,
`NoDataSwatch` for the legend key, both keyed on a `useId()`-derived pattern id
so two mounted maps cannot collide). It has to be a *texture*: every fill on a
data scale is a solid colour, so a paler solid colour is the same kind of mark
only quieter, and reads as "scored somewhere unremarkable". `ComparisonMap` drew
exactly that — flat `--muted` at 0.5 opacity — until ABL-23.

`comparison/mapFill.ts` is the decision, as a pure function, because
`<Geographies geography={url}>` fetches its topojson and so renders no country
shapes under `renderToString`. Three states: `ranked` (a measured WAPE on the
ramp), `flat` (measured but unrankable — MAE/RMSE are magnitudes, not scores,
and a sub-`MIN_COUNTRIES_FOR_SCALE` WAPE set has no ordering), `none` (the
hatch). `usesFlatFill` keeps the legend's flat key on screen exactly when a flat
fill is drawn. Note the map's legend now renders for every metric, not only
WAPE — it is the only thing naming which forecast type is being coloured.

The predecessors are gone, and the reason is the failure mode this repo keeps
hitting. `METRIC_THRESHOLDS`, `getMetricColor` and `getMetricColorHSL` (in
`lib/colors.ts`) and `getStatusLabel` (in `lib/comparisonConstants.ts`) graded a
WAPE against fixed cutoffs — load 3%/5%, price 12%/18% — that nothing had ever
calibrated and the data does not reach. On the default 30-day window that made
21 of 24 load cells and 23 of 24 price cells the identical red, and stamped
every one of the 24 countries "Needs Improvement" from 9.9% to 76.8%. Both
files keep a comment where the code was. Green-vs-red was the second problem:
it is the one pair a red-green colour blind viewer cannot separate, and
`EuropeMap` had already moved the house scale off it.

**The leaderboard needs a single forecast type; "All" renders a prompt, not a
table.** It used to build each row by averaging every metric over whatever
types that country had, which produced two wrong numbers at once. `mae` for
`load` is megawatts and `mae` for `price` is EUR/MWh, so the MAE column added
euros to megawatts. And coverage is not uniform — measured 2026-08-05, 20 of 24
countries had exactly {load, price}, DE/AT had 5 types, FR/BE had 8 — so IT's
9.9% "average WAPE" was load and price while BE's 76.8% also carried
wind_onshore (191%) and wind_offshore (156%). The table sorted on that by
default, ranking IT far above BE for forecasts IT is not measured on; per type,
BE actually forecasts load better than IT (5.6% vs 8.1%). No composite is
recoverable without a weighting the data does not define, so
`buildLeaderboardRows` takes a concrete type and returns `[]` for `'all'`
(`components/comparison/leaderboardRows.ts`), and the view offers type buttons
instead. The heatmap is the cross-type view; it never averages.

The "Status" column is now "Standing", carrying an exact `#rank / n` rather
than an adjective. Unmeasurable countries are unranked, not last, and are
excluded from `n`.

### 7. Data freshness — is what we are drawing actually current?

`/api/data-freshness/:cc` answers per stream, and **the verdict is the server's,
not the caller's** (ABL-60). It used to return five bare timestamps; the one
caller never invented a rule from them, so the header pulsed a green "live" dot
beside GB's five-year-old load and stayed green right through the 2026-08-06
ENTSO-E outage — 484 HTTP 503s, 0 of 30 countries stored, and a dashboard
serenely drawing yesterday. That is this repo's usual defect wearing a different
hat: not a wrong number in a chart, but a wrong claim *about* a chart.

Each of `load`, `price`, `generation`, `tsoLoadForecast`,
`tsoGenerationForecast` now returns `{ latest, ageHours, status }` with `status`
one of `live` / `stale` / `none`. `none` is deliberately not a health verdict —
a stream we have never held is not an outage, and an alarm no ingest fix could
clear is furniture.

**Two rules, because the streams are not the same kind of thing**
(`services/freshness.ts`, pure, colocated test):

- **Measured actuals** (`energy_load`, `energy_generation`) are judged on age.
  `MEASURED_STALE_AFTER_HOURS` is **18**, sized from the ingest schedule plus
  measurement: full passes run 00:30 / 06:30 / 13:30 / 18:30 UTC
  (`../energy-data-gathering/docker/Dockerfile:22`), so the longest scheduled
  gap is 7h, and measured against prod 2026-08-07 07:10 UTC — minutes after a
  healthy 06:30 pass — 31 of 34 countries sat 0.93-3.18h behind while BG sat
  6.18h and AL/ME ~9.2-9.4h. The slowest healthy country therefore reaches
  ~16.4h legitimately. It is not a tuned edge: every healthy country was under
  9.5h and the next value up was MK at 34.2h, so **any threshold from 9.5h to
  34h selects the same set**.
- **Day-ahead publications** (`energy_price`, both TSO forecast tables) are
  judged on **coverage**, never age. A healthy day-ahead price is dated up to
  ~46h in the *future*, so the age rule would read it as impossibly fresh
  forever and never notice a missing tomorrow — which is exactly how ABL-51 got
  found by a board member instead of by us. The rule: before
  `DAY_AHEAD_REQUIRED_AFTER_UTC_HOUR` (**14**, the first hour by which the 13:30
  pass has finished, so "missing" means *we* are missing it rather than nobody
  having published yet) the newest row must reach today's Brussels market day;
  after it, tomorrow's.

  The bound is the **start** of the required Brussels day, not its end, and that
  is what makes one Brussels-framed test correct for every bidding zone from WET
  to EET: a zone that published the day in full has a newest row ~20h past that
  day's local start, far more than the ≤3h spread between European market
  timezones. Testing the day's *end* would mark BG (UTC+3) stale while complete.

**Known limit, stated rather than papered over.** AL's ordinary 9.4h overlaps a
fast publisher's age after one missed pass (FR would reach ~15.4h), so no
fleet-wide threshold separates "chronically late" from "missed one pass". This
catches a *sustained* outage, not every dropped pass. Doing better needs a
per-country baseline the database cannot supply: `publication_timestamp_utc` is
rewritten on every re-fetch, so it dates the last pass that touched a row, not
the pass that first stored it. That is an ingest-side fix — see ABL-60's
remaining scope.

**The header pill** renders it through `layout/freshnessPill.ts` (pure,
colocated test). Three things worth knowing before changing it:

- **The pulse animation *is* the liveness claim**, so `stale` and `none` get a
  still dot rather than a differently-coloured pulse. A pulsing amber still
  reads as "a running pipeline, in a mood".
- **The word carries the state, not the colour** — "stale, 1 day ago" /
  "tomorrow missing". Colour is `dirty` (terracotta) rather than `medium`
  (amber) on contrast: measured against the light tokens `medium` is 2.55:1 on
  `--background`, failing both the 4.5:1 text bar and the 3:1 non-text bar,
  while `dirty` is 6.97:1 (5.26:1 dark).
- **Only `load`, `generation` and `price` drive the tone.** The two TSO forecast
  streams back an opt-in overlay, and including them would put an uncalibrated
  alarm on screen — measured 2026-08-07, BG's `tsoLoadForecast` reached only
  `2026-08-07 20:00`, so BG would go amber every afternoon whether or not its
  TSO publishes a D+1 forecast at all.

The pill's age now comes from the server's `ageHours`, not from re-parsing
`latest` in the browser. `new Date('2026-08-07 05:45:00')` is parsed as **local**
time by V8, so on the ~90% of `energy_load` rows that use a space separator the
header understated the age by the viewer's UTC offset — two hours in Brussels,
always in the reassuring direction.

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

## Timestamp storage: two separators in one column

**Every timestamp column in this database can hold both `2026-07-20T00:00:00`
and `2026-07-20 00:00:00`.** Not one form per table — both forms inside the same
column. Measured 2026-08-05:

| column | `T` | space |
|---|---:|---:|
| `forecasts.target_timestamp_utc` | 2,035,692 | 5,208 |
| `energy_price.timestamp_utc` | 828,878 | 701,420 |
| `energy_load.timestamp_utc` | 279,880 | 2,480,336 |
| `energy_renewable.timestamp_utc` | 90,636 | 721,319 |
| `energy_generation`, `net_position`, `crossborder_flows`, `forecast_quantiles`, `energy_load_forecast`, `energy_generation_forecast` | 0 | all |

Two independent causes. In `forecasts` the split is **by writer**: every
`catboost`/`xgboost`/`lightgbm`/`tso_*` row is `T`, the two `chronos` models
write space. In the actuals it is a **historical cutover** — the last `T` row is
2025-11-26 (`energy_load`), 2025-11-25 (`energy_price`, `energy_renewable`);
everything ingested since is space.

SQLite compares these as plain strings, and `'T'` (84) > `' '` (32). So on the
end date of a window, a `T` row sorts *above* a space-form upper bound and a
space row sorts *below* a `T`-form upper bound. **Neither single form is a
correct bound while both exist** — that was ABL-21, where
`/forecasts/compare` normalised to a space and silently dropped every ML
forecast dated on the end date (the default window ends at *now*, so the missing
day was today).

`server/src/utils/timestamp.ts` is the single answer. `timestampRange(start,
end)` + `rangeClause(column)` + `rangeArgs(range)` build a two-clause predicate:
a wide, bare-column `BETWEEN` that keeps the index seek, plus an exact
`REPLACE(col, 'T', ' ') BETWEEN` re-check over the rows it found. **Use it for
every window predicate**, including on the tables measured 100% space — the
per-table matrix above is a measurement, not a guarantee, and three separate
hand-rolled normalizers had already drifted apart before it existed
(`forecastService`, `mlForecastService` and `crossCountryMetricsService` each
kept a private copy; two kept `T`, one kept space, and that is precisely why
those endpoints disagreed about the same window).

Putting `REPLACE` on the column *alone* is correct but forfeits the seek —
measured on FR/load over 7 days: 0.086 ms bare, 0.27 ms two-clause, 4.41 ms
`REPLACE`-only, with the plan degrading from `(country_code=? AND
forecast_type=? AND target_timestamp_utc>? AND target_timestamp_utc<?)` to
`(country_code=? AND forecast_type=?)`. See the `date()`/`strftime()` entry in
Common Issues for the 51s scar this repo already has from that class of change.

**Still open (not fixed by ABL-21):** the forecast↔actual *join* predicates are
not separator-agnostic, so a window reaching before the 2025-11-26 cutover
silently fails to join `T`-separated actuals — a WAPE over a biased sample
rather than a short series. Measured on `energy_price` FR, 2025-11-20..25: 741
rows matched of 860. Filed as its own ticket; current default windows
(7d/30d/90d) do not reach back that far.

**They are not all the same shape, and grepping for one misses the others:**

- `crossCountryMetricsService.ts:125`, `mlForecastService.ts:200` and `:247`
  normalise **only the forecast side**:
  `REPLACE(f.target_timestamp_utc, 'T', ' ') = a.<timestampCol>`.
- `tsoForecastService.ts:293` has **no normalisation at all** —
  `f.target_timestamp_utc = a.timestamp_utc`, joining
  `energy_generation_forecast` to `energy_renewable`. That forecast column is
  100% space-form (measured 2026-08-05: 0 `T` of 3,033,167), so a one-sided
  `REPLACE` on it would be a no-op and this bare form fails on exactly the same
  rows — the impact is identical, but a grep for `REPLACE(f.` does not find the
  site. Fixing this class means normalising the **actuals** side, which is the
  side that is mixed.

Sizing, measured 2026-08-05 over the whole `T` era (`energy_renewable` holds
90,636 `T` rows, 2021-12-31..2025-11-25): solar pairs a separator-agnostic join
would match and `:293` drops — BA 9,315 (vs 43,043 matched), DE 7,396 (vs
24,658), PL 4,804 (vs 23,122), FI 4,740 (vs 24,632), RO 4,600, IT 4,535. So
roughly a fifth of the available history on the affected countries, not a
rounding error — it is invisible today only because the default windows are
recent. Note the naive both-sides `REPLACE` fix is the expensive one this repo
already has a scar from: it defeats the index on a 3.0M × 811k join and did not
complete in 120 s during this measurement.

## Data the database does not have

- **Timestamps that are all really UTC.** 26,405 rows carry a trailing offset
  instead of a bare instant — `2025-11-28T00:00:00+02:00`, length 25 rather
  than 19 — in `energy_price` (6,942), `energy_load` (11,717) and
  `energy_renewable` (7,746). All of them fall in one band, 2025-11-13 to
  2025-11-28, around the same ingest change that produced the separator cutover
  above. A `+02:00` row is displayed two hours from where it belongs. This is
  the sibling module's ingest, not ours; do not "fix" it here and do not
  backfill it. Escalated under ABL-21.
- **Nothing, for generation — except Albania.** This entry used to say nuclear
  and fossil were unavailable. They are not: `energy_generation` holds the
  complete ENTSO-E A75 document — nuclear, all seven fossil sub-types (gas,
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
  is normal, not a bug. See "Generation data" below for the NULL/0 and sign
  rules, and `dashboard/generationSeries.ts` for how the columns reach the UI.
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
  upstream stall. (ABL-60 turned the "is this stream current" half of this into
  a served verdict — see "Data freshness" above. That answers *whether* a stream
  is behind; this bullet is why a given zone being behind is usually not a bug
  to file. AL's ordinary ~9.4h lag is exactly why the threshold there is 18h.)
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

## Testing

```bash
cd client && npx vitest run && npx tsc -b
cd server && npx vitest run
```

Green as of 2026-08-08: **436 client tests / 32 files**, **406 server tests /
26 files**, clean typecheck. Fewer passing than that means something broke.
(The server figure moved from 189 / 13 in ABL-17, which added
`routes/forecast.test.ts` and `middleware/errorHandler.test.ts`; ABL-19 raised
the client figure and touched no server file; ABL-21 added
`utils/timestamp.test.ts` and one more `forecast.test.ts` case; ABL-23 added
`comparison/mapFill.test.ts` and touched no server file; ABL-13 added
`server/src/app.test.ts` and touched no client file; ABL-25 added
`services/degenerateForecast.test.ts` and
`dashboard/degenerateForecastNote.test.ts`, one per side; ABL-35 added cases to
all four of those plus `routes/netPosition.test.ts`, then a second pass added
`services/loadQuality.test.ts` and `routes/load.test.ts` for the impossible-zero
load rule and touched no client file; ABL-44 added `routes/generation.test.ts`
plus `getGenerationSeries` cases in `services/generationService.test.ts`
server-side, and `lib/divergingStack.test.ts` +
`dashboard/generationSeries.test.ts` client-side; ABL-54 added
`routes/prices.test.ts` server-side and `lib/priceWindow.test.ts` client-side,
one per side of the day-ahead window; ABL-60 added
`services/freshness.test.ts` + `routes/dataFreshness.test.ts` server-side and
`layout/freshnessPill.test.ts` client-side; ABL-15 added
`docs/claudeMdCitations.test.ts` server-side and touched no client file; ABL-76
merged five branches that had been closed but never merged, which is where
`lib/readingFreshness.test.ts` + `lib/forecastGap.test.ts` client-side and
`docs/claudeMdCitations.test.ts` + `utils/timestamp.test.ts`'s `toIsoUtc` cases
server-side actually arrived, and added `release/unmergedWork.test.ts`.)

### Before you mark an issue `done`

```bash
cd server && npm run check:unmerged
```

**A commit on a branch is not shipping.** ABL-76 found five issues marked `done`
whose branch was created, committed, and never merged — three of them absent
from `main` *and* `origin/main`, including ABL-58, a live confidently-wrong-
number defect that sat in prod for a week because prod is built from `main`.
Branch existence and issue status had both been read as proof of shipping, and
neither is.

The check joins `git merge-base --is-ancestor <tip> main` to the board's issue
status and fails only on `done` + unmerged (`release/unmergedWork.ts`, pure,
colocated test). In-flight, blocked and in-review branches are listed but never
failed — the whole point is a check nobody wants to disable. It needs
`PAPERCLIP_API_URL` / `PAPERCLIP_API_KEY` / `PAPERCLIP_COMPANY_ID`; without them
it lists unmerged branches and exits 0 rather than guessing.

It is deliberately **not** in the vitest suite: a test that failed whenever an
unmerged branch existed would be red on every working branch every day. Run it
at the moment you close an issue, which is the moment the defect is created.

Two conventions, and they are for different layers.

**Pure helpers get a colocated `.test.ts`.** `horizonBars.ts`, `sourceRows.ts`,
`windowLabel.ts`, `lib/dataScale.ts`, `comparison/accuracyScale.ts`,
`comparison/leaderboardRows.ts`, `comparison/mapFill.ts`, `store/migrate.ts`,
`dashboard/degenerateForecastNote.ts`, `config/forecastModels.ts`,
`server/src/utils/timestamp.ts`, `server/src/services/degenerateForecast.ts`
(which now classifies both the forecast and the actuals series),
`server/src/services/loadQuality.ts`, `lib/divergingStack.ts`,
`dashboard/generationSeries.ts`, `lib/priceWindow.ts`,
`server/src/services/freshness.ts`, `layout/freshnessPill.ts`,
`lib/readingFreshness.ts`, `lib/forecastGap.ts`,
`server/src/docs/claudeMdCitations.ts`, `server/src/release/unmergedWork.ts`.
Logic is extracted into a pure function
specifically so it can be tested this way. `timestamp.test.ts` also drives a
throwaway in-memory SQLite holding both separator forms, and asserts the query
*plan* still shows a range seek — the correctness and the performance property
are both easy to break and neither is visible by reading.

**Routes get an end-to-end test against a fixture database.**
`server/src/routes/*.test.ts` for `dashboard`, `forecast`, `forecastComparison`,
`tsoForecast`, `crossCountryComparison`, `netPosition`, `load`, `generation`,
`prices` and `dataFreshness`: a real request in, the real `ApiResponse<T>`
envelope out. Two shared pieces:

- `server/src/test/fixtureDb.ts` — an **in-memory** SQLite database. Its
  `CREATE TABLE` statements are copied verbatim from `energy_dashboard.db`
  because the column defaults are what is under test: `energy_generation` has no
  `DEFAULT 0`, `energy_renewable` does.
- `server/src/test/apiHarness.ts` — starts the **real** app (`createApp()`, in
  its API-only mode) on an ephemeral port. It used to hand-mirror the wiring
  instead, under a comment claiming it matched `index.ts`. It did not, and that
  gap was ABL-13: the shipped app dropped both error handlers whenever
  `client/dist` existed, while every route test asserted against a copy that
  kept them. Do not reintroduce a second app graph here.

**The app wiring gets its own test.** `server/src/app.test.ts` boots
`createApp` in **both** modes — with a real built-client directory written to a
`mkdtemp` dir, and without one — and asserts the error contract from the
outside: content type, status, and the exact `{ success, error, code }` keys.
The SPA-mode half cannot live in `apiHarness.ts`, because it needs an
`index.html` on disk that no route test should have to arrange.

A route test mocks `../config/database.js` to the fixture and
`../config/writeDatabase.js` to `noWriteDb.ts`'s thrower, so **the real shared
database is never opened — not readonly, not writable.** That is structural, not
a convention someone has to remember. Call `clearResponseCache()` in
`beforeEach`: `cacheMiddleware` is a module singleton keyed on URL, and without
it a broken route keeps returning the correct cached answer.

The fixture's six countries each stand for a failure shape this repo has shipped
a wrong number for — `PT` all-NULL generation **plus MK's and SI's live
impossible-zero `energy_load` shape** (exact `0.0` hours *interleaved with real
ones* on the day after `WINDOW`, paired against a flat catboost forecast so the
accuracy half is covered too - ABL-35), `AT` no generation rows *and*
xgboost-only coverage, `BE` negative day-ahead prices plus all-zero solar
actuals, `FR` pumped storage and consumption-only fossil going negative **plus
the two-column hydro shape** (`hydro_run_mw` + `hydro_reservoir_mw`, with the
02:00 reservoir reading NULL so `NULL + 40` staying NULL is asserted rather than
assumed - ABL-17), `GR` stopped publishing mid-window **and carries both
degenerate net-position series**: a forecast collapsed to ~1e-7 MW where no row
is exactly `0.0` so an `= 0` guard misses all of them (ABL-25), and, on the day
after `WINDOW`, actuals that are *exactly* `0.0` (ABL-35) - two defects with one
signature and different guards. GR's `energy_load` on that same day is all-zero
too, which is what pins the fallback: "latest load" has to step back over the
whole bad day to the last hour GR really published rather than reading 0 MW or
dropping the country. `DE`
the ordinary case plus a superseded forecast vintage that catches a broken
`MAX(generated_at)` dedup. Add to that set rather than inventing a seventh
country for a shape already covered — ABL-25 did exactly that, giving GR its
second shape rather than a new country, because "nothing publishes actuals to
contradict the forecast" is the same country's condition.

One format difference the fixture encodes on purpose: `forecasts.target_timestamp_utc`
is written with a **`T`** separator (`atT`), matching production, while the
actuals tables use a space (`at`). That is not cosmetic — `normalizeTimestamp`
converts query bounds to the space form, and `'T'` > `' '` as a string, so a
range predicate on `forecasts` silently excludes the window's end date. See
ABL-21; do not "tidy" the fixture into one format, or the bug becomes untestable.

One thing the fixture deliberately **cannot** express: anything measured
against the real clock. Every row in it is dated 2026-07-01/02, which is in the
past for any run after that date, so a shape that is only wrong when a timestamp
is in the *future* — or one whose whole subject is age — needs rows stamped from
`Date.now()`. `routes/prices.test.ts` (tomorrow's day-ahead prices) and
`routes/dataFreshness.test.ts` (a live stream and a 20-hour-old one) are the
only tests that add any, and both add them to their own copy of the fixture
rather than to `fixtureDb.ts` — a fixed constant would go stale, and a relative
one in the shared builder would silently move every other file's window.

The flip side is useful: because the shared rows are permanently older than
`MEASURED_STALE_AFTER_HOURS`, "stale" is the default in `dataFreshness.test.ts`
and every live case has to be created on purpose. Assertions there are also
written to hold at **every hour of the day** — the day-ahead coverage rule
changes what it requires at 14:00 UTC, and a test that flipped verdict at
lunchtime would be worse than no test.

### This file's own citations are tested

The ~60 `file:line` citations below are checked mechanically by
`server/src/docs/claudeMdCitations.test.ts`, so `cd server && npx vitest run`
fails on a stale one. They rot silently otherwise: an unrelated commit inserts
twenty lines, the cited line still exists, nothing errors, and the citation now
points at a blank line or the wrong function. ABL-3 verified every citation by
hand and a merge the same hour re-broke thirteen of them — hand verification does
not survive concurrent work.

Two rules, both chosen by measuring them against this document (ABL-15):

- **The cited line must exist and hold something.** Not past the end of the
  file, not blank, not comment-only.
- **The symbol must be where the citation says.** When the prose names a symbol
  just before the citation, and that symbol is declared at the top level of the
  cited file, the cited line has to mention it or fall inside its declaration.

The second rule is the one that earns its keep: of the eight stale citations
this check found on arrival, the first rule caught three and the second caught
seven. It is deliberately narrow — skipped for bare `:NNN` continuations, which
idiomatically point at a *use* site rather than at the declaration
(`TABS_WITH_MODEL_PICKER` is declared at `CountryDashboardView.tsx:56` and
applied at `:116`), and skipped when the named symbol is not a top-level
declaration (`ENERGY_DB_PATH` is only ever read off `process.env`, so a citation
naming it is not judged). Both exclusions were needed to reach zero false
positives across the whole file. A check that cries wolf gets disabled.

Notes for when it fails:

- A citation may point at a **comment on purpose**, where the prose quotes the
  comment as a comment. Add it to `COMMENT_CITATION_ALLOWLIST`. Entries are keyed
  by file and by an excerpt of the comment, not by line, so they survive the
  comment moving; an entry that matches nothing is itself a failure, so the
  allowlist cannot quietly accumulate dead weight.
- Citations into the sibling `../energy-data-gathering` module are checked for
  **presence only** — its line numbers are not ours to keep true. They resolve
  against the primary checkout, so they work from a git worktree, and are skipped
  entirely where that module is not checked out.
- The working tree is the source of truth, so editing this file and running the
  suite tells you straight away. Set `CLAUDE_MD_CITATIONS_REF=HEAD` to check a
  committed snapshot instead — worth doing in the primary checkout, where another
  run's half-finished edit to a cited file shifts lines under you.

What it does **not** catch: a citation that lands on plausible but unrelated
code, where the prose names no symbol. Line numbers stay in the doc because they
are what make it fast to use; this check is the maintenance cost that buys them.

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
4. Add UI toggle in the tab or in `ModelPicker`/`TimePicker` as appropriate

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

// Per stream, since ABL-60 — not five bare timestamps. `ageHours` is signed and
// server-computed; negative is normal for a day-ahead stream. See "Data
// freshness" above for the two rules behind `status`.
type FreshnessStatus = 'live' | 'stale' | 'none';

interface FreshnessStream {
  latest: string | null;
  ageHours: number | null;
  status: FreshnessStatus;
}

interface DataFreshness {
  load: FreshnessStream;
  price: FreshnessStream;
  generation: FreshnessStream;
  tsoLoadForecast: FreshnessStream;
  tsoGenerationForecast: FreshnessStream;
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
- **The workstation replica can be hours behind prod even with a fresh mtime.**
  Measured 2026-08-07 07:10 UTC: the replica's newest `energy_load` row was
  `00:15` (≈7h old) while prod's was `05:45` (≈1.4h). Anything about freshness,
  staleness or "is this table current" must be settled against prod
  (`http://192.168.86.36:3001/api/...`, read-only) — the replica will make a
  healthy pipeline look broken. It is still the right place to measure *shapes*
  (row counts, per-country distributions, table-vs-table comparisons)

## Common Issues

**"Cannot connect to database":**
- Verify the SQLite file at `ENERGY_DB_PATH` (or `server/.env`'s value) exists
- Without `ENERGY_DB_PATH` set, the server defaults to `/data/energy_dashboard.db`, which won't exist on a workstation checkout

**A country's load/price forecast is blank:**
- Check whether a specific model is pinned in `ModelPicker` — catboost and
  xgboost coverage barely overlaps (see Forecast model selection), so a pinned
  model with no data for that country renders nothing. The pinned row carries a
  **Pinned** badge in the dropdown.
- The chart now says so itself rather than just going blank: a footnote under
  the line chart reads "<model> has no forecast for <country> in this window."
  with a **Use the best available model** button that drops the pin
  (`lib/forecastGap.ts`, `dashboard/ForecastGapNotice.tsx`, wired in `LoadTab`
  and `PriceTab`). Unpinned and still empty reads "No forecast published for
  <country> in this window." and offers no button — the ladder already tried
  every registered model.
- Selecting the type's **"Default"** entry clears the pin (ABL-16). It used to
  *create* one, which is what made this state unrecoverable without clearing
  localStorage.
- Confirm the model is actually registered in `server/src/config/forecastModels.ts`

**TSO forecasts not showing:**
- In `ModelPicker`, select a `TSO ·` entry for that forecast type. `load` has
  both D+1 and D+7 registered; `solar`/`wind_onshore`/`wind_offshore` have D+1
  only; `price`/`renewable`/`biomass`/`hydro_total`/`net_position` have no TSO
  model at all — check `forecastModels.ts` before assuming a bug
- Note the picker does not render on the Generation or Forecast-accuracy tabs
  at all (`TABS_WITH_MODEL_PICKER`, `CountryDashboardView.tsx:56`, applied at
  `:116`), so there is no "picker that does nothing" to hit there
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
  (`useDashboardData.ts:47`) — there is no `useComputedDateRange()`, despite
  what this file claimed until ABL-4
- A preset with no `case` there is a compile error since ABL-12 (`never` guard
  in the `default` branch), so this is caught by `tsc -b` rather than by
  reading — but the `default` still resolves to a 7-day window at runtime, for
  the unvalidated string a same-version persisted blob can carry
- `timeOffset` is non-zero whenever the arrows have been used, and it is in
  ~10 React Query keys — a "stale" chart is often just a shifted window; check
  the explicit range the picker shows beside itself
- Bump `PERSIST_VERSION` and add a `migratePersisted()` clause if you changed
  the shape of anything in `partialize`

**The header pill says "stale" (or "tomorrow missing"):**
- That is the signal working, not a UI bug. Read `/api/data-freshness/:cc` —
  each stream carries `latest`, `ageHours` and `status`, so it names which one
  is behind and by how much.
- `stale` on `load`/`generation` means the newest *measurement* is over 18h old,
  which is past the longest scheduled gap plus the slowest TSO's own lag: at
  least one full ingest pass stored nothing for that country. Settle it on prod
  (`/app/logs/pipeline.log`), not the workstation replica — the replica can be
  hours behind prod even with a fresh mtime.
- `stale` on `price` means the day-ahead result does not reach the market day it
  should. After 14:00 UTC that is tomorrow. This is ABL-51's signature.
- Some zones are permanently stale and always will be: GB's load stops
  2021-06-14 and UA's 2022-02-25. That is the correct reading, not a defect to
  suppress.
- See "Data freshness" above before changing a threshold — both are sized from
  measurements recorded there.

**Data freshness returning nothing:**
- Verify `/api/data-freshness/:countryCode` endpoint is responding
- Check that database has data for selected country — a stream with no rows at
  all reports `status: 'none'`, which is deliberately not `stale`

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
- This is why window predicates go through `rangeClause`/`rangeArgs` rather
  than wrapping the column in `REPLACE`: see "Timestamp storage: two separators
  in one column".

**A series is short by exactly one day, at the end of the window:**
- Almost certainly a hand-rolled timestamp bound instead of
  `timestampRange`/`rangeClause`/`rangeArgs`. `'T'` sorts above `' '`, so a
  space-form upper bound excludes every `T`-separated row on the end date — and
  the default window ends at *now*, making the dropped day today. That was
  ABL-21; see "Timestamp storage: two separators in one column".
- The symptom is a missing series with no error and no empty state, which reads
  as "the model didn't run" rather than as a bug. Check the row count against
  raw SQL before believing the chart.

**An API call returns HTML, or `unwrap()` reports a malformed envelope:**
- Fixed under ABL-13, but know the shape, because it is invisible in a dev
  checkout. The server decides it is "production" from the mere existence of
  `client/dist/index.html` (`app.ts`'s `resolveClientDist`), not from
  `NODE_ENV` — so a built or deployed box takes a branch a plain `npm run dev`
  never does. That branch used to skip `notFoundHandler`/`errorHandler`
  entirely, on the belief that the SPA fallback covered them. It did not:
  `app.get('*')` catches unmatched *routes*, never a thrown error, and Express
  selects an error handler by arity. Measured before the fix, in production
  mode: a thrown `AppError` came back `400 text/html` as
  `<pre>Error: …</pre>` plus ten stack frames of absolute repo paths, and an
  unmatched `/api/*` came back **`200` with index.html** — a success status
  carrying HTML into `unwrap()`.
- Both handlers are now registered unconditionally, after the SPA fallback, and
  the fallback skips `/api`. `server/src/app.test.ts` pins all of it; removing
  either half fails it.
- To reproduce this class of bug at all you need `client/dist/index.html` to
  exist — it is gitignored and absent in a fresh checkout, which is why it
  survived. Create one, start the server, and curl an API path.
