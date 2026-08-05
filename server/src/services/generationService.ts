import type { Database as DatabaseType } from 'better-sqlite3';
import defaultDb from '../config/database.js';
import { GenerationMix } from '../types/index.js';
import { timestampRange, rangeClause, rangeArgs } from '../utils/timestamp.js';

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

// `renewable_percentage` is attached to GenerationMix after the SQL row comes
// back (see getGenerationMix) - GENERATION_MIX_SQL itself never selects it,
// so the raw row shape omits it.
type GenerationMixRow = Omit<GenerationMix, 'renewable_percentage'> & { row_count: number };

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
 * this country has no energy_generation rows in the window at all (still
 * mid-backfill; see the A75 plan) or when the window's total positive
 * generation is zero/negative (a share of nothing is not 0%, it is
 * undefined).
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
