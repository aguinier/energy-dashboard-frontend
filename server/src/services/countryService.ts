import db from '../config/database.js';
import { Country } from '../types/index.js';

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

  // Get data availability for this country
  const loadRange = db.prepare(`
    SELECT
      MIN(timestamp_utc) as first_load,
      MAX(timestamp_utc) as last_load,
      COUNT(*) as load_records
    FROM energy_load
    WHERE country_code = ?
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
