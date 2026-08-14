import { describe, it, expect } from 'vitest';
import { ACTUAL_SOURCES, actualsSourceFor } from './actualsSource.js';
import { RENEWABLE_MW_COLUMNS, RENEWABLE_COMPONENTS } from './renewableTotal.js';
import type { ForecastType } from '../types/index.js';

/**
 * Pure, and deliberately so: this imports no DB-touching module, so it runs
 * under either Node ABI and needs no replica. See CLAUDE.md, "NODE_MODULE_VERSION
 * mismatch".
 */
describe('actualsSource — the one forecast-type -> actuals mapping', () => {
  const SCORED_TYPES = [
    'load', 'price', 'solar', 'wind_onshore', 'wind_offshore',
    'hydro_total', 'biomass', 'renewable',
  ] as const;

  it('covers every forecast type the accuracy services score', () => {
    for (const type of SCORED_TYPES) {
      expect(actualsSourceFor(type as ForecastType), type).toBeDefined();
    }
  });

  // The regression guard for ABL-399 itself. `energy_renewable` is frozen and
  // carries `DEFAULT 0` on every `*_mw` column, so it cannot express "this
  // country does not report this type" — it answers `0.0`, which an accuracy
  // metric reads as a measurement. Measured on the replica 2026-08-13, that
  // fabricated 9,192 forecast/actual pairs, including every one of the 3,895
  // offshore-wind pairs (whose real values are negative).
  //
  // This assertion is the whole issue in one line, and it is cheap to keep
  // true: a new type added to the mapping has to name its table here.
  it('reads no actual from the frozen energy_renewable', () => {
    for (const [type, source] of Object.entries(ACTUAL_SOURCES)) {
      expect(source!.table, type).not.toBe('energy_renewable');
    }
  });

  it('routes every generation-family type to energy_generation', () => {
    for (const type of ['solar', 'wind_onshore', 'wind_offshore', 'biomass', 'hydro_total', 'renewable'] as const) {
      expect(actualsSourceFor(type as ForecastType)!.table, type).toBe('energy_generation');
    }
    // load and price are not part of the ABL-324 migration and must not move.
    expect(actualsSourceFor('load' as ForecastType)!.table).toBe('energy_load');
    expect(actualsSourceFor('price' as ForecastType)!.table).toBe('energy_price');
  });

  describe('valueExpr', () => {
    it('prefixes a single column with the caller-supplied alias', () => {
      const solar = actualsSourceFor('solar' as ForecastType)!;
      expect(solar.valueExpr('')).toBe('solar_mw');
      expect(solar.valueExpr('a.')).toBe('a.solar_mw');
      expect(solar.valueExpr('s2.')).toBe('s2.solar_mw');
    });

    // Each of the three services used to carry its own `hydro_total` special
    // case for exactly this reason: `'hydro_run_mw + hydro_reservoir_mw'` as a
    // bare string cannot be prefixed with an alias. Producing the expression
    // here is what let all three drop that branch.
    it('parenthesises a multi-column reduction so it can be embedded', () => {
      const hydro = actualsSourceFor('hydro_total' as ForecastType)!;
      const expr = hydro.valueExpr('a.');
      expect(expr.startsWith('(')).toBe(true);
      expect(expr.endsWith(')')).toBe(true);
      expect(expr).toContain('a.hydro_run_mw');
      expect(expr).toContain('a.hydro_reservoir_mw');
    });

    // The reduction has to be NULL only when EVERY component is NULL. Both
    // halves are load-bearing and each is the other's fix — see renewableTotal.
    it('is null-aware, not COALESCE-to-zero and not NULL-propagating', () => {
      const expr = actualsSourceFor('hydro_total' as ForecastType)!.valueExpr('a.');
      // NULL only when all components are NULL...
      expect(expr).toContain('a.hydro_run_mw IS NULL AND a.hydro_reservoir_mw IS NULL');
      // ...and otherwise a sum that lets a reported member stand beside an
      // unreported one.
      expect(expr).toContain('COALESCE(a.hydro_run_mw, 0) + COALESCE(a.hydro_reservoir_mw, 0)');
    });

    // Accuracy queries embed this inside ABS(actual - forecast). Rounding the
    // actual before differencing would change the error itself, so the bare
    // expression must not carry the ROUND that the /renewables SELECT form does.
    it('does not round the actual', () => {
      for (const type of ['hydro_total', 'renewable'] as const) {
        expect(actualsSourceFor(type as ForecastType)!.valueExpr('a.'), type).not.toContain('ROUND');
      }
    });

    // `renewable` is the type with no counterpart column at all —
    // `total_renewable_mw` was a stored computed column on the frozen table.
    // Deriving it here from renewableTotal's list rather than from a second
    // hand-written one is what stops the accuracy path and /renewables coming
    // to disagree about which columns are renewable.
    it('derives renewable from renewableTotal.RENEWABLE_MW_COLUMNS', () => {
      const expr = actualsSourceFor('renewable' as ForecastType)!.valueExpr('a.');
      for (const column of RENEWABLE_MW_COLUMNS) {
        expect(expr, column).toContain(`a.${column}`);
      }
      // Stores are not primary generation and must stay out: their discharge
      // was generated — and counted — somewhere else already.
      expect(expr).not.toContain('hydro_pumped_mw');
      expect(expr).not.toContain('energy_storage_mw');
    });

    // The frozen table folded pumped storage into `hydro_reservoir_mw`, so the
    // same two column names meant a different quantity there. Proven on the
    // replica: BE 2026-01-14 08:00, energy_renewable.hydro_reservoir_mw = 73.31
    // = energy_generation.hydro_pumped_mw exactly, while
    // energy_generation.hydro_reservoir_mw is NULL.
    it('defines hydro_total as renewableTotal does — run + reservoir, never pumped', () => {
      const expr = actualsSourceFor('hydro_total' as ForecastType)!.valueExpr('a.');
      expect(RENEWABLE_COMPONENTS.hydro).toEqual(['hydro_run_mw', 'hydro_reservoir_mw']);
      expect(expr).not.toContain('hydro_pumped_mw');
    });
  });
});
