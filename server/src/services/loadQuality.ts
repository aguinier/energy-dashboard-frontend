/**
 * "This row is not a measurement."
 *
 * A country's total electricity load is never zero. There is no hour in which
 * a national grid draws exactly 0 MW — not overnight, not on a holiday, not
 * during a blackout (a blackout is missing data, and ENTSO-E publishes that as
 * an absent row, not as a zero). So a stored `load_mw` of exactly `0.0` is not
 * a small reading; it is the ingest writing a placeholder where a measurement
 * should be.
 *
 * Measured read-only against the replica on 2026-08-06, over all 2,762,517
 * non-null `energy_load` rows:
 *
 * - **543 rows are exactly `0.0`**, across 11 countries — BA 277, MK 99, ME 73,
 *   ES 46, PL 25, MD 10, RO 5, AL 4, NL 2, RS 1, SI 1.
 * - **0 rows are negative.** Load is a strictly positive quantity, which is
 *   what makes the rule below safe.
 * - It is **ongoing**, not historical: the most recent is SI at
 *   `2026-08-06 00:00`, the day this was measured, and MK at
 *   `2026-08-02 21:00`.
 *
 * They are provably not measurements. MK's three affected days are exactly
 * `0.0` for all 22-24 hours of the day while MK's normal daily peak over the
 * surrounding fortnight is 543-717 MW. A country does not have zero demand for
 * a calendar day.
 *
 * What this was doing on screen, before this guard:
 *
 * - `getLatestLoad` returned the newest row whatever it held, and **both MK and
 *   SI had an impossible zero as their newest row** — so the header stat tile
 *   read a confident `0 MW`.
 * - `getLoadStats` reported `min_load: 0` for MK and SI over a 30-day window.
 * - The window average was dragged down with no sign anything was wrong: MK's
 *   30-day mean read 330.7 MW against a true 378.5 MW, understated by 12.6%.
 *
 * ## Why this is a per-row rule, when net position gets a per-series one
 *
 * `degenerateForecast.ts` judges a net-position series by its *maximum* and
 * withholds the whole thing, and it is emphatic that a per-row `=== 0` filter
 * would be wrong there. Both are right, and the difference is physical rather
 * than stylistic:
 *
 * - A **net position is signed**. A real one crosses zero several times a day,
 *   so a single zero row is ordinary and only the whole series' magnitude
 *   carries information. Dropping rows there would punch holes in genuine
 *   charts and leave a degenerate series looking like a shorter genuine one.
 * - A **load is strictly positive**. A single zero row is already impossible on
 *   its own, so it can be judged alone — and it *must* be, because these zeros
 *   are isolated inside otherwise healthy series (543 bad rows out of 2.76M,
 *   0.02%). Withholding MK's whole series over three bad days would destroy
 *   56,510 good readings to suppress 99 bad ones.
 *
 * So: same goal, opposite granularity, because the underlying quantity has a
 * different sign convention.
 *
 * ## Why exactly zero, and not a magnitude floor
 *
 * There is a grey zone just above zero — 24 rows sit in `0 < load < 10` MW (MK
 * 17, BA 6, ME 1, the smallest being MK at 0.01 MW), and against MK's real
 * 400-1400 MW range those are almost certainly false too.
 *
 * They are deliberately **not** caught here. `0.0` is provably not a
 * measurement and needs no calibration to say so; 0.01 MW merely looks wrong,
 * and every threshold that would catch it is a number nobody has justified
 * against the smallest genuine load in the table. This codebase's recurring
 * defect is the confidently-wrong number, and inventing an uncalibrated cutoff
 * to delete real-looking data is the same mistake pointing the other way. The
 * grey zone is recorded here and filed rather than silently swept up.
 */

/**
 * Is this stored `load_mw` a measurement?
 *
 * `null`/`undefined`/NaN are not measurements either, and answering `false`
 * keeps callers from having to special-case them separately. Negative values
 * are rejected on principle rather than on evidence — none exist today, and if
 * one ever appears it is the same class of ingest artifact as a zero.
 */
export function isMeasuredLoad(value: number | null | undefined): boolean {
  if (value == null || !Number.isFinite(value)) return false;
  return value > 0;
}

/**
 * The same rule as SQL, for the query layer.
 *
 * Takes the column so an aliased join can pass `e.load_mw`, mirroring
 * `rangeClause` in `utils/timestamp.ts`. Kept beside `isMeasuredLoad` rather
 * than inlined at each call site so the two cannot drift: `loadService.ts`
 * alone holds seven `energy_load` query sites, and a literal repeated seven
 * times is a literal that gets fixed six times.
 *
 * That count read "five" here until ABL-262, which is the small version of the
 * same problem — the enumeration in CLAUDE.md was wrong in the same way and at
 * the same time, and a stale count is how `forecastService.ts` stayed off the
 * list of sites anyone thought to check. CLAUDE.md now carries the full table
 * and the grep that reproduces it.
 *
 * `> 0` also excludes SQL `NULL` (a `NULL` comparison is never true), which is
 * the wanted behaviour — an absent reading is not a measurement — and matches
 * `isMeasuredLoad(null) === false`.
 *
 * This is a bare-column comparison on purpose. It stays sargable, so it can be
 * combined with `rangeClause`'s index seek without the plan degrading; see the
 * `date()`/`strftime()` note in CLAUDE.md's Common Issues for the 51-second
 * scar this repo already carries from wrapping an indexed column in a function.
 */
export function measuredLoadClause(column = 'load_mw'): string {
  return `${column} > 0`;
}

/**
 * The same guard for the accuracy joins, which are generic over forecast type.
 *
 * Those queries pull their actuals side from a `Record<forecastType, {table,
 * column}>` map, so the predicate has to be conditional: a `0.0` is impossible
 * for `load` and completely ordinary for `solar` (overnight), `wind_*` (still
 * air) or `price` (a genuine zero-clearing hour). Applying `> 0` across the
 * board would silently delete real measurements and bias every renewable metric
 * upward — the same class of mistake, pointing the other way.
 *
 * Returns an empty string for every other type, so the caller can interpolate
 * it unconditionally.
 *
 * This matters because the false zeros do reach these metrics. Measured on the
 * replica 2026-08-06, joining the 543 impossible rows to the forecast tables:
 * **ES 104 and SI 8** pair with a stored ML `load` forecast, and **MK 72, ES
 * 46, ME 25, PL 25, MD 9, AL 4, NL 2, RS 1, SI 1** pair with a TSO one. Each
 * such pair scores `|forecast - 0|` — a 100% error against a number nobody
 * measured — and SI's (2026-08-06) and MK's (2026-08-02) sit inside the default
 * 30-day window, so they are inflating a displayed MAPE/WAPE today.
 */
export function loadActualGuard(forecastType: string, actualColumn: string): string {
  return forecastType === 'load' ? `AND ${measuredLoadClause(actualColumn)}` : '';
}
