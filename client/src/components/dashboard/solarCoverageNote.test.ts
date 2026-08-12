import { describe, it, expect } from 'vitest';
import { describeSolarCoverage, isSolarPartial, SOLAR_PARTIAL_QUALIFIER } from './solarCoverageNote';
import type { GenerationMix, SolarCoverage } from '@/types';

const EMPTY_MIX: GenerationMix = {
  solar: null, wind_onshore: null, wind_offshore: null, hydro_run: null,
  hydro_reservoir: null, hydro_pumped: null, biomass: null, geothermal: null,
  marine: null, other_renewable: null, energy_storage: null, nuclear: null,
  fossil_gas: null, fossil_hard_coal: null, fossil_brown_coal: null,
  fossil_oil: null, fossil_oil_shale: null, fossil_peat: null,
  fossil_coal_derived_gas: null, waste: null, other: null,
  renewable_percentage: null,
};

// NL as measured on the replica, 2026-08-12.
const NL_COVERAGE: SolarCoverage = {
  verdict: 'partial_subset',
  pairs: 8693,
  forecastSumMw: 12_447_625,
  actualSumMw: 731_416,
  ratio: 17,
  referenceDays: 90,
};

const mix = (coverage?: SolarCoverage): GenerationMix => ({
  ...EMPTY_MIX,
  solar: 84.1,
  solar_coverage: coverage,
});

describe('isSolarPartial', () => {
  it('is true only for a partial_subset verdict', () => {
    expect(isSolarPartial(NL_COVERAGE)).toBe(true);
    expect(isSolarPartial({ ...NL_COVERAGE, verdict: 'consistent' })).toBe(false);
    expect(isSolarPartial({ ...NL_COVERAGE, verdict: 'unknown' })).toBe(false);
  });

  it('treats an absent verdict as no caveat, not as a reassurance failure', () => {
    // An older server sends no `solar_coverage` at all. That must degrade to
    // "we did not check", which renders nothing - not to a crash.
    expect(isSolarPartial(undefined)).toBe(false);
  });
});

describe('describeSolarCoverage', () => {
  it('returns nothing for a country whose solar is consistent', () => {
    expect(describeSolarCoverage(mix({ ...NL_COVERAGE, verdict: 'consistent', ratio: 1 }), 'Germany')).toBeNull();
  });

  it('returns nothing when the check could not run', () => {
    expect(describeSolarCoverage(mix({ ...NL_COVERAGE, verdict: 'unknown', ratio: null }), 'Norway')).toBeNull();
  });

  it('returns nothing when the mix has not loaded', () => {
    expect(describeSolarCoverage(undefined, 'Netherlands')).toBeNull();
    expect(describeSolarCoverage(mix(undefined), 'Netherlands')).toBeNull();
  });

  it('refuses the bare label and names the country where it reads naturally', () => {
    // `countryLabel` is the raw country_name, so the headline avoids the
    // possessive it cannot punctuate ("Netherlands's") and the detail carries
    // the name instead.
    const note = describeSolarCoverage(mix(NL_COVERAGE), 'Netherlands');

    expect(note).not.toBeNull();
    expect(note!.headline).toContain('grid-metered output');
    expect(note!.headline).not.toContain("Netherlands's");
    expect(note!.detail).toContain('Netherlands');
    expect(note!.labelQualifier).toBe(SOLAR_PARTIAL_QUALIFIER);
  });

  it('cites the measured evidence rather than asserting the caveat', () => {
    const note = describeSolarCoverage(mix(NL_COVERAGE), 'the Netherlands')!;

    expect(note.detail).toContain('17x');
    expect(note.detail).toContain('8,693 hours');
    expect(note.detail).toContain('90 days');
  });

  it('never presents the ratio as a correction factor', () => {
    // The single most important property of this wording. The day-ahead
    // forecast is itself a partial view, so 17x is a lower bound on a
    // discrepancy and not a multiplier back to national solar. The note must
    // say the true level is unknown, and must say no correction was applied.
    const note = describeSolarCoverage(mix(NL_COVERAGE), 'the Netherlands')!;

    expect(note.detail).toContain('cannot measure');
    expect(note.detail).toContain('no correction is applied');
    expect(note.detail).not.toMatch(/times higher|multiply|true level is|actual solar is/i);
  });

  it('states that the series is still drawn', () => {
    // Dropping the series would trade a wrong chart for a missing one.
    const note = describeSolarCoverage(mix(NL_COVERAGE), 'the Netherlands')!;

    expect(note.detail).toContain('drawn unchanged');
  });

  it('flags the renewable share as affected too', () => {
    // Solar sums into RENEWABLE_MW_SUM server-side, so the donut centre, the
    // header tile and the map choropleth inherit the understatement.
    const note = describeSolarCoverage(mix(NL_COVERAGE), 'the Netherlands')!;

    expect(note.detail).toContain('renewable share');
  });

  it('renders nothing rather than "nullx" if a ratio-less partial verdict arrives', () => {
    // The server cannot produce this combination - a zero actual sum resolves
    // to `unknown` before any division - but a stale or misbehaving server
    // must degrade to silence, not to a broken sentence.
    const note = describeSolarCoverage(mix({ ...NL_COVERAGE, actualSumMw: 0, ratio: null }), 'Testland');

    expect(note).toBeNull();
  });

  it('never renders a non-finite figure', () => {
    const note = describeSolarCoverage(mix(NL_COVERAGE), 'the Netherlands')!;

    for (const bad of ['null', 'undefined', 'Infinity', 'NaN']) {
      expect(note.detail).not.toContain(bad);
      expect(note.headline).not.toContain(bad);
    }
  });
});
