import { describe, it, expect } from 'vitest';
import {
  classifyLoadForecastBasis,
  applyLoadForecastBasis,
  suppressIfDivergentBasis,
  DIVERGENT_LOAD_BASIS,
  ERROR_MEASURES,
} from './loadForecastBasis.js';

// NL's real shape over 2026-08-04..11: a large, clean, systematic offset. The
// WAPE is not an outlier the way the MAPE is — which is exactly why it has to
// be suppressed deliberately rather than left to look harmless (ABL-388).
const measured = { mae: 2443, mape: 73.4, wape: 41.2, rmse: 2890, dataPoints: 168, mapeSamples: 168 };

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
    // ABL-388. WAPE is robust to the near-zero-actual problem that makes a
    // MAPE unreadable, so it is the one measure someone might argue should
    // survive here. It must not: this rule is about the two series measuring
    // different quantities, and weighting by magnitude does not make a
    // definitional gap into forecast error.
    expect(out.wape).toBeNull();
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
    const empty = { mae: null, mape: null, wape: null, rmse: null, dataPoints: 0, mapeSamples: 0 };
    expect(applyLoadForecastBasis('NL', empty)).toEqual({
      ...empty,
      basis: 'divergent_basis',
      basisNote: DIVERGENT_LOAD_BASIS.NL.reason,
    });
  });

  it('does not invent a measure the carrier never published', () => {
    // Blanking is driven off ERROR_MEASURES but applied only to keys that are
    // there, so the TSO shape does not acquire a `bias: null` it never had —
    // which is what lets one function serve two genuinely different response
    // shapes without either listing fields.
    expect(applyLoadForecastBasis('NL', measured)).not.toHaveProperty('bias');
  });
});

// The cross-country entry's shape: `bias` and a skill block, no `mape`.
// Numbers are NL's, measured on prod over 2026-08-04..11 and published in full
// — this is the payload ABL-490 was filed against.
const crossCountry = {
  mae: 2435.77,
  wape: 30.99,
  rmse: 3475.71,
  bias: -2063.27,
  dataPoints: 169,
  skillVsSeasonalNaive: { n: 169, skillPct: -136.8, baselineWape: 13.09 },
};

describe('ERROR_MEASURES', () => {
  it('blanks every name it lists, whichever carrier declares it', () => {
    // The property that matters is generic, not per-field: a carrier that
    // publishes a listed measure has it withheld without anyone adding a line
    // to the helper. Build a carrier holding all five at once and check the
    // list drives the blanking rather than a literal somewhere.
    const everything = Object.fromEntries(ERROR_MEASURES.map((m) => [m, 1])) as Record<string, number | null>;
    const out = suppressIfDivergentBasis('NL', everything) as Record<string, number | null>;
    for (const measure of ERROR_MEASURES) {
      expect(out[measure], measure).toBeNull();
    }
  });

  it('names bias — the field that reached prod unsuppressed', () => {
    expect([...ERROR_MEASURES]).toContain('bias');
  });
});

describe('suppressIfDivergentBasis', () => {
  it('blanks bias along with the rest', () => {
    // ABL-493's first trap. `bias` is not published by the TSO accuracy shape,
    // so calling `applyLoadForecastBasis` as it stood would have left this
    // standing — and it is the number a reader would act on, reading as a
    // systematic 2 GW over-forecast a TSO could correct rather than as the
    // behind-the-meter solar the two series disagree about.
    const out = suppressIfDivergentBasis('NL', crossCountry);
    expect(out.mae).toBeNull();
    expect(out.wape).toBeNull();
    expect(out.rmse).toBeNull();
    expect(out.bias).toBeNull();
  });

  it('drops skillPct and keeps n and baselineWape', () => {
    const out = suppressIfDivergentBasis('NL', crossCountry);
    // skillPct divides by the contaminated model WAPE, and is what renders the
    // "worse than the D-7 naive baseline" badge.
    expect(out.skillVsSeasonalNaive.skillPct).toBeNull();
    // The baseline is the *actual* from the same hour seven days earlier, so
    // this is realized against realized — both terms net of behind-the-meter
    // solar. It is a true statement about the country and stays.
    expect(out.skillVsSeasonalNaive.baselineWape).toBe(13.09);
    expect(out.skillVsSeasonalNaive.n).toBe(169);
  });

  it('attaches the marks only on suppression', () => {
    const out = suppressIfDivergentBasis('NL', crossCountry);
    expect(out).toMatchObject({ basis: 'divergent_basis', basisNote: DIVERGENT_LOAD_BASIS.NL.reason });
  });

  it('returns a comparable entry completely untouched — not stamped comparable', () => {
    // The difference from `applyLoadForecastBasis`, and the reason there are
    // two functions: on a response of ~272 (country, type) cells recording one
    // finding, stamping every other cell would destroy the ability to diff the
    // payload and see that nothing moved but the country named.
    const out = suppressIfDivergentBasis('DE', crossCountry);
    expect(out).toEqual(crossCountry);
    expect(out).not.toHaveProperty('basis');
    expect(out).not.toHaveProperty('basisNote');
  });

  it('does not mutate its input, including the nested skill block', () => {
    const input = { ...crossCountry, skillVsSeasonalNaive: { ...crossCountry.skillVsSeasonalNaive } };
    suppressIfDivergentBasis('NL', input);
    expect(input).toEqual(crossCountry);
  });
});
