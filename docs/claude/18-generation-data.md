> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# Generation data

## Generation data

Two tables, both written from **one** A75 fetch per country per window
(`../energy-data-gathering/src/fetch_renewable.py` →
`ENTSOEClient.query_generation_and_renewable_with_metadata`,
`../energy-data-gathering/src/entsoe_client.py:1187`). Never add a second
request to fill one of them.

- **`energy_generation`** — the whole document. 21 `*_mw` columns, one per
  ENTSO-E production type. Prefer this for anything new.
- **`energy_renewable`** — the older, narrower table: 8 renewable columns, with
  pumped storage folded into `hydro_reservoir_mw`. **Frozen.** The forecast job
  and several backfill scripts read it; the dashboard **has now been moved off
  it entirely** (ABL-324), read site by read site. Tranche 1 moved
  `renewableService`'s four sites (ABL-351), tranche 2 moved
  `dashboardService`'s timeseries leg and `countryService`'s two (ABL-352),
  tranche 3 moved `tsoForecastService`'s two (ABL-353) — see "Generation
  forecast accuracy moved off the frozen table" below, which is where the
  migration stopped being a tidy-up and started removing published wrong
  numbers — and **ABL-399 finished it**, moving the seven sites the first three
  tranches could not see.

  **`server/src` now holds no read of this table.** Verify with the bare table
  name, never with a SQL-keyword grep — see the next paragraph for why:

  ```bash
  grep -rn "energy_renewable" server/src --include=*.ts | grep -v '\.test\.ts'
  ```

  The only hits are prose. `src/test/fixtureDb.ts` still **creates and seeds**
  the table on purpose: its `DEFAULT 0` is the contrast the accuracy tests
  measure against, and deleting it would delete the ability to prove the
  fabricated-actual defect is gone.

  **Why those seven hid from a grep, and the rule it leaves behind.**
  `crossCountryMetricsService`, `mlForecastService` and `forecastService` each
  held their own mapping object keyed by forecast type, carrying the table as a
  *string*, and interpolated it into the SQL at query time — `FROM
  ${mapping.table}`, `LEFT JOIN ${mapping.table}`. No literal ever sat next to a
  SQL keyword, so
  `grep -rn "FROM energy_renewable\|JOIN energy_renewable" server/src` returned
  **zero hits while all seven were live**, and this entry recommended exactly
  that grep — reporting a completed migration that had not happened. A
  table name held in a variable is invisible to the search everyone runs. The
  mapping now lives once, in `server/src/services/actualsSource.ts`
  (`actualsSource.ts:205`), where the table names are literals and
  `actualsSource.test.ts` asserts that none of them is `energy_renewable`.

  Those three were out of the earlier tranches' scope deliberately: they are
  generic over forecast type, so moving them was not a table swap but a
  decision about what `renewable` and `hydro_total` mean on the new table.
  Both reuse `renewableTotal.ts` rather than restating it — `renewable` is a
  null-aware sum over `RENEWABLE_MW_COLUMNS` (it had no counterpart column at
  all; `total_renewable_mw` was a stored computed column), and `hydro_total` is
  `RENEWABLE_COMPONENTS.hydro`, i.e. run-of-river + reservoir and **not**
  pumped storage. See "The ML accuracy path scored forecasts against actuals
  that never happened" below for what that moved and why.

  `energy_renewable` itself remains frozen and is not re-derived: it is built
  from the *pre-netting* flatten specifically so its values are unchanged, and
  deriving it from `energy_generation` would shift `hydro_reservoir_mw`
  (measured 1520 → 1410) because of that folding. With no dashboard reader left
  it is now redundant here, but the forecast job and several backfill scripts
  still read it, so retiring it is its own cross-module migration with its own
  approval.

  **`/v1/accuracy` (ABL-373) keeps its own mapping, deliberately**, and it was
  never an eighth read site — `mlForecastService`'s then-`ACTUAL_DATA_MAPPING`
  was the obvious thing to import when you need "which actual does this
  forecast type score against", and importing it is one line. `accuracyStream`
  (`server/src/v1/data/accuracyRepo.ts:171`) resolves the actuals side through
  `v1/data/series.ts`'s `STREAMS` instead — the same constant
  `/v1/observations` reads — so a public accuracy figure is computed from rows
  the subscriber can fetch and check. `publicAppGraph.test.ts` asserts those
  internal services are unreachable from the public app, so adopting their
  mapping is a failing test rather than a plausible simplification. **That
  separation survives ABL-399**: `services/actualsSource.ts` is the one mapping
  for the internal services, `v1/data/series.ts` is the one for the public
  surface, and neither may import the other.

  ABL-373 excluded `renewable` and `hydro_total` from `/v1/accuracy` on the
  grounds that "their actual has no settled definition on the table we are
  moving to", naming ABL-399 as the issue that would settle it. It now is
  settled — see the two definitions above — so adding those two streams to
  `/v1/accuracy` is available follow-up work, and would restate the same
  decision in that app's own constant rather than share one across the
  boundary.

  **It also stores one instant under several timestamp spellings, which is why
  the read path is leaving it** (ABL-324, CEO-approved 2026-08-12). Measured on
  the replica 2026-08-12: `energy_renewable` holds **26,694 duplicate
  instants**, the overwhelming majority disagreeing on at least one value
  column, against **0 across 3,178,270 rows** in `energy_generation` — which is
  also 100% space-form (zero `T`-separated rows, and zero rows of any length
  other than 19, so none of the trailing-offset rows either). A duplicate
  instant is not cosmetic where a query `AVG()`s over a window: the two
  disagreeing values were averaged into one chart point equal to neither.

  **Three different numbers are in circulation for this census and they are
  all correct — they count different things.** Re-measured 2026-08-13, whole
  table, 829,568 rows (821,822 of length 19 and 7,746 of length 25, the
  trailing-offset rows):

  | figure | definition |
  |---:|---|
  | **26,694** | duplicate instants among **length-19 rows only** — the figure above and in `utils/timestamp.ts`. Every one is a pair, so surplus rows is also 26,694. |
  | **28,987** | duplicate instants over **all** rows, i.e. including the length-25 trailing-offset spelling as a third form. (ABL-352's issue text says 28,982; that is the same measurement a day earlier.) |
  | **34,440** | **surplus rows** over all forms — `rows − distinct instants`, so an instant stored three times contributes 2. This is the one that says how much a `COUNT(*)` overstates. |

  Quote whichever answers the question at hand and say which it is. The
  distribution is not even: **BA alone holds 65,868 rows for 48,766 distinct
  instants** (26% duplicated). `energy_generation`'s control figure is **0
  duplicate instants across 3,178,270 rows** under every one of the three
  definitions.

  Two costs come with each move, both signed off, and both must be surfaced
  rather than absorbed:

  - **Hydro reads lower**, because the two tables split it differently.
    Measured on the replica, FR 2026-08-01..07: `energy_renewable`'s
    `hydro_reservoir_mw` averages **2,014.3 MW** against `energy_generation`'s
    **1,181.7 MW** (run-of-river agrees exactly, 2,326.1 MW on both sides).
    This is a *different* measurement from the 1520 → 1410 figure above, which
    is about re-deriving the frozen table itself.
  - **`energy_generation` does not cover every hour `energy_renewable` does.**
    Measured 2026-08-12, France: `energy_renewable` holds 2,208 rows across all
    23 days of 2026-06-30..2026-07-22 while `energy_generation` holds 135
    across **2** of them — full days on 06-30 and a partial 07-22, and nothing
    at all for **07-01..07-21** (ABL-323, ABL-328). Those 21 days must render
    as a gap, never as zero and never interpolated.

  **`total_renewable_mw` has no counterpart in `energy_generation`** — it was a
  stored computed column — so every move turns a column read into a sum, and a
  sum is where "we do not know" quietly becomes a confident `0`. The reduction
  is stated once, in `server/src/services/renewableTotal.ts` (pure, colocated
  test): NULL when every component is NULL, the sum of the reported ones
  otherwise, and a measured `0.0` is a value rather than a missing reading.
  `generationService.RENEWABLE_MW_SUM` is generated from that module's column
  list, so the renewable breakdown's `total` and the renewable share's
  numerator — served side by side on one `/renewables/mix` object — cannot come
  to define "renewable" differently.

  **The `COALESCE(x, 0)` this removes was live, and Germany was the victim.**
  Measured through a local server on the replica, 2026-08-12:
  `/api/renewables/latest` reported DE with **`total_renewable = 0.0`**, and
  `solar = 0.0`, and `wind_onshore = 0.0`. Germany's newest `energy_generation`
  row (`2026-08-12 13:00:00`) is an all-NULL placeholder at the leading edge of
  ingest — the A75 document for that interval has not been filled in yet — and
  the row before it, at 12:45, carries **55,057.91 MW of solar alone**. The
  frozen table stores that placeholder as literal `0.0` (it carries
  `DEFAULT 0`), and the old query's `COALESCE` could not have told the
  difference anyway. The endpoint now answers `null` for every field and for
  the total: *the newest stored row reports nothing*, which is the true claim.
  Exactly one country was in that state at that moment, but it is the ingest
  edge, so it rotates.

  **`getLatestRenewable`'s all-countries query needs its `CROSS JOIN`.** It is
  an ordinary inner join whose ON clause is unchanged; the keyword only pins
  `countries` (34 rows) as the outer loop. Allowed to reorder, SQLite drives
  from `energy_generation` and runs the correlated `MAX()` subquery per row —
  `SCAN r USING COVERING INDEX` across all 3,178,270 entries. Measured on the
  replica 2026-08-12: **2.819s reordered vs 0.002s pinned**, same 34 rows;
  end to end through the API, 1.97s vs 0.22s. `energy_generation` is roughly
  four times the frozen table's size, so porting that query unchanged would
  have left a live endpoint slower than it was before the move.
  `routes/renewables.test.ts` asserts the plan rather than a duration, since
  on a six-country fixture both shapes are instant.

### Generation forecast accuracy moved off the frozen table (ABL-353)

Tranche 3 of ABL-324. `getGenerationForecastAccuracy`'s two query sites — the
hourly join (`tsoForecastService.ts:402`) and the aggregated branch
(`:388`) — now read `energy_generation`. This is the accuracy-critical tranche,
and the move removed three separate defects; the sample change is large enough
that **any accuracy figure for solar / wind_onshore / wind_offshore recorded
before 2026-08-13 is not comparable with one recorded after**.

All figures measured read-only on the replica 2026-08-13, forecast-anchored
over full history (the forecast side is unchanged, so classifying each forecast
row by what the two actuals tables offer for the same instant isolates the
move).

**1. The frozen table was fabricating the actual, and this is the serious one.**
`energy_renewable` carries `DEFAULT 0` on every `*_mw` column, so a type a
country does not report is stored as a literal `0.0`. `energy_generation` has
no such default and stores NULL. **477,846 pairs existed only because of that
default**, 477,838 of them (99.998%) with the frozen table holding exactly
`0.0`. The proof of the mechanism is in the data: across all three types,
`energy_renewable` holds NULL in **zero** rows the forecast could pair with —
it cannot express "not reported" at all.

It is concentrated in offshore wind, where **436,069 of 661,077 pairs (66%)
were fabricated**, and for **23 countries that report no offshore wind at all —
AL, AT, BA, BG, CH, CY, CZ, EE, FI, GR, HR, HU, IE, LT, LU, LV, ME, MK, RO, RS,
SE, SI, SK — 100% of their pairs were**, so their offshore pair count is now
exactly zero. (PL is *not* one of them, despite looking like one in a 30-day
window: it retains 3,613 pairs over full history. Take that list from the
full-history count, not from a recent window, or a country reads as
never-reporting when it has merely stopped.) A `0.0` fabricated actual against the `0.0`
forecast ENTSO-E publishes for those zones scored zero error at every point, so
`/tso-forecast/accuracy/generation/:cc` reported `mae: 0, rmse: 0` over
thousands of `dataPoints`: a flawless offshore-wind forecast for a landlocked
country, and top of any ranking sorted by error. Those pairs no longer exist,
so the endpoint now answers `dataPoints: 0` and null metrics. Solar had the
same shape at smaller scale (41,012 pairs, 41,011 exactly zero), which is what
takes MK and RS solar to zero pairs — the ABL-35 dead-zero species, correctly
withheld rather than relabelled.

**2. Variant-spelled actuals were silently dropped** — the defect the issue is
named for. 90,636 `energy_renewable` rows are `T`-separated or carry a trailing
offset while `energy_generation_forecast` is 100% space-form, so the string
equality could not match them and the pair left the join with no error and no
empty state. Recovered: **60,494 solar / 69,056 wind_onshore / 70,408
wind_offshore pairs across 28 countries.**

**3. Coverage.** `energy_generation` holds 3,178,270 rows against the frozen
table's 829,568, so pair counts rise roughly fourfold over full history
(solar 663,242 → 2,664,498; wind_onshore 663,242 → 2,929,588; wind_offshore
119,601 → 603,150). Almost all of that is hours `energy_renewable` never held.

**The cost, and it must render as a gap.** `energy_generation` lacks hours the
frozen table has: **FR 2,073 rows over 2026-07-01..07-22 and BA 92 rows** (the
ABL-323/ABL-328 hole). The `INNER JOIN` drops those to absent points, which is
the required behaviour — never a zero, never carried forward, never
interpolated. `routes/tsoForecast.test.ts` pins it on AT, which has real
`energy_renewable` readings and no `energy_generation` rows at all.

**Headline metrics moved, and the movement is the point rather than a
regression.** Because the sample changed in both directions, a MAPE that fell
is not an improved forecast and one that rose is not a degraded one — both are
the same forecast measured over an honest sample. Over 2026-07-14..08-12,
NL wind_offshore MAE goes 1,988.84 → 781, DE solar MAPE 198.02 → 57.39 over
full history, and 23 countries' offshore figures disappear entirely. **Do not
reconcile a stored or screenshotted pre-2026-08-13 figure against a current
one**; re-measure instead.

Two things this tranche deliberately did **not** do. No NULL-aware total is
involved — `solar` / `wind_onshore` / `wind_offshore` are single columns
carrying identical names in both tables, so this is a table swap and
`renewableTotal.ts` has nothing to reduce here; it is not imported rather than
threaded through a one-element sum. And the join stays a plain equality rather
than gaining `timestampFormOnClause` — see the entry under "Timestamp storage"
for the measurement behind that, and for the condition that would reverse it.

Nothing in this client calls `/tso-forecast/accuracy/generation/:cc` (see
"ForecastTab" above), so none of the above was visible in the UI. It is a live
public endpoint, so it was wrong where an API consumer could read it.

Three things to know before touching this:

- **`NULL` ≠ `0`.** A type a country does not report is `NULL` — we do not know.
  A measured zero (solar overnight) is `0.0`. `energy_generation` deliberately
  has **no `DEFAULT 0`**, and the mapping avoids `fillna(0)`. Note
  `groupby().sum()` collapses an all-NaN group to `0.0` unless you pass
  `min_count=1`. **Since ABL-268 that column has a second source of `NULL`** —
  a position the TSO published no `Point` for, blanked at ingest instead of
  being stored as a forward-filled `0.0`. See "More of `energy_generation` is
  about to read NULL" below before reading a new gap as a defect.
- **Values can be negative, legitimately — including solar and wind (ABL-412).**
  ENTSO-E reports `Actual Aggregated` and `Actual Consumption` separately; the
  full mapping nets them (`aggregated - consumption`), so `hydro_pumped_mw` is
  negative while pumping and a consumption-only type (French `Fossil Hard coal`)
  is negative outright. An earlier version skipped every Consumption series,
  which recorded France as a net pumped-storage *generator* at +26 MW while it
  was pumping 285-349 MW.

  **The netting is applied to every production type, not only to the store-like
  ones it was introduced for**
  (`../energy-data-gathering/src/entsoe_client.py:1472`,
  `_net_generation_consumption`). So a type whose
  own auxiliary load is metered reads negative whenever it is not generating,
  and `energy_generation.solar_mw` is a *signed net* quantity, not gross solar
  output. Counted read-only on the replica on 2026-08-13, **seven of the nine
  renewable columns carry negative readings** — `solar_mw` 97,702 rows (3.45%,
  worst -57.36, NL and IT), `biomass_mw` 21,230 (NL), `wind_offshore_mw` 11,325
  (BE, NL, FR), `other_renewable_mw` 9,039 (IT, worst -1,111.0),
  `hydro_reservoir_mw` 2,073 (PT, HU, FR), `hydro_run_mw` 705 (IE),
  `wind_onshore_mw` 491 (FR, worst -1,018.7). Only `geothermal_mw` and
  `marine_mw` are genuinely never negative.

  **NL solar is negative at every single night hour** (-0.11 to -1.52 MW,
  1,390/1,390 fit-window hours in the ABL-396 screen) — the same ABL-325 story
  as the bullet below: its A75 solar is a small grid-metered subset, so that
  subset's metered auxiliary load is a large fraction of it. The values arrive
  non-negative from ENTSO-E; **the sign is ours**, produced by the netting. It
  is therefore not an ingest sign error to repair and not a metering artefact to
  re-fetch — it is a read-side semantics question, and it is answered read-side.
- **A ratio against `TOTAL_POSITIVE_MW_SUM` clamps; a reported MW value does
  not.** `RENEWABLE_MW_SUM` used to sum its nine columns unclamped on the
  premise that "none of these nine types are expected to go negative" — refuted
  by the census above, and refuted when it was written. The numerator let a
  negative reading subtract while the denominator clamped the same column to 0,
  which understated the share (BE 7-day 56.63% -> 56.72%, NL 30-day 21.56% ->
  21.61%, i.e. visibly at the 2dp the wire carries). Both halves now clamp
  per row per column. `/renewables/mix`'s seven fields and its `total`
  deliberately do **not** — they report readings, where a negative net value is
  a true measurement and blanking it would be the fabrication this dashboard
  exists to avoid.
- **DE's overnight solar floor is upstream, and it stopped on 2026-05-31
  22:00Z** (= 2026-06-01 00:00 Europe/Berlin, a clean local-midnight boundary).
  DE reported a flat 3-17 MW baseline at every night hour from 2022-01 to that
  instant, then exact `0.0` from it onward; 2021 is clean too. This is not an
  ingest vintage artefact: `fetched_at` shows the whole 2021-01..2026-06 span
  was written by **one** backfill run on 2026-07-29 15:00-15:29, one chunk per
  month, so the same code produced both the floor and the zeros. Do not "fix"
  it, and do not read a clean recent window as certifying an older one — the
  ABL-396 gate window (2026-07-11 onward) is 0/160 contaminated night hours
  while its fit window is 87.8%.
- **Share of generation, not of load.** `generationService.getRenewableShare` is
  the single definition — renewable output over total *positive* generation, as
  a ratio of window sums. Three separate implementations existed before
  (`renewableService`'s join, plus inline `AVG/AVG` SQL in the header and the
  map), disagreeing with each other. Share-of-load is wrong here: a net
  exporter generates more than it consumes, so single rows read over 100%.
- **"Actual generation" means *metered* generation, and for one country that
  is not the same thing** (ABL-325). A75 reports what the TSO can meter, which
  excludes behind-the-meter distributed generation. For almost everyone that
  gap is negligible; for **NL solar it is the whole story** — the reported
  series peaks at 428.8 MW against a Dutch fleet well over 20 GW, and renders
  as 0.93% of NL's generation mix in high summer. See the next section.

### More of `energy_generation` is about to read NULL (ABL-268)

The A75 ingest ran entsoe-py's sparse-document forward-fill unguarded on every
country every day — the same mechanism ABL-50 fixed for load and ABL-55 for net
position, third occurrence. `query_generation_and_renewable_with_metadata` now
applies `blank_unpublished_zeros_by_series`
(`../energy-data-gathering/src/published_points.py`) to the MultiIndex frame
**before either flatten**, so a position the TSO published no `Point` for is
written as `NULL` rather than as a measured `0.0`.

**It is not deployed, so this describes a change that has not happened yet.**
Checked the way this file insists on rather than inferred from git ancestry: on
prod 2026-08-14, `docker exec energy-data-gathering grep -c
blank_unpublished_zeros_by_series /app/src/published_points.py` returns **0**,
and that container had been up 45 hours, predating the merge. The guard is
**forward-only** — it changes what future passes write and backfills or deletes
nothing, so every row in the table today is unaffected either way.

Scale, measured on the sibling side through the real fetch path for market day
2026-08-12 across 15 zones: **2,357 values blanked, and the only transition
anywhere is `0.0` → `NULL`** — no non-zero value changed, appeared or
disappeared. It is not indiscriminate; SI and DK blanked nothing. Expect
`marine_mw`, `fossil_oil_shale_mw` and `fossil_coal_derived_gas_mw` to go
substantially `NULL`, being 100%, 73.9% and 36.3% exact-`0.0` today.

Three read-side consequences, each checked against this repo rather than
assumed:

- **Renewable share does not move at all.** Both sums clamp through a
  `COALESCE` — `RENEWABLE_MW_SUM` (`generationService.ts:206`) and
  `TOTAL_POSITIVE_MW_SUM` (`generationService.ts:238`) are
  `MAX(COALESCE(col, 0), 0)` per column per row — so a cell contributes exactly
  0 whether it holds `0.0` or `NULL`. With the only transition being
  `0.0` → `NULL`, numerator and denominator are both unchanged. There is
  nothing to re-baseline.
- **No accuracy figure can count a blanked cell as a measured zero.** Every
  path joining a forecast to `energy_generation` already filters the actual:
  `tsoForecastService.ts:409` (hourly) and `tsoForecastService.ts:435`
  (aggregated), `mlForecastService.ts:246` and `mlForecastService.ts:290`,
  `crossCountryMetricsService.ts:170`, and `forecastService.ts:316`. A blanked
  cell becomes an **absent point**, so `dataPoints` shrinks honestly instead of
  overstating a sample whose metrics silently skipped it.
- **The generation mix will show gaps where it used to show zeros, and that is
  the existing rule firing more often rather than a rendering bug.**
  `buildGenerationMixSeries` (`generationSeries.ts:146`) drops a group that is
  null at every point from the series, the legend and the tooltip. The visible
  case is overnight solar: 206 of the blanks fall in UTC hours 20–05, where a
  fill from a genuinely published overnight `0.0` is entirely plausible — and
  is refused anyway, because the document cannot say which case it is.

**`energy_renewable` is deliberately untouched.** `_map_renewable_columns`
`fillna(0)`s what it maps, so a blanked cell reaches the frozen table as the
same `0.0` it held before, pinned byte-identical for all 15 zones by that
repo's `test_energy_renewable_output_is_byte_identical`. The known gap recorded
under `LoadTab` above — that `energy_renewable` has the same signature and is
not guarded — therefore still stands, now by decision rather than by omission.

**Comparability, and it is narrower than ABL-353's or ABL-399's.** Those moved
which table the actual is read from and so changed history; this changes only
what is written from the deploy onward. A generation accuracy figure over a
window straddling that deploy mixes two ingest regimes and should be
re-measured rather than reconciled; one over a window entirely before it is
unaffected.

### The ML accuracy path scored forecasts against actuals that never happened (ABL-399)

The remainder of ABL-324, and the tranche where the frozen table was hurting
the most reader-facing surfaces: `/forecasts/compare`, the ML accuracy
endpoints, and the ComparisonView heatmap, map and leaderboard — plus the D-7
seasonal-naive baseline, so a wrong baseline had been making models look better
or worse than they are.

**One mapping now, not three.** `server/src/services/actualsSource.ts` is the
single forecast-type -> actuals source, replacing a private copy in each of
`forecastService`, `mlForecastService` and `crossCountryMetricsService`. One of
those copies carried a comment promising it was "kept identical to the mapping
every other consumer already uses … so the three cannot drift apart again",
which is a promise a literal cannot keep. `ActualsSource.valueExpr(prefix)`
also removed the per-site `hydro_total` special case each of the three had to
carry, because a two-column expression cannot simply be prefixed with a join
alias.

All figures below measured read-only on the replica 2026-08-13, full history.
Blast radius is **AT, BE, DE and FR** — the only countries with a stored ML
forecast of any renewable-family type.

**1. The frozen table fabricated the actual.** `DEFAULT 0` on every `*_mw`
column means a type a country does not report is stored as a literal `0.0`.
Taking every forecast row paired against such a `0.0` and asking
`energy_generation` what it recorded at the same country and instant:

| type | pairs at `0.0` | genuine `0.0` | **positive** | **negative** | no gen row |
|---|---:|---:|---:|---:|---:|
| `solar` | 44,279 | 38,128 | **5,287** | 0 | 864 |
| `wind_offshore` | 3,895 | 0 | 0 | **3,895** | 0 |
| `wind_onshore` | 8 | 0 | **8** | 0 | 0 |
| `biomass` | 2 | 0 | **2** | 0 | 0 |

**9,192 pairs were scored against a zero that never happened.** Every one of
the 3,895 offshore pairs is wrong and not one agrees: the real measurement is
*negative* — a fleet drawing auxiliary load — which `energy_generation` records
and the frozen table flattens. Reproduced per row on BE `2026-01-14 08:00:00`:
frozen `wind_offshore_mw = 0`, generation **−26.2625 MW**. On the solar side
the real generation reached **+334.72 MW** (DE) against a stored zero.

**The 38,128 genuine overnight zeros are kept.** A solar fleet at 03:00 really
did generate 0 MW. This is why the fix is a table swap and **not** a `> 0`
filter on the actual — that would delete those readings and bias every
renewable accuracy figure upward. `loadQuality.loadActualGuard` still applies
`> 0` to `load` and to nothing else, unchanged.

(Those counts are raw forecast rows. The endpoints deduplicate to
`MAX(generated_at)` per target timestamp first, so the *scored* pairs corrected
are 1,460, against 6,285 genuine zeros preserved and 108 instants with no
`energy_generation` row, which become absent points.)

**2. `hydro_total` was run-of-river plus a store, and is now hydro.** Both
tables carry `hydro_run_mw` and `hydro_reservoir_mw`, which is the trap: the
frozen table folds pumped storage into `hydro_reservoir_mw` while
`energy_generation` splits it into its own `hydro_pumped_mw`. Proven on the BE
instant above — frozen `hydro_reservoir_mw` is `73.31`, *exactly*
`energy_generation.hydro_pumped_mw`, while generation's own
`hydro_reservoir_mw` is NULL. `actualsSource` takes
`RENEWABLE_COMPONENTS.hydro` (run + reservoir, no pumping), the definition
ABL-351 already shipped for `/renewables`, so the two surfaces cannot disagree
about the same country's hydro. **BE's hydro actual falls from ~129 MW mean to
~39 MW**: the old figure was hydro generation plus a store.

**The reduction must be null-aware, and BE is why.** BE reports no reservoir
hydro at all — `hydro_reservoir_mw` is NULL in **all 49,213**
`energy_generation` rows — so a NULL-propagating `a + b` yields NULL for every
Belgian hour and takes BE's `hydro_total` accuracy from 5,121 pairs to **zero**,
discarding real run-of-river readings to express an absence that is a property
of Belgium's fleet rather than of our data. For FR the two rules differ on **2
rows of 90,397**. This reverses a comment `forecastService` used to carry
("deliberately not COALESCE'd to 0 … `NULL + 30` reading as 30 would invent a
measurement"): true of a bare COALESCE, false of the guarded form, which is
NULL when *every* component is NULL and so can never turn an absence into a
measurement.

**3. Headline movements.** WAPE, full history, before -> after:

| type | AT | BE | DE | FR |
|---|---|---|---|---|
| `solar` | 87.58 → 87.37 | 26.18 → 26.20 | 57.78 → 57.91 | 20.29 → 20.82 |
| `wind_onshore` | 76.02 → 75.67 | 121.96 → **137.74** | 66.45 → 66.02 | 78.15 → 77.63 |
| `wind_offshore` | — | 111.68 → 110.39 | — | 69.52 → 70.29 |
| `biomass` | — | 58.83 → **72.01** | — | 6.69 → 6.95 |
| `hydro_total` | — | 79.85 → **626.98** | — | 15.62 → 20.82 |
| `renewable` | 57.52 → 53.35 | 46.61 → 52.82 | 43.77 → 45.68 | 17.33 → 23.16 |

Pair counts move two ways and both are correct. Every country gains ~28 pairs
from hours `energy_generation` holds and the frozen table does not; **FR loses
491** (5,025 → 4,534) to the `energy_generation` coverage hole
(2026-07-01..22, ABL-323/ABL-328), which renders as absent points — never zero,
never interpolated. BE `hydro_total` keeps its pairs (5,121 → 5,149): the
run-of-river actual is still measured, it is simply no longer added to a store.
Its WAPE at 626.98% is the training-target mismatch below, stated loudly rather
than smoothed — per this file's own rule, above ~100% the only honest reading
of a WAPE is "loses to forecasting zero", and BE's `hydro_total` model is
predicting roughly the right number for a quantity we have stopped calling
hydro.

**Known consequence, stated rather than absorbed: the models are trained on the
other table.** The sibling `energy-forecast` job fits these renewable-family
models against `energy_renewable` (`RENEWABLE_TYPE_SOURCE_TABLE`,
`../energy-forecast/src/db.py:392`), so scoring them against `energy_generation`
measures them against a quantity they were not fitted to. That is what moves BE
`biomass` (mean actual 101.03 -> 252.35 MW, MAE roughly doubling) and BE
`wind_onshore`. It is not a regression introduced here — it is the same
disagreement, now visible. The endpoint's job is to compare a forecast of a
country's generation against the best statement we hold of that generation, and
every other surface already reads `energy_generation`; keeping this one path on
the frozen table to preserve a flattering number would be the
confidently-wrong-number defect in its purest form. **Any renewable-family
accuracy figure recorded before 2026-08-13 is not comparable with one recorded
after** — re-measure, do not reconcile.

**Do not file "switch the training table onto `energy_generation`" — that is
ABL-321, and the CEO rejected it on measurement**
(`../energy-forecast/src/db.py:356` states the verdict at the constant itself).
Its before/after backtest **failed** a non-inferiority check on three
already-serving pairs — AT solar 12.89 -> 13.44% WAPE, DE wind_onshore
51.63 -> 53.50, BE wind_onshore 46.56 -> 47.81 — four improvements
notwithstanding. ABL-331 then narrowed that constant to the default for a
training run that names no source, since which table an artifact is *served*
from is recorded in the artifact rather than in the constant, so flipping it now
moves no live forecast (`../energy-forecast/src/db.py:381`). Scoring truth and
training source are independent, and ABL-321's own decision window already used
`energy_generation` as primary truth.

What is genuinely new is **ABL-410**: that repo's forecast-quality scorecard
still scores these types against the frozen table (`ACTUAL_SPECS`,
`../energy-forecast/src/evaluation/scorecard.py:52`), so it and this dashboard
now publish **different WAPEs for the same model** — its figure is the left
column of the table above, ours the right. Do not reconcile them; they measure
against different statements of the actual. `hydro_total` differs there twice
over, because that entry also uses a strict `hydro_run_mw + hydro_reservoir_mw`
against its own training-side target's null-aware form
(`../energy-forecast/src/db.py:406`) — the same rule this dashboard arrived at
independently, which is decent evidence it is the right one.

**Performance is unchanged**, which a 4x larger actuals table does not suggest:
measured warm on the replica, the whole cross-country query is **1,974 ms
before and 1,908 ms after**. (A first pass read 13,568 ms for the "before" arm
and it was a cold-cache artifact — worth naming, because it briefly looked like
a 5.8x speed-up and would have been written down as one. Time both arms warm,
in the same process, or the number measures the page cache.) The
two-LEFT-JOIN `timestampFormOnClause` shape is kept for every
type, including the six now on `energy_generation` where the 'T'-form fallback
join provably matches nothing (0 'T' rows in 3,180,752) — retained so the query
stays correct without a code change if a future ingest ever writes one, which
is the silent-drop trap ABL-353 had to document for its single-join site.

### Solar coverage: when the label cannot stand unqualified

`getGenerationMix` attaches a `solar_coverage` verdict
(`server/src/services/solarCoverage.ts`) to every mix it serves, and the
Generation tab qualifies its Solar band, arc and row from it
(`client/src/components/dashboard/solarCoverageNote.ts`).

The test is **not** installed capacity, which this repo does not hold. It pairs
our actuals against **ENTSO-E's own day-ahead solar forecast for the same
country and hour**, which we already ingest into `energy_generation_forecast`.
If both describe the same fleet their sums agree. Measured on the replica over
2026-05-14..08-12, eighteen countries land between 0.95 and 1.29 (RO is the
widest honest case); **NL sits at 17.0 across 8,693 consecutive hours**, which
no forecast error produces. NL is the only `partial_subset` in Europe.

Three rules this encodes, all of which cost a bug to learn:

- **The ratio is never a correction factor.** The day-ahead forecast is itself
  only what the TSO sees (NL's peaks at 7,871 MW, still far under the fleet),
  so 17.0 is a lower bound on a discrepancy, not a route back to national
  solar. `solarCoverageNote.test.ts` pins that the note never prints one.
- **`unknown` is not `consistent`.** A country with no solar forecast to check
  against (NO's sums to exactly 0.0 MW over 8,691 pairs) must not divide out to
  a comfortable ratio of 0 and be pronounced sound on absent evidence.
- **A dead-zero actual series is a different defect and is deliberately not
  claimed here.** **BA's solar has read exactly 0.0 at every hour since
  2026-04-13 06:00** — four months through the Balkan summer — while ENTSO-E
  forecasts up to 244 MW and BA's wind and hydro report normally. That is a
  feed emitting zeros (the ABL-35 species), not a metered subset; the
  partial-coverage wording would be actively wrong about it, and the remedy is
  to *withhold* the number rather than relabel it. `classifySolarCoverage`
  returns `unknown` for it. Not yet fixed — filed separately.
