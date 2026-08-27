> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# Timestamp storage: two separators in one column

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
(`mlForecastService.ts:128`, called from both its hourly and aggregated
branches) and `crossCountryMetricsService.ts`'s `metricSelect()`
(`crossCountryMetricsService.ts:121`, covering both the actuals join and the
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
`energy_renewable` 26,694 pairs, **26,400** conflicting, re-measured 2026-08-12
over the whole 829,568-row table, pairing length-19 rows on `(country_code,
instant)` and comparing `total_renewable_mw`). An `IN(...)` join matches
*both* rows whenever both exist, so it would have traded ABL-214's silent-drop
defect for a silent-fan-out one — double-counting that hour, and on a
conflicting pair, handing an accuracy metric the right-looking value and the
wrong one as if they were independent observations. That is exactly the
confidently-wrong-number defect this whole file exists to catch, and it was
not this join's decision to make: settling which of a conflicting pair is
authoritative is a data-provenance judgment, not a read-side accuracy query,
and that is what ABL-215 was for.

**That `energy_renewable` figure read `2,441` here until ABL-329, understating
it by ~10x** — it made a near-universal defect read as a marginal one, and
anyone sizing work against this table from that number would have sized it an
order of magnitude too small. The pair count reproduces to the row (26,694),
which pins the definition exactly; the conflict count does not reproduce at
2,441 under any predicate tried — 24 of them, every `*_mw` column both
differs-at-all and differs-with-both-sides-non-zero, plus rounding, magnitude
and relative-difference variants — so `2,441` measured nothing recoverable
rather than something narrower. The real distribution, 2026-08-12:
`total_renewable_mw` differs on 26,400 pairs, still 26,400 after `ROUND(,2)`,
26,362 by more than 0.5 MW, and 23,237 with both sides non-zero. **Not one of
the 26,400 is a NULL-against-a-value mismatch** — all 26,400 are two non-NULL,
genuinely different numbers, which is what makes the `IN(...)` fan-out an
accuracy defect rather than a coalescing nuisance. BA alone contributes 17,013;
excluding it leaves 9,387 across 28 other countries, so this is not one bad
country either. **The design conclusion is unchanged and strictly better
supported** at a 98.9% conflict rate than at the 9% the old number implied:
still two `LEFT JOIN`s plus `COALESCE`, never one `IN(...)`.

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
`load_mw` updated to the T value. **CH, PL and SI were left open at the time**
— ABL-227's original sample couldn't resolve them (differences were
noise-scale against a further, later ENTSO-E revision neither stored snapshot
captured) — leaving 9,496 conflicting pairs. `energy_price`'s 16,896
conflicting pairs are untouched entirely; ABL-227/ABL-215 scoped to
`energy_load` only, since price's overlap is mostly disjoint coverage rather
than value conflict.

