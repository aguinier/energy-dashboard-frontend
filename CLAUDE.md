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
│       │   └── ComparisonView.tsx        # Forecast-quality portfolio: type-local ranking/map, evidence disclosure, matrix
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
│       │   │   ├── WindTab.tsx           # Onshore + offshore share this one (ABL-235) — same chart, different column
│       │   │   ├── AbleCard.tsx          # Card shell dashboard chart compositions wrap their charts in
│       │   │   ├── ModelPicker.tsx       # Registry-driven forecast model selector (see below)
│       │   │   ├── ForecastGapNotice.tsx # multi-select "<model> has no forecast here" + remove-from-comparison button
│       │   │   ├── TimePicker.tsx        # categorised presets + window nav
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
        │   ├── coreNetPosition.ts     # Minimal, provisional read for the JAO Core
        │   │                          #   net position archive (ABL-230)
        │   ├── dataFreshness.ts, countries.ts, weather.ts
        │   ├── opsStatus.ts           # /ops/status, /ops/status/combined (ABL-237, ABL-238)
        ├── services/                  # One service module per route group
        │   ├── freshness.ts           # Pure: is a stream live / stale / never held
        │   ├── loadQuality.ts         # Pure: the impossible-zero load rule
        │   ├── degenerateForecast.ts  # Pure: collapsed-to-zero net position
        │   ├── freshnessRollup.ts     # Pure: fleet-wide worst-case freshness verdict
        │   ├── hostMetrics.ts         # Pure: disk/CPU/network readings, null when unmeasurable
        │   ├── forecastVintageArchiveService.ts, forecastVintageArchiveScheduler.ts
        │   │                          # Append-only forecast-vintage capture (ABL-184)
        │   ├── peerOpsStatus.ts       # Fetches the peer environment's /api/ops/status (OPS_PEER_URL)
        │   ├── combinedOpsStatusService.ts  # Merges local + peer for the ABL-238 status page
        │   └── coreNetPositionService.ts, jaoCoreNetPositionCapture.ts,
        │       coreNetPositionScheduler.ts
        │                              # JAO Core CCR net position capture (ABL-230) —
        │                              #   see "Core CCR net position (JAO)" below
        ├── workers/                   # captureForecastVintagesWorker.ts,
        │                              #   captureCoreNetPositionWorker.ts — each
        │                              #   scheduler's writable-connection thread
        ├── lib/
        │   └── syncBlackoutWindow.ts  # Pure: is `now` inside the ABL-220 DB-sync lock window
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
server). On CAT, the acceptance target is the local dashboard Docker
container, which reads the CAT replica database. It serves a built image, so
working-tree server changes are not visible through the ordinary acceptance
proxy. See [`../WORKFLOWS.md`](../WORKFLOWS.md), **API proxy on CAT**, for the
authoritative target and the separate local-server procedure used to exercise
server changes; keep the environment-specific address there rather than
duplicating it here.

## Deployment

Merging to `main` does **not** deploy: this repository has no CI/CD deployment
step. Production is the Debian host **QuietlyConfident** (`192.168.86.36`),
reachable with `ssh clavain@192.168.86.36` and serving the dashboard on port
`3001`. Its checkout is
`/home/clavain/energy-dashboard/repos/energy-dashboard-frontend`.

After the reviewed commit is pushed to GitHub, deploy from that host:

```bash
cd /home/clavain/energy-dashboard/repos/energy-dashboard-frontend
git pull
cd docker
docker compose build
docker compose up -d --force-recreate
```

Do not commit code on production. The client and server are built into one image,
so this deploy updates them together. Do not infer deployed state from git
ancestry or an issue marked done: ABL-120 found merged work still undeployed.
Inspect the running container and the served bundle instead. The fuller runbook
is [`../WORKFLOWS.md`](../WORKFLOWS.md), which is intentionally outside this
repository.

## Key Features

### 1. Views

Three top-level views, switched via `currentView` in the store (`map` | `country` | `comparison`):
- **`MapView`** — landing page, a Europe choropleth (`EuropeMap.tsx`) with a floating metric selector.
- **`CountryDashboardView`** — six top-level country tabs: Price, Load, Generation, Wind onshore, Wind offshore (ABL-235) and Net position. Forecast-quality country detail is entered from the portfolio, not carried as a competing tab (`client/src/views/CountryDashboardView.tsx:131`).
- **`ComparisonView`** — the Forecast quality portfolio home: a type-local ranking/map for the default `load` type leads the page, then disclosed error evidence, then the country × forecast-type matrix as the explicit all-types view (`client/src/views/ComparisonView.tsx:29`). (The portfolio used to lead with a "Forecast performance by variable" card grid, `ForecastPortfolio`/`portfolioRows.ts` — removed under ABL-166 at the CEO's request; the rest of the page, its nav entry, and the per-country `ForecastTab` were untouched.)

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
(`resolveModelCandidates`, `forecastModels.ts:211-220`): production model
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

(`forecastModels.ts:174` still asserts the sets are fully disjoint, as measured
on 2026-07-26. That comment is now stale for `price`; the behaviour it
justifies — ordered rather than absolute preference — is unaffected.)

**A pin is clearable, and "pinned" is not "shown" (ABL-16).** The server still
honours an explicit request strictly — "if you asked for xgboost and it has
nothing, you get nothing, not a silent substitution" (`forecastModels.ts:220`).
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

(`selectedModelByType` above is this section's name for it at ABL-16 — the
field net position's multi-select picker later needed to hold several ids in
was renamed `selectedModelsByType`, an array per type, at ABL-203/v9. See
"ModelPicker" below and State management for the current shape; nothing about
the ABL-16 fix itself changed.)

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
forecast type) and stores the choice per type in `selectedModelsByType`
(`Record<string, string[]>`, ABL-203/v9 — was `selectedModelByType`, one
string per type, before net position's picker needed to hold several at
once), so a choice on one tab never leaks into a type where that model
doesn't exist.

**`ModelPicker` is multi-select on every tab it renders on, as of ABL-204.**
It started single-select (one pin, `setSelectedModel`/`clearSelectedModel`
writing/clearing a one-element list) and was rewritten to a checkbox popover
matching net position's shipped baseline (`NetPositionModelPicker`, ABL-203),
reading/writing the selection through `toggleSelectedModel` directly rather
than through the one-element-list helpers. Those two setters still exist and
still write/clear a one-element list — `ForecastTab`'s own read of
`useLoadChartData()` and a returning user's pre-ABL-204 single pin both rely
on that shape — but `ModelPicker` itself no longer calls them. `Load` and
`Price` and `net_position` are consequently three independent multi-select
pickers over the same store shape, not one shared component:
`ModelPicker.tsx` renders for `price`/`load` (`TABS_WITH_MODEL_PICKER`),
`NetPositionModelPicker.tsx` for `net_position`. They were deliberately left
as two files rather than unified into one generic component — see this
section's "Load and Price" entry below for why.

Each tab's data hook reduces the picker's selection to one of two shapes,
mirroring net position's `mode: 'default' | 'selection'` split
(`useNetPositionData`): with nothing checked, `LoadTab`/`PriceTab` derive
`useMl` / `useTso` / `tsoHorizon` straight from the unpinned candidate the
server's ladder would try first — always ml, since `load` and `price` both
register an ml model as production (`selected.source`, `selected.tsoHorizon`,
`useLoadChartData.ts:112-114`). With one or more models checked, the hook
instead returns a `modelSelection: LoadModelQuery[]` (or `PriceModelQuery[]`)
array, one entry per checked model, and the tab renders through
`lib/multiForecastSeries.ts` instead of the single-series adapters — see
"Load and Price" below. The older `showForecast` / `showTSOForecast` /
`tsoForecastType` boolean toggles and the D+1/D+7 button are still gone; both
code paths above derive from the picker, never from those fields. They remain
in the store as legacy persisted fields, but are not uniformly dead — see
State management below for which are still read.

### 2b. The header stat row was removed

`AbleStatRow` — a four-tile strip (day-ahead price, current load, renewable
share, peak demand) that sat above the tab bar on every country page — is
gone (ABL-221). The reported "confusing banner" was not, as a first pass
assumed, the sparklines under each tile (`6350836`/`19f27b6` dropped those
first); a second round of the same complaint, naming all four numbers
explicitly, was the strip itself. Removed with it: `AbleStatRow.tsx`, its
sole data source `useDashboardOverview` (`useDashboardData.ts`), and
`client/src/lib/readingFreshness.ts` — the per-reading staleness classifier
"Current load" used, left with no caller. `GET /api/dashboard/overview`
(`getDashboardOverview`, `dashboardService.ts`) and the route itself are
untouched: it is still the documented public endpoint `ApiCta` advertises,
and no other client code ever called it.

