# Country page as a scrolling annotated document — design

Status: approved in brainstorming, not yet implemented.
Scope: `CountryDashboardView` only. This is the reference implementation for a
wider redesign; map and comparison views follow only if this survives contact
with real data.

## Goal

Replace the country view's flat seven-tab row with a single scrolling document
of numbered, captioned figures, in which forecast accuracy is a property of
every figure rather than a destination you navigate to.

## Why this needs a design at all

Three structural problems, all in this one view:

1. **`analytics` is a tab with no tab.** `CountryDashboardView.tsx` renders six
   `TabsTrigger` elements and seven `TabsContent`. The seventh — Forecast
   accuracy — has no trigger. It is reachable only via
   `goToCountry(code, 'analytics')` from `ComparisonHeatmap`,
   `ComparisonLeaderboard`, `ComparisonMap` and `CountryRanking`. A user who
   arrives from the map cannot discover that per-country accuracy exists.
2. **The tab row mixes three kinds of thing** as if they were peers: market
   outcomes (Price, Net position), physical quantities (Load, Generation, Wind
   onshore, Wind offshore) and evaluation (Forecast accuracy).
3. **Trust signals are off the page.** Freshness lives behind a header pill;
   ops status sits at an unlinked `/ops-status`. For a forecasting product,
   "is this current, and how good has it been" should be visible on the figure.

## Verified facts this design rests on

Each was checked against the source or the database, not assumed.

- **`getComparisonSummary` is keyed by exactly the right types.**
  `services/forecastComparisonService.ts:129` iterates
  `['load', 'price', 'solar', 'wind_onshore', 'wind_offshore']` and returns a
  record keyed by them. One request can serve every figure's badge.
- **…but it returns MAPE, which is unusable here.**
  `services/wape.ts` documents why: MAPE divides each point by its own actual,
  so a series that goes to zero nightly explodes. Its header records BE solar
  at **58,186% MAPE against 62.37% WAPE** (ABL-19), and ABL-388 consolidated
  the measure into that one file precisely so two endpoints' "WAPE" could not
  come to mean different things. A badge fed by the current summary endpoint
  would print a garbage number for solar on day one.
- **WAPE per country × forecast type already exists in SQL.**
  `services/crossCountryMetricsService.ts:146` computes it and re-exports from
  `wape.js`. The country page needs that reduction projected to one country.
- **Four forecast types cover three of the five figures.** Types exist for
  load, price, wind onshore and wind offshore — and the two wind types share
  a single figure. So figures 1, 2 and 4 can carry a residual strip; figure 3
  (generation mix) has a forecast only for its solar component, and figure 5
  (net position) has none at all.
- **Withholding is a third state, distinct from "not measurable".** The
  divergent-basis rule (`services/loadForecastBasis.ts`) withholds every error
  measure *and the forecast line itself* for a country whose realized load and
  load forecast are published on different bases — NL, where the forecast is
  gross of behind-the-meter solar and the actuals are net. The difference is
  definitional, not forecast error. Every surface must route through that
  module.
- **The API serialises requests.** `client/src/App.tsx` states the API is
  "single-threaded and synchronous; a slow query blocks every other request",
  which is why `shouldRetryQuery` caps retries at one. Today exactly one tab
  body is mounted at a time; five figures on one page changes that.
- **The current generation palette fails three of six colour checks.**
  `GENERATION_GROUP_COLORS` (`components/dashboard/generationSeries.ts:84`),
  run through the dataviz validator on all pairs: nuclear `#C2665A` ↔ biomass
  `#73A35F` is ΔE **4.3** under deuteranopia; biomass ↔ hydro `#2FA39C` is ΔE
  **9.3** for *normal* vision (floor is 15); `#6B6459`, `#A98F5D` and
  `#B7AFA0` fall under the chroma floor and read as gray.
- **Belgian data has real holes that the current charts would paper over.**
  For 2026-08-28, `energy_generation.nuclear_mw` is NULL for all 24 hours and
  `solar_mw` is NULL for 9. Published generation averages 4,262 MW against a
  mean load of 9,372 MW — less than half of supply is in the feed.

## Decisions taken

