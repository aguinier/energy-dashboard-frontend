> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# Key Features

## Key Features

### 1. Views

Three top-level views, switched via `currentView` in the store (`map` | `country` | `comparison`):
- **`MapView`** — landing page, a Europe choropleth (`EuropeMap.tsx`) with a floating metric selector.
- **`CountryDashboardView`** — six top-level country tabs: Price, Load, Generation, Wind onshore, Wind offshore (ABL-235) and Net position. Forecast-quality country detail is entered from the portfolio, not carried as a competing tab (`client/src/views/CountryDashboardView.tsx:131`).
- **`ComparisonView`** — the Forecast quality portfolio home: a type-local ranking/map for the default `load` type leads the page, then disclosed error evidence, then the country × forecast-type matrix as the explicit all-types view (`client/src/views/ComparisonView.tsx:29`). (The portfolio used to lead with a "Forecast performance by variable" card grid, `ForecastPortfolio`/`portfolioRows.ts` — removed under ABL-166 at the CEO's request; the rest of the page, its nav entry, and the per-country `ForecastTab` were untouched.)

### 2. Forecast model selection

`server/src/config/forecastModels.ts` is the registry: which models (`catboost`,
`xgboost`, TSO day-ahead/week-ahead, the net-position Chronos/XGBoost/baseline runs, ...) may
serve which forecast type, and which one is `production` for that type. **A
model must be listed there to be served at all.**

**The client sends `model=` only when the user explicitly picked one** in
`ModelPicker` (`client/src/components/dashboard/ModelPicker.tsx`, driven by
`useForecastModels.ts`'s `resolveSelection` — `requestModelId` is set from an
id the user actually chose and from nothing else, `useForecastModels.ts:155`).
**ABL-469's auto-selection does not weaken this**: a measured recommendation
decides which model is *displayed*, and is deliberately still not pinned onto
the wire — see "The default is auto-selected per (country, forecast type)"
below for why.
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

### The default is auto-selected per (country, forecast type) — ABL-469

`FORECAST_MODELS` names one `production` model per forecast **type**, picked by
hand on 2026-07-26 and never by measurement. It has no country dimension, so a
pair whose ENTSO-E series is twice as accurate as ours still displayed ours.
Measured through the real service code against the replica on 2026-08-20, that
is the ordinary case rather than an edge one — WAPE over a rolling 30 days,
ours vs ENTSO-E D+1: DE load **6.77 vs 3.41**, FR load 5.17 vs 1.54, ES load
6.00 vs 1.18, BE load 5.30 vs 3.86, DE solar 62.13 vs 4.69, DE wind_onshore
63.65 vs 13.48, BE wind_offshore 194.76 vs 35.23. The Board directive (ABL-316,
2026-08-14) is that the better series is displayed **labelled with its source**,
while ours stays selectable and keeps accruing a track record.

`GET /forecasts/models?type=&country=` now carries a `recommended` key beside
the type's config. `services/bestForecastModel.ts` is the ranking rule (pure,
colocated test) and `services/recommendedModelService.ts` measures the
candidates. **No new accuracy machinery and no new table**: every figure comes
from an accuracy function that already served an endpoint, at 14-32 ms per
pair measured on the replica, so the "prefer the accuracy the server already
computes" bar is met rather than deferred to a follow-up.

Four properties are load-bearing:

- **The recommendation decides what is *displayed*, and is still never pinned
  onto the wire.** `requestModelId` stays `undefined` for anything the user did
  not choose (`useForecastModels.ts:155`), so the claim above this section
  survives intact. A recommendation is measured over the last 30 days and says
  nothing about a window the user has shifted back six months; pinning it there
  would blank the chart in exactly the case the server's fallback ladder exists
  to cover. So auto-selection chooses the *source*, and the ladder keeps
  choosing between our own models by coverage.
- **A fallback is never labelled as a measurement.** A pair with no qualifying
  candidate resolves to the type's `production` id exactly as before, with
  `fallback: true`, and `describeAutoSelection` returns `null` for it —
  announcing an unmeasured default as "the most accurate forecast here" would
  be this repo's defining failure mode in a sentence.
- **An `ml` label waits for `meta.model` to agree.** A tso recommendation is
  unambiguous (the tab fetches that horizon directly), but nothing is pinned for
  an ml one, so the ladder could serve one model while the measurement named
  another — a chart labelled with a model that did not draw it. Measured over
  the same window, **no pair has rows from more than one of our registered ml
  models**, so the disagreement is empty today; the check keeps the label
  correct by construction rather than by that measurement holding.
