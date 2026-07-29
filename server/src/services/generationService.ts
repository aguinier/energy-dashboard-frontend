import type { Database as DatabaseType } from 'better-sqlite3';
import defaultDb from '../config/database.js';
import { GenerationMix } from '../types/index.js';
import { normalizeTimestamp } from '../utils/timestamp.js';

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
      AND timestamp_utc BETWEEN ? AND ?
  `;

type GenerationMixRow = GenerationMix & { row_count: number };

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
  const normalizedStart = normalizeTimestamp(start);
  const normalizedEnd = normalizeTimestamp(end);

  const stmt = db.prepare(GENERATION_MIX_SQL);
  const row = stmt.get(upperCode, normalizedStart, normalizedEnd) as GenerationMixRow | undefined;

  if (!row || row.row_count === 0) {
    return null;
  }

  const { row_count: _row_count, ...mix } = row;
  return mix;
}
