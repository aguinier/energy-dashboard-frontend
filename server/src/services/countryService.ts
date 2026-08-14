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

  // The `renewable` block reads `energy_generation` (ABL-324, tranche 2 of 3).
  //
  // `COUNT(*)` over the frozen `energy_renewable` counted ROWS, and that table
  // stores one instant under several timestamp spellings — so the count was an
  // overstatement of our own coverage, which is this repo's usual defect
  // pointed at itself. Measured on the replica 2026-08-13, BA held **65,868
  // rows for 48,766 distinct instants** (26% duplicated); table-wide the
  // inflation is 34,440 rows. `energy_generation` has **0 duplicate instants
  // across 3,178,270 rows**, so a row count there is an instant count.
  //
  // Both tables are written from the same single A75 fetch, so this is the
  // same document's coverage counted without the duplication — not a second
  // upstream source and not a different question.
  //
  // The count is NOT guarded the way the load block above is, and that is a
  // decision rather than an oversight. `measuredLoadClause()` exists because a
  // stored `load_mw = 0.0` is a POSITIVE FALSE CLAIM — a grid never draws 0 MW,
  // so the row asserts a measurement nobody took. An `energy_generation` row
  // whose renewable columns are all NULL asserts nothing at all; NULL is
  // already the correct "we hold no reading" encoding, and the row's existence
  // genuinely means we hold that instant's A75 document. Measured 2026-08-13
  // there are 90 such rows in 3,178,270 (0.0028%), and they move exactly one
  // country's `to`: DE's raw MAX is `2026-08-12 13:00:00`, an unfilled
  // leading-edge document, against a value-bearing MAX of `12:45:00`. A guard
  // over the nine renewable columns would correct that 15 minutes and cost the
  // covering index — measured on DE, `SEARCH ... USING COVERING INDEX` at
  // 17.4 ms becomes `SEARCH ... USING INDEX` plus a row lookup per row at
  // 86.4 ms, a 5x regression on a live endpoint. Not proportionate. Note the
  // frozen table was worse here, not better: its `DEFAULT 0` stores DE's same
  // leading-edge instant as `solar_mw = 0, total_renewable_mw = 0`.
  const renewableRange = db.prepare(`
    SELECT
      MIN(timestamp_utc) as first_renewable,
      MAX(timestamp_utc) as last_renewable,
      COUNT(*) as renewable_records
    FROM energy_generation
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
 * since the other two legs cannot be guarded the same way: an all-NULL
 * `energy_generation` row is an honestly empty A75 document rather than a
 * placeholder value, and a zero-clearing `energy_price` hour is a real
 * measurement.
 *
 * It changes nothing in practice either. All 11 countries carrying placeholder
 * zeros (BA, MK, ME, ES, PL, MD, RO, AL, NL, RS, SI — 543 rows out of 2.76M)
 * hold tens of thousands of genuine rows beside them, so none of them is here
 * *because* of a placeholder.
 *
 * The third leg reads `energy_generation` (ABL-324, tranche 2 of 3). Unlike
 * the two duplicate-exposed sites this file and `dashboardService` also move,
 * this one was never wrong — `DISTINCT country_code` cannot be inflated by
 * duplicate instants — and it moves so that no read path is left on the frozen
 * table. Verified on the replica 2026-08-13 to be a no-op on live data: both
 * tables hold exactly the same 34 country codes, and the whole UNION returns
 * the identical 36 codes either way.
 */
export function getCountriesWithData(): string[] {
  const stmt = db.prepare(`
    SELECT DISTINCT country_code
    FROM (
      SELECT country_code FROM energy_load
      UNION
      SELECT country_code FROM energy_price
      UNION
      SELECT country_code FROM energy_generation
    )
    ORDER BY country_code
  `);
  return (stmt.all() as Array<{ country_code: string }>).map((row) => row.country_code);
}