- **Two exclusions do real work, and both were verified live.** NL load comes
  back `unmeasurable_wape` on **both** sides — `applyLoadForecastBasis`
  suppresses the TSO series *and* our own, so ABL-277's divergent-basis country
  is not auto-selected onto a figure that is a definitional gap — and `tso-d7`
  is `sparse_coverage`
  everywhere, publishing one value per day at noon (4.2% of the window's hours),
  so its WAPE answers a narrower question and must not be ranked against a
  series measured all day. The coverage bar counts **distinct window hours, not
  a share of the largest point count**; the latter was tried first and excludes
  the hourly ML model for competing against a 15-minute TSO series, which is a
  resolution difference and not a coverage difference.

**Suppressing one side of a divergent-basis pair and not the other is strictly
worse than suppressing neither, and this shipped that way for a day** (found
merging ABL-493/ABL-501 onto `a508ba1`, fixed there). ABL-469 applied
`applyLoadForecastBasis` to the TSO branch of `measure()` alone, on the reading
this file itself carried at the time — that the divergence was a property of
the *TSO's* forecast. ABL-493 refuted that by measurement: it is a property of
what ENTSO-E nets out of the country's **realized** series, so it binds every
forecast of that series, and NL catboost carries *more* of the gap than the TSO
does (+173.7% midday bias against +123.2%, both vanishing in winter).

The half-applied rule does not merely leave one number unsuppressed. The honest
exclusion of the TSO series hands the ranking to the contaminated model **by
walkover** — it becomes the only qualifying candidate, so `fallback` is `false`,
`recommended.wape` publishes the ~32% definitional gap on
`/forecasts/models?type=load&country=NL`, and `describeAutoSelection` prints it
under the chart as *the most accurate forecast for the Netherlands*. Meanwhile
ABL-501 withholds that same model's series from the chart entirely, so the page
would have recommended a model on its accuracy and refused to draw it, in the
same card. Both branches of `measure()` now go through the rule, NL load falls
through to the no-history fallback, and `describeAutoSelection` says nothing —
which is the correct amount to say about an accuracy nobody can attribute.

`LoadTab` gates the auto-selection note on the withheld verdict as well, so the
sentence cannot outlive the line it describes even if a future path produces a
recommendation for a withheld pair. That is defence in depth rather than
duplication: the server fix stops the *number* being published, the client gate
stops the *claim* being made.

`PriceTab` deliberately carries no source label: `price` has **no TSO model
registered**, so the "a TSO default must not read as ours" case cannot arise
there, and its subtitle already says `dashed = able-ml forecast`. The window,
the ranking measure (WAPE) and the tie-break (evidence, then the incumbent,
then registry order) are the three judgement calls the issue asked to be stated
rather than buried; they are argued in `bestForecastModel.ts`'s header.

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

**"These" means the accuracy endpoints above — not `/forecasts`.** This has
already been misread once (ABL-285 was filed on the premise that a `/forecasts`
batch can mix models), so state it plainly: `getForecastData` walks the
candidate ladder and **returns the first candidate that has rows**
(`forecastService.ts:52-56`), and `queryForecasts` always applies
`AND model_name = ?` (`:53`). One `/forecasts` response therefore carries
**exactly one `model_name`**, pinned or not. What it *can* mix, because neither
is pinned, is `model_version` and `generated_at` — the hourly branch takes
`MAX(generated_at)` per target timestamp (`:80-88`), so one window spans as
many runs as it has distinct target hours. The daily/weekly branch selects no
`model_name`/`model_version` at all and averages `horizon_hours` (`:98-113`),
so those columns are absent rather than wrong there.

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
`useLoadChartData.ts:133-135`). With one or more models checked, the hook
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

  **A forecast that is not on the same basis as the actuals is withheld
  server-side, and the card says why** (ABL-501). This is the divergent-basis
  rule one level up from the accuracy measures ABL-277 and ABL-493 suppressed:
  those stopped a wrong *number* being published, this stops a wrong *picture*
  being drawn. It was live — measured through a local server on the replica
  2026-08-20, NL's Load tab drew a dashed line at **9,431 MW over a realized
  4,361 MW** at 12:00 on market day 2026-08-05, with nothing on the card
  saying the two were different quantities. The tell that it is a basis gap and
  not a weak model is one day at two hours: the same catboost run reads 9,801
  against a realized 9,909 at 03:00, and 9,431 against 4,361 at 12:00.

  Four endpoints withhold, all through `withholdDivergentBasisSeries`
  (`server/src/services/loadForecastBasis.ts`) and all gated on the forecast
  type so NL's price and wind overlays are untouched: `/api/forecasts`,
  `/api/forecasts/compare`, `/api/forecasts/multi-horizon` and
  `/api/tso-forecast/load/:cc`. Each answers `data: []` with
  `meta.basis: 'divergent_basis'`, `meta.basisNote` (the sentence) and
  `meta.withheldPoints`.

  Five properties, in rough order of how expensive each would be to
  rediscover:

  - **`withheldPoints` is not decoration.** A withheld series and a country
    nobody forecasts both answer `data: []`, and they are different claims.
    Without a count, a consumer — including our own client — reads the first as
    the second and reports "no forecast published for the Netherlands", which
    is false: catboost publishes a full day. This is the same distinction
    `dataPoints` surviving suppression draws for the measures, and the same one
    `degenerate_zero` draws against `no_actuals` on the net-position side.
  - **`meta.model` still names the withheld model**, read before the
    withholding rather than off the empty array afterwards — the honest half of
    the answer, and what separates this from the no-rows case where there is no
    model to name (`netPositionService.ts` keeps `model_name` for the same
    reason).
  - **`/compare` withholds the forecasts and keeps the actuals.** That
    endpoint's claim is that the two arrays are the same quantity, so the
    *pairing* is what is false; the realized series is a true measurement and
    dropping it would assert a gap in data we hold in full.
  - **The rule takes no model argument.** It is a property of what ENTSO-E nets
    out of NL's *realized* series, so it binds every forecast of that series —
    the TSO's, ours, and any future one. That is also why a pin cannot escape
    it and why the multi-select picker needed no second code path.
  - **`getForecastData` and `getLoadForecast` are no longer exported.**
    `getForecastSeries` and `getServedLoadForecast` are the entry points, so a
    caller cannot obtain a forecast series without the verdict on whether it may
    be drawn. That is the structural version of the rule ABL-493 cost us once
    already, when the metric rule sat in one service and the endpoint that
    mattered most lived in another.

  Client side, `components/dashboard/forecastBasisNote.ts` (pure, colocated
  test) owns the words, the way `comparison/basisNotice.ts` does for a withheld
  measure. **The trap it exists for was created by the fix itself**: once the
  server withholds, a withheld overlay and an uncovered one are both zero
  points, and the existing copy for zero points is `forecastGap.ts`'s
  "<model> has no forecast for <country> in this window" — false here, and with
  a **Remove from comparison** button whose premise is that another model might
  cover the country. So a withheld entry never reaches that path:
  `LoadTab`'s selection view filters it out of the gap list and prints the
  registry sentence separately, and `multiForecastSeries.ts` gives it
  `WITHHELD_LEGEND_NOTE` ("Withheld — different basis") instead of "Not
  available in …" beside the same hatched swatch. It is also excluded from the
  point-writing loop and from the band, not merely marked `covered: false` —
  that flag governed the legend alone, so rows arriving with a withheld verdict
  would still have been drawn.

  `/api/forecasts/latest` is the one forecast endpoint deliberately **not**
  covered: it returns a newest-batch across every type with no actuals beside
  it, so it would need per-row type gating for a payload nothing renders
  (ABL-285 deleted its last client reader). Filed as follow-up rather than
  bolted on.

  **An `energy_load` row of exactly `0.0` is withheld everywhere, because a
  national grid never draws 0 MW** (ABL-35). This is the same "published a
  placeholder as a measurement" defect as GR's net position below, in a
  different table, and it was live: measured read-only against the replica
  2026-08-06, **543 of ~2,647,076 rows are exactly `0.0`** across 11 countries
  (BA 277, MK 99, ME 73, ES 46, PL 25, MD 10, RO 5, AL 4, NL 2, RS 1, SI 1) and
  **0 rows are negative**. The 543 count is unchanged; re-verified 2026-08-12 and
  2026-08-14 (the denominator is exactly 2,647,076 on the replica that day).

  (The denominator dropped from the 2026-08-06 census value of 2,762,517, and
  **that drop is still unexplained** — ABL-453 flagged it "not investigated
  further" and it stays open. This entry briefly attributed it to "the
  `(country_code, timestamp_utc)` dedupe" in `server/src/v1/data/accuracyRepo.ts`,
  which cannot be the cause in kind, never mind in line number: that module is a
  **read path**, and a dedupe inside a `SELECT` cannot change how many rows a
  table stores. The documented *writes* do not close the gap either — ABL-256
  deleted 30,066 rows and ABL-257 a further 7,617, which is 37,683 of the 115,441
  the census implies, against continuing ingest in the other direction. Do not
  re-attribute this without measuring it; an explanation that is merely plausible
  is what this file exists to stop. The citation is deliberately left as a bare
  path with **no line number**: `accuracyRepo.ts`'s header comment does record
  the 2026-08-11 no-duplicates measurement, so citing it reads as support for
  the attribution this paragraph retracts. Do not restore the line number, and
  do not re-add the `COMMENT_CITATION_ALLOWLIST` entry that a line number would
  then require — the measurement is real, the inference from it was not.)
  It is ongoing, not historical — the newest were SI at
  `2026-08-06 00:00` and MK at `2026-08-02 21:00`.

  **SI's zero roams and self-repairs** (ABL-453). SI always has **exactly one**
  zero row, and it sits at the newest stored timestamp — the leading edge of
  ingest. Once ENTSO-E publishes the Point, the row is overwritten with the real
  value. Verified on prod 2026-08-14: rows at `08-10 00:15`, `08-11 06:15`,
  `08-12 00:15`, and `08-13 00:15` were all previously `0.0` and have since
  repaired to `941.75`, `1556.77`, `1078.11`, and `1066.00` MW. Only `08-14 00:15`
  was still `0.0`, and it was the newest row.

  A leading-edge SI zero is **"not published yet," not "fabricated."** It is
  expected, contained, and must **not** be re-filed. Cf. ABL-67/ABL-181: a
  Board-approved 392-row delete was aborted when 189 rows self-repaired within
  four minutes — a 48% false-positive rate.

  **The correct test of the ABL-157 guard is the total count, not a date filter.**
  A `COUNT(*) WHERE load_mw = 0 AND timestamp_utc > <recent date>` returning `1`
  is the SI leading edge and is expected. File a bug only if:
  - the **total** across all countries grows above 543, or
  - a zero appears at a timestamp that is **not** the newest row for that country
    and does not self-repair within ~24 h.

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
  the 18:30 pass, dropping 191 of 667 LU load rows). The **fabricated** zero
  count stops growing (the SI leading-edge zero described above is not fabricated
  and is not counted by this fix).
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
    and are probably false too, but `0.0` needs no calibration to be disprovable
    while any cutoff above it is a number nobody has justified. That grey zone is
    deliberately still served. Re-measured 2026-08-14: **MK 18** (0.005-9.715,
    newest `2026-08-05`, MK's known stall date) and **BA 6** (0.44-9.25). The
    total is unchanged at 24, but the composition is not what this entry
    recorded on 2026-08-06 — it said MK 17 / BA 6 / **ME 1**, and ME now has
    **none**. So the grey zone is not a fixed historical set: MK gained a row
    and a new low, ME's lost one. Re-measure it rather than citing this line,
    and note the total staying at 24 is a coincidence of two offsetting moves,
    not evidence that nothing changed.

  Every `energy_load` read site in `server/src` applies one of the two
  helpers, with a single documented exception. The enumeration was wrong twice
  before — it claimed completeness while a hole was open, both times — so it is
  written here as counted read sites, verifiable with
  `grep -rn "FROM energy_load\b" server/src`:

  | module | `energy_load` reads | helper |
  |---|---:|---|
  | `loadService.ts:21` `:38` `:57` `:75` `:86` `:111` `:146` | 7 | `measuredLoadClause()` |
  | `dashboardService.ts:84` `:106` `:183` `:369` | 4 | `measuredLoadClause()` |
  | `tsoForecastService.ts:246` `:286` | 2 | `measuredLoadClause()` |
  | `countryService.ts:51` | 1 | `measuredLoadClause()` |
  | `dataFreshnessService.ts:35` | 1 | `measuredLoadClause()` |
  | `crossCountryMetricsService.ts:155-168` | 4 aliases | `loadActualGuard()` ×3 |
  | `mlForecastService.ts:243` `:287` | 2 | `loadActualGuard()` |
  | `forecastService.ts:312` | 1 | `loadActualGuard()` |
  | `countryService.ts:153` | 1 | **none, deliberately** |

  `dashboardService.ts`'s four are current load, peak demand, the map
  choropleth and the timeseries daily average.
  `crossCountryMetricsService.ts` joins the table under four aliases and needs
  only three guards: `s`/`s2` are guarded in their join clauses and the
  `a`/`a2` pair is guarded once in the `WHERE`, through the `COALESCE` that
  merges them (`crossCountryMetricsService.ts:132,171`).

  The unguarded one is `getCountriesWithData` — a `SELECT DISTINCT` over a
  three-table `UNION` that answers *is this code worth offering in a picker*,
  not *what did we measure*. It returns no value a chart can render, and
  guarding only its load leg would make the `UNION` incoherent, since an
  all-NULL `energy_generation` row is an honestly empty A75 document rather
  than a placeholder value, and a zero-clearing `energy_price` hour is a real
  measurement. It also
  changes nothing: every one of the 11 countries carrying placeholder zeros
  holds tens of thousands of genuine rows beside them.

  (Its third leg read the frozen `energy_renewable` until ABL-352; the sentence
  above used to cite that table's ambiguous zeros as the reason. Both legs of
  that reason still hold, for different tables. Verified on the replica
  2026-08-13 that the move is a no-op on live data: both tables hold the same
  34 country codes and the whole `UNION` returns the identical 36 either way.)

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

  That endpoint's *renewable* block had a third version of the same defect,
  fixed by ABL-352 (ABL-324 tranche 2): it counted **rows** in the frozen
  `energy_renewable`, which stores one instant under several spellings, so
  `records` overstated our own coverage. It reads `energy_generation` now,
  where a row count is an instant count. Deliberately **unguarded**, unlike the
  load block beside it, and the distinction is the one this whole section turns
  on: a stored `load_mw = 0.0` is a positive false claim, while an
  `energy_generation` row whose value columns are all NULL asserts nothing —
  NULL is already the correct encoding, and the row's existence really does
  mean we hold that instant's A75 document. Measured 2026-08-13, 90 rows of
  3,178,270 are in that state and they move exactly one country's `to` (DE's
  raw MAX `2026-08-12 13:00:00`, an unfilled leading-edge document, against a
  value-bearing `12:45:00`). Guarding it costs the covering index — 17.4 ms to
  86.4 ms on DE — which is not proportionate to 0.0028% of rows. Note the
  frozen table was *worse* at that same instant, not better: its `DEFAULT 0`
  stores DE's 13:00 as `solar_mw = 0, total_renewable_mw = 0`.

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

  **`energy_renewable` carries the same signature, and it needs no guard here —
  the read path it would have protected no longer exists** (ABL-42, closed
  2026-08-14 as resolved by the ABL-324/ABL-399 migration). This entry used to
  say the rule was "genuinely ambiguous" and to warn against extending
  `measuredLoadClause` without sizing a threshold first. Both halves are now
  settled, and neither the way it expected.

  The signature is real and reproduces exactly. Measured read-only on the
  replica 2026-08-14, day-level rule (>=20 rows/day, every renewable column
  exactly `0.0`): **11 country-days, AT 2 and MD 9** — AT `2025-11-15` and
  `11-16` at 96 rows each, MD 9 days scattered over 2022-02-01..2023-01-25.

  **The ambiguity is gone, and it was never a threshold question.** MD's days
  were called undecidable because its genuine range is 2-282 MW, so a zero day
  is not separable *by magnitude*. It does not have to be: `energy_generation`
  records what actually happened at those same instants, and it says both
  countries were generating.

  | | `energy_renewable` | `energy_generation`, same country-days |
  |---|---|---|
  | AT 2025-11-15/16 | all columns `0.0`, 96 rows each | solar **948 / 1,548 MW**, wind 356 / 468, hydro run 2,500 / 2,572 |
  | MD, all 9 days | all columns `0.0` | hydro run **19-54 MW**, biomass 1-3 MW, every day (solar and wind genuinely `0.0`) |

  So **all 11 are fabrications**, MD included, and none is a real zero. That is
  the frozen table's `DEFAULT 0` doing what it does everywhere else in this
  file — see the ABL-399 and ABL-353 entries, where the identical mechanism
  fabricated 477,846 and 9,192 accuracy pairs. Cross-reference against the
  better table is the general answer here; sizing a floor per country was the
  wrong tool and would have condemned MD's genuine 2 MW days.

  **Nothing reads it, so there is nothing to guard.** ABL-324/ABL-399 moved
  every dashboard read onto `energy_generation`; `server/src` now holds no read
  of `energy_renewable` at all (see "Generation data" for the verification
  command). A whole-day all-columns rule on that table would be a read-side
  guard on a table this repo does not read — dead on arrival, and one more
  thing to keep true.

  **It was never actually served wrong either, for a second and independent
  reason worth knowing before anyone "restores" it.** The fabricated rows are
  **`T`-form** (verified: all 96+96+24 sampled), `energy_generation_forecast`
  is 100% **space-form**, and the pre-ABL-353 accuracy join was a bare equality
  with no normalisation — so the join *dropped* them rather than scoring them.
  Two defects masked each other. That is the concrete case for why ABL-353
  moved the table instead of taking this file's earlier advice to fix the
  separator handling in place: a separator-only fix would have **activated**
  192 fabricated `0.0` actuals against AT's real TSO solar and wind forecasts,
  turning an invisible bug into a flawless-looking 0% error. The ML path was
  never exposed at all — the earliest renewable-family forecast row of any type
  is `2025-12-28` (`renewable` `2025-12-26`), a month after AT's zero days and
  years after MD's, and AT has **zero** stored forecasts of any type before
  2025-12-01.

  `energy_renewable` itself is untouched and stays that way: it is frozen, the
  rows are real history of what we stored, and deleting them is a shared-database
  write decision that belongs to the Board, not to a read-side fix. What still
  matters is that the sibling `energy-forecast` job and several backfill scripts
  read this table — so the fabrications remain live *there*, and that is the one
  place this finding is still actionable (filed separately).
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

  **A country whose realized load and TSO load forecast measure different
  quantities publishes no accuracy figure at all** (ABL-277). Subtracting one
  series from the other only measures forecast error when both measure the
  same thing. For **NL** they do not, and the resulting numbers were live:
  measured on prod over 2026-08-04..11, NL's D+1 load forecast scored **75.1%
  MAPE with a +2,427 MW bias**, against 1.2-3.6% for DE/FR/ES/IT/BE.

  **The divergence is upstream, and our ingest is faithful** — established by
  probing ENTSO-E directly on 2026-08-12 for market day 2026-08-05.
  `A65`/`A16` (Actual Total Load) and `A65`/`A01` (Day-ahead Total Load
  Forecast) for domain `10YNL----------L` each return one TimeSeries,
  businessType `A04`, objectAggregation `A01`, unit `MAW`, resolution `PT15M`
  — and disagree at source (realized 3,858.9-11,248.2 MW, forecast
  8,280.6-13,378.8 MW). Our stored rows reproduce both to the decimal. So the
  three obvious causes are all excluded: no ingest aggregation or scaling
  error, no bidding-zone mismatch, no partial-TSO coverage. **Do not re-file
  this as an ingest bug**, and do not "fix" it in `energy-data-gathering`.

  The gap is behind-the-meter solar. ENTSO-E's *reported* NL solar generation
  peaks at **181 MW** on a cloudless August day against an installed Dutch
  fleet well over 20 GW, so essentially the whole fleet is invisible as
  generation and is netted out of the realized series but not the forecast.
  Seasonality is the proof: over 2026-08-04..11 the midday bias (09-14 UTC) is
  **+123.2%** against **+9.8%** overnight, while the same measurement over
  2026-01-06..20 gives **+0.0%** midday and **−0.2%** overnight. No solar, no
  divergence. (A second, smaller level offset visible at night is *unexplained*
  and wanders — it crossed sign between 2025-11 and 2025-12, and a year
  earlier the forecast sat *below* realized at midday, 2025-06 midday bias
  **−38%**. It does not weaken the finding: two series measuring one quantity
  do not carry a wandering ±10% night-time offset.)

  `services/loadForecastBasis.ts` is the rule (pure, colocated test).
  Three properties are load-bearing:

  - **It is a registry of measured findings, not a threshold**
    (`DIVERGENT_LOAD_BASIS`, `loadForecastBasis.ts:119`). A threshold was
    tried and rejected: across the 34 countries with a stored D+1 load
    forecast there is **no gap in the MAPE distribution to put one in**. FR
    reached 11.6% and DK 11.0% over 2025-06-01..15 through ordinary forecast
    error, while EE and IE sit at ~10.5% over 2026-08-04..11 — any cutoff
    catching the latter condemns the former. An uncalibrated cutoff is exactly
    what `METRIC_THRESHOLDS` was deleted for. An entry is added only once the
    divergence is established against the raw upstream documents, and carries
    the evidence that established it.
  - **The rule lives in the service, not the routes**
    (`tsoForecastService.ts:474`), so every consumer inherits it rather than
    having to remember it. That is what closes `/tso-forecast/accuracy/load`,
    `/tso-forecast/metrics`, and — through `forecastComparisonService`'s three
    call sites — `/forecast-comparison/:cc`, `/:cc/best` and `/:cc/rolling`.
    `ForecastTab`'s TSO D+1/D+7 horizon bars vanish for NL as a consequence,
    because `buildHorizonBars` drops a bar whose `mape` is null.
  - **`dataPoints`/`mapeSamples` stay truthful; `mae`/`mape`/`rmse`/`bias` go
    null.** The points really did pair — reporting zero of them would assert
    "no data", a different and equally false claim, the same distinction
    `degenerate_zero` draws against `no_actuals` on the net-position side.
    **`bias` is the one that most needed nulling**: measured on the replica
    before the fix, NL's summary reported `mae: 0, rmse: 0` beside
    `bias: 2435.22` — a clean systematic over-forecast the TSO could
    supposedly correct, when it is the solar the two series disagree about.
    Two `?? 0` coercions produced those zeros
    (`forecastComparisonService.ts:255` is where the divergent case now
    returns before reaching them).

  Suppression is **unconditional**, not gated on season or on the size of the
  observed error. In a window where the two happen to agree — NL winter — the
  difference is still not attributable to forecast skill, and a number we
  cannot attribute is not a number we can publish.

  Client side, `ForecastTab.tsx:178` prints the reason under the stat strip
  and `modelComparison.ts:200` gives the panel a `divergent_basis` row state,
  because three em-dashes beside a healthy sample count reads as a sparse
  measurement rather than as no measurement.

  **NL is not the only suspect zone — the others are unestablished, and were
  deliberately not guessed at.** Measured over 2026-08-04..11: BA 37.2% MAPE
  (+6.6% night / +86.7% midday — NL's exact signature, and 137% MAPE over
  2026-06), MK 26.4%, MD 23.6%, LT 14.2%, EE 10.8%, IE 10.5%. None has been
  probed upstream, so none is in the registry. Filed separately; do not add an
  entry without the upstream measurement that justifies it.

  **It is not a TSO-forecast property. This entry said it was, and that was
  wrong** (corrected by ABL-493, measured on the replica 2026-08-20). The
  sentence it replaces read: "Our own ml models are trained against the same
  realized series they are scored on, so ml accuracy for NL is measuring what
  it claims to (it is simply poor — 94.75% MAPE for catboost D+1, which is a
  model-quality question, not a basis one)." The premise is plausible and the
  conclusion is false: **our own catboost NL load forecast carries the same
  gap, and more of it than the TSO's.**

  Three measurements settle it, over 2026-08-04..11 (`forecasts`, NL load,
  which is 100% `catboost` — there is no tso-named model row for NL load in
  that window, so this really is our model):

  | | midday bias (09-14 UTC) | overnight bias (21-05) | WAPE |
  |---|---:|---:|---:|
  | NL **Feb** 2026-02-10..24 | **−1.9%** | +0.2% | 10.28% |
  | NL **Jun** 2026-06-10..24 | **+138.2%** | −3.6% | 31.46% |
  | NL **Aug** 2026-08-04..11 | **+173.7%** | −3.0% | 32.59% |
  | DE Aug, control | −0.5% | +3.3% | 8.18% |
  | BE Aug, control | −1.4% | −0.8% | 5.58% |

  Same proof as ABL-277's, on the ml side: **no solar, no divergence.** A
  merely weak model does not produce a clean diurnal bias that vanishes in
  winter and reaches +174% at midsummer noon, and neither control shows any
  midday skew at all.

  The levels say what is actually being predicted. NL midday, Aug: **actual
  3,464 MW, our ml 9,480 MW, ENTSO-E D+1 8,073 MW.** Our forecast is closer to
  the TSO's forecast (13.31% WAPE against it) than either is to reality
  (32.59% / 32.46%) — two forecasts of Dutch **gross** load, scored against a
  realized series published **net** of behind-the-meter solar.

  **What is measured is that our ml forecast is on the gross basis; *why* is
  not, and do not write it down until it is.** Whether the NL model is fitted
  to a gross target or inherits the basis through a feature is a question for
  the sibling `energy-forecast` repo, and this repo cannot see the answer. It
  is filed separately. What follows for *this* repo is only that the ml path
  needed the same suppression the TSO path already had — see "Cross-country
  comparison metrics" below, and, one level up from any measure, the withheld
  overlay under `LoadTab` above (ABL-501).

  **Three consumers have now had to inherit this rule, and each was found the
  same way — by looking for the next one.** `tsoForecastService` (ABL-277),
  `crossCountryMetricsService` (ABL-493), and `recommendedModelService`'s ml
  branch (found merging ABL-493 onto ABL-469; see "The default is auto-selected
  per (country, forecast type)"). The recurring shape is that a rule stated in
  one service is inherited only by the callers someone remembered, so when
  adding a surface that divides a forecast by an actual, the question to ask is
  not "does this look like an accuracy endpoint" but "does this publish, rank
  or label a number derived from both series". The auto-selection case is the
  instructive one: it did not publish a measure to a chart axis at all, it
  merely *ranked* on one — and ranking on a suppressed measure put the
  contaminated model on screen with a commendation attached.

  (No January control exists on the ml side: NL's earliest stored load
  forecast of any model is `2026-02-03`, so February is the low-solar window,
  and it is a good one — Dutch solar at 52°N in February is close enough to
  nothing for the purpose.)

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
  (`useDashboardData.ts:116`) and `getGranularityForPreset`
  (`useDashboardData.ts:157`).
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
`server/src/types/index.ts:254`), every per-tab hook sends an explicit
`start`/`end` computed by `getDateRangeForPreset` (`useGenerationMix`,
`useDashboardData.ts:208`, and `useMapData` likewise at `:188`), and
`migratePersisted` deletes a stored
`timeRange` outright (`store/migrate.ts:106`). `timePreset` is the single field
describing the window. (`comparisonTimeRange`, a separate `'7d'|'30d'|'90d'`
field for `ComparisonView`, is unrelated and does still exist.)

