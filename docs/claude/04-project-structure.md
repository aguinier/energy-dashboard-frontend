> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# Project Structure

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
│       │   │   ├── ForecastVintageNote.tsx # "when was this forecast generated, by which
│       │   │   │                         #   model" footnote under the ML line (Load/Price/Wind)
│       │   │   ├── ModelComparisonPanel.tsx    # "Compare forecast models" table (ForecastTab)
│       │   │   ├── generationSeries.ts   # The nine A75 families: grouping, palette,
│       │   │   │                         #   stack order, series builder (GenerationTab)
│       │   │   └── horizonBars.ts, sourceRows.ts, windowLabel.ts, modelComparison.ts,
│       │   │       forecastVintage.ts          # Pure helpers (each has a .test.ts)
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
        │   ├── opsStatus.ts           # /ops/status, /ops/status/combined, /ops/status/history
        │   │                          #   (ABL-237, ABL-238; `derived` warn/error verdicts
        │   │                          #   added by ABL-292, history by ABL-288)
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
        │   ├── opsSnapshot.ts, opsSnapshotStore.ts, opsSnapshotScheduler.ts,
        │   │   opsHistoryService.ts   # Append-only JSONL ops-status snapshots (ABL-288) —
        │   │                          #   a file next to the DB, never a table in it
        │   └── coreNetPositionService.ts, jaoCoreNetPositionCapture.ts,
        │       coreNetPositionScheduler.ts
        │                              # JAO Core CCR net position capture (ABL-230) —
        │                              #   see "Core CCR net position (JAO)" below
        ├── workers/                   # captureForecastVintagesWorker.ts,
        │                              #   captureCoreNetPositionWorker.ts — each
        │                              #   scheduler's writable-connection thread
        ├── lib/
        │   ├── syncBlackoutWindow.ts  # Pure: is `now` inside the ABL-220 DB-sync lock window
        │   └── opsStatusThresholds.ts # Pure: the ONLY home of the ops warn/error
        │                              #   thresholds — client and alert engine both
        │                              #   consume the verdict, never the cutoff (ABL-292)
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
