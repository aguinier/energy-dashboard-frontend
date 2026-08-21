import { describe, it, expect } from 'vitest';
import type { CrossCountryMetrics, CrossCountryMetricsEntry } from '@/types';
import {
  basisNoticesAcrossTypes,
  basisNoticesFromRows,
  divergentBasisNote,
  NOT_COMPARABLE,
} from './basisNotice';

const NOTE =
  'Not measurable here. ENTSO-E publishes the Dutch realized load net of ' +
  'behind-the-meter solar and the day-ahead forecast without it, so the ' +
  'difference between them is a definitional gap, not forecast error.';

/** NL's load entry as the server now serves it: measures withheld, count kept. */
const withheld: CrossCountryMetricsEntry = {
  mae: null,
  wape: null,
  rmse: null,
  bias: null,
  dataPoints: 169,
  skillVsSeasonalNaive: { n: 169, skillPct: null, baselineWape: 13.09 },
  basis: 'divergent_basis' as const,
  basisNote: NOTE,
};

/** An ordinary measured entry. Annotated, not inferred: `BasisFields` is an
 * all-optional ("weak") type, so a bare literal with none of its keys is a TS
 * error rather than the null result the call is asserting. */
const measured: CrossCountryMetricsEntry = {
  mae: 120.5,
  wape: 4.8,
  rmse: 150.1,
  bias: -12.3,
  dataPoints: 168,
  skillVsSeasonalNaive: { n: 168, skillPct: 22.4, baselineWape: 6.2 },
};

describe('divergentBasisNote', () => {
  it('returns the registry sentence for a withheld entry', () => {
    expect(divergentBasisNote(withheld)).toBe(NOTE);
  });

  it('returns null for an ordinary entry, and for one that is simply absent', () => {
    expect(divergentBasisNote(measured)).toBeNull();
    expect(divergentBasisNote(undefined)).toBeNull();
    expect(divergentBasisNote(null)).toBeNull();
  });

  it('returns null for a stale response predating the field, rather than an empty heading', () => {
    // Every build before ABL-493 sends neither key. That must read as "no
    // finding" — the same way absence from the server's registry does — and
    // not as a withheld row with nothing to say for itself.
    expect(divergentBasisNote({ basis: undefined, basisNote: undefined })).toBeNull();
  });

  it('requires both fields — a half-suppressed entry prints no heading', () => {
    // Neither half alone is a state the server produces, and a "not
    // comparable" marker with no sentence under it would be the silent gap
    // this whole change exists to remove.
    expect(divergentBasisNote({ basis: 'divergent_basis' })).toBeNull();
    expect(divergentBasisNote({ basis: 'divergent_basis', basisNote: '' })).toBeNull();
    expect(divergentBasisNote({ basisNote: NOTE })).toBeNull();
  });

  it('says "not comparable", never that data is missing', () => {
    // We hold both series in full — 169 paired hours and a real D-7 baseline.
    // "No data" would send a reader to ask for a backfill nobody needs, and it
    // is the claim the server gave this its own verdict word to avoid.
    expect(NOT_COMPARABLE).toBe('not comparable');
    expect(NOT_COMPARABLE).not.toMatch(/no data|missing|unavailable|insufficient/i);
  });
});

describe('basisNoticesFromRows', () => {
  it('is empty for the ordinary case', () => {
    expect(basisNoticesFromRows([{ country: 'DE', ...measured }])).toEqual([]);
  });

  it('names each withheld country once, in row order', () => {
    const notices = basisNoticesFromRows([
      { country: 'DE', ...measured },
      { country: 'NL', ...withheld },
      { country: 'FR', ...measured },
    ]);
    expect(notices).toEqual([{ country: 'NL', note: NOTE }]);
  });

  it('deduplicates a country that appears twice', () => {
    const notices = basisNoticesFromRows([
      { country: 'NL', ...withheld },
      { country: 'NL', ...withheld },
    ]);
    expect(notices).toHaveLength(1);
  });
});

describe('basisNoticesAcrossTypes', () => {
  const data: CrossCountryMetrics = {
    NL: { load: withheld, price: measured },
    DE: { load: measured, price: measured },
  };

  it('names the type as well as the country, because the matrix shows several at once', () => {
    expect(basisNoticesAcrossTypes(data, ['load', 'price'])).toEqual([
      { country: 'NL', type: 'load', note: NOTE },
    ]);
  });

  it('says nothing about the same country\'s other types', () => {
    // The finding is about NL's load pair. Its price numbers are intact and
    // must not be shadowed by a footnote that reads as covering the row.
    const notices = basisNoticesAcrossTypes(data, ['price']);
    expect(notices).toEqual([]);
  });

  it('only considers the columns in view', () => {
    expect(basisNoticesAcrossTypes(data, [])).toEqual([]);
  });

  it('sorts by country so the footnote does not reshuffle when the table is re-sorted', () => {
    const twoCountries: CrossCountryMetrics = {
      SI: { load: { ...withheld, basisNote: 'SI reason' } },
      BA: { load: { ...withheld, basisNote: 'BA reason' } },
    };
    expect(basisNoticesAcrossTypes(twoCountries, ['load']).map((n) => n.country)).toEqual(['BA', 'SI']);
  });
});
