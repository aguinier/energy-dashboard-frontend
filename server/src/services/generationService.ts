import type { Database as DatabaseType } from 'better-sqlite3';
import defaultDb from '../config/database.js';
import { GenerationMix, GenerationSeriesPoint, WindGenerationSeriesPoint, Granularity } from '../types/index.js';
import { timestampRange, rangeClause, rangeArgs } from '../utils/timestamp.js';
import { getSolarCoverage } from './solarCoverage.js';

/**
 * SQL for getGenerationMix, exported so tests can assert on the exact text
 * the prepared statement runs (mirrors RENEWABLE_PERCENTAGE_SQL's convention
 * in renewableService.ts) and pass their own in-memory database.
 *
 * Filters directly on `country_code`/`timestamp_utc` - no date()/strftime()
 * wrapper - so the (country_code, timestamp_utc) index on energy_generation
 * stays seekable. Wrapping the joined/filtered column in a function is the
 * exact mistake that cost 51s per 30-day query in renewableService until it
 * was fixed (see RENEWABLE_PERCENTAGE_SQL there); grouping by date()/
 * strftime() is fine, this query just never needs to.
 *
 * No `COALESCE(x, 0)` anywhere. `AVG()` already skips NULL rows and returns
 * NULL when every row in the window is NULL for a column - exactly what "this
 * country does not report this production type" must read as on the wire,
 * never a fabricated 0. `row_count` is the one exception: it is used only to
 * tell "no rows matched the window at all" (mix should be null) apart from
 * "rows matched, but this particular column happens to be null throughout"
 * (that column should be null, the rest of the mix should not be).
 */
export const GENERATION_MIX_SQL = `
    SELECT
      COUNT(*) as row_count,
      ROUND(AVG(solar_mw), 2) as solar,
      ROUND(AVG(wind_onshore_mw), 2) as wind_onshore,
      ROUND(AVG(wind_offshore_mw), 2) as wind_offshore,
      ROUND(AVG(hydro_run_mw), 2) as hydro_run,
      ROUND(AVG(hydro_reservoir_mw), 2) as hydro_reservoir,
      ROUND(AVG(hydro_pumped_mw), 2) as hydro_pumped,
      ROUND(AVG(biomass_mw), 2) as biomass,
      ROUND(AVG(geothermal_mw), 2) as geothermal,
      ROUND(AVG(marine_mw), 2) as marine,
      ROUND(AVG(other_renewable_mw), 2) as other_renewable,
      ROUND(AVG(energy_storage_mw), 2) as energy_storage,
      ROUND(AVG(nuclear_mw), 2) as nuclear,
      ROUND(AVG(fossil_gas_mw), 2) as fossil_gas,
      ROUND(AVG(fossil_hard_coal_mw), 2) as fossil_hard_coal,
      ROUND(AVG(fossil_brown_coal_mw), 2) as fossil_brown_coal,
      ROUND(AVG(fossil_oil_mw), 2) as fossil_oil,
      ROUND(AVG(fossil_oil_shale_mw), 2) as fossil_oil_shale,
      ROUND(AVG(fossil_peat_mw), 2) as fossil_peat,
      ROUND(AVG(fossil_coal_derived_gas_mw), 2) as fossil_coal_derived_gas,
      ROUND(AVG(waste_mw), 2) as waste,
      ROUND(AVG(other_mw), 2) as other
    FROM energy_generation
    WHERE country_code = ?
      AND ${rangeClause('timestamp_utc')}
  `;

// `renewable_percentage` and `solar_coverage` are attached to GenerationMix
// after the SQL row comes back (see getGenerationMix) - GENERATION_MIX_SQL
// itself never selects either, so the raw row shape omits them.
type GenerationMixRow = Omit<GenerationMix, 'renewable_percentage' | 'solar_coverage'> & {
  row_count: number;
};

/**
 * Window-average generation by production type, straight from the complete
 * A75 document (`energy_generation`) rather than the renewable-only
 * narrowing in `energy_renewable`. Returns null only when no rows fall in
 * the window at all; otherwise every field is independently either a real
 * average or null (type not reported by this country) - see GENERATION_MIX_SQL.
 */
