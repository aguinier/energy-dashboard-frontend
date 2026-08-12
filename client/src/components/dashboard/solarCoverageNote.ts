import type { GenerationMix, SolarCoverage } from '@/types';

/**
 * The sentences the Generation tab prints when a country's reported solar is
 * only the grid-metered part of its solar fleet (ABL-325).
 *
 * Pure, and its own module, because **the wording is the entire fix**. The
 * series is not wrong - NL's 196,757 solar observations are real, metered, and
 * internally consistent. What was wrong was calling ~2% of Dutch solar "Solar"
 * with no qualifier, on a card that also folds it into a renewable share.
 *
 * Three things this deliberately does not do, each of which was the tempting
 * option:
 *
 * 1. **It does not drop the series.** A missing Solar row would trade a
 *    confidently wrong chart for a silently missing one, and the next person
 *    files "NL solar broken". The gap has to say why it is a gap - the same
 *    rule `degenerateForecastNote.ts` follows.
 * 2. **It does not print a correction factor.** `coverage.ratio` is the ratio
 *    of ENTSO-E's own day-ahead forecast to our actuals, and that forecast is
 *    itself only what the TSO can see (NL's peaks at 7,871 MW against a fleet
 *    over 20 GW). So the ratio is a lower bound on a discrepancy, not a route
 *    back to national solar. Rendering "solar is 17x higher" would replace one
 *    fabricated number with another.
 * 3. **It does not name a country.** The verdict is measured per country from
 *    data we hold, so this stays correct if NL's ingest improves or if another
 *    country develops the same gap - neither of which a hardcoded NL branch
 *    would notice.
 */
export interface SolarCoverageNote {
  headline: string;
  detail: string;
  /** Suffix for the "Solar" label on the chart legend and the by-source table. */
  labelQualifier: string;
}

/** The qualified label, e.g. `Solar (metered subset)`. */
export const SOLAR_PARTIAL_QUALIFIER = 'metered subset';

/**
 * True when this mix's solar figure needs the caveat.
 *
 * A missing `solar_coverage` (older server) and an explicit `unknown` are
 * treated identically and both mean "no caveat" - see the type's own comment
 * for why `unknown` must never render as a reassurance instead.
 */
export function isSolarPartial(coverage: SolarCoverage | undefined): boolean {
  return coverage?.verdict === 'partial_subset';
}

export function describeSolarCoverage(
  mix: GenerationMix | undefined,
  countryLabel: string,
): SolarCoverageNote | null {
  const coverage = mix?.solar_coverage;
  if (!isSolarPartial(coverage) || !coverage) return null;

  // A `partial_subset` verdict always carries a finite ratio - the server
  // resolves a zero actual sum to `unknown` before dividing, precisely so this
  // never has to render an Infinity. Guarded anyway rather than asserted: an
  // older or misbehaving server sending the combination must produce no note,
  // not the string "nullx".
  if (coverage.ratio == null) return null;

  const hours = coverage.pairs.toLocaleString('en-GB');

  return {
    // No country name in the headline, and no possessive. `countryLabel` is
    // the raw `countries.country_name`, so the natural phrasing produces
    // "not Netherlands's total solar generation" - and the article that would
    // fix it ("the Netherlands", but not "the Germany") is not something the
    // column tells us. The name appears in the detail below, in a position
    // that does not need one.
    headline: 'Solar here is grid-metered output, not this country\'s total solar generation.',
    detail:
      `Over the last ${coverage.referenceDays} days ENTSO-E's own day-ahead solar forecast ` +
      `for ${countryLabel} totalled ${coverage.ratio}x the solar actuals reported for the same ` +
      `${hours} hours. The two series therefore do not describe the same fleet: what ENTSO-E ` +
      `publishes as actual generation covers only solar the grid operator meters, and excludes ` +
      `behind-the-meter distributed generation. The metered series below is real and is drawn ` +
      `unchanged — but its level, its share of generation, and the renewable share that ` +
      `includes it are all understated by an amount we cannot measure from this data, so no ` +
      `correction is applied.`,
    labelQualifier: SOLAR_PARTIAL_QUALIFIER,
  };
}
