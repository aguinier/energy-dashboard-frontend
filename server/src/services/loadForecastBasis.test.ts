import { describe, it, expect } from 'vitest';
import {
  classifyLoadForecastBasis,
  applyLoadForecastBasis,
  DIVERGENT_LOAD_BASIS,
} from './loadForecastBasis.js';

const measured = { mae: 2443, mape: 73.4, rmse: 2890, dataPoints: 168, mapeSamples: 168 };

describe('classifyLoadForecastBasis', () => {
  it('reports NL as divergent, with a reason', () => {
    const v = classifyLoadForecastBasis('NL');
    expect(v.basis).toBe('divergent_basis');
    expect(v.basisNote).toContain('behind-the-meter solar');
  });

  it('is case-insensitive', () => {
    expect(classifyLoadForecastBasis('nl').basis).toBe('divergent_basis');
    expect(classifyLoadForecastBasis('Nl').basis).toBe('divergent_basis');
  });

  it('reports the countries measured as fine as comparable, with no note', () => {
    // The five the ABL-277 report measured at 1.2-3.6% MAPE over 2026-08-04..11.
    for (const cc of ['DE', 'FR', 'ES', 'IT', 'BE']) {
      expect(classifyLoadForecastBasis(cc)).toEqual({ basis: 'comparable', basisNote: null });
    }
  });

  it('treats an unknown country as comparable — absence is "no finding", not "verified fine"', () => {
    expect(classifyLoadForecastBasis('ZZ').basis).toBe('comparable');
    expect(classifyLoadForecastBasis('').basis).toBe('comparable');
  });

  it('never returns a note without a divergent verdict, or a verdict without a note', () => {
    for (const cc of ['NL', 'DE', 'ZZ', 'ba', 'MK']) {
      const v = classifyLoadForecastBasis(cc);
      expect(v.basisNote != null).toBe(v.basis === 'divergent_basis');
    }
  });

  it('states what the gap is rather than claiming data is missing', () => {
    // The whole point of a separate word: we hold both series in full.
    for (const entry of Object.values(DIVERGENT_LOAD_BASIS)) {
      expect(entry.reason).not.toMatch(/no data|missing|not available|unavailable/i);
      expect(entry.measuredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('applyLoadForecastBasis', () => {
  it('blanks the error measures for a divergent country', () => {
    const out = applyLoadForecastBasis('NL', measured);
    expect(out.mae).toBeNull();
    expect(out.mape).toBeNull();
    expect(out.rmse).toBeNull();
    expect(out.basis).toBe('divergent_basis');
    expect(out.basisNote).toBeTruthy();
  });

  it('keeps the pairing counts truthful, so it cannot read as "no data"', () => {
    const out = applyLoadForecastBasis('NL', measured);
    expect(out.dataPoints).toBe(168);
    expect(out.mapeSamples).toBe(168);
  });

  it('passes a comparable country through untouched', () => {
    const out = applyLoadForecastBasis('DE', measured);
    expect(out).toEqual({ ...measured, basis: 'comparable', basisNote: null });
  });

  it('does not mutate its input', () => {
    const input = { ...measured };
    applyLoadForecastBasis('NL', input);
    expect(input).toEqual(measured);
  });

  it('leaves an already-empty window empty rather than inventing a state', () => {
    const empty = { mae: null, mape: null, rmse: null, dataPoints: 0, mapeSamples: 0 };
    expect(applyLoadForecastBasis('NL', empty)).toEqual({
      ...empty,
      basis: 'divergent_basis',
      basisNote: DIVERGENT_LOAD_BASIS.NL.reason,
    });
  });
});