export function getGenerationMix(
  countryCode: string,
  start: string,
  end: string,
  db: DatabaseType = defaultDb
): GenerationMix | null {
  const upperCode = countryCode.toUpperCase();
  const range = timestampRange(start, end);

  const stmt = db.prepare(GENERATION_MIX_SQL);
  const row = stmt.get(upperCode, ...rangeArgs(range)) as GenerationMixRow | undefined;

  if (!row || row.row_count === 0) {
    return null;
  }

  const { row_count: _row_count, ...mix } = row;
  // Same table, same country, same window, computed by the one function every
  // other consumer of "renewable share" also calls (getDashboardOverview's
  // header stat, the map's renewable_pct choropleth, /renewables/mix and
  // /renewables/percentage) - see getRenewableShare. The Generation tab's
  // donut reads this field instead of re-deriving a percentage from `mix`
  // itself, so it cannot drift from what the header shows.
  return {
    ...mix,
    renewable_percentage: getRenewableShare(upperCode, start, end, db),
    // Attached here rather than fetched separately by the client (ABL-325) so
    // the caveat and the number it qualifies arrive in one payload and cannot
    // be rendered apart - the same reason `renewable_percentage` is computed
    // server-side above. A `solar` field that reaches the Generation tab
    // without its coverage verdict beside it is precisely the wrong-number-
    // under-a-plausible-label failure this is here to close.
    //
    // Deliberately NOT scoped to `start`/`end`: coverage is a property of the
    // series, not of the window on screen. See COVERAGE_REFERENCE_DAYS.
    solar_coverage: getSolarCoverage(upperCode, db),
  };
}

/**
 * The single definition of "renewable" and "total generation" behind the
 * renewable-share figure, shared verbatim by the per-country query
 * (RENEWABLE_SHARE_SQL, below) and the per-country-map query
 * (dashboardService.getMapData's 'renewable_pct' branch) so the two can never
 * define either term differently - that split-brain (header divided by load,
 * donut divided by generation; one a mean of hourly ratios, the other a ratio
 * of sums) is exactly the bug this module exists to close.
 *
 * Renewable = solar, onshore/offshore wind, run-of-river and reservoir hydro,
 * biomass, geothermal, marine, and ENTSO-E's "other renewable" bucket - every
 * `*_renewable_mw`/generation column the A75 document reports except the two
 * excluded below. Summed with COALESCE-to-0 (not clamped): none of these nine
 * types are expected to go negative, and a country that simply does not
 * report one (null) must contribute nothing to the sum rather than poison it.
 *
 * `hydro_pumped` and `energy_storage` are deliberately excluded from the
 * renewable set - they are stores, not primary generation. Net pumping is
 * routinely negative (charging), and even when positive (discharging) it is
 * energy that was generated - and counted - elsewhere already; counting it
 * again as "renewable output" would double-count it.
 */
export const RENEWABLE_MW_SUM = `(
        COALESCE(solar_mw, 0) + COALESCE(wind_onshore_mw, 0) + COALESCE(wind_offshore_mw, 0) +
        COALESCE(hydro_run_mw, 0) + COALESCE(hydro_reservoir_mw, 0) + COALESCE(biomass_mw, 0) +
        COALESCE(geothermal_mw, 0) + COALESCE(marine_mw, 0) + COALESCE(other_renewable_mw, 0)
      )`;

/**
 * Total generation, positive contributions only - the denominator matches the
 * Generation tab donut's existing concept of "total measured generation"
 * (buildSourceRows.ts, client-side): a negative reading is a draw (pumped
 * storage charging, a stray consumption-only fossil row), not production, and
 * must not shrink the base every other type is measured against.
 *
 * This clamps each of the 21 A75 columns to >=0 individually, per row, then
 * sums across both columns and rows - a direct SQL "ratio of window sums"
 * (energy-weighted: every 15-minute reading counts once, in proportion to its
 * own duration, rather than treating every row as equally representative the
 * way an unweighted mean-of-ratios would). This is *not* bit-for-bit the same
 * number the donut's own JS previously produced client-side (which clamped
 * each of 9 *grouped* rows at its *window-average* level, e.g. netting
 * fossil_hard_coal's occasional small negative against fossil_gas within one
 * "Fossil" bucket before clamping the bucket). The two agree whenever a
 * column's sign is stable across the window - true for nearly all countries
 * and windows - and diverge only for a column that flips sign inside the
 * window (pumped storage charging then discharging), where per-row-per-column
 * clamping is the more defensible reading of "total positive generation":
 * it counts every generated MWh once and discards only genuine draws, rather
 * than letting a draw net against unrelated production in the same bucket.
 *
 * Includes hydro_pumped and energy_storage (when positive - a battery or
 * reservoir discharging is real output) even though both are excluded from
 * the renewable numerator above; also includes nuclear, every fossil type,
 * waste and ENTSO-E's "other" - everything GENERATION_MIX_SQL carries.
 */