| Decision | Choice |
|---|---|
| Front door | The map stays. This view is the drill-down. |
| Structure | One scrolling annotated document; the tab row is deleted. |
| Aesthetic | Modern scientific (Observable / Datawrapper). |
| Accuracy treatment | Caption badge wherever a forecast exists; residual strip additionally on figures 1, 2 and 4. Figures 3 and 5 state the absence instead. |
| WAPE source | Extend `/forecast-comparison/:cc/summary` to reduce through `services/wape.ts`. |
| Landing strategy | Prove it on this one view before touching map or comparison. |

## Architecture

### Page structure

```
header (unchanged AbleHeader)
breadcrumb            Map / Belgium
title block           country name, code, one-sentence framing, provenance
control bar           one global window control + forecast selector
summary strip         four computed figures
figure 1  Load        actual vs day-ahead        badge + residual strip
figure 2  Price       day-ahead clearing         badge + residual strip
figure 3  Generation  stacked mix, gaps hatched  solar-only badge
figure 4  Wind        onshore / offshore         badge + residual strip
figure 5  Net position                           no badge; provenance only
footer                per-figure API endpoint
```

### Figure anatomy

A `<Figure>` primitive, used five times:

- `number` — figures are cited by number in captions and links
- `title` — serif, sentence case
- `caption` — one or two sentences saying what the figure shows and why it is
  here; not a restatement of the title
- plot slot — an existing `Able*` chart component, restyled
- `<FigureFootnote>` — `<AccuracyBadge>` plus provenance, and a stated absence
  where data is missing

`<AccuracyBadge>` has **three** states, and conflating any two is a defect:

1. **Measured** — a WAPE with its denominator. It must never render a number
   without one: a WAPE over four points is not a measurement, and
   `CountryRanking` already draws this distinction.
2. **Not measurable** — `wape` is null for this window (no actual of positive
   magnitude). A neutral chip, never a zero.
3. **Withheld** — the country's forecast and actuals are on divergent bases,
   so no error measure is meaningful. The badge says so in those terms, and
   **the figure draws no forecast line at all**. This is not a degraded case
   of (2): an analyst reading "not measurable" for NL would conclude the data
   was thin, when in fact the comparison is invalid by definition.

The badge derives all three from `services/loadForecastBasis.ts`; it must not
re-derive withholding from a threshold or a country list.

Not every figure can carry an accuracy claim, and the design does not fake
one. Figure 3's badge reports the **solar component only** and says so on its
face; figure 5 carries no badge, and its footnote states that no forecast is
published for net position. An honest absence is the point of the treatment —
a badge that appears everywhere by inventing a denominator would be worse than
the orphaned tab this design replaces.

`<ResidualStrip>` is a short second axis beneath the plot showing
`actual − forecast` per interval, signed. Rendered only where a forecast type
exists.

### What is deleted

- The `TabsList` / `TabsContent` pair and `activeChartTab` from the store.
- `ForecastTab` — its content becomes the per-figure badges. This is the
  substance of the change, not a side effect.
- The `analytics` banner block in `CountryDashboardView.tsx:142`.

Callers of `goToCountry(code, 'analytics')` land on the country page scrolled
to the figure matching the forecast type they clicked. Scroll-to-anchor only;
no URL change (routing was explicitly deprioritised).

## Visual system

Grounded in the existing tokens, cooled for the scientific direction. The teal
accent is kept — it is the one distinctive brand element.

- Surface `#FCFCFB`, panel `#FFFFFF`, rule `#E7E7E4`
- Ink `#101010`, dim `#4C4C50`, muted `#75757A`
- Accent `#1F6B5C` (unchanged `--primary`), soft `#E3EFEB`
- Figure titles and captions: Source Serif 4, fallback Georgia
- Labels and UI: existing sans stack
- All numerals: JetBrains Mono, tabular figures (the existing `.font-mono-num`)

The seven-step type scale in `tailwind.config.js` is kept as-is. It was a
considered replacement for twelve ad-hoc sizes and nothing here improves on it.

### Series colour

Categorical slots use Okabe-Ito, which passes the validator on **all** pairs:

| Slot | Hex |
|---|---|
| Solar | `#E69F00` |
| Wind | `#56B4E9` |
| Gas | `#D55E00` |
| Biomass | `#009E73` |
| Nuclear | `#CC79A7` |

