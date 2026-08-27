> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# Common Development Tasks

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

**A registry entry whose `model_name` nothing writes is dead.** Registering a
model makes it *offerable*, not *served* — an explicit request is honoured
strictly, so it resolves to that model, finds no rows, and draws an empty chart.
Measured on the replica 2026-08-12, both wind shadow candidates are in exactly
this state: `xgboost-retrain-v1` (`wind_offshore`) and `catboost-retrain-v1`
(`wind_onshore`) are registered and pickable, and have **zero rows fleet-wide**.
Check the `forecasts` table for the `model_name` before adding the entry.

### Adding a country to a generation stream (ABL-319)

**Serving is data-driven end to end — no country allowlist exists anywhere, so
training a model is the whole job.** Traced DE `wind_offshore` on 2026-08-12:

- `getForecastData` filters on `country_code` / `forecast_type` / `model_name`
  only (`services/forecastService.ts:61-137`); `resolveModelCandidates` is keyed
  by **stream** and never sees a country (`config/forecastModels.ts:224`).
- `getAvailableForecastTypes` is a plain `SELECT DISTINCT forecast_type`
  (`services/forecastService.ts:221-234`), so the first row written for a
  country/stream adds the type to the picker with no code change.
- No client component gates generation by country; `WindTab` is shared by both
  wind streams and reads whatever the API returns.

So the gate is the **write path**, not the picker. `wind_offshore` serves BE and
FR and nobody else because only those two have a trained model — DE reports
662-701 MW of real offshore generation every hour and forecasts none of it.
`models/DE/wind_offshore` exists but holds only un-promoted variant
subdirectories (`candidate/`, `centroid/`, `multipoint/`, `production/`) with no
top-level `model.joblib`, which is the exact path `Forecaster.load` opens in the
sibling `energy-forecast` repo (`../energy-forecast/src/forecaster.py:898`); it
raises `FileNotFoundError` and `../energy-forecast/scripts/forecast_daily.py:452`
counts the pair as *skipped*. Do not read a directory under
`models/<CC>/<stream>/` as evidence that a stream is trained — check for
`model.joblib` at its top level.

A country with no rows degrades to `200` + an empty array, and the chart leaves
`forecast: null` at every point rather than drawing a zero line
(`buildSeriesGrid`, `client/src/lib/chartAdapters.ts:35`). Both directions are
pinned by `routes/forecast.test.ts`'s "serving is data-driven, not
country-gated" block and the two `adaptWindSeries` cases in
`client/src/lib/chartAdapters.test.ts`.

### Modifying TSO or ML forecast display

Key files:
- `server/src/config/forecastModels.ts` — which models exist per type
- `server/src/services/tsoForecastService.ts`, `mlForecastService.ts`,
  `forecastService.ts` — database queries
- `client/src/components/dashboard/ModelPicker.tsx` — selection UI
- `client/src/components/dashboard/LoadTab.tsx`, `PriceTab.tsx`,
  `NetPositionTab.tsx` — where the selected model's data actually renders