export const TOTAL_POSITIVE_MW_SUM = `(
        MAX(COALESCE(solar_mw, 0), 0) + MAX(COALESCE(wind_onshore_mw, 0), 0) +
        MAX(COALESCE(wind_offshore_mw, 0), 0) + MAX(COALESCE(hydro_run_mw, 0), 0) +
        MAX(COALESCE(hydro_reservoir_mw, 0), 0) + MAX(COALESCE(hydro_pumped_mw, 0), 0) +
        MAX(COALESCE(biomass_mw, 0), 0) + MAX(COALESCE(geothermal_mw, 0), 0) +
        MAX(COALESCE(marine_mw, 0), 0) + MAX(COALESCE(other_renewable_mw, 0), 0) +
        MAX(COALESCE(energy_storage_mw, 0), 0) + MAX(COALESCE(nuclear_mw, 0), 0) +
        MAX(COALESCE(fossil_gas_mw, 0), 0) + MAX(COALESCE(fossil_hard_coal_mw, 0), 0) +
        MAX(COALESCE(fossil_brown_coal_mw, 0), 0) + MAX(COALESCE(fossil_oil_mw, 0), 0) +
        MAX(COALESCE(fossil_oil_shale_mw, 0), 0) + MAX(COALESCE(fossil_peat_mw, 0), 0) +
        MAX(COALESCE(fossil_coal_derived_gas_mw, 0), 0) + MAX(COALESCE(waste_mw, 0), 0) +
        MAX(COALESCE(other_mw, 0), 0)
      )`;

/**
 * SQL for getRenewableShare. Filters directly on `country_code`/
 * `timestamp_utc` - same shape as GENERATION_MIX_SQL - so the
 * (country_code, timestamp_utc) index stays seekable; only RENEWABLE_MW_SUM/
 * TOTAL_POSITIVE_MW_SUM (columns that are neither filtered nor joined) are
 * wrapped in COALESCE/MAX.
 *
 * `row_count` distinguishes "no rows in this window at all" (this country
 * has not been backfilled yet, or the window predates its A75 ingest) from
 * "rows exist, but nothing positive was generated" - both end up NULL
 * (NULLIF makes a zero/absent total NULL either way), but row_count lets
 * getRenewableShare short-circuit the former without relying on that.
 */
export const RENEWABLE_SHARE_SQL = `
    SELECT
      COUNT(*) as row_count,
      ROUND(SUM${RENEWABLE_MW_SUM} * 100.0 / NULLIF(SUM${TOTAL_POSITIVE_MW_SUM}, 0), 2) as renewable_pct
    FROM energy_generation
    WHERE country_code = ?
      AND ${rangeClause('timestamp_utc')}
  `;

/**
 * Renewable share of total generation for one country/window - energy_generation
 * ÷ energy_generation, a ratio of window sums (see RENEWABLE_MW_SUM/
 * TOTAL_POSITIVE_MW_SUM). This is the one function behind every "Renewable
 * share" figure in the app: AbleStatRow's header stat card, the Generation
 * tab's donut (via getGenerationMix), the map's renewable_pct choropleth
 * (via the same RENEWABLE_MW_SUM/TOTAL_POSITIVE_MW_SUM fragments,
 * re-embedded in dashboardService's per-country GROUP BY query), and the
 * /renewables/mix and /renewables/percentage routes.
 *
 * Returns null - never 0, never a fallback to some other definition - when
 * this country has no energy_generation rows in the window at all (a window
 * predating its ingest, or a country ENTSO-E does not currently publish -
 * measured 2026-08-04, AL is the only one, with nothing after 2026-06-23) or
 * when the window's total positive generation is zero/negative (a share of
 * nothing is not 0%, it is undefined).
 */
export function getRenewableShare(
  countryCode: string,
  start: string,
  end: string,
  db: DatabaseType = defaultDb
): number | null {
  const upperCode = countryCode.toUpperCase();
  const range = timestampRange(start, end);

  const stmt = db.prepare(RENEWABLE_SHARE_SQL);
  const row = stmt.get(upperCode, ...rangeArgs(range)) as
    | { row_count: number; renewable_pct: number | null }
    | undefined;

  if (!row || row.row_count === 0) return null;
  return row.renewable_pct;
}