This is also where ABL-58's fix used to render: the rule that a "current"
reading over 48h old (`WITHHOLD_AFTER_HOURS`) is withheld rather than shown
bare, which is what stopped GB's 2021-06-14 `energy_load` row from reading
`CURRENT LOAD 37.27 GW` for five years. That rule protected one specific
on-screen number; with the tile gone, there is nothing left on this page for
it to protect, and no page currently renders an unbounded "current load"
figure outside the documented API. The server-side correctness guards are
unaffected — `measuredLoadClause()` (see "LoadTab" below) and the `toIsoUtc`
timestamp stamping (`server/src/utils/timestamp.ts`) were never client-only
and still apply to `/dashboard/overview`'s own response. If a future feature
resurrects a headline, instantaneous (not window-bounded) number, it needs a
display-time freshness gate again, not just the raw value — the deleted
`readingFreshness.ts` (recoverable from this branch's history before this
commit) is the reference implementation to restore.

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
  **That fix shipped 2026-08-10** (ABL-157 redeployed the `energy-data-gathering`
  container at 15:34Z; `published_points.py` is present and the guard fired on
  the 18:30 pass, dropping 191 of 667 LU load rows). The count stops growing.
  And it does not make this read-side guard redundant: MK's `position 1` **was**
  genuinely published as `0.0`,
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

  Every `energy_load` read site in `server/src` applies one of the two
  helpers, with a single documented exception. The enumeration was wrong twice
  before — it claimed completeness while a hole was open, both times — so it is
  written here as counted read sites, verifiable with
  `grep -rn "FROM energy_load\b" server/src`:

  | module | `energy_load` reads | helper |
  |---|---:|---|
  | `loadService.ts:21` `:38` `:57` `:75` `:86` `:111` `:146` | 7 | `measuredLoadClause()` |
  | `dashboardService.ts:78` `:100` `:177` `:300` | 4 | `measuredLoadClause()` |
  | `tsoForecastService.ts:199` `:239` | 2 | `measuredLoadClause()` |
  | `countryService.ts:51` | 1 | `measuredLoadClause()` |
  | `dataFreshnessService.ts:35` | 1 | `measuredLoadClause()` |
  | `crossCountryMetricsService.ts:140-150` | 4 aliases | `loadActualGuard()` ×3 |
  | `mlForecastService.ts:235` `:279` | 2 | `loadActualGuard()` |
  | `forecastService.ts:251` | 1 | `loadActualGuard()` |
  | `countryService.ts:114` | 1 | **none, deliberately** |

  `dashboardService.ts`'s four are current load, peak demand, the map
  choropleth and the timeseries daily average.
  `crossCountryMetricsService.ts` joins the table under four aliases and needs
  only three guards: `s`/`s2` are guarded in their join clauses and the
  `a`/`a2` pair is guarded once in the `WHERE`, through the `COALESCE` that
  merges them (`crossCountryMetricsService.ts:117,156`).

  The unguarded one is `getCountriesWithData` — a `SELECT DISTINCT` over a
  three-table `UNION` that answers *is this code worth offering in a picker*,
  not *what did we measure*. It returns no value a chart can render, and
  guarding only its load leg would make the `UNION` incoherent, since
  `energy_renewable`'s zeros are genuinely ambiguous (see the "Known gap"
  below) and a zero-clearing `energy_price` hour is a real measurement. It also
  changes nothing: every one of the 11 countries carrying placeholder zeros
  holds tens of thousands of genuine rows beside them.

  **Two sites have been the hole, and both were `MAX(timestamp_utc)`.**
  `dataFreshnessService.ts` (ABL-60) dated the *pipeline's health* from a raw
  `MAX`, so a placeholder could certify the ingest as current — measured on the
  replica 2026-08-07, SI's raw MAX was `2026-08-07 00:15` with `load_mw = 0`
  against a guarded MAX of `00:00`. `countryService.ts`'s `getCountrySummary`
  (ABL-262) was the same defect one endpoint over: `/api/countries/:code/summary`
  dated its `to` from a raw `MAX` and sized `records` from a raw `COUNT`, so it
  reported coverage through hours holding a `0.0`. Both aggregates are guarded
  now, together rather than separately — `records` gates whether the block
  renders at all, so counting placeholders would let a country whose every
  stored load row is a placeholder report a confident span we never measured.

  `loadActualGuard()` covers the accuracy joins and the comparison endpoint,
  which are generic over forecast type and so must apply the rule **only** to
  `load`: a `0.0` is ordinary for solar overnight, for still wind, and for a
  zero-clearing price, and a blanket `> 0` there would delete real measurements
  and bias every renewable metric upward. That path was affected too — joining
  the 543 rows to the forecast tables, ES 104 and SI 8 pair with a stored ML
  load forecast and MK 72 / ES 46 / ME 25 / PL 25 / MD 9 / AL 4 / NL 2 / RS 1 /
  SI 1 pair with a TSO one, each scoring a 100% error against a number nobody
  took, with SI's and MK's inside the default 30-day window.

  `forecastService.ts`'s `getForecastWithActuals` — behind
  `GET /api/forecasts/compare` — was the last unguarded read, closed by
  ABL-262. It served the placeholders straight through as actuals: measured
  read-only against prod 2026-08-12, `?country=MK&type=load` over
  2026-08-01..03 returned 24 actuals of which all 24 were exactly `0` MW,
  against MK's 543-717 MW daily peak (ES 33 zeros of 193, BA 3 of 25, RO 3 of
  97). Nothing rendered it — `useLoadChartData.ts` fetches it on every Load tab
  render and re-exports it as `comparisonData`, but no component reads that yet
  — so this was a live public endpoint one binding away from a chart, not a
  visible regression. Note the query params are `start`/`end`; `startDate`/
  `endDate` are silently ignored and the route falls back to the last 7 days.

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

  **Both tabs' `ModelPicker` is multi-select (ABL-204), extending net
  position's shipped baseline (ABL-203) to the two forecast types where
  coverage is the hard part rather than the easy part.** Checking several ml
  models here is not the same shape as net position's: net position's four
  candidates are all ml and mostly overlap in coverage, so a selected-but-
  empty model is the exception. Measured against `energy_dashboard.db`,
  `load`'s catboost (21 countries) and xgboost (AT/BE/FR) are **strictly
  disjoint** — no country has both — and `price`'s are near-disjoint (AT
  alone served by both, see "Forecast model selection" above). So on these
  two tabs, checking two ml models is normally "one line and one nothing",
  and that emptiness has to be named per model, not left to read as a bug.
  `load` also registers two TSO models (D+1, D+7) alongside the two ml
  ones, so a selection here can mix sources in a way net position's picker
  never has to — `price` has none, so `PriceTab`'s selection view never
  branches on source.

  `useLoadChartData`/`usePriceChartData` fan out one query per checked model
  into a `modelSelection: LoadModelQuery[] | PriceModelQuery[]` array (ml via
  `fetchForecastData` pinned to that model id, tso via `fetchTSOLoadForecast`
  pinned to that model's horizon) — the existing single-model fields
  (`forecastData`, `tsoForecastData`, `servedModelId`, …) are untouched and
  still describe the unpinned "Default" request, because `ForecastTab` reads
  `loadData`/`forecastData` off `useLoadChartData()` directly for its own
  single-line "forecast vs actual" overlay regardless of what is checked on
  the Load tab. `LoadTab`/`PriceTab` each split into a default view (nothing
  checked, today's pre-ABL-204 single-series render, unchanged) and a
  selection view (one or more checked) exactly the way `NetPositionTab`
  already splits on `useNetPositionData`'s `mode`.

  The selection view merges actuals with N normalized forecast entries via
  `lib/multiForecastSeries.ts`'s `buildMultiForecastSeries` — the Load/Price
  counterpart of `chartAdapters.ts`'s `adaptNetPositionMultiSeries`, and
  deliberately not the same function, because the honest-gap requirement is
  stricter here. Net position's adapter drops an uncovered model from
  `AbleLineChart`'s `forecastSeries` entirely, leaving the tab to footnote it
  separately — reasonable when a gap is rare. `buildMultiForecastSeries`
  instead keeps **every** checked model in `forecastSeries`, tagged
  `covered: false` when it has zero rows, because a gap is the ordinary
  outcome here. `AbleLineChart`'s legend renders that as a diagonal-hatched
  swatch plus "— Not available in `<country>`" instead of a solid dot,
  reusing `NoDataHatch`'s "texture signals absence, never a quiet value"
  semantic in a legend rather than a choropleth. `lib/forecastGap.ts`'s
  `describeForecastGapsForSelection` additionally footnotes each uncovered
  model by name below the chart, and `ForecastGapNotice`'s new `gaps` prop
  gives each one its own "Remove from comparison" button
  (`toggleSelectedModel`) — the ABL-16 property ("a gap has to stay
  reachable, not just visible") applied per model instead of once.

  The min/max band (TSO week-ahead's daily min/max) draws under the same
  rule net position's p10-p90 band already uses: only when exactly one model
  is checked, because several bands on one chart is unreadable and a lone
  band under N lines would misattribute uncertainty to models that never
  published one.

  Line colour and dash pattern are stable per model id, not per selection
  order — `dashboard/forecastLineTokens.ts`, keyed on the registry ids
  (`catboost`, `xgboost`, `tso-d1`, `tso-d7`). Net position's picker
  differentiates only by colour; this one also varies the dash rhythm,
  because two ml models trained on the same data routinely predict
  near-identical values — lines overlapping almost exactly is the normal
  case here, not an edge case, and a shared dash rhythm would hide the far
  line under the near one. `AbleLineChart`'s multi-line renderer draws a 4px
  surface-colour under-stroke beneath each 2px patterned line for the same
  reason. Both changes are additive to `AbleForecastSeriesSpec`
  (`dash?`/`covered?`/`coverageNote?`) and apply to every caller including
  net position's — that picker doesn't set the new fields, so its lines keep
  the default dash and simply gain the under-stroke halo.

  This is the Design Consultant's ABL-205 recommendation, taken with two
  deliberate exceptions, noted rather than silently dropped:

  - **Net position's own picker was not rebuilt to match.** The design doc
    frames ABL-203's checkbox list as the shipped *baseline* and asks for the
    refinements — the "Default — automatic" radio row, real
    `<input type="checkbox">` rows instead of a `role="listbox"`, the
    "Models · N selected" collapsed label — to "land in the Load/Price
    follow-up", i.e. here, not necessarily backported. Doing so would have
    meant modifying an already-shipped, board-reviewed feature outside this
    change's scope for a consistency gain with no functional requirement
    behind it. `NetPositionModelPicker.tsx` is unchanged; `ModelPicker.tsx`
    is the new, refined design and the two are intentionally two components
    rather than one shared one, at least until net position's picker is
    revisited on its own.
  - **No per-row "not available here" hint inside the open picker.** The
    design doc's item 3 asks the checkbox row itself to mirror the legend's
    hatch/note while the dropdown is open. That needs `ModelPicker` to know
    the current query results for this country/window, which today live in
    each tab's own data hook, not in the picker component. Wiring that
    through was left for a follow-up: the chart's legend and the per-model
    footnote already satisfy the acceptance requirement ("says in words that
    `<model>` does not forecast `<country>` — no silent gap") once the user
    looks at the chart, and the picker is a control, not a second place that
    needs to restate the chart's answer before the chart has rendered it.
    Hover-dimming the non-hovered forecast lines to 35% opacity (the design
    doc's other secondary suggestion, for legibility under heavy overlap) was
    left for the same reason — a legibility polish, not a correctness
    requirement, and the under-stroke halo above already addresses the
    concrete "which line is which" problem it was proposed to solve.
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
  (`CountryDashboardView.tsx:69`, applied at `:129`) limits it to `price`,
  `load`, `wind-onshore` and `wind-offshore` (ABL-235), the tabs whose chart
  reads a multi-select picker (ABL-204).
  `net-position` isn't in that set either, but for the opposite reason: it has
  its own separate multi-select picker instead (`NetPositionModelPicker`,
  ABL-203), rendered by its own `activeChartTab === 'net-position'` branch
  beside it. It
  used to render and do nothing, while `useRenewableChartData` fired five
  per-type ML forecast queries plus a TSO one that no component consumed: six
  API calls per view, discarded. Both are gone, and so is that hook — ABL-44
  moved its last consumer onto `useGenerationSeries`, taking
  `chartAdapters.adaptRenewableMixSeries` with it. If you add a forecast
  overlay to this tab, add it back to that set.
- **`NetPositionTab`** — `AbleLineChart` for ENTSO-E day-ahead net position
  plus one or more selected registered forecasts. `NetPositionModelPicker`
  (ABL-203) is a **multi-select** box, not a dropdown: Chronos-2 V010 (the
  production default) plus three labelled shadow candidates — Baseline V012,
  XGBoost V014, Chronos-2 V016 (`forecastModels.ts:86-114`) — can be checked
  together, each drawn as its own coloured, labelled dashed line over one
  shared actuals series (`dashboard/netPositionModelColors.ts` for the
  palette, `lib/chartAdapters.ts`'s `adaptNetPositionMultiSeries` for the
  merge, `AbleLineChart`'s `forecastSeries` prop for the N-line draw). Only
  V010 has a stored p10-p90 band, and it draws only when exactly one model is
  checked — several bands on one chart is unreadable, and a lone band under N
  lines would misattribute uncertainty to models that never published one.
  `useNetPositionData` fans out one query per checked model through
  `useQueries`, each pinned via `model=` and keyed on its id — the same
  per-model-query property ABL-177 first established for the single-select
  case, generalised to N; nothing checked ("Default", or the overlay switched
  off) is the one unpinned query every other forecast tab already sends, and
  the server's candidate ladder picks. A checked model with no rows for this
  zone is named in a footnote rather than silently missing its line — the
  degenerate-forecast case below (`describeDegenerateForecast`) and the
  plain-no-coverage case (`lib/forecastGap.ts`'s `describeForecastGap`) both
  apply per model now, not once for a single response.

  **Which "net position" this is now states itself, because a second number
  with the same name exists and disagrees (ABL-222, researched under
  ABL-219).** `net_position.net_position_mw` is the zone's net position over
  every ENTSO-E SDAC implicitly-coupled border — inside the Core CCR
  flow-based region or not — never the narrower **Core flow-based net
  position** JAO separately publishes for the 12 Core zones (AT, BE, CZ,
  DE-LU, FR, HR, HU, NL, PL, RO, SI, SK). Measured 2026-08-09 08:00 UTC:
  France's two numbers disagree even in **sign** — Core −114.9 MW (importer)
  vs the figure this tab and the map draw, +1,557.7 MW (exporter); the mean
  gap over the day is 2,576 MW. **Do not call this "AC vs DC"**: Germany's
  Core figure already nets in its HVDC links (modelled as virtual hubs inside
  the flow-based domain), and France's Core figure excludes its *AC* borders
  with ES and IT, so an AC/DC label would be wrong in both directions — the
  only correct axis is which borders are in scope. **Do not verify this on
  Germany**: DE-LU's two figures are identical to four decimal places, so DE
  proves nothing; FR is the divergent case.

  `lib/netPositionScope.ts` is the pure helper stating the scope, colocated
  with `netPositionScope.test.ts`. `netPositionTabDisclosure`
  (`netPositionScope.ts:144`) renders under this card's title
  (`NetPositionTab.tsx:218`) and appends the Core caveat only for the 12 Core
  CCR country codes (`isCoreCcrCountry`, `netPositionScope.ts:55`);
  `NET_POSITION_MAP_DISCLOSURE` (`netPositionScope.ts:94`) is the map legend's
  all-coupled disclosure, and `MAP_METRICS`'s `net_position.legendLabel`
  (`lib/constants.ts:41`) was its legend heading.

  **Both numbers are now on screen, behind one toggle (ABL-234).** ABL-222
  stated which figure was drawn; ABL-230 ingested the other one; this is the
  switch between them. `netPositionScope` — `'all_coupled'` (the default, and
  the pre-ABL-234 behaviour byte for byte) or `'core'` — is a single persisted
  store field driving **both** surfaces, deliberately: they draw the same
  quantity, and letting the map and the tab disagree is how a reader concludes
  the data contradicts itself. `NetPositionScopeToggle.tsx` is the control (a
  two-option segmented `role="radiogroup"`, matching `MapMetricSelector`'s
  visuals rather than `ModelPicker`'s popover — the options are mutually
  exclusive and both always apply). It renders beneath the metric selector on
  the map, and only for `net_position`; and after `TimePicker` on the country
  tab.

  Every string that names a scope is now a **function of the scope**, in
  `netPositionScope.ts` — `netPositionLegendLabel`,
  `netPositionMapDisclosure`, `netPositionHatchLegendLabel`, and
  `netPositionTabDisclosure(countryCode, scope)`. That last one keeps ABL-222's
  property in both branches: it describes the borders the *currently selected*
  view covers, then names the other figure as a different number rather than a
  correction. A sentence about the view the reader just left would be worse
  than not having the toggle.

  **The measurement, re-taken live on 2026-08-12 for the hour 2026-08-09 08:00
  UTC** (JAO's four 15-minute intervals averaged to the hour, against that
  hour's `net_position` row):

  | zone | Core | all coupled | |
  |---|---:|---:|---|
  | **FR** | **−368.9** | **+1,494.575** | **disagree in sign** |
  | DE | 9,423.875 | 9,423.875 | identical |
  | NL | 1,695.15 | 1,695.15 | identical |

  **Verify on France, never on Germany.** DE's and NL's every coupled border
  is either inside the Core domain or modelled as a virtual hub within it, so
  their two figures coincide *exactly* — a toggle wired to the wrong table
  would pass on either. Verified end to end through a running server against a
  scratch database holding real rows from both sources (2026-08-09
  06:00–10:00Z): FR Core mean **−1,000.6 MW (importing)** vs all-coupled
  **+783.7 MW (exporting)**.

  **Server side, all additive — `/net-position` and `/dashboard/map` are
  untouched**, so the default view issues exactly the queries it did before.
  `routes/coreNetPosition.ts` grew `GET /core-net-position/map?start=&end=`
  (declared *before* `/:countryCode`, since `'map'` is a country-code-shaped
  string) and gave `GET /core-net-position/:countryCode` a real contract:
  `{ actual, meta: { country_code, bidding_zone, in_core, coverage,
  last_seen } }`. **An empty array always carries the reason it is empty** —
  `CoreNetPositionCoverage` is `served` / `no_data` / `out_of_core` /
  `not_captured`, and those are four different claims, not one. `out_of_core`
  in particular is *not* missing data: we hold a perfectly good all-coupled
  figure for Spain, and calling that a gap would be this repo's recurring
  defect in words instead of numbers. Returning a bare `[]` for all four would
  have pushed the judgement into the client, which would then have had to keep
  its own copy of the 12-zone list to recover it.

  **The Core series is NOT guarded by `classifyActualSeries`, and that
  asymmetry is a decision.** The 1 MW degenerate-zero floor is sized from a
  measurement over 26,882 `net_position` country-days and exists because
  entsoe-py's sparse-document forward-fill manufactured a year of exact-`0.0`
  GR rows. Neither half transfers: `parseJaoCoreNetPositionResponse` skips a
  missing or non-numeric hub rather than carrying a value forward, and nothing
  has been captured yet to size a Core threshold against. Importing the number
  unmeasured would be exactly the uncalibrated cutoff `METRIC_THRESHOLDS` was
  removed for, and a genuinely balanced Core zone would vanish. If a
  fabrication mode ever appears in `core_net_position`, size a threshold
  against it *then*.

  **Client side.** `useCoreNetPositionData.ts` holds both queries, each gated
  on the Core view actually being selected. The map switches source in
  `EuropeMap` via `map/netPositionMapScope.ts` (pure, colocated test —
  `<Geographies>` fetches its topojson and renders no shapes under
  `renderToString`, the same reason `comparison/mapFill.ts` is a pure module).
  It returns `ranked` / `no_data` / `out_of_core`; the last two **share the
  `NoDataHatch` texture on purpose** — both mean "not on the scale", and a
  second texture would weaken the first — so the hover sentence
  (`NON_CORE_MAP_NOTICE`) is what carries the difference, and it says *not
  applicable*, never *not measured*. An out-of-scope shape takes a tab stop
  with `role="img"` so a keyboard user can reach that sentence too. **LU is
  never `out_of_core`**: it shares DE_LU, and the map emits it with DE's value
  rather than a hole, because a hole there would claim Luxembourg is outside
  the Core region.

  The tab's Core branch is `CoreNetPositionView` (in `NetPositionTab.tsx`),
  **actuals only** — nothing in this dashboard forecasts the Core figure, no
  registry entry produces one, so `NetPositionModelPicker` does not render in
  Core view rather than sitting there unable to change the chart (the
  "renders and does nothing" state ABL-44 removed from the Generation tab).
  `coreNetPositionNote.ts` prints which of the three empty states applies.

  **`lib/coreNetPositionSeries.ts` averages JAO's quarter-hours into the
  chart's hourly grid, and must not be replaced by `adaptNetPositionSeries`.**
  That adapter writes each point into its hour bin unconditionally, so four
  quarters in one bin leave the **last** one standing. Measured on the real
  response for FR 2026-08-09 08:00 UTC — quarters −114.9, −624.8, +174.8,
  −910.7 — last-write-wins draws −910.7 against a true hourly mean of −368.9,
  and the 08:30 quarter alone would have coloured France an *exporter*.
  Averaging is also what makes the two toggle states comparable at all: it is
  why DE's four quarters reproduce its all-coupled hourly value to the digit.

  Two deliberate, reasoned narrowings of ABL-231's design spec, recorded
  rather than silently applied: the legend shows **one** hatch key with
  widened wording ("no data / outside Core region") instead of two keys
  sharing one texture with different meanings — a legend that renders the same
  mark twice does not disambiguate, and the per-country hover does; and
  `NetPositionModelPicker` was left untouched rather than restyled to match
  the new toggle, being already-shipped, board-reviewed work outside this
  change's scope (the same call ABL-204 made about it).

  **The toggle ships useful only once the capture is enabled.** ABL-230's
  ingest is gated on `JAO_CORE_NET_POSITION_ENABLED` **and**
  `HELIO_WRITE_TOKEN`, neither of which this change sets, so on a deployment
  today `core_net_position` does not exist and Core view is empty everywhere.
  That is why `not_captured` is a distinct coverage word with its own copy
  ("a capture that has not been switched on, not an outage at JAO") rather
  than a silent blank — but it does mean turning the capture on is a real
  follow-up step, not a formality.

  Handles
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

  **The two zones were not symmetric, and this mattered for reading the tab
  before the delete described below.** Measured on the replica 2026-08-07 —
  this is the record of what was found and the evidence the ABL-181 deletion
  decision rested on, not a description of the table's current state:

  - **GR — 192 of 192 post-break rows were exactly `0.0`**, every one
    fabricated, across 13 UTC-day buckets. GR had published no real net
    position since 2025-09-30. Its own `crossborder_flows` showed a median net
    *export* of 1,142 MW over those same hours.
  - **IE — only 2026-03-14 was fabricated** (23 rows, plus 1 spill row on
    03-13 = 24). Its other post-break days carried genuine values, up to 738.8
    MW, so IE's newest *usable* day was already 2026-07-24, not 2025-09-30 —
    unaffected by the later delete, since `getLastSeen` already stepped back
    over the one fabricated day to reach it.

  Because `classifyActualSeries`/`getNetPositionActualSeries` judge a queried
  window by its series **maximum**, not row by row, IE's mostly-genuine March
  window was never classified `degenerate_zero` even before the delete — the
  24 fabricated 03-14 rows rode along inside an otherwise-real `served` series
  and would have been returned and drawn like any other point. GR's window,
  100% fabricated after the break, was the one case the whole-series rule
  caught.

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

  **The fix shipped 2026-08-10 15:34Z** (ABL-157). Verified on prod:
  `/app/src/published_points.py` is present (12,106 bytes),
  `grep -c drop_unpublished_zeros_series entsoe_client.py` returns 1, and the
  guard fired on the 18:30 UTC pass — "PL net position: dropping 29 of 780 value
  rows that ENTSO-E published no Point for and that forward-filled to exactly 0."
  All five fixes are live: `12c5a6b` (ABL-50 load guard), `1dc6e99` (this one),
  `6299e98` (ABL-54 day-ahead price window), `4e99322` + `941d258` (crossborder).
  **Lesson to carry forward:** ABL-63 deployed the *dashboard-frontend* container
  and left the ingest container on the old image — a "done" status and a merged
  ancestor on this module's main said nothing about the ingest side of prod. The
  same reasoning error would apply to any future fix that has independently
  shipping halves (like ABL-54, whose client half went live weeks before the
  ingest half). Always grep the running container; do not infer deploy state from
  git ancestry or issue status.

  Deployed or not, the guard only stops *new* fabrications. The **216**
  fabricated rows (GR 192, IE 24) were deleted from prod on 2026-08-11 at
  13:23:19Z under ABL-181 (ABL-67 approved the write, `request_confirmation`
  `c5398dd4`, accepted 2026-08-11T08:11:55Z); row counts confirmed:
  `GR_before=24271 GR_after=24079`, `IE_before=24286 IE_after=24262`, and zero
  all-zero day buckets remain anywhere in the table. GR's series now ends
  cleanly at `2025-09-30 21:00`. The read-side guards below are **still
  load-bearing** — for three distinct reasons that each survive the deletion:

  1. `classifyActualSeries` and `classifyForecastSeries` guard against *future*
     fabrications. The ingest guard prevents new ones; the read-side check is
     the backstop that catches anything the ingest guard misses, and removing it
     before ingest is provably correct in production would trade defence-in-depth
     for a single point of failure.
  2. MK's `position 1, quantity 0.0` was **genuinely published** by ENTSO-E, so
     it is still in the table on purpose. `measuredLoadClause()` is the only
     thing keeping it off a chart — ABL-181 was scoped to the fabricated GR/IE
     rows and did not touch MK.
  3. GR's degenerate *forecast* series (`chronos-2-V010`, ~1e-7 MW medians) was
     never in ABL-181's scope and is still stored. `degenerateForecast.ts` is
     still load-bearing on live data.

  Do not read the deletion as permission to remove the guards.

  **Verified against prod, 2026-08-11, that GR now renders the more correct
  state this predicts, rather than assuming it.** With the fabricated actuals
  gone, GR has no rows at all after 2025-09-30: `/api/net-position/GR` over
  the default 7d window now returns `actual: []` with `meta.actual_coverage:
  'no_actuals'` — no longer `'degenerate_zero'`, because there is nothing left
  in that range to classify — and `meta.last_seen` unchanged at
  `2025-09-30T21:00:00`. `describeDegenerateActual` returns `null` for
  `'no_actuals'` (`degenerateForecastNote.ts:70`), so `NetPositionTab` falls
  through the withheld-actuals branch to the `lastSeen` branch
  (`NetPositionTab.tsx:270-284`) and renders "Greece stopped publishing a net
  position on September 30, 2025." — consistent with reason 3 above, its
  forecast is untouched by the delete and still renders its own
  `degenerate_zero` note beside the empty actuals state.

  **IE's classification changed too, confirmed the same way.** As above, IE's
  March window was already `served` even with the fabricated rows riding
  along inside it. With them gone, IE's `2026-03-01..2026-03-30` window now
  returns 47 rows, `actual_coverage: 'served'`, max |value| 738.8 MW — a
  genuinely clean line, not one with a fabricated flat day inside it.

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
  derivation (`AbleLineChart.tsx:304`) was the reason the pre-ABL-35 24-hour
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
returns the preset name at offset 0 and the window's own bounds otherwise —
the same rule `TimePicker`'s own shifted-window caption follows by calling
`formatWindowRange` directly (`TimePicker.tsx:8`, applied at `:55`), since it
only ever needs the shifted half. (`describeWindow` itself has had no
production caller since ABL-221 removed `AbleStatRow`, its only consumer;
`windowLabel.test.ts` and `dashboard/timePresets.test.ts`'s exhaustiveness
check on `WINDOW_LABEL` are why the file stays.) Bounds are formatted in the
**viewer's** timezone, matching the chart axes and the "times in <zone>"
caption — a Brussels-formatted caption over a locally-formatted axis would
disagree with itself.

Adding a preset means touching six places. All six now fail loudly:

- Keyed `Record<TimePreset, …>`, so the missing key is named directly:
  `PRESET_SHIFT_HOURS` (`lib/constants.ts:20`), `WINDOW_LABEL`
  (`dashboard/windowLabel.ts:23`), and `ANCHOR_FOR_PRESET`
  (`store/migrate.ts:25`), whose keys `VALID_TIME_PRESETS` derives from.
- A `const unhandled: never = preset` in the `default` branch, so the new value
  is reported as not assignable to `never`: `getDateRangeForPreset`
  (`useDashboardData.ts:117`) and `getGranularityForPreset`
  (`useDashboardData.ts:158`).
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
`PERSIST_VERSION` in `store/migrate.ts` (currently `10`, `migrate.ts:7`), bumped
with a matching clause in `migratePersisted()` whenever a persisted field's
shape or meaning changes. `migratePersisted` must never throw: `state` is an
arbitrary, possibly years-old localStorage blob. Skipping this step leaves
returning users on a shape the current code doesn't understand — previously a
blank tab panel or a view nobody chose.

It is **not** a per-version switch. `migrate.ts:55` short-circuits only on
`fromVersion >= PERSIST_VERSION`; below that, *every* clause runs for *any*
older blob, so each clause must be safe to apply to a blob that never had the
field. The clauses today coerce an unknown `currentView` / `activeChartTab` /
`timePreset` back to a valid value (`migrate.ts:134` for the last), remap a
stored `comparisonMetric: 'mape'` to `'wape'` (`:92`), **delete** three dead
keys — `layers` (`:86`), `timeRange` (`:106`), `analyticsConfig` (`:118`) —
and split `selectedModelByType`'s pin/hidden conflation into
`forecastHiddenByType`, dropping every stored pin (`:159-168`, ABL-16), then
convert that single pin per type into a one-element list under the renamed
`selectedModelsByType` (`:187-196`, ABL-203/v9) — the shape net position's
multi-select picker needs to hold several pins at once, with a returning
user's one stored pin carrying forward as their starting selection rather
than being dropped, and finally coerce an unrecognised `netPositionScope` back
to `'all_coupled'` (`:215-217`, ABL-234/v10). That last clause has nothing to
carry forward — no older field encoded the border scope — so refusing an
out-of-union value is its whole job, and it is not ceremony: the two scopes
can disagree in **sign** (FR, 2026-08-09 08:00 UTC: Core −368.9 MW importing
vs all-coupled +1,494.6 MW exporting), so a stray string must not leave a
reader on a chart whose legend names a scope the query did not use. It coerces
to `'all_coupled'` rather than `'core'` because that is both the pre-existing
default and the only view guaranteed to hold data — Core capture is off by
default in a deployment.
Note `layers` is deleted, not folded into `showForecast`/`showTSOForecast` as
an earlier version did — that folding unconditionally overwrote `showForecast`
with `false` on every migration, clobbering a value the current code had
legitimately set moments earlier.

**`timeRange` is gone.** This section used to say `timeRange` (the legacy
closed enum) and `timePreset` both persisted and both drove UI, and that the
`/dashboard/*` endpoints forced it. Neither is true any more: nothing in
`client/src` declares or reads a `timeRange` field, there is no `TimeRange`
type in `client/src/types/index.ts` at all (the enum survives only server-side,
`server/src/types/index.ts:233`), every per-tab hook sends an explicit
`start`/`end` computed by `getDateRangeForPreset` (`useGenerationMix`,
`useDashboardData.ts:207`, and `useMapData` likewise at `:187`), and
`migratePersisted` deletes a stored
`timeRange` outright (`store/migrate.ts:106`). `timePreset` is the single field
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
(`store/migrate.ts:37`, checked at `:134`) and `timeAnchor` is re-derived from
it (`:135`), because the two persist separately and only `setTimePreset` keeps
them in step. `VALID_TIME_PRESETS` is no longer a hand-maintained literal — it
is `Object.keys(ANCHOR_FOR_PRESET)`, and `ANCHOR_FOR_PRESET` is keyed
`Record<TimePreset, TimeAnchor>`, so it cannot drift from the union.

```typescript
// The COMPLETE persisted set — `partialize`, dashboardStore.ts:357-381.
// Anything absent here (timeOffset, isLive, servedModelByType, …) is
// session-only and resets on reload.
currentView: AppView;                                // 'map' | 'country' | 'comparison'
selectedCountry: string;
timePreset: TimePreset;
timeAnchor: TimeAnchor;
mapMetric: MetricType;
netPositionScope: NetPositionScope;                  // 'all_coupled' | 'core' — ABL-234, drives map AND tab
activeChartTab: string;              // price|load|renewables|wind-onshore|wind-offshore|net-position|analytics
selectedModelsByType: Record<string, string[]>;      // per forecast-type PINs; absent/empty = server ladder
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
  queries (`useLoadChartData.ts:172`, `:213`; `usePriceChartData.ts:133`);
  `selectedMLHorizons` drives the multi-horizon fetch
  (`useLoadChartData.ts:131`, `:177`).
- **Written, and read only by dead code.** `showForecast`. `setTimePreset`
  still sets it `true` for future presets (`dashboardStore.ts:150`) and
  `useLatestForecast` gates its query on it (`useDashboardData.ts:239`, `:248`)
  — but that hook's only consumer, `ForecastMetadataBadge.tsx`, is imported by
  nothing, so it has no on-screen effect today.
- **No reader at all.** `showTSOForecast`, `tsoForecastType`,
  `visibleRenewableTypes`, `sidebarOpen`, `comparisonCountries`.

Careful with the name `showForecast`: `useLoadChartData`/`usePriceChartData`
declare *local* consts of that name derived from the picker
(`selected?.source === 'ml'`, `useLoadChartData.ts:113`;
`usePriceChartData.ts:77`), which shadow the store field. A grep hit is not
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

**Skill vs D-7 seasonal-naive, beside every WAPE in `CountryRanking` and the
leaderboard's "Evidence and error measures" table** (ABL-186). A WAPE with no
reference point reads as respectable in isolation — the CEO's original probe
found a load forecast at 9.4% WAPE, invisible as a problem until set beside
D-7 persistence at 5.9%. `crossCountryMetricsService.ts`'s per-type query
self-joins the same actuals table a second time, at `target_timestamp_utc`
minus 7 days, guarded by `loadActualGuard()` on that side too (a placeholder
`load_mw = 0.0` seven days back must not pose as a real reading, same as on
the primary actuals join). `skillScore.ts`'s `computeSkillVsSeasonalNaive` is
the pure aggregation: `n` (pairs with an actual, a model forecast, *and* a D-7
baseline — never larger than the WAPE's own sample), `skillPct` (`100 * (1 -
model_wape / baseline_wape)`, `null` rather than 0 when `n` is 0 or the
baseline's own WAPE is 0/undefined), and `baselineWape` for context.

This mirrors, rather than re-derives, the methodology the board already
reviewed for the forecast-quality scorecard — `score_against_baseline` and
`aligned_point_baselines` in the sibling `energy-forecast` repo
(`../energy-forecast/src/evaluation/scorecard.py:158`,
`../energy-forecast/src/baselines.py:297`): same D-7
same-hour baseline definition, same pair-intersection rule. That scorecard is
a batch Python job reading the replica directly and writing JSON/markdown
reports to its own `reports/` directory — there is no live API or shared
artifact channel the Node/TS dashboard can call at request time, so this is a
faithful reimplementation in a second runtime rather than a call into the
first, the same relationship this dashboard's own WAPE already has with the
Python side's WAPE.

`CrossCountryMetricsEntry.skillVsSeasonalNaive` is optional on the client wire
type only so pre-existing hand-built `CrossCountryMetrics` literals elsewhere
in the test suite keep compiling without it — a real API response always
carries it. `components/comparison/SkillCell.tsx` (shared by `CountryRanking`
and `ComparisonLeaderboard`, colocated `skillBadge.ts` for the pure
win/loss/insufficient-data classification) renders a loss with colour, a
down-marker, and explicit screen-reader text — never colour alone, so a reader
who cannot see colour still gets "worse than the D-7 naive baseline" — and
renders "insufficient data" as its own state rather than a dash or a coerced
0%. `ComparisonHeatmap`'s matrix cells and `ComparisonMap`'s hover tooltip
also show WAPE but toggle between WAPE/MAE/RMSE/bias and have far less room
per cell; skill is not yet added there.

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
one of `live` / `stale` / `ended` / `none`. `none` is deliberately not a health
verdict — a stream we have never held is not an outage. `ended` is the matching
non-alarm verdict for a stream we held but whose upstream series stopped; an
alarm no ingest fix could clear is furniture.

**Two rules, because the streams are not the same kind of thing**
(`services/freshness.ts`, pure, colocated test):

- **Measured actuals** (`energy_load`, `energy_generation`) are judged on age.
  `MEASURED_STALE_AFTER_HOURS` is **18**, sized from the ingest schedule plus
  measurement: full passes run 00:30 / 06:30 / 13:30 / 18:30 UTC
  (`../energy-data-gathering/docker/Dockerfile:22`), so the longest scheduled
  gap is 7h, and measured against prod 2026-08-07 07:10 UTC — minutes after a
  healthy 06:30 pass — 31 of 34 countries sat 0.93-3.18h behind while BG sat
  6.18h and ME ~9.2h. The slowest healthy country therefore reaches ~16.4h
  legitimately. It is not a tuned edge: every healthy country was under 9.5h
  and the next value up was MK at 34.2h, so **any threshold from 9.5h to 34h
  selects the same set**. (AL measured 9.4h in that same snapshot — but that
  was a mid-publication coincidence, not AL's character; see "Known limit"
  below.)
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

- **Ended upstream** applies to either kind once its newest usable row is over
  `ENDED_AFTER_HOURS` (**30 days**) old (`services/freshness.ts:74`). This is a
  terminal, non-alarm verdict, sized against all 39 production countries on
  2026-08-10 12:04 UTC: the slowest healthy measured stream was 11.1h, the
  worst active stall was MK generation at 111.1h, and the next value was AL
  generation at 1,143.1h; day-ahead streams had the same gap (CH generation
  forecast 87.1h, then UA/GB at 39,039h/45,181h). Thirty days is over 6x the
  worst active stall and spans at least 102 longest scheduled ingest gaps. It
  selected only AL generation plus GB/UA load and generation forecasts.
  There is no country ignore-list: a newer row immediately re-enters the normal
  live/stale rule (`classifyMeasuredStream`, `services/freshness.ts:181`;
  `classifyDayAheadStream`, `services/freshness.ts:213`).

  This is still an inference from absence, not proof of upstream causality. A
  single-stream ingest defect left untouched for 30 days has the same stored
  shape. The long delay is what makes the operational verdict useful without
  silently swallowing the active stalls visible in the measured fleet.

**Known limit, stated rather than papered over.** ME's ~9.2h overlaps a fast
publisher's age after one missed pass (FR would reach ~15.4h), so no
fleet-wide threshold separates "chronically late" from "missed one pass". This
catches a *sustained* outage, not every dropped pass. Doing better needs a
per-country baseline the database cannot supply: `publication_timestamp_utc` is
rewritten on every re-fetch, so it dates the last pass that touched a row, not
the pass that first stored it. That is an ingest-side fix — see ABL-60's
remaining scope.

**That 9.4h was a snapshot, not AL's character** (ABL-84). The 2026-08-07
measurement above happened to catch AL mid-publication; AL does not run
steadily 9.4h behind. It publishes in bursts and goes dark in between, so its
age sawtooths from ~1h to *days*. Whole-history gaps over 6h in AL
`energy_load`, measured on prod 2026-08-09: **2024-12-31 → 2025-12-17 (8,401h)**,
2025-12-18 → 2025-12-29 (265h), 2025-12-30 → 2026-02-16 (1,147h),
2026-06-28 → 2026-07-08 (232h), thirteen single-day 24.2h gaps across 2022-23,
and the open one since 2026-08-06 21:45. Read against that record, an AL
`stale` verdict is the *expected* state a good fraction of the time, and is
still the correct verdict — do not retune the threshold to silence it. The
number to distrust is the 9.4h, not the pill.

**The header pill** renders it through `layout/freshnessPill.ts` (pure,
colocated test). Three things worth knowing before changing it:

- **The pulse animation *is* the liveness claim**, so `stale`, `ended` and
  `none` get a still dot rather than a differently-coloured pulse
  (`freshnessPulses`, `layout/freshnessPill.ts:28`). A pulsing amber still
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

**`GET /api/ops/status` (ABL-237) is a fleet-wide rollup, not a new source of
truth.** Built as the foundation for a separate acceptance/prod status
dashboard (ABL-236), it reuses this section's per-country classification
rather than re-deriving it: `opsStatusService.ts`'s `getFleetFreshness` calls
`getDataFreshness` (`dataFreshnessService.ts`) once per country from
`countryService.getAllCountries()`, then `freshnessRollup.ts`'s
`computeFreshnessRollup` reduces every (country, stream) pair to one worst-case
verdict — `stale` outranks everything (the only actionable alarm of the four),
`live` outranks the two non-alarm verdicts `ended`/`none`, and an empty fleet
reads `none` rather than throwing. It also reports host/process KPIs
(`hostMetrics.ts`): disk usage for the directory holding `ENERGY_DB_PATH` via
`fs.statfsSync` (one code path for the Linux container and the Windows
acceptance host, no extra dependency), process memory/uptime, and CPU load —
`null` on Windows rather than `os.loadavg()`'s fabricated `[0, 0, 0]`, per this
file's own rule that a metric we cannot measure is `null`, never invented.

**Per-interface network throughput (ABL-290) is the one KPI whose value needs
two readings**, and it carries four distinct absences that must not collapse
into one. `getNetworkThroughput` (`hostMetrics.ts:227`) parses `/proc/net/dev`
— Linux-only, so the Windows acceptance host gets `null`, the same honest gap
`cpuLoad` reports — and banks each read in process-lifetime state, so the ops
page's poll supplies the second sample. Cumulative `rxBytes`/`txBytes` are real
from the first call; the derived `rxBytesPerSec`/`txBytesPerSec` are `null`
until there is a window to divide by, and `null` again whenever a counter goes
backwards (interface bounce, container restart, 32-bit wrap) — the bytes
actually moved are then unknowable, and a wrap-correction would invent an
enormous one. The clock is `performance.now()`, deliberately not `Date.now()`:
an NTP step between two samples would otherwise scale every rate on the page.
Two parsing traps are covered by `hostMetrics.test.ts`: a wide counter abuts
its colon (`eth0:123456789012`) so the line splits on the first `:` not on
whitespace, and transmit bytes are field 9, not field 2. Client-side, `network`
is **optional, not merely nullable** (`types/index.ts:392`) — a peer on a build
older than ABL-290 sends no key at all, which `buildNetworkRows`
(`client/src/lib/networkRows.ts`) renders as "not reported by this build",
separately from `null` ("not measured on Windows"), `[]` ("no non-loopback
interfaces"), and a listed interface whose rate is still `—`. A rate under
1 B/s renders `<1 B/s`, never a rounded-down `0 B/s`; an exact zero is a
measured zero and does read `0 B/s`.
Provenance (`commit`/`runtime`/`db_path`) is `getHealthProvenance()` verbatim,
the same values `/api/health` (`routes/index.ts:50`) reports — `/health`'s own
response contract is unchanged. Unlike `/health`, this endpoint touches the
database (the freshness rollup), so it is expected to fail during the
twice-daily DB sync's write-lock blackout described above — a known window,
not a defect (see "Acceptance blackout during Stage 2", `../WORKFLOWS.md`).

**`GET /api/ops/status/combined` (ABL-238) is the acceptance/prod status
page's data source** — the internal `/ops-status` route, not in the main nav
(`App.tsx` checks `window.location.pathname` directly rather than going
through the persisted `currentView` store, so visiting it never changes what a
normal user's next visit lands on). It fetches the peer environment's own
`/api/ops/status` server-side (`peerOpsStatus.ts`) rather than having the
browser call both origins directly — a cross-origin browser fetch from prod's
page straight to acceptance's API (or vice versa) would hit CORS, and this
also keeps the peer's LAN IP out of the client bundle. The peer's base URL is
`OPS_PEER_URL` (`server/.env.example`, `docker/.env.example`,
`docker-compose.yml`) — prod's points at acceptance and acceptance's points at
prod; deliberately not hardcoded, since the same built image runs as either
side. `combinedOpsStatusService.ts`'s `getCombinedOpsStatus` wraps **both**
sides — the local call to `getOpsStatus()` and the peer HTTP fetch — in the
same `{ reachable, ... }` shape, so a DB lock on this side during the sync
blackout degrades this side alone, never blanks the peer's KPIs, and never
500s the whole combined payload; `peerConfigured: false` (unset `OPS_PEER_URL`)
is reported distinctly from `peer.reachable: false` (configured but not
answering), so the page can say "not set up" instead of "down". `syncBlackout`
(`lib/syncBlackoutWindow.ts`, ABL-220) tells the client to render an
unreachable side as a known-state annotation rather than a red alarm when the
timestamp falls in the ~07:00 / ~16:30 local sync window. That module owns the
pad sizing and its justification — 2 min before the scheduled minute and a
per-window `padAfterMin` (`server/src/lib/syncBlackoutWindow.ts:61`), widened
to 60 min by ABL-249 after a 34m07s run on 2026-08-12; this page consumes it
and does not size it. The window was previously misdiagnosed as a code/container defect
(ABL-220's writeup) and the status page is built specifically not to repeat
that mistake. No visitor-counter KPI and no external alerting/paging are in
scope here — see the issue for why.

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

**Fixed for the ml accuracy joins (ABL-214).** This section used to say the
forecast↔actual *join* predicates were not separator-agnostic and frame that as
`energy_price`-specific, citing `energy_price` FR 2025-11-20..25: 741 of 860
rows matched. ABL-211 found the underlying join is generic across every
forecast type sharing `ACTUAL_DATA_MAPPING` — it dropped `T`-separated
`energy_load` actuals identically, not just `energy_price`'s. Both sites are
now separator-agnostic: `mlForecastService.ts`'s `resolvedActualJoin()`
(`mlForecastService.ts:114`, called from both its hourly and aggregated
branches) and `crossCountryMetricsService.ts`'s `metricSelect()`
(`crossCountryMetricsService.ts:108`, covering both the actuals join and the
D-7 seasonal-naive baseline join beneath it).

**The obvious fix is wrong, not just imprecise — measure before joining on
"either form."** A single join matching `actualCol IN (REPLACE(expr,'T',' '),
REPLACE(expr,' ','T'))` looks like the natural extension of `rangeClause`'s
seek-preserving two-clause shape to an equality, and was the approach this
ticket originally sketched. It silently fans out: `energy_load` alone has
**137,113** country-hours where a `T` row and a space row both exist, and
**107,047** of those pairs held **conflicting** values (measured 2026-08-11,
against ABL-211/ABL-215's then-still-open "which one is authoritative" board
question — `energy_price` has 16,896 such pairs, 2 conflicting;
`energy_renewable` 26,694 pairs, 2,441 conflicting). An `IN(...)` join matches
*both* rows whenever both exist, so it would have traded ABL-214's silent-drop
defect for a silent-fan-out one — double-counting that hour, and on a
conflicting pair, handing an accuracy metric the right-looking value and the
wrong one as if they were independent observations. That is exactly the
confidently-wrong-number defect this whole file exists to catch, and it was
not this join's decision to make: settling which of a conflicting pair is
authoritative is a data-provenance judgment, not a read-side accuracy query,
and that is what ABL-215 was for.

**ABL-215 ruled and executed on 2026-08-12, but only for `energy_load` and
only for 23 of the ~26 conflicted countries.** ABL-227 sampled ~200
conflicting country-hours against live ENTSO-E and found the winner is
consistent *within* a country, not global: the Board approved a per-country
rule — space-row wins (AT, BE, BG, CZ, DE, FR, GR, HR, IT, LU, LV, NL, PT),
T-row wins (DK, EE, IE, LT, NO, RO, SE, SK — space was wrong by 8-57%, not a
plausible revision), format-only normalize with no value change (FI, HU —
conflicts were rounding artifacts of the same reading, average diff
~0.004%). Re-enumerated immediately before writing (97,551 conflicting pairs
for these 23 countries, not the stale 107,047 total): the losing row was
copied to `energy_load_conflict_backup_abl215` (tagged `rule_applied`) before
being deleted, and the 26,465 T-wins rows had their surviving space-row
`load_mw` updated to the T value. **CH, PL and SI are still open** — ABL-227's
sample couldn't resolve them (differences were noise-scale against a further,
later ENTSO-E revision neither stored snapshot captured) — leaving 9,496
conflicting pairs. `energy_price`'s 16,896 conflicting pairs are untouched
entirely; ABL-227/ABL-215 scoped to `energy_load` only, since price's overlap
is mostly disjoint coverage rather than value conflict. The two-LEFT-JOIN-
COALESCE shape below is therefore still load-bearing for CH/PL/SI and for all
of `energy_price` — do not simplify it back to a single join on the theory
that ABL-215 "closed" the conflict question.

**ABL-256 executed on 2026-08-12 and closed the rest — every non-conflicting
`energy_load` T-row, format only, zero `load_mw` values changed anywhere.**
Two blocks ABL-215 explicitly left untouched, because neither carried a
provenance question: **142,767 orphan T-rows with no space-form counterpart at
all** (AL 103,960, GB 24,792, plus 22 smaller countries — all written in one
batch at `2025-11-25 10:18:1x`, the same historical cutover moment, ~8.5
months before AL's unrelated 2026-08-06 upstream stall, ABL-84/ABL-152 — that
stall is unaffected, this touched no row from it) had their separator
rewritten in place, id-addressed
(`UPDATE energy_load SET timestamp_utc = REPLACE(timestamp_utc,'T',' ')
WHERE id = ?`, `load_mw` never named in the statement); and **30,066
agreeing-duplicate T-rows**, where the T-row and its space-row twin already
held byte-identical `load_mw` (20,562 across the 23 ABL-215 countries, plus a
newly-found 9,504 across 5 more — GB, PL, ES, CH, UA — that were never in
conflict and so were never inside ABL-215's scope either way), had the
redundant T-row deleted; the surviving space-row was never written to. Board
accepted the proposal outright, folding in the 9,504-row third block.
Executed under the identical ABL-181/ABL-210 procedure: fresh re-enumeration
immediately before writing (confirmed the 172,833-row total to the exact row,
zero drift since the proposal), ingest paused only for the transaction's
duration (5.5s), a single transaction with pre-image backup tables
(`energy_load_orphan_backup_abl256`, `energy_load_agreeing_backup_abl256`)
row-count-verified before either statement ran, and independent post-commit
re-verification (20/20 spot checks on each block; `energy_price` and every
other table confirmed byte-for-byte unchanged). `energy_load` dropped from
182,329 to exactly **9,496** T-separator rows — CH 1,783 / PL 5,853 / SI
1,860, precisely the still-open conflicts ABL-215 could not resolve — and
gained zero new orphans, since every rewritten row already had no space-form
counterpart to collide with. `energy_load`'s own row count dropped by exactly
30,066 (the deletes, from 2,679,772 to 2,649,706); nothing else in the table
or the database changed.

`timestampFormOnClause` (`server/src/utils/timestamp.ts:140`) is instead
always used as **two separate LEFT JOINs** — one matching the space form, one
matching the `T` form, on two different aliases — `COALESCE`d together
preferring space. That changes nothing for any country-hour that already
matched before this fix (a space-form row, unconditionally preferred, exactly
like the one-sided-`REPLACE` join it replaces) and only adds coverage for an
hour where a `T` row is the *only* one that exists — **142,767 of
`energy_load`'s then-279,880 `T` rows, measured 2026-08-11**, is now a
historical figure: ABL-256 rewrote every one of those specific rows to space
form, so none of them are `T`-only (or `T` at all) any more, and the shape's
remaining `energy_load` role is purely the space-preferred tie-break over
CH/PL/SI's 9,496 still-conflicting pairs, not an orphan rescue. The orphan-
rescue case is still live and unmeasured-since-2026-08-11 for `energy_price`
and `energy_renewable`, which ABL-256 did not touch. Two separate LEFT JOINs
can never fan out the way one `IN(...)` join can: each side matches at most
one physical row (verified 2026-08-11 — zero exact `(country_code,
timestamp_utc)` string duplicates in `energy_load`, `energy_price` or
`energy_renewable`), so their combination is at most one row, not up to two.

**Currently a no-op against live data — measured, not assumed.** The
`energy_price` FR 741-of-860 figure this section used to cite no longer
reproduces against the live replica: as of 2026-08-11 the earliest row in
`forecasts`, across *every* forecast type, is 2025-12-26 (`load`/xgboost) — a
month after the ~2025-11-26 actuals cutover this whole section is about. So
today this fix changes zero currently-computed metrics; it stays dormant until
a historical backfill, a retrained model's archived vintage, or the table's own
earliest row otherwise reaches back past the cutover again. Filing that as a
regression would be wrong — the fix is correct and was worth shipping now
rather than waiting for it to matter, but there is no headline WAPE it moves
today.

**Still open, and deliberately not folded into ABL-214 — a real, live gap, not
the same one-line shape.** `tsoForecastService.ts:296`
(`getGenerationForecastAccuracy`, joining `energy_generation_forecast` to
`energy_renewable`) has the identical defect — `f.target_timestamp_utc =
a.timestamp_utc`, no normalisation on either side — and unlike the two services
above it **is** currently live: `energy_generation_forecast` holds rows back to
2021-01-01, deep inside `energy_renewable`'s `T`-form window
(90,636 rows, 2021-12-31..2025-11-25). Measured on a DE/solar window straddling
the cutover (2025-11-15..2025-12-01): today's bare-equality join returns 1,057
rows; the separator-agnostic, dedup-safe join returns 2,013 — essentially
double. It needs the identical `timestampFormOnClause`-pair-plus-`COALESCE`
treatment as the two fixed services above (never the naive `IN(...)`, for the
same fan-out reason — `energy_renewable` alone has 2,441 conflicting `T`/space
pairs), in both its hourly and aggregated branches. That is materially more
than "the same one line" this ticket was scoped for, and nothing in this
client currently calls `/tso-forecast/accuracy/generation/:cc` (see
"ForecastTab" above), so it was left unfixed here rather than grown into this
change — filed as its own follow-up instead.

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
- **AL load, stalled upstream since 2026-08-06 21:45 UTC** (ABL-84, ABL-152).
  *Distinct from the AL generation gap above, and a different shape: this is
  intermittent, not permanent.* AL does normally publish `energy_load`; it
  stopped here upstream. Re-confirmed on prod 2026-08-11 05:45 UTC:
  `/api/data-freshness/AL` → `load.latest 2026-08-06 21:45:00`, `ageHours
  103.859`, `status stale`. Both prod and the CAT replica show the same frozen
  timestamp — not a replica-sync artifact.
  **Upstream, confirmed twice.** ABL-84 queried ENTSO-E `A65`/`processType=A16`
  with the pipeline's own client: the document **ends at `2026-08-06T22:00Z`**,
  exactly our newest row. Control `A65`/`A01` (day-ahead load forecast) over the
  same window returned 94 points through 2026-08-09, confirming the token, the
  `10YAL-KESH-----5` domain, and the endpoint are all healthy. ABL-152
  re-probed 2026-08-10: 327 rows, newest still `2026-08-06 21:45`, zero
  transport errors.
  **The `cron_update.log` 400/503 lines are a trap** (ABL-84): `cron_update.log`
  shows sporadic errors against AL load on 08-06 13:30, 08-08 00:30, 08-09
  00:30. They are not the cause — passes on either side succeeded and
  `MAX(timestamp_utc)` never moved. Do not re-diagnose this from the error lines
  alone; it produces a confident, wrong answer.
  **This is not permanent.** Unlike AL generation, this stream is `stale` not
  `ended` — Albania will resume publishing and the verdict will return to `live`
  on its own. Do not promote it to a dead-zone entry. If you see this stream
  stale with `latest = 2026-08-06 21:45` and are about to file a bug, first
  check whether the frozen timestamp already matches a closed issue (ABL-84's
  title carries it) — that is the fingerprint for this specific outage.
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
- **LU's `net_position` was a byte-identical duplicate of DE, until
  2026-08-11.** Both country codes resolve to the same ENTSO-E bidding zone —
  `NET_POSITION_BIDDING_ZONES` maps `DE` and `LU` both to `DE_LU`
  (`../energy-data-gathering/src/entsoe_client.py:1989-1992`) — so every ingest
  pass wrote a separate `LU` fetch that was numerically identical to the `DE`
  fetch, double-counting DE in any per-country aggregate that summed across
  countries (a national total, a cross-country mean). ABL-35 defect 4; fixed
  under Board confirmation `820fa10c` (accepted 2026-08-11): the ingest now
  skips the `LU` fetch entirely, before any API call, rather than fetching and
  deduping after the fact — `NET_POSITION_DUPLICATE_ZONE_COUNTRIES`
  (`../energy-data-gathering/src/entsoe_client.py:1994-2013`), applied at
  `../energy-data-gathering/src/fetch_net_position.py:41-49`. No schema or UI
  change: the dashboard already reads LU through a `LU -> DE_LU` alias, not as
  a second country's series. The **459 rows already stored** under
  `country_code='LU'` (as of 2026-08-10) are deliberately left in place.
  **ABL-67 is now `done`, but do not read that as covering LU.** It
  authorized only the deletion of the 216 GR/IE rows documented above under
  ABL-181 (executed 2026-08-11 13:23 UTC) — rows with no genuine counterpart,
  fabricated outright by a sparse-document forward-fill. LU's rows are the
  opposite shape: real, correctly-fetched measurements that happen to
  duplicate DE's, and were never in ABL-181's scope. Whether to delete a
  genuine duplicate is a different, still-open database-write policy
  question, not settled by this fix. This is `net_position`-only:
  `PRICE_BIDDING_ZONES` carries the identical `DE`/`LU` → `DE_LU` mapping
  (`../energy-data-gathering/src/entsoe_client.py:2017-2022`) and must **not**
  get the same treatment — a price is intensive, not additive, so LU
  genuinely trades at the DE-LU price and de-duplicating it would delete a
  correct value, not a manufactured one.
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
  by `MAX(timestamp_utc)` on prod, never by `data_ingestion_log`. If your
  remit is read-only (no ENTSO-E API access to probe), check first whether an
  existing closed issue already carries the same frozen `MAX(timestamp_utc)` in
  its title or body — the frozen timestamp is the fingerprint for an upstream
  outage, and a match means the condition is already known (e.g. AL load frozen
  at `2026-08-06 21:45` → ABL-84). that table
  records an `INSERT OR REPLACE` rowcount, so rewriting rows that already
  existed logs as inserts and a healthy ingest looks identical to a five-day
  upstream stall. (ABL-60 turned the "is this stream current" half of this into
  a served verdict — see "Data freshness" above. That answers *whether* a stream
  is behind; this bullet is why a given zone being behind is usually not a bug
  to file. The 18h threshold is sized from the measurement above — ME at ~9.2h
  is the slowest genuinely-representative country, the longest ingest gap is 7h,
  and 9.5h–34h all select the same set. AL is *not* representative: it publishes
  in bursts and is `stale` a good fraction of the time by design — see "That
  9.4h was a snapshot" above. **Do not retune the threshold to silence AL.**)
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
- **As-issued forecast vintages — added under ABL-184, server-only, and only
  once deployed.** Until now none of the above existed for forecasts either:
  `forecasts` and the two TSO tables are replace-on-refresh, so a corrected
  re-run destroys the value it replaces before anything reads it
  (`ingestNetPositionForecast`'s delete-then-reinsert in
  `netPositionIngestService.ts` is the in-repo example; the TSO tables'
  unique constraint carries no run/issue-time dimension at all, so *any*
  refresh overwrites — ABL-134).
  `server/src/services/forecastVintageArchiveService.ts` now records every
  distinct (source, forecast_type, country, target, model, run, value) tuple
  it sees, the first time it sees it, into a new append-only
  `forecast_vintage_archive` table alongside the existing ones — never
  replacing, never deleting.

  **The migration, exactly:** `ensureForecastVintageArchiveTable`
  (`forecastVintageArchiveService.ts:116`) issues only `CREATE TABLE IF NOT
  EXISTS` plus two `CREATE INDEX IF NOT EXISTS` statements. No existing
  table, column or row is read for writing, altered, or dropped, and there is
  no separate migration script — the table is created lazily by the first
  capture, not by a deploy-time step. No client change, no registry change,
  no reader touched.

  **It captures nothing until this server is deployed and running with a
  write connection.** Landing this branch on `main` changes no running
  process; `forecast_vintage_archive` does not exist in production until
  code built from it is deployed. Once it is, capture is automatic and
  gated exactly like `POST /api/weather/snapshot` already is — on
  `HELIO_WRITE_TOKEN` being set (`shouldScheduleForecastVintageArchive`,
  `forecastVintageArchiveScheduler.ts:50`), started from `index.ts` at
  server boot. If that variable is unset in production for some other
  reason, deploying this code still captures nothing until it is set.

  **Runs in a worker thread, never on Express's request-handling thread.**
  Measured against a full copy of the production-scale replica (2026-08-11):
  one capture pass over `forecasts` (2.1M rows), `energy_load_forecast`
  (2.4M) and `energy_generation_forecast` (3.0M) takes **~147s**, and even a
  fully idempotent no-op rescan of unchanged data takes **~23s**.
  better-sqlite3 is synchronous, so running that inside the process serving
  dashboard API requests would freeze every other response for the
  duration — the same class of problem `services/readQueryWorker.ts` already
  exists to avoid for a single expensive read. `startForecastVintageArchiveScheduler`
  (`forecastVintageArchiveScheduler.ts:104`) instead runs it on a 15-minute
  timer inside `workers/captureForecastVintagesWorker.ts`, on its own
  connection, with an in-flight guard so a slow pass is skipped rather than
  overlapped by the next tick.

- **Core CCR net position (JAO) — added under ABL-230, server-only, and only
  once explicitly enabled.** Step 2 of ABL-219 (Board-approved via
  `confirmation:e4484ddc-7dcc-4e96-bb3d-23883577e078:core-netpos-ingest:v3`).
  `net_position.net_position_mw` (see "NetPositionTab" above) is a zone's net
  position over every SDAC-coupled border; the **Core** net position is a
  separately-published, narrower quantity — only exchanges inside the 12-zone
  Core CCR flow-based domain — that can disagree with it, including in sign
  (France 2026-08-09 08:00 UTC: Core -114.9 MW vs the all-borders +1,557.7 MW;
  full evidence in ABL-219's research brief, issue comment `5ba93873`). This
  is the pipeline's **first non-ENTSO-E source**:
  `https://publicationtool.jao.eu/core/api/data/netPos?FromUtc=<iso>&ToUtc=<iso>`,
  public and unauthenticated, 15-minute resolution, verified working
  2026-08-11. Do not call the distinction "AC vs DC" — it is which borders are
  in scope, not conductor type (Germany's Core figure already nets in its
  HVDC links; France's excludes its AC borders to ES/IT).

  Mirrors the `forecast_vintage_archive` pattern directly above rather than
  `netPositionIngestService.ts`: an append-only capture from an external
  source on a timer, not a client-triggered write. `server/src/services/
  coreNetPositionService.ts` owns a new, additive `core_net_position` table
  (`ensureCoreNetPositionTable`, `CREATE TABLE IF NOT EXISTS` only — no
  existing table touched), `jaoCoreNetPositionCapture.ts` fetches and parses
  one window, and `coreNetPositionScheduler.ts` runs that on a 15-minute timer
  inside `workers/captureCoreNetPositionWorker.ts`, on its own writable
  connection, with the same in-flight guard as the forecast archive.

  Only the 12 Core zone `hub_*` fields are stored (`CORE_ZONE_HUB_TO_COUNTRY`,
  `coreNetPositionService.ts`) — the response also carries 2 ALEGrO hubs and 9
  other external/DC virtual hubs Germany's own figure already nets in, and
  none of those is a standalone bidding-zone net position. `hub_DE` is the
  DE_LU zone; it is stored once, under `'DE'`, never duplicated under `'LU'`
  — creating that duplicate is the exact defect ABL-35 (defect 4) already cost
  a dedicated fix to remove from `net_position`. `resolveCoreCountryCode`
  aliases a caller's `'LU'` to `'DE'` at read time, reusing
  `netPositionService.ts`'s `resolveBiddingZone` for the DE/LU mapping itself
  rather than duplicating it.

  **Gated on TWO env vars, not a reuse of `HELIO_WRITE_TOKEN` alone.** That
  token is very plausibly already set in production, since it also gates the
  live weather-snapshot and net-position-forecast write endpoints — reusing
  it here would risk enabling live JAO capture the moment this code deploys,
  which is exactly what ABL-230 says must not happen as a side effect of
  merging. `shouldScheduleCoreNetPositionCapture`
  (`coreNetPositionScheduler.ts`) requires `JAO_CORE_NET_POSITION_ENABLED` — a
  new variable, not set anywhere, not set as part of this change — **and**
  `HELIO_WRITE_TOKEN`, since a writable connection is still the same
  prerequisite `getWriteDb()` has (unopenable on the Windows/Docker-Desktop
  acceptance box). Landing and deploying this code changes nothing in prod
  until both are set, which is a deliberate follow-up step coordinated with
  the CEO, not part of this issue.

  ABL-230 shipped a deliberately provisional read (`{ points }`, one route) on
  the note that the follow-up UI issue owned the real contract. **ABL-234 made
  that revision** — `routes/coreNetPosition.ts` now serves a per-zone series
  whose empty array always names *which* kind of empty it is, plus a `/map`
  route — see "NetPositionTab" above for the shape and for the toggle that
  consumes it. This section stays the reference for the ingest half.

## Testing

```bash
cd client && npx vitest run && npx tsc -b
cd server && npx vitest run
```

Green as of 2026-08-12: **45 client test files / 590 tests** (570 passing in
this checkout — the other 20, in `dashboardStore.test.ts`/`windowLabel.test.ts`,
fail on the pre-existing `storage.setItem is not a function` sandbox quirk the
ABL-203 paragraph below already documents, not a regression; ABL-263 tracks
them), **44 server test files / 620 tests**, all passing, clean typecheck.
Fewer tests passing than that means something broke.

(Both figures are a fresh `npx vitest run` on ABL-238 merged with `origin/main`
at `0871259` — what `main` becomes when this lands — not arithmetic on the two
branches' separate claims. Measured on a detached `origin/main` immediately
beforehand: **42 server files / 604 tests** and **44 client files / 575 tests**,
555 passing with the same 20 failing and no ABL-238 file on disk, which is what
establishes those 20 as `main`'s rather than this branch's. ABL-238 adds +2
server files / +16 cases (`services/peerOpsStatus.test.ts`,
`services/combinedOpsStatusService.test.ts`, and new cases in the existing
`routes/opsStatus.test.ts`) and +1 client file / +15 cases
(`lib/opsStatusThresholds.test.ts`).)

(`main` arrived here already claiming 41/602 while measuring 42/604: ABL-234
counted correctly, but ABL-266 landed afterwards and
`server/src/release/checkUnmergedWork.test.ts` is exactly the missing +1 file /
+2 cases. A count is only true of the tree it was measured on — re-measure it,
never re-derive it from two branches' claims. The server file count includes
the repo-root `scripts/backfillModelGuard.test.ts` (43 files under `server/`
plus that one): ABL-244 added it together with `server/vitest.config.ts:11`,
whose `include: ['src/**/*.test.ts', '../scripts/**/*.test.ts']` is what makes
repo-root scripts discoverable from the server suite at all.)

(ABL-234 added the Core / all-coupled-borders scope toggle. Client: 3 new
files — `lib/coreNetPositionSeries.test.ts`, `components/map/
netPositionMapScope.test.ts`, `components/dashboard/coreNetPositionNote.test.ts`
— plus new cases in `lib/netPositionScope.test.ts` (scope-aware copy) and
`store/migrate.test.ts` (the v10 clause). Server: no new file; 22 new cases
across `services/coreNetPositionService.test.ts` and a rewritten
`routes/coreNetPosition.test.ts`, which now asserts the revised contract
instead of ABL-230's provisional `{ points }` shape. Every net-position value
in both fixtures is real — the Core figures were fetched live from JAO on
2026-08-12 and the all-coupled ones read from the replica — specifically so
the France sign-disagreement case and the DE-LU false negative are pinned by
measurement rather than by invented numbers.)
(ABL-230 added the JAO Core net position ingest, server-only: 4 new files
(`services/coreNetPositionService.test.ts`, `services/
jaoCoreNetPositionCapture.test.ts`, `services/coreNetPositionScheduler.test.ts`,
`routes/coreNetPosition.test.ts`), 45 new cases, no client file touched. It
also fixed one pre-existing failure this checkout already carried, unrelated
to ABL-230 itself: `docs/claudeMdCitations.test.ts` had flagged the
`NetPositionTab.tsx` citation a few sections above (in "NetPositionTab") as
landing on a blank line at its old line numbers, 158 through 173 — ordinary
line drift from an earlier, unrelated change — corrected to the actual
`lastSeen` branch that citation was always describing, now
`NetPositionTab.tsx:270-284` (verified: the same "stopped publishing a net
position" ternary this section's own prose quotes). This branch was rebased
onto `main` 2026-08-12 after ABL-221's second pass, ABL-237 and ABL-240 landed
there (492 server tests / 34 files, 520 client tests / 41 files, per the
paragraphs below) — ABL-230's 45 server cases land on top of that base, not
the 421/27 this entry originally measured against before the rebase. The
rebase also shifted the `/api/health` line number the "host/process KPIs"
paragraph below cites — `coreNetPositionRouter`'s mount line now lands above
it — and that citation was updated to match. Neither the 492/34 nor the 520/41
figures below
survive a fresh count in this checkout either (35 server test files, 523
client tests present before this rebase's own additions) — the same
never-fully-reconciled-merges drift the ABL-214 paragraph names; this entry
reconciles only ABL-230's own delta against the top-line figures actually
measured just now, not the whole gap.)

ABL-221's second pass — the user's "remove the whole banner, not just the
mini graphs" follow-up comment — deleted `AbleStatRow.tsx` outright. The first
pass, `6350836`, had only dropped its sparklines, which was not what "confusing
banner" meant. Gone with the component: its sole data source
`useDashboardOverview` (`useDashboardData.ts`) and `lib/readingFreshness.ts`,
the per-reading staleness classifier "Current load" used with no other caller
— see "The header stat row was removed" above. That dropped 1 client file / 14
tests (`readingFreshness.test.ts`); no server file changed. Measured
immediately before this change: 534 client tests / 42 files — already above
the 488/39 this entry had recorded, for the same never-fully-reconciled-merges
reason the ABL-214 note below names; this entry reconciles only against
ABL-221's own delta, landing at 520/41, not the whole gap.

ABL-262 (the `/api/forecasts/compare` load guard) added one server file
(`routes/countries.test.ts`, 6 cases) and extended `routes/forecast.test.ts`
by 5, for **+11 server tests / +1 server file**. The headline figure above is
deliberately *not* restated from that run's measurement: the shared checkout
held three runs' uncommitted work at the time (ABL-238's ops-status page,
ABL-244's backfill guard — which also drops in a `server/vitest.config.ts`
broadening discovery to `../scripts/**/*.test.ts` — and this one), so the
543/38 it measured in `server/src` is not attributable to any single merge.
Prefer a stated delta over an absolute measured on a contaminated tree; if you
see a server figure far above 492/34, that is the backlog of unreconciled
merges this section already documents, not a regression.

ABL-237 (the `/api/ops/status` KPI endpoint, merged separately) added three
server files — `services/hostMetrics.test.ts`, `services/freshnessRollup.test.ts`,
`routes/opsStatus.test.ts`. ABL-240 (this merge — generalizing the net-position
ingest path to wind shadow candidates) added one server file
(`routes/netPositionIngest.test.ts`, 6 cases) and extended two others
(`services/netPositionIngestService.test.ts` +5, `config/forecastModels.test.ts`
+1). The 492/34 server figure above is measured on this merged tree with a
Node version matching the compiled `better-sqlite3` native module — see
"NODE_MODULE_VERSION mismatch" below if `cd server && npx vitest run` throws
that error instead of running.)
(That server figure predates several since-merged branches already reflected
in this checkout's history — e.g. ABL-190/ABL-221 — which is why a fresh run
here shows more than 421/27 even before ABL-214's own tests; this entry was not
re-reconciled against all of them, only against the delta ABL-214 itself adds.
ABL-214 touched no client file. It added 9 server cases across three existing
files — `timestampFormOnClause` cases in `utils/timestamp.test.ts`, and a
conflicting-T/space-pair-does-not-fan-out case plus a T-form-only-rescue case
in each of `services/mlForecastService.test.ts` and
`services/crossCountryMetricsService.test.ts` — no new file.)
(ABL-204 extended the multi-model overlay to Load and Price — two new files,
`dashboard/forecastLineTokens.test.ts` and `lib/multiForecastSeries.test.ts`,
plus new cases in `lib/forecastGap.test.ts` for
`describeForecastGapsForSelection` — which is where the client figure moved
from 474/37 to 488/39; it touched no server file. ABL-203 added the
net-position multi-model picker before it — `migrate.test.ts`'s v9 clause,
`useForecastModels.test.ts`'s `resolveMultiSelection` cases,
`chartAdapters.test.ts`'s `adaptNetPositionMultiSeries` cases, and a new file,
`dashboard/netPositionModelColors.test.ts` — which is where the client figure
moved from 449/36 to 474/37; it touched no server file, and the 411->421
server figure this entry used to carry already held on unmodified `main`
before this branch, so it is not part of this change's delta. (One
shared-workstation caveat worth naming here rather than re-discovering: this
checkout's `npx vitest run` intermittently fails ~20 client tests in
`dashboardStore.test.ts`/`windowLabel.test.ts` with `storage.setItem is not a
function` — a `zustand`/`localStorage` environment quirk in this sandbox, not
a code defect. Verified identical on unmodified `main` with this branch's
changes fully stashed, including untracked files, before attributing it to
ABL-203; do the same before re-diagnosing it as a regression.)
ABL-166 removed `ForecastPortfolio` and its `portfolioRows.ts` helper — the
"Forecast performance by variable" card grid the CEO asked to drop from the
Forecast quality portfolio page, leaving the rest of that page, its nav entry,
and the per-country `ForecastTab` in place — which is where the client figure
dropped by 3 tests and 1 file, from 452/37.
ABL-156 merged ABL-146's generation-mix x-axis fix and ABL-151's fourth
freshness verdict — both landed done but stranded on branches misleadingly
named for other issues (ABL-101 and ABL-149, respectively, whose own fixes had
already shipped separately) — which is where the client figure picked up 3
more `chartTicks.test.ts` cases and the server figure picked up
`freshness.test.ts`/`dataFreshness.test.ts` cases for the `ended` verdict. The
server figure here is the pre-merge author's own verification, not a rerun in
this checkout: a pre-existing `better-sqlite3` native-module ABI mismatch
blocked `cd server && npx vitest run` in this shared workstation checkout at
merge time, confirmed identical on unmodified `main` before either merge, so
it predates and is unrelated to both changes. The 411 above is measured fresh
in this checkout, not inherited: merging the ABL-101 and ABL-149 branches
themselves on top of ABL-156's cherry-picked fixes (`3c48561`, `0116d60`)
added one more server case beyond the 410 ABL-156 reported.
ABL-153 reconciled `main` and `origin/main` after an 11-vs-6-commit
divergence and landed ABL-150's cross-country-metrics fix on top, which is
where the client figure picked up `ForecastPortfolio`/`portfolioRows.test.ts`
and the v8 `comparisonForecastType` migration cases, and the server figure
picked up `crossCountryMetricsService.test.ts`'s query-plan case. The server
figure moved from 189 / 13 in ABL-17, which added
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
`lib/forecastGap.ts`, `dashboard/forecastLineTokens.ts`,
`lib/multiForecastSeries.ts`,
`lib/netPositionScope.ts`, `lib/coreNetPositionSeries.ts`,
`components/map/netPositionMapScope.ts`,
`components/dashboard/coreNetPositionNote.ts` (ABL-234 — the last two exist as
pure modules for the reason `comparison/mapFill.ts` does: `<Geographies>`
fetches its topojson, so the map's Core/out-of-scope decision cannot be
asserted through the component),
`server/src/docs/claudeMdCitations.ts`, `server/src/release/unmergedWork.ts`,
`server/src/services/freshnessRollup.ts`, `server/src/services/hostMetrics.ts`
(ABL-237 — both injectable at their I/O boundary, `statfs`/`loadavg`/`platform`
as optional params, specifically so `hostMetrics.test.ts` can exercise the
graceful-degradation path — a throwing stat call, a mocked Windows platform —
without a real disk or `os.loadavg()`).
Logic is extracted into a pure function
specifically so it can be tested this way. `timestamp.test.ts` also drives a
throwaway in-memory SQLite holding both separator forms, and asserts the query
*plan* still shows a range seek — the correctness and the performance property
are both easy to break and neither is visible by reading.

**Routes get an end-to-end test against a fixture database.**
`server/src/routes/*.test.ts` for `dashboard`, `forecast`, `forecastComparison`,
`tsoForecast`, `crossCountryComparison`, `netPosition`, `load`, `generation`,
`prices`, `dataFreshness` and `opsStatus`: a real request in, the real
`ApiResponse<T>` envelope out. Two shared pieces:

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
(`TABS_WITH_MODEL_PICKER` is declared at `CountryDashboardView.tsx:69` and
applied at `:129`), and skipped when the named symbol is not a top-level
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
// freshness" above for the rules behind `status`.
type FreshnessStatus = 'live' | 'stale' | 'ended' | 'none';

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
- Acceptance proxies the built local CAT Docker image, not the working-tree
  server, so a working-tree server fix will not show up there. Use the
  `PORT=3002` + local `ENERGY_DB_PATH` procedure in
  [`../WORKFLOWS.md`](../WORKFLOWS.md), **API proxy on CAT**, to exercise it
- **The workstation replica can be hours behind prod even with a fresh mtime.**
  Measured 2026-08-07 07:10 UTC: the replica's newest `energy_load` row was
  `00:15` (≈7h old) while prod's was `05:45` (≈1.4h). Acceptance reads this
  replica, so its data freshness describes CAT, not prod. Anything about
  prod health, freshness, staleness or "is this table current" must be settled
  against prod directly
  (`http://192.168.86.36:3001/api/...`, read-only) — the replica will make a
  healthy pipeline look broken. It is still the right place to measure *shapes*
  (row counts, per-country distributions, table-vs-table comparisons)

## Common Issues

**"Cannot connect to database":**
- Verify the SQLite file at `ENERGY_DB_PATH` (or `server/.env`'s value) exists
- Without `ENERGY_DB_PATH` set, the server defaults to `/data/energy_dashboard.db`, which won't exist on a workstation checkout

**A country's load/price forecast is blank:**
- Check whether a specific model is checked in `ModelPicker` — catboost and
  xgboost coverage barely overlaps (see Forecast model selection), so a
  checked model with no data for that country renders nothing for that line.
- With nothing checked ("Default"), an empty overlay is silent: the actuals
  still render, there is just no dashed line and no footnote explaining why.
  **This is a deliberate exception to this file's usual "never fill a gap
  silently, say why" rule** (ABL-221) — the single-pin footnote that used to
  read "<model> has no forecast for <country> in this window." with a **Use
  the best available model** button was reported confusing and removed from
  `LoadTab`'s and `PriceTab`'s default views. `describeForecastGap` and the
  `ForecastGap` type it returns still live in `lib/forecastGap.ts` and are
  still exercised — `NetPositionTab` calls `describeForecastGap` directly
  (not through `ForecastGapNotice`) for its own per-model footnote, and that
  one was **not** touched; see the `NetPositionTab` entry above.
- With one or more Load/Price models checked (ABL-204), a checked-but-empty
  model stays in the chart's legend with a hatched key and "— Not available
  in <country>" rather than disappearing, and gets its own footnote below the
  chart with a **Remove from comparison** button
  (`lib/forecastGap.ts`'s `describeForecastGapsForSelection`,
  `ForecastGapNotice`'s `gaps` prop, now the component's only prop — ABL-221
  deleted the single-select `gap` prop and its render branch as dead code
  once `LoadTab`/`PriceTab` stopped passing it). This multi-select case is
  unrelated to the removed default-view footnote above: it only renders once
  a user has explicitly checked more than one model to compare, so ABL-221
  left it in place.
- Selecting the type's **"Default — automatic"** entry clears every checked
  model (ABL-16). It used to *create* a pin, which is what made this state
  unrecoverable without clearing localStorage.
- Confirm the model is actually registered in `server/src/config/forecastModels.ts`

**TSO forecasts not showing:**
- In `ModelPicker`, check a `TSO ·` entry for that forecast type. `load` has
  both D+1 and D+7 registered; `solar`/`wind_onshore`/`wind_offshore` have D+1
  only; `price`/`renewable`/`biomass`/`hydro_total`/`net_position` have no TSO
  model at all — check `forecastModels.ts` before assuming a bug
- Note `ModelPicker` does not render on the Generation, Forecast-accuracy or
  Net position tabs at all (`TABS_WITH_MODEL_PICKER`,
  `CountryDashboardView.tsx:69`, applied at `:129`) — Net position instead
  gets its own separate multi-select `NetPositionModelPicker` — so there is no
  "picker that does nothing" to hit on any of the three
- Check the API response has data for the selected country
- Verify database tables have data: `energy_load_forecast`, `energy_generation_forecast`

**Week-ahead (D+7) band not showing:**
- Check "ENTSO-E TSO · D+7" in `ModelPicker` for the Load tab — there is no
  separate D+1/D+7 toggle anymore, the picker's selection controls it
- With one or more models checked (ABL-204), the band draws only when D+7 is
  the *sole* checked model — several bands on one chart is unreadable, and a
  lone band under N lines would misattribute uncertainty to models that never
  published one. Uncheck the others to see it.
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
- `ended` is not an alarm: the stream was held before but its newest usable row
  is over 30 days old. On the 2026-08-10 fleet this names GB/UA load and
  generation forecasts, plus AL generation. It is derived from age and
  self-clears when a newer row lands; do not replace it with a country list.
- See "Data freshness" above before changing a threshold — all are sized from
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

**Every `/api/...` route returns an HTML 404 from `localhost:3001`:**
- Read the response headers before debugging routes. If the same HTML 404
  appears through Vite and directly on `localhost:3001`, with a `Server:` header
  we never set (observed: `Server: gunicorn`), you are not talking to our server.
  An unmatched `/api` route from our Express app is a JSON
  `{ success, error, code }` envelope with no `Server` header; that response
  contract is pinned in `server/src/app.test.ts:117`.
- Diagnose the listener collision with the port-owner and Docker checks in
  [`../WORKFLOWS.md`](../WORKFLOWS.md), **API proxy on CAT**. On CAT, an
  unrelated service owns loopback `localhost:3001` even while the dashboard
  container publishes the same port on its LAN address; the specific loopback
  bind wins for loopback traffic.
- This is an environment problem, not a repo problem. Do not "fix" it by
  changing the default proxy target in `client/vite.config.ts`. Keep the
  environment-specific acceptance target in the gitignored `.env.local` as
  documented in `WORKFLOWS.md`; use its separate `PORT=3002` procedure for a
  working-tree server. After editing this file, `cd server && npx vitest run`
  checks its `file:line` citations via `docs/claudeMdCitations.test.ts`.