`Other` is a reserved neutral outside the categorical set, not a sixth
category. The palette's one remaining warning — contrast below 3:1 for the
lighter slots — is dischargeable only by visible labels, so **series are
labelled at the line end and there is no legend box**. The accessibility
constraint and the aesthetic agree here; they must not drift apart later.

## Data flow

One additional request per country page:

```
GET /api/forecast-comparison/:countryCode/summary?start=&end=
  -> { load, price, solar, wind_onshore, wind_offshore }
     each carrying wape, dataPoints, window
```

**Server change:** `getComparisonSummary` must reduce through
`services/wape.ts` and return `wape` alongside the existing `mape`. Adding a
field is backward compatible; no existing consumer breaks. Doing it here rather
than in a new route also removes the MAPE trap for the next caller.

Every other series keeps its current endpoint unchanged.

## Performance

The failure mode this design most plausibly introduces. Today one tab body is
mounted; tomorrow five figures want data from a server that serialises.

- Each figure body mounts on `IntersectionObserver`, not on page load.
- Skeletons are rendered at the figure's final height so mounting does not
  shift scroll position.
- Requests stagger rather than fan out; only figure 1 fetches eagerly.
- `staleTime` and the one-retry cap in `App.tsx` are kept exactly as they are.

Accept as a gate: **first meaningful paint must not regress against the current
tab view.** If it does, the design is wrong, not the budget.

## Edge cases

- **NULL is never zero.** Lines segment across missing intervals; stacked bands
  do not interpolate; unpublished spans are hatched and named in the footnote.
  Figure 3 states "nuclear absent for all 24 hours; solar unpublished for 9".
- **No denominator, no number.** A null WAPE, or one over too few points,
  renders as "not measurable in this window", never as a figure.
- **Coverage is stated, not implied.** A share-of-generation statistic computed
  over a feed missing half of supply is misleading; the summary strip reports
  reported-generation-as-share-of-load instead.
- **NL is the first country this design breaks on.** Belgium is the reference
  implementation and has no divergent-basis problem, so the withheld path will
  not be exercised by the proof. It must be built and tested anyway, against
  NL, before the design is extended past one country.
- **Per-figure error boundary.** One failed series degrades its own figure and
  leaves the rest of the document readable.

## Testing

- `wape.ts` stays the only definition; a test asserts the summary endpoint's
  `wape` equals `crossCountryMetricsService`'s for the same country and window.
- Badge rendering: null WAPE, low `dataPoints`, and a normal value.
- Gap segmentation: a series with interior NULLs produces multiple line
  segments and no interpolated span. This is the rule most likely to regress.
- Store migration: `migrate.ts` must map any persisted `activeChartTab` to a
  figure anchor. Note `VALID_CHART_TABS` (`store/migrate.ts:42`) currently omits
  `wind-onshore` and `wind-offshore` despite both being live triggers — a
  pre-existing bug that this migration supersedes.
- Visual: figure 3 renders hatching for the nine unpublished solar hours on
  2026-08-28.

## Build order

1. Server: `wape` on the summary endpoint, with the equality test.
2. `<Figure>`, `<AccuracyBadge>`, `<ResidualStrip>` primitives, tested in
   isolation.
3. Figure 1 (Load) end to end, including the residual strip — the hardest case.
4. Remaining four figures.
5. Delete the tab row, `ForecastTab`, and `activeChartTab`; add the migration.
6. Intersection mounting and the paint-time measurement.

Steps 1–3 are the proof. If figure 1 does not hold up at real density, stop.

## Non-goals

- URL routing and deep links. Deprioritised deliberately; scroll anchors only.
- Map view, comparison view, ops status.
- Dark mode. The existing tokens are coarse defaults and are out of scope here.
- Changing which data is collected, or any ingest behaviour.

## Open risks

- **Density is unproven.** Five figures at 96 points each on one page has not
  been rendered against real data at laptop width. This is the single reason
  the work is scoped to one view.
- **Scroll versus tabs is a real trade.** Tabs let a user park on one series;
  a document makes them scroll past four to reach the fifth. Mitigated by
  anchors from the summary strip, but not eliminated.
- **`getComparisonSummary` swallows failures.** Its loop catches and skips
  types with no data (`forecastComparisonService.ts:135`), so a badge may be
  absent for reasons other than "no forecast exists". The absent and the failed
  cases need distinguishing before the badge can claim anything.