/**
 * The 21 A75 `*_mw` columns collapsed into the nine families the Generation
 * tab draws. **This is the same grouping `buildSourceRows` applies
 * client-side** for the donut and the by-source table
 * (`client/src/components/dashboard/sourceRows.ts`) - stated twice because
 * the two live on opposite sides of the wire, and asserted equal by
 * `generationSeries.test.ts` client-side, which walks this list's aliases.
 *
 * Twenty-one stacked areas is unreadable; nine is the same number of legend
 * entries the table underneath already carries, so a viewer reads one legend
 * for both marks rather than two that partition the same 21 columns
 * differently.
 *
 * `hydro_pumped` is its own group rather than folded into `hydro` for the
 * same reason it is its own row: it is a store, not a source, and it is the
 * one group that is routinely negative (see GENERATION_SERIES_SQL).
 */
export const GENERATION_GROUPS: Record<string, readonly string[]> = {
  nuclear: ['nuclear_mw'],
  solar: ['solar_mw'],
  wind: ['wind_onshore_mw', 'wind_offshore_mw'],
  hydro: ['hydro_run_mw', 'hydro_reservoir_mw'],
  hydro_pumped: ['hydro_pumped_mw'],
  fossil: [
    'fossil_gas_mw', 'fossil_hard_coal_mw', 'fossil_brown_coal_mw', 'fossil_oil_mw',
    'fossil_oil_shale_mw', 'fossil_peat_mw', 'fossil_coal_derived_gas_mw',
  ],
  biomass: ['biomass_mw'],
  waste: ['waste_mw'],
  other: ['geothermal_mw', 'marine_mw', 'other_renewable_mw', 'energy_storage_mw', 'other_mw'],
};

/**
 * One group's SELECT expression.
 *
 * The shape is `sumOrNull` (sourceRows.ts) expressed in SQL, deliberately and
 * exactly: take each member column's own null-skipping `AVG()`, then sum the
 * members that produced one, and return NULL only when *every* member of the
 * group averaged to NULL.
 *
 * Both halves matter, and both are the opposite of the obvious one-liner:
 *
 *  - `AVG(COALESCE(a,0) + COALESCE(b,0))` (what renewableService does over the
 *    frozen table) is wrong here because it charges a bucket for the rows in
 *    which a column is simply absent: a country reporting gas for two of four
 *    hours would read at half its true gas output rather than at its average
 *    over the hours it actually reported.
 *  - `AVG(a + b)` is wrong the other way: SQL's `+` propagates NULL, so one
 *    unreported member (FR's `hydro_reservoir_mw` at 02:00) would null the
 *    whole group for that bucket and delete a real `hydro_run_mw` reading.
 *
 * The COALESCE here therefore never turns "not reported" into a fabricated 0
 * at the group level - the CASE guard in front of it is what decides that -
 * it only lets a reported member stand alone next to an unreported sibling.
 * Over a single bucket spanning the whole window this returns bit-for-bit
 * what `buildSourceRows` computes from `getGenerationMix`, which is the
 * property that keeps the trend chart and the donut from disagreeing.
 */
function groupExpression(alias: string, columns: readonly string[]): string {
  const allNull = columns.map((c) => `AVG(${c}) IS NULL`).join(' AND ');
  const sum = columns.map((c) => `COALESCE(AVG(${c}), 0)`).join(' + ');
  return `CASE WHEN ${allNull} THEN NULL ELSE ROUND(${sum}, 2) END as ${alias}`;
}

/**
 * Bucket key for a granularity. Mirrors renewableService's private clause of
 * the same shape, including the `REPLACE(..., ' ', 'T')` on the hourly branch
 * that hands the client an ISO-separated timestamp.
 *
 * `date()`/`strftime()` appear only in GROUP BY, never in WHERE - grouping
 * through a function is fine, filtering or joining through one is what
 * defeats the (country_code, timestamp_utc) index (see RENEWABLE_SHARE_SQL's
 * note, and the 51s scar in renewableService).
 */
function generationGroupByClause(granularity: Granularity): string {
  switch (granularity) {
    case 'daily':
      return 'date(timestamp_utc)';
    case 'weekly':
      return "strftime('%Y-W%W', timestamp_utc)";
    case 'monthly':
      return "strftime('%Y-%m', timestamp_utc)";
    default:
      return "REPLACE(timestamp_utc, ' ', 'T')";
  }
}