**ABL-255/ABL-257 resolved SI and most of PL on 2026-08-12, on a larger
ENTSO-E sample.** ABL-255 re-adjudicated the 9,496 with more evidence per
country: SI got the same T-row-wins treatment as ABL-215's 8-country group (T
closer in all 13 sampled weeks, 89.3% overall, median relative error T 0.82%
vs space 13.44%), and PL got a mixed verdict — most of it is the identical
int-vs-2dp rounding artifact that defined ABL-215's FI/HU rule, but 69 rows
plus all of CH still showed noise-scale differences against an unsettled
ENTSO-E revision the sample couldn't pin down. ABL-257 executed the resolvable
part on 2026-08-12 (Board `request_confirmation` accepted 07:35:09Z, scoped
fresh rather than reusing ABL-215's approval): **SI 1,857 T-wins + PL 5,760
no-op/format-only = 7,617 rows**, mirroring ABL-215's mechanics exactly —
re-enumerated immediately before writing (zero drift from the plan), losing
rows copied to `energy_load_conflict_backup_abl257` before deletion, in-
transaction verification (byte-identity on every touched row, scope
boundaries untouched, exact row-count delta) before COMMIT, then an
independent post-commit re-check on a separate connection. `energy_load`
dropped from 2,649,706 to **2,642,089** (exactly −7,617); every other table
confirmed byte-for-byte unchanged. SI now carries 3 T-rows (rounding-only,
diff < 1 MW, left untouched — not a genuine conflict) and PL carries 93 (24
zero-fabrication rows out of scope per ABL-210/closed, plus the 69 residual
rows deferred alongside CH).

**CH (1,783: 1,403 genuine + 380 rounding) and PL's 69 residual rows are the
only `energy_load` conflicts still open**, tracked in a follow-up issue
(ABL-258) pending a larger or more recent ENTSO-E sample — the same
unsettled-revision problem ABL-255 could not close for them. The two-LEFT-
JOIN-COALESCE shape below is still load-bearing for CH, PL's 69 residual rows,
and all of `energy_price` — do not simplify it back to a single join on the
theory that this is fully closed.

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
1,860, precisely the still-open conflicts ABL-215 could not resolve at that
point — and gained zero new orphans, since every rewritten row already had no
space-form counterpart to collide with. `energy_load`'s own row count dropped
by exactly 30,066 (the deletes, from 2,679,772 to 2,649,706); nothing else in
the table or the database changed. (That 9,496 was ABL-256's own snapshot, not
the current figure — ABL-257 resolved 7,617 of it the same day; see above.)

`timestampFormOnClause` (`server/src/utils/timestamp.ts:145`) is instead
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

**Closed by ABL-353, and not by the fix this entry used to prescribe.**
`getGenerationForecastAccuracy` had the identical bare-equality defect —
`f.target_timestamp_utc = a.timestamp_utc`, no normalisation on either side —
and unlike the two services above it **was** live, because
`energy_generation_forecast` holds rows back to 2021-01-01, deep inside
`energy_renewable`'s `T`-form window. This entry prescribed the
`timestampFormOnClause`-pair-plus-`COALESCE` treatment for both its branches.
That is **not** what shipped, and the reason is worth keeping: ABL-324
tranche 3 moved the actuals side off `energy_renewable` onto
`energy_generation` (`tsoForecastService.ts:402`, `:431`), which removes the
precondition rather than working around it. Measured 2026-08-13,
`energy_generation` is **0 `T`-form and 0 non-19-length rows out of
3,178,270** and `energy_generation_forecast` is **0 of 3,050,001** — both
sides of the join are space-form by construction, and both tables have **zero**
duplicate `(country_code, instant)` keys, so the join is one-to-at-most-one and
a plain equality is exact. Adding the two-LEFT-JOIN shape would forfeit the
index seek for no rows. The plans are unchanged and both sides still seek
(`SEARCH a USING INDEX idx_generation_country_time`); measured on DE/solar over
30 days, 4.2 ms against the old 6.8 ms.

The single-window figure this entry used to quote (DE/solar 2025-11-15..12-01,
1,057 rows bare vs 2,013 separator-agnostic) understated the problem by
measuring one country in one month. Fleet-wide over full history, the pairs
lost to variant spelling alone were **60,494 solar / 69,056 wind_onshore /
70,408 wind_offshore across 28 countries**. See "Generation forecast accuracy
moved off the frozen table" below for the full accounting, including the larger
defect the move uncovered.

The rule this entry states still stands for every read that *does* touch a
two-form table: never the naive `IN(...)`, for the fan-out reason —
`energy_renewable` alone has **26,400** conflicting `T`/space pairs, 98.9% of
the 26,694 it has.

**`/v1/accuracy` is the third call site, and the first that publishes the
tie-break as a term of a contract** (ABL-373). `readAccuracyPoints`
(`server/src/v1/data/accuracyRepo.ts:259`) uses the same two-LEFT-JOIN-plus-
`COALESCE` shape against `energy_load`, `energy_price` and `energy_generation`,
and every response carries `meta.conflict_convention: "space_preferred"`.

That field is the part worth copying. Which member of a conflicting pair is
authoritative is **ABL-215**, and the parts of it still open — CH's 1,783 pairs
and PL's 69 residual rows in `energy_load`, all 16,896 of `energy_price`'s
overlapping pairs — are exactly the ones a paid accuracy metric would resolve
*silently*, because reducing a window to a number requires picking one. Naming
the convention on the response converts a silent pick into a published one: if
ABL-215 later rules the other way for a zone, the number changes as a
**documented change to a stated convention** that a subscriber can reconcile,
rather than as a correction they discover by finding last quarter's figures no
longer reproduce. An endpoint that has to make an open decision should say which
way it made it.

Dormant against live data today for the same reason the two internal sites are —
`forecasts`' earliest row of any type is 2025-12-26, a month after the actuals
cutover, so no forecast currently pairs with a `T`-form actual. It is shipped
now rather than when it starts to matter, because what makes it start to matter
is a historical backfill or a retrained model's archived vintage, and neither of
those arrives with a reminder to revisit an accuracy join.
`accuracyRepo.test.ts` pins both directions on the production schema: the shape
returns one row for a conflicting pair, and the naive `IN(...)` returns two —
both stored values, offered to the metric as independent observations, with
nothing in the result saying which is wrong.
