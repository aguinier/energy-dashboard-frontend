import db from '../config/database.js';
import { Country } from '../types/index.js';
import { measuredLoadClause } from './loadQuality.js';

export function getAllCountries(): Country[] {
  const stmt = db.prepare(`
    SELECT
      country_code,
      country_name
    FROM countries
    ORDER BY country_name
  `);
  return stmt.all() as Country[];
}

export function getCountryByCode(code: string): Country | undefined {
  const stmt = db.prepare(`
    SELECT
      country_code,
      country_name
    FROM countries
    WHERE country_code = ?
  `);
  return stmt.get(code.toUpperCase()) as Country | undefined;
}

export function getCountrySummary(code: string) {
  const upperCode = code.toUpperCase();

  // Get data availability for this country.
  //
  // Guarded (ABL-262). `MAX(timestamp_utc)` over unguarded rows is exactly the
  // ABL-60 defect: it dates our coverage from a placeholder, so `to` claims we
  // hold a reading through an hour where we hold a `0.0`. Measured on the
  // replica 2026-08-07, SI's raw MAX was `2026-08-07 00:15` with `load_mw = 0`
  // against a guarded MAX of `00:00`.
  //
  // `COUNT(*)` is guarded with it rather than left as a raw row count, for two
  // reasons. Splitting them would emit a self-inconsistent payload — a
  // `records` total larger than the `from`..`to` range it is reported beside.
  // And `records` gates the block: `> 0` is what decides whether this endpoint
  // answers with a range or with `null`, so counting placeholders would let a
  // country whose every stored load row is a `0.0` report a confident span of
  // data we never measured. This reports measured coverage, which is the only
  // coverage a consumer of `from`/`to` can act on.
  const loadRange = db.prepare(`
    SELECT
      MIN(timestamp_utc) as first_load,
      MAX(timestamp_utc) as last_load,
      COUNT(*) as load_records
    FROM energy_load
    WHERE country_code = ?
      AND ${measuredLoadClause()}
  `).get(upperCode) as { first_load: string; last_load: string; load_records: number };

  const priceRange = db.prepare(`
    SELECT
      MIN(timestamp_utc) as first_price,
      MAX(timestamp_utc) as last_price,
      COUNT(*) as price_records
    FROM energy_price
    WHERE country_code = ?
  `).get(upperCode) as { first_price: string; last_price: string; price_records: number };

  const renewableRange = db.prepare(`
    SELECT
      MIN(timestamp_utc) as first_renewable,
      MAX(timestamp_utc) as last_renewable,
      COUNT(*) as renewable_records
    FROM energy_renewable
    WHERE country_code = ?
  `).get(upperCode) as { first_renewable: string; last_renewable: string; renewable_records: number };

  return {
    country_code: upperCode,
    load: loadRange.load_records > 0 ? {
      from: loadRange.first_load,
      to: loadRange.last_load,
      records: loadRange.load_records
    } : null,
    price: priceRange.price_records > 0 ? {
      from: priceRange.first_price,
      to: priceRange.last_price,
      records: priceRange.price_records
    } : null,
    renewable: renewableRange.renewable_records > 0 ? {
      from: renewableRange.first_renewable,
      to: renewableRange.last_renewable,
      records: renewableRange.renewable_records
    } : null
  };
}

/**
 * Which countries appear in any energy table at all.
 *
 * Deliberately **not** `measuredLoadClause`-guarded, unlike `getCountrySummary`
 * above (ABL-262). This asks a presence question, not a measurement one — it
 * returns no value a chart can render, only whether a code is worth offering in
 * a picker. Guarding the load leg alone would also make the UNION incoherent,
 * since the other two legs cannot be guarded the same way: `energy_renewable`'s
 * zeros are genuinely ambiguous (see the "Known gap" note in CLAUDE.md) and a
 * zero-clearing `energy_price` hour is a real measurement.
 *
 * It changes nothing in practice either. All 11 countries carrying placeholder
 * zeros (BA, MK, ME, ES, PL, MD, RO, AL, NL, RS, SI — 543 rows out of 2.76M)
 * hold tens of thousands of genuine rows beside them, so none of them is here
 * *because* of a placeholder.
 */
export function getCountriesWithData(): string[] {
  const stmt = db.prepare(`
    SELECT DISTINCT country_code
    FROM (
      SELECT country_code FROM energy_load
      UNION
      SELECT country_code FROM energy_price
      UNION
      SELECT country_code FROM energy_renewable
    )
    ORDER BY country_code
  `);
  return (stmt.all() as Array<{ country_code: string }>).map((row) => row.country_code);
}