Nor was there ever a *backend* blocker forcing it to stay. The
`/dashboard/overview|map|initial` endpoints take an explicit `start`/`end`
window and let it **win** over the legacy enum whenever both are present
(`server/src/routes/dashboard.ts:49`, `:76`, `:138`; `timeRange` is consulted
only as the fallback, via `getTimeRangeDates` in `dashboardService.ts:20`, and
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
  queries (`useLoadChartData.ts:192`, `:233`; `usePriceChartData.ts:133`);
  `selectedMLHorizons` drives the multi-horizon fetch
  (`useLoadChartData.ts:151`, `:197`).
- **No reader at all.** `showForecast`, `showTSOForecast`, `tsoForecastType`,
  `visibleRenewableTypes`, `sidebarOpen`, `comparisonCountries`.
  `showForecast` is still *written* — `setTimePreset` sets it `true` for future
  presets (`dashboardStore.ts:150`) — but ABL-285 deleted its last reader:
  `useLatestForecast` gated its query on it, `ForecastMetadataBadge.tsx` was
  that hook's only consumer and was imported by nothing, so the hook, its
  `fetchLatestForecast` client and the badge all went in one diff. The
  `GET /api/forecasts/latest` **route is untouched and still live** — only the
  client's dead call path is gone.

Careful with the name `showForecast`: `useLoadChartData`/`usePriceChartData`
declare *local* consts of that name derived from the picker
(`selected?.source === 'ml'`, `useLoadChartData.ts:133`;
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

**A divergent-basis country publishes no error measure here either** (ABL-493).
`loadForecastBasis.ts`'s rule had exactly one caller —
`tsoForecastService.ts` — so NL's load error was withheld on
`/tso-forecast/accuracy/load/NL` and published in full on this endpoint at the
same moment. Live on prod, 2026-08-04..11: `data.load.NL` was
`{mae: 2435.77, wape: 30.99, rmse: 3475.71, bias: -2063.27, dataPoints: 169,
skillVsSeasonalNaive: {n: 169, skillPct: -136.8, baselineWape: 13.09}}` with no
`basis` key at all, ranking NL **24th of 24** on the forecast-quality tab under
a "worse than the D-7 naive baseline" badge. The rule was written into a
service so every consumer would inherit it; the consumer that mattered most was
in a different service and inherited nothing.

Four things about the shape, three of which are traps:

- **The suppressed set is `ERROR_MEASURES`, and it includes `bias`.** The old
  helper blanked `mae`/`mape`/`wape`/`rmse` — the fields the *TSO* shape has.
  This entry publishes `bias` and no `mape`, so calling that helper unchanged
  would have left `bias: -2063.27` standing, which is the definitional gap
  restated in megawatts and the one figure on the response a reader would act
  on. Blanking is now driven off a named list at runtime and applied only to
  keys the carrier actually has, so one function serves both shapes without
  either listing fields.
- **`skillPct` goes; `n` and `baselineWape` stay.** The D-7 baseline is the
  *actual* from the same hour last week (`skillScore.ts`), so `baselineWape` is
  realized against realized — both terms net of behind-the-meter solar — and is
  a true statement about the country (Dutch load varies 13.09% week over week).
  `skillPct` divides by the contaminated model WAPE and is also what renders
  the loss badge. Blank what is unattributable, keep what is real.
- **It is gated on the forecast type.** `DIVERGENT_LOAD_BASIS` is a *load*
  finding; this service loops over eight types, so an ungated application would
  blank NL's price and generation numbers too — a second false claim, in the
  other direction. Generation-side divergence is ABL-400 and is deliberately not
  folded in. Suppression is driven off the registry, never off a literal `'NL'`,
  so ABL-283's pending work flows through by adding an entry.
- **A comparable entry is byte-identical, with no `basis` key at all.** Absence
  reads the way absence from the registry does: no finding, never "verified
  fine". Verified end to end against the replica through a local server, same
  query as prod's: **exactly 1 of 66 (country, type) cells changed**, all 23
  other load entries unchanged, `data.price.NL` unchanged, and NL went from
  ranked 24th to unplaced with the ranked denominator falling 24 → 23. Stamping
  `basis: 'comparable'` everywhere would have cost that check, which is the
  cheapest one available on a change like this.

`MeasuresClassified<T>` (`loadForecastBasis.ts`) is the compile-time half, in
the ABL-305 `Exhaustive<…>` idiom and asserted beside both response types. It
generalises ABL-388's property — `wape` was made a *required* field so a new
measure could not reach a divergent-basis country by being forgotten — from one
field to the whole shape: every plain-numeric field on a served entry must be an
error measure the module blanks or a pairing count it keeps, and adding a sixth
fails the build naming the field. It cannot see a measure nested inside an
object, which is why `skillVsSeasonalNaive` is handled by name.

Client side, nothing needed to change to keep NL out of the ranking —
`wapeRanks` already excluded a null WAPE ("not last, unplaced") and every cell
already guarded `!== null`. What was missing was the **reason**, and a bare
em-dash trades a wrong number for a silent one. `comparison/basisNotice.ts`
(pure, colocated test) owns the words: cells read **"not comparable"**, never
"no data" or "insufficient data" — we hold both series in full, 169 paired
hours and a real D-7 baseline — and the registry sentence is printed as a
footnote under the leaderboard, the ranking and the matrix, and in the map
tooltip. `SkillCell` is deliberately *not* rendered for such a row: with
`skillPct` null it prints "insufficient data", which is false here.

**Those same endpoints now serve `wape` beside `mape`, and on a generation
type it is the one to read** (ABL-388). The `actual > 0` guard above stops a
division *by zero*; nothing in it stops a division by 0.4 MW, and a solar
series passes through near-zero at dawn and dusk every day. Measured on the
replica 2026-08-13, full history, `/tso-forecast/accuracy/generation/:cc`:

| country | type | MAPE | WAPE |
|---|---|---:|---:|
| HU | solar | 7,421.87% | **13.12%** |
| NL | solar | 6,866.02% | 1,727.81% |
| CY | solar | 4,850.79% | 128.39% |
| CY | wind_onshore | 4,694.35% | 77.71% |
| HU | wind_onshore | 3,306.38% | 82.45% |
| PT | solar | 928.00% | **14.41%** |
| DE | solar | 57.39% | **7.17%** |

This is ABL-19's defect (BE solar MAPE 148,458%) in a second place, so it gets
ABL-19's answer rather than a new one: `services/wape.ts` is now the single
definition, moved out of `crossCountryMetricsService.ts` when it acquired a
second caller, and both `tsoForecastService.calculateMetrics` and its
deliberate mirror `mlForecastService.calculateMetrics` reduce through it. Do
not write a second WAPE — that is the mistake `renewableTotal.ts` exists to
prevent, one measure over.

Three things about the shape:

- **`wape`'s sample is `dataPoints`, not `mapeSamples`.** It covers every
  paired row, including the zero-actual ones MAPE must skip, so there is
  deliberately no `wapeSamples` field.
- **`null`, never `0`, when the window's actuals sum to zero.** BE's overnight
  solar is a measured 0.0 at every hour; a magnitude-weighted error over zero
  magnitude is undefined, not a flawless forecast.
- **`applyLoadForecastBasis` blanks it along with `mae`/`mape`/`rmse`**, and
  `SuppressibleLoadMetrics.wape` is required rather than optional so a future
  measure cannot reach a divergent-basis country by being forgotten. WAPE is
  immune to the near-zero defect, which makes it tempting to let through as
  the one honest number for NL — it is not one. That rule is about two series
  measuring different quantities, and weighting by magnitude does not turn a
  definitional gap into forecast error.

**WAPE is not a universal rescue, and the NL row above is the proof.** It
stays at 1,727.81% because that is not a near-zero-actual artifact: NL's
ENTSO-E day-ahead solar forecast sums to **18.28x** our metered actuals over
full history, which is exactly the `partial_subset` finding
`solarCoverage.ts` already carries (it measured 17.0 over a 90-day window).
A WAPE is forecast skill only where both series measure the same population.
Measured the same day, the aggregate forecast/actual ratio is ~1 for the
ordinary cases and far from it for a handful: solar NL 18.28, BA 3.21, CY
2.24, LU 1.57; wind_onshore SK 2.29, BA 1.75, HU 1.58, NL 1.75; and a ratio
of **0.00** for NO solar, CZ/SI wind_onshore and IT wind_offshore, where the
TSO publishes a forecast column of zeros and WAPE reads exactly 100%. None of
those is established against the upstream documents the way ABL-277's NL load
entry is, so none is suppressed — that is ABL-400, and the evidence bar
`loadForecastBasis.ts` sets applies to it. Above ~100% the only honest reading
of a WAPE is "loses to forecasting zero".

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
  found by a board member instead of by us. The rule: before that stream's
  `DAY_AHEAD_REQUIRED_AFTER_UTC_HOUR` the newest row must reach today's Brussels
  market day; after it, tomorrow's.

  **The deadline is per stream, because the three streams are three different
  ENTSO-E documents** (ABL-494, `services/freshness.ts:168`). They do not
  publish at the same time of day, and one shared 14 made
  `tsoGenerationForecast` read `stale` fleet-wide every afternoon:

  | Stream | Document | Data item | Upstream publication deadline | Required after (UTC) |
  |---|---|---|---|---|
  | `price` | A44 | 12.1.D | SDAC auction, ~12:45 Brussels (10:45 UTC CEST) | **14** |
  | `tsoLoadForecast` | A65 / A01 | 6.1 | around midday Brussels D-1 | **14** |
  | `tsoGenerationForecast` | A69 / A01 | 14.1.D | **18:00 Brussels D-1** (Reg. 543/2013 Art. 14.1) = 16:00 UTC CEST, 17:00 UTC CET | **20** |

  Document types are `../energy-data-gathering/config.py`'s (`price`,
  `load_forecast_day_ahead`, `wind_solar_forecast`). `14.1.D` is quoted verbatim
  from ENTSO-E's own Acknowledgement 999 text; the other two items are the
  Reg. 543/2013 numbering. 14 for A44 is roughly the hour by which the 13:30
  pass has finished, so "missing" means *we* are missing it rather than nobody
  having published yet; A65 clears that hour empirically (DE/FR/ES/IT/PL all
  held tomorrow at 15:17 and 16:32 UTC on 2026-08-20).

  **A pass takes 17-55 minutes, not the ~11 this file and the docstring used to
  claim.** That figure was inferred from one pass's per-country fetch stamps and
  was wrong by up to 5x. Measured on prod from `cron_update.log` over 08-18..20:
  16m55s, 23m00s, 29m46s, 29m19s, 20m40s, 18m55s, 23m43s and **55m10s**.
  Countries are fetched in one sequential alphabetical loop, so an overrun bites
  the tail of the alphabet rather than everyone — in the 55-minute pass, NL was
  fetched 14:07 and UA 14:25, both after the 14:00 cutoff. Two consequences: the
  A69 hour must clear 18:30 + 55m = **19:25**, which is why it is 20 and not 19;
  and 14:00 can already fire while the pass carrying the data is still running,
  a pre-existing few-minute false-positive risk on `price` and
  `tsoLoadForecast`. 14 is kept anyway — it is the ABL-51 tripwire, and widening
  it trades a rare few-minute false positive for permanently later real-miss
  detection — but whether the shared floor should move to 15 is its own
  judgement with its own evidence.

  That the A69 horizon actually moves at the 18:30 pass is measured, not
  inferred: DE's stored row count per pass repeats identically across 08-18/19/20
  and closes at 15-minute resolution — 704 at 13:30 (newest row today) and 780 at
  18:30 (newest row tomorrow); the early publishers' 800 is 704 + 96, exactly one
  extra market day. At the 13:30 pass that early set is NL, BE, AT, GR, HR, HU,
  LT, LU, NO and RO, so do not treat NL/BE as special in a fixture.

  **What that costs, stated rather than papered over:** between 14:00 and 20:00
  UTC we cannot distinguish "upstream never published A69" from "we have not
  fetched it yet", and the rule no longer pretends to. That is a bound of a
  four-passes-a-day ingest, not a workaround. Measured 2026-08-20 by raw HTTP
  probes against ENTSO-E: at 15:24 UTC the API itself answered Acknowledgement
  999, "No matching data found for GENERATION_FORECAST_WIND_SOLAR [14.1.D]", for
  DE's tomorrow — the old alarm fired while *nobody* had the data. Two things
  survive inside the window: a stream that fails to reach even today is still
  `stale` at any hour, and from 20:00 UTC a genuinely missing tomorrow is caught
  for the rest of the day — ABL-51's protection, intact.

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
  live/stale rule (`classifyMeasuredStream`, `services/freshness.ts:264`;
  `classifyDayAheadStream`, `services/freshness.ts:303`).

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
is **optional, not merely nullable** (`client/src/types/index.ts:559`) — a peer on a build
older than ABL-290 sends no key at all, which `buildNetworkRows`
(`client/src/lib/networkRows.ts`) renders as "not reported by this build",
separately from `null` ("not measured on Windows"), `[]` ("no non-loopback
interfaces"), and a listed interface whose rate is still `—`. A rate under
1 B/s renders `<1 B/s`, never a rounded-down `0 B/s`; an exact zero is a
measured zero and does read `0 B/s`.
Provenance (`commit`/`runtime`/`db_path`) is `getHealthProvenance()` verbatim,
the same values `/api/health` (`server/src/routes/index.ts:50`) reports — `/health`'s own
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
that mistake. Alerting arrived separately under ABL-287, below, and is still
not paging — the log is the only channel. A visitor-counter KPI was out of
scope here too until ABL-289 added one — see "7c. Visitor counters" below.

### 7b. "Last refreshed" per stream — when did the ingest last run?

`GET /api/data-freshness/:cc/ingest` (ABL-295, follow-up A from ABL-286's
provenance audit) answers a **different question** from the endpoint above, from
a **different source**, and the two must not be merged. Section 7 asks *how old
is the newest row we hold*, from `MAX(timestamp_utc)` on the data tables. This
asks *when did we last go and look, and did the pass write anything*, from
`data_ingestion_log` — which nothing in this repo read until now
(`grep -rn data_ingestion_log server/src client/src` returned nothing).

**Why not `publication_timestamp_utc`.** Because it is not a publication time —
see "Data the database does not have". ENTSO-E builds documents on request, so
that column dates our fetch; the audit measured 80.4% of `energy_load` rows
carrying a stamp over a day newer than the row holding it, max drift 39.1 days.
So the label is **"Last refreshed"**, never "Published" or "Generated": every
word on screen describes our pipeline, not the producer.

**The two values, and why collapsing them would be an incident.** A `completed`
pass does not mean rows were written. Measured on the replica 2026-08-12
(matching the issue's prod figures exactly): 2,886 of 16,335 `price` passes
stored nothing, `load` 1,367 of 16,301, `load_forecast_week_ahead` 4,119 of
16,298, `net_position` 1,267 of 2,668. Per (country, stream) it is worse than a
rounding error — it is the permanent state of whole streams:

- `net_position` — **14 of 36 zones have never had one pass store a row** (AL BA
  CH CY DK GB IT MD ME MK NO RS SE UA); GR and IE last did on 2026-07-31.
- `load` — GB and UA never have, matching their dead series.
- `renewable` — AL last did on 2026-06-30 within the historical gap (2026-06-24 – 2026-08-05); Albania resumed A75 publication on 2026-08-06 and `energy_renewable` now runs through 2026-08-12 21:00.
- `load_forecast_week_ahead` — ME last did 2026-05-24; BA GB MD MK SI UA never.

Every one of those was "checked" during the 00:30–00:48 UTC pass that morning.
Showing only the check would tell a GB user their load was refreshed today.

**`lastStoredRows` is NOT "the data got newer", and the field is named for
that.** `records_inserted` counts rows *written*, and the ingest upserts a
rolling 7-day window, so `INSERT OR REPLACE` counts a rewrite. AL load proves
it live: frozen at `2026-08-06 21:45` since its upstream stall, still storing
660 → 636 → … → 180 rows a pass as the window slides past. See the
`data_ingestion_log` bullet under "Data the database does not have" for the full
measurement. The client caption says so and points at the pill for data age.

- `services/ingestLog.ts` — pure, colocated test. The pipeline→stream map, the
  four-state `classifyDelivery`, and `mergePipelinePasses`.
- `services/ingestFreshnessService.ts` — one grouped read. **No `INDEXED BY`
  hint on purpose**: SQLite picks the barely-selective `idx_ingestion_log_status`
  and scans, which measured **38 ms** for FR across all seven pipelines against
  **133 ms** when forced onto `idx_ingestion_log_pipeline`, whose row lookups are
  random. The better-looking index is 3.5x slower here.
- Client: `layout/lastRefreshed.ts` (pure, colocated test) owns every word;
  `layout/LastRefreshedPanel.tsx` renders it in a popover behind the header
  pill, and `useIngestFreshness(open)` is gated so nothing is fetched until a
  reader opens it.

Four states, four different claims — `classifyDelivery`, and none may be
collapsed into another: `flowing` (the latest pass stored rows), `checked_no_data`
(we have run since the last write and got nothing), `never_delivered` (passes on
record, not one has ever written — there is no timestamp to show, so the copy
says "Never" rather than falling back to the check time), and `not_logged` (no
pass on record, which says the log cannot answer, not that the pipeline never
ran — hence `logStartsAt` beside the streams, the log only begins 2025-12-23).

**A multi-pipeline stream takes the best per-pipeline verdict, never the two
maxima compared against each other.** `tsoLoadForecast` is written by both
`load_forecast_day_ahead` and `load_forecast_week_ahead`, and D+7 finishes ~1s
after D+1 in every cycle (FR 2026-08-12: `00:39:16.351083` then
`00:39:17.291833`). Six countries (BA GB MD MK SI UA) have a D+7 that has never
stored a row while their D+1 is healthy — so `max(lastChecked)` is always D+7's
and `max(lastStoredRows)` always D+1's, one second earlier, and classifying those
two against each other would report `checked_no_data` **forever** on a table
refreshed four times a day. Reporting a healthy stream as stalled is the same
false claim as the reverse.

Scope: the six streams the dashboard draws. `crossborder_flows` and the two
weather pipelines are logged but unrendered, and weather is keyed by bidding
zone (`DK1`/`DK2`) where every ENTSO-E pipeline uses plain `DK`. A `failed`
status is producible by the writer
(`../energy-data-gathering/src/db.py:1192`) but has never occurred — 114,982
`completed`, 1 `running` — and is counted as neither a check nor a write.
**The ops warn/error thresholds live in exactly one module:
`server/src/lib/opsStatusThresholds.ts` (ABL-292).** They started out in
`client/src/lib/opsStatusThresholds.ts`, which meant the only thing in the
system that could turn a KPI into a verdict was a browser — and ABL-287's
alert engine is a scheduled server-side job. `/api/ops/status/combined` now
returns a `derived` key alongside the raw numbers:
`{ local: { environment, disk, freshness }, peer: { … }, commitDrift }`, each a
`'ok' | 'warn' | 'error' | 'unknown'`. `commitDrift` (added by ABL-287) is the
one verdict that is a *comparison* rather than a property of either side, which
is why it sits beside the two lanes instead of inside them; it is `'warn'` at
most, never `'error'` — two lanes on different builds is normal for the minutes
between deploying one and the other, and paging on it would page on every
rollout. `deriveSideState` runs off whatever the
endpoint reports for each side, so both lanes are covered by construction —
prod's `peer` is acceptance and acceptance's `peer` is prod. Disk is
`DISK_WARN_RATIO` = 0.75 (`server/src/lib/opsStatusThresholds.ts:44`) and
`DISK_ERROR_RATIO` = 0.9 (`:45`); freshness reuses the `freshnessRollup.ts`
severity ranking, where `stale` is the only alarm.
The client no longer derives anything — `OpsStatusView.tsx` renders
`data.derived` and mirrors only the `ThresholdState` union into
`client/src/types/index.ts`, the same way it mirrors every other server
response type. **Do not reintroduce a client-side copy of a threshold**: two
copies that drift is how a page reads "fine" while a pager reads "critical",
and there is no second place left to change one.

Two rules this endpoint holds to, both load-bearing:

- **`derived` is additive.** `local`, `peer`, `peerConfigured`, `syncBlackout`
  and `timestamp` keep the exact ABL-238 shape, and the verdict is a sibling
  key rather than a field grafted into either side — `SideStatus` stays the one
  type `peerOpsStatus.ts` can build straight from a peer's raw
  `/api/ops/status`, which is why that single-side endpoint has **no** `derived`
  key of its own. `routes/opsStatus.test.ts` pins the full top-level key set on
  both endpoints; that test failing is the intended alarm for a reshape.
- **An unreachable side reports `'unknown'` per KPI, not `'error'`.** We did not
  measure its disk at 100% — we did not measure it at all, and an alert rule
  keyed on `disk === 'error'` must not fire on a peer that merely timed out.
  Unreachability is expressed in `environment`, which is also the field that
  carries the ABL-220 blackout downgrade (`error` -> `warn` inside the window).
  Anything asserting on `environment` for an unreachable side must read
  `syncBlackout.active` rather than assume `error`, or it fails twice a day.

**The alert engine (ABL-287) turns those verdicts into notifications.**
`services/opsAlertScheduler.ts` evaluates every 5 minutes
(`OPS_ALERT_INTERVAL_MINUTES`), on by default (`OPS_ALERTS_ENABLED=false` opts
out). It calls `getCombinedOpsStatus()` **in-process** rather than fetching our
own port — a loopback would add failure modes (bound interface, port, proxy)
unrelated to the health being reported, and would break exactly when the server
is unwell. It imports that service *dynamically* for the reason
`forecastVintageArchiveScheduler.ts:4-8` documents: a static import would open a
`better-sqlite3` handle merely by importing the scheduler.

Four properties, each with tests, none of them optional:

- **Alert on transition, not on level.** `lib/opsAlertEngine.ts` is pure and
  compares each KPI against the state it *last told a human*, so a disk sitting
  at 91% notifies once, not every five minutes. Fires on breach, escalation
  (`warn`->`error`), improvement (`error`->`warn`) and recovery.
- **First run fires.** `unknown -> warn|error` is a firing transition. An engine
  that only fired on a change *from* `ok` would boot into an already-breached
  world and stay silent forever — live on 2026-08-12 that was acceptance disk at
  85.11% and stale freshness on both lanes.
- **Unknown is held, never recorded.** An unmeasured KPI is not a recovery and
  not a breach, and it must not overwrite the stored state — otherwise a
  measurement flicker (`warn` -> unmeasured -> `warn`) re-fires under the
  first-run rule.
- **The blackout holds the DB-backed KPIs.** Inside the ABL-220 window,
  reachability and freshness are held — no breach *and* no false recovery. Disk
  and commit drift do not touch the database and are not held; a disk filling up
  at 07:00 is still a disk filling up.

**The last-notified record is not ABL-288's snapshot store, deliberately.**
`lib/opsAlertStateStore.ts` keeps one small JSON object
(`OPS_ALERT_STATE_PATH`, default `ops-alert-state.json` beside
`ENERGY_DB_PATH`): per KPI, the last state we announced. Do **not** replace it
by re-deriving state from stored readings — move `DISK_ERROR_RATIO` from 0.90 to
0.85 and a stored 87% reading re-derives from `ok` to `error`, so the engine
compares `error` against a previous that is now *also* `error`, sees no
transition, and the threshold change suppresses the very alert it was made to
produce. What we told someone is a historical fact and is stored as one. Nothing
in that module throws: its input is an arbitrary file on a host we do not
control, and a monitoring job that dies on its own state file is worse than one
that forgets.

**Delivery is logging-only, by Board decision (2026-08-12).** `AlertChannel` in
`services/opsAlertChannel.ts` is a two-method interface with one implementation.
There is no SMTP config, no credentials and no stubbed credential handling in
this repo — email is a separate issue for when credentials exist, and is one
adapter behind that interface. A delivery failure is caught, logged, and the
transition is deliberately **not** recorded, so the next tick retries rather
than marking a breach "already reported" that nobody received.

**`GET /api/ops/status/history` (ABL-288) is the trend half of that page**, and
it is the one ops route that does **not** touch the database. A scheduler
(`startOpsSnapshotScheduler`, `server/src/services/opsSnapshotScheduler.ts:114`)
records a narrow projection of the combined reading — `toOpsSnapshot`
(`server/src/services/opsSnapshot.ts:67`) keeps disk/RSS/uptime/freshness and
drops the stale-country list and per-stream counts — into an append-only JSONL
file every `OPS_SNAPSHOT_INTERVAL_MINUTES` (default 15), kept
`OPS_SNAPSHOT_RETENTION_DAYS` (default 14). **It is a file, not a table**: the
shared SQLite database belongs to `energy-data-gathering` and adding a table to
it is out of bounds, and the deployed Windows acceptance host cannot open a WAL
connection on its bind-mounted filesystem at all, while a plain append to that
same mount works. The default path sits next to the database
(`resolveSnapshotConfig`, `server/src/services/opsSnapshotStore.ts:68`) — so
**deploying this makes a new `ops-status-snapshots.jsonl` appear in `/data`**,
alongside the database, never inside it. Unlike the two DB-writing schedulers
this one is **on by default**: it writes only its own file, and a trend that
needs a deploy-time flag flipped before it starts accumulating is a trend
nobody has when they first need it. `OPS_SNAPSHOT_ENABLED=false` turns capture
off; reads are still served.

The `days` figure is a **projection, not a measurement**, and
`computeDiskHeadroom` (`server/src/lib/diskHeadroom.ts:179`) is written to
refuse far more often than it answers — a least-squares fit of used-percent
against time that returns `days: null` with a machine-readable `reason` for
seven distinct refusals: fewer than four readings, a span under 72 hours, a
flat or falling disk (`not_rising` — not "never", not a huge number), R² under
0.5 (`noisy_fit`), already at the threshold (`already_breached` — the alarm is
the current reading, not a countdown), and a crossing past a year
(`beyond_horizon`, because extrapolating years from days of history is
fabrication with a decimal point on it). It projects off the last **measured**
percent, never the fitted value at that instant. `basis` (readings, span,
slope, R², current percent) is returned even for the refusals, and the page
renders it, so a projection built on 42 readings with R²=0.97 and a refusal
built on three readings are told apart by the reader rather than trusted.

**The span bar is 72 hours because prod's disk is a sawtooth, not a ramp
(ABL-459).** It was 12 hours, and on 2026-08-14 that rendered a ~170-day runway
as **46.1 days with `reason: "ok"` and R²=0.88 beside it** — the page fabricating
an emergency from a disk sitting at 49.3%. Decomposed, the 39.5h window is a flat
**1.96 GiB/day** baseline plus nine step events, and the steps are infrastructure
rather than growth. Attribution is confirmed **byte-exactly, not inferred**: prod's
`ops_backup_cron.log` reads `2026-08-13 00:01:32 UTC wrote … 4.156 GiB` and
`2026-08-14 00:01:18 UTC … 4.196 GiB`, matching the `+4.156` and `+4.196` steps in
the snapshot series; the `+4.2` then `-4.2` pairs ~30 min later at 05:07 and 14:37
UTC are the ABL-220 sync staging (07:00/16:30 Europe/Brussels — the box is CEST).

A least-squares line over less than a couple of cycles of a 24h period is
dominated by the phase it opens and closes on. Sweeping the start phase over a
series rebuilt from those measured components, worst-case slope error was **+156%
at 12h, +66% at 24h, +13% at 48h, +8% at 72h, +1% at 168h** — 72h (three cycles)
is the first bar sound both while backups are pruned and while they accumulate.

Two things this cost, worth not re-learning:

- **R² cannot catch it, so do not reach for `noisy_fit`.** A daily staircase is
  locally very well fitted by a rising line; at a 12h span R² ranged 0.00-0.99
  while the error reached 156%. R² measures how well a line fits, never whether a
  line is the right model. Span is the guard that works.
- **A step-detection refusal was tried and rejected on measurement.** In the
  pruned regime a *healthy* 72h window carries a larger single-step share
  (0.67-0.82) than the misleading window did (0.46), because the sync pairs are
  ±4.2 GiB against a small net. It does not separate the two cases, and a
  threshold catching the bad one would refuse healthy windows permanently.

`basis.minSpanHours` carries the bar on the wire so `describeHeadroom` can say how
far short a refusal falls without keeping its own copy — the ABL-292 rule, whose
failure mode here is a sentence confidently naming a threshold the server stopped
using.

**Related operational fact, not a projection bug:** the ABL-252 backups are
**not yet net-zero**. Retention is daily×14 + weekly×8 and the log still reads
`retained 3 of 3` — nothing has been pruned, so the directory is genuinely
filling toward a bounded ~99 GiB steady state (~13 GiB on 2026-08-14). Until it
saturates, disk growth is legitimately non-linear, which is a second reason a
straight line is the wrong model right now.

`DISK_THRESHOLD_PERCENT` (`server/src/lib/diskHeadroom.ts:86`) is not a number
of its own — it is `DISK_ERROR_RATIO * 100`, imported from the single
thresholds module above. The countdown and the badge cannot drift because
there is only one constant to change; were it mirrored, the page would say a
disk is fine and that it crosses "full" tomorrow.

Every one of those refusals is a *sentence*, not a blank cell: `describeHeadroom`
(`client/src/lib/opsHistorySeries.ts:74`) maps all eight reasons to prose, and
`describeStorage` (`:133`) separates "capture is switched off" from "nothing
captured yet" from "the store could not be read" — three states that all render
as an empty chart and have three different fixes. A side that was unreachable,
or reported no disk, is a **hole in the line, never a zero**: `diskSeries`
(`:39`) emits `null` and the chart splits its stroke with `drawableRuns`, the
same rule the forecast lines follow. `hours` is clamped to what is actually
retained and the served window echoed back as `windowHours`, so a client asking
for 90 days of a 14-day file is told it got 14 rather than handed 14 days
labelled 90.

### 7c. Visitor counters — how many people actually use this?

**`visitors` on `/api/ops/status` (ABL-289) counts requests, in four lanes, in
memory, and never claims to be more than that.** The scope is "how many people
use this once it is published", and the trap is that both environments already
sit under constant self-inflicted traffic: the docker healthcheck, the peer
poll `peerOpsStatus.ts` fires at the *other* side every time somebody has
`/ops-status` open, and this page's own 30s refetch. A plain request count
reads in the thousands on a box nobody visited — the confidently-wrong-number
failure mode, applied to a vanity metric.

So `lib/classifyRequest.ts` (pure, table-tested) puts every request in exactly
one lane before it is counted, and `middleware/requestCounter.ts`
(`server/src/app.ts`, mounted after CORS and ahead of both the API router and
the static mount, so it sees SPA document loads and assets too) records it:

- `page` — an SPA document load. `index.html` is served `no-store`, so this is
  one per visit or hard refresh, and it is the closest measurable proxy for
  "somebody opened the dashboard".
- `api` — a data call made for a visitor.
- `asset` — hashed JS/CSS, fonts, images. Separate because one page load fans
  out into a dozen; folded into `page` they would multiply the headline figure
  by a cache-dependent factor.
- `automated` — `/api/health`, `/api/ops/*`, every non-GET/HEAD method (the
  only writes here are the token-gated heliocast and net-position ingests), and
  recognised bot/CLI user agents. **A request with no `User-Agent` counts as
  automated**: every mainstream browser sends one, and guessing "visitor"
  inflates in the direction that flatters.

Three constraints shape the storage, and all three are visible in the payload:

1. **It is in-memory, per process.** The energy DB is opened readonly and is
   `energy-data-gathering`'s to shape, so a counter table there is a schema
   change this repo may not make, and a counter file in the mounted `/data`
   volume is the same trespass by another route. A restart therefore zeroes it.
   That is survivable *only* because `countingSince`, `windowDaysCovered` and
   `windowComplete` ride along and the page renders them: `buildTrafficBlock`
   (`client/src/lib/opsTrafficRows.ts`) prints "12 so far", never "12 in 7d",
   until the process has actually observed seven days.
2. **Buckets are UTC days**, not local, so they do not shift under DST or under
   which box is reporting.
3. **`distinctClientsToday` is an estimate and is named like one.** It counts
   distinct `sha256(per-process salt, ip, user-agent)` — one household behind
   NAT reads as one, one person on two devices reads as two. The salt is random
   per process and never persisted, so nothing here survives a restart or reads
   back into an address. Past `DISTINCT_CLIENT_CAP` (20,000/day) it reports
   `null`, not the cap: a counter frozen at its ceiling while traffic keeps
   arriving is a wrong number, and unknown is the honest one.

The field is **optional on the client type** (`client/src/types/index.ts`) on
purpose. The peer half of `/api/ops/status/combined` is whatever build is
deployed on the other box, and every build before ABL-289 answers with no
`visitors` key; `buildTrafficBlock` returns `null` for that and the card says
"not reported by this build" rather than rendering the absence as zeros — which
would be a confident claim that nobody visited prod.