/**
 * SQL for getGenerationSeries at one granularity, exported so tests can assert
 * on the exact text and on the query plan (same convention as
 * GENERATION_MIX_SQL / RENEWABLE_SHARE_SQL).
 *
 * ## Negative values are returned signed, never clamped
 *
 * `hydro_pumped` is negative whenever a country is pumping, and a
 * consumption-only fossil type (FR's `fossil_hard_coal_mw`) is negative
 * outright. This query returns them as measured. Clamping them to 0 here
 * would be the fabrication this dashboard exists to avoid, and netting them
 * into a neighbouring group would hide a real draw inside someone else's
 * production. **How they are drawn** is the client's decision and is
 * documented in `dashboard/generationSeries.ts`, which stacks negative groups
 * downward from the zero baseline rather than up.
 */
export function generationSeriesSql(granularity: Granularity): string {
  const bucket = generationGroupByClause(granularity);
  const groups = Object.entries(GENERATION_GROUPS)
    .map(([alias, columns]) => groupExpression(alias, columns))
    .join(',\n      ');
  return `
    SELECT
      ${bucket} as timestamp,
      ${groups}
    FROM energy_generation
    WHERE country_code = ?
      AND ${rangeClause('timestamp_utc')}
    GROUP BY ${bucket}
    ORDER BY timestamp
  `;
}

/**
 * Generation by source over time, from the full A75 document
 * (`energy_generation`) - the trend counterpart to `getGenerationMix`'s
 * window average, reading the same table through the same grouping so the
 * Generation tab's stacked chart, its donut and its by-source table cannot
 * describe different mixes.
 *
 * Every group is independently either a number (possibly negative, possibly a
 * measured 0.0) or null, meaning "this country reported none of this group's
 * production types in this bucket". Callers must not read a null as a zero;
 * see `groupExpression`.
 *
 * Returns `[]` when no rows fall in the window - the caller's empty state,
 * not a series of zeros.
 */
export function getGenerationSeries(
  countryCode: string,
  start: string,
  end: string,
  granularity: Granularity = 'hourly',
  db: DatabaseType = defaultDb
): GenerationSeriesPoint[] {
  const upperCode = countryCode.toUpperCase();
  const range = timestampRange(start, end);

  const stmt = db.prepare(generationSeriesSql(granularity));
  return stmt.all(upperCode, ...rangeArgs(range)) as GenerationSeriesPoint[];
}

/**
 * SQL for getWindGenerationSeries, exported for the same test-assertion
 * convention as generationSeriesSql/GENERATION_MIX_SQL.
 *
 * A single AVG() per column, not `groupExpression`'s combined-family CASE —
 * there is only ever one member per group here, so AVG()'s own null-skipping
 * (NULL in, NULL out for an all-null bucket) already gives the right answer
 * with no risk of one column's absence deleting the other's reading.
 */
export function windGenerationSeriesSql(granularity: Granularity): string {
  const bucket = generationGroupByClause(granularity);
  return `
    SELECT
      ${bucket} as timestamp,
      ROUND(AVG(wind_onshore_mw), 2) as wind_onshore,
      ROUND(AVG(wind_offshore_mw), 2) as wind_offshore
    FROM energy_generation
    WHERE country_code = ?
      AND ${rangeClause('timestamp_utc')}
    GROUP BY ${bucket}
    ORDER BY timestamp
  `;
}

/**
 * Onshore/offshore wind generation actuals over time, split rather than
 * combined into getGenerationSeries' single `wind` family (ABL-235) — the
 * wind forecast tab needs each type plotted against its own registered
 * forecast models, which the combined figure cannot support. Same source
 * table, same null semantics as getGenerationSeries: a type this country does
 * not report in a bucket is null, never 0.
 */
export function getWindGenerationSeries(
  countryCode: string,
  start: string,
  end: string,
  granularity: Granularity = 'hourly',
  db: DatabaseType = defaultDb
): WindGenerationSeriesPoint[] {
  const upperCode = countryCode.toUpperCase();
  const range = timestampRange(start, end);

  const stmt = db.prepare(windGenerationSeriesSql(granularity));
  return stmt.all(upperCode, ...rangeArgs(range)) as WindGenerationSeriesPoint[];
}
