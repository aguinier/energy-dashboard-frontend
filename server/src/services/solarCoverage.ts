import type { Database as DatabaseType } from 'better-sqlite3';
import defaultDb from '../config/database.js';

/**
 * "This solar series is real, but it is not the whole country."
 *
 * ENTSO-E's A75 actual-generation document reports generation the TSO can
 * meter. For most countries that is very nearly the national solar fleet. For
 * the Netherlands it is not: the overwhelming majority of Dutch solar is
 * behind-the-meter distributed generation that never reaches this feed, so
 * `energy_generation.solar_mw` for NL is a small grid-metered subset wearing
 * the label "Solar" (ABL-325, found by the ABL-318 audit).
 *
 * The series itself is fine - 196,757 observations, no gaps, internally
 * consistent, forecastable. **The defect is entirely in what the number is
 * called.** So nothing here drops or rescales a value; it only establishes
 * whether the label can stand unqualified.
 *
 * ## The test, and why it is this test
 *
 * The obvious argument - "NL peaks at 428.8 MW against a >20 GW installed
 * fleet" - compares our data against an outside fact this codebase does not
 * hold and cannot verify. There is a stronger check that needs nothing
 * external: **ENTSO-E also publishes a day-ahead solar forecast for the same
 * country and the same hour**, which we already ingest into
 * `energy_generation_forecast`. If our actual series and ENTSO-E's own
 * forecast of that series describe the same population, their sums over a long
 * window must be close. Where they are not, the two series are not the same
 * population, and that is a fact about data we hold.
 *
 * Measured read-only against the replica on 2026-08-12, paired by country and
 * hour over 2026-05-14..2026-08-12 (`SUM(forecast) / SUM(actual)`):
 *
 * ```
 *   DE 1.00   ES 0.95   IT 0.96   FR 1.03   PL 1.09   BE 1.01   SE 1.00
 *   FI 1.03   SK 0.96   HR 0.98   AT 1.00   CZ 1.00   DK 0.97   PT 0.98
 *   HU 1.00   BG 1.07   GR 1.21   RO 1.29        NL 17.0
 * ```
 *
 * Eighteen countries land between 0.95 and 1.29 - ordinary forecast bias. NL
 * sits at **17.0** across 8,693 consecutive hours, which no forecast error
 * produces. NO is excluded by the evidence bar below rather than by name: it
 * reports essentially no solar either side (0.0 MW mean forecast against a
 * 1.8 MW mean actual), so there is nothing to take a ratio of.
 *
 * ## What this deliberately does NOT do
 *
 * It does not yield a correction factor, and the note it feeds must never
 * print one. The day-ahead forecast is itself only what the TSO can see - NL's
 * forecast peaks at 7,871 MW, still far under the installed fleet - so `17.0`
 * is a lower bound on a discrepancy, not a multiplier back to national solar.
 * We can say the actual is a partial subset. We cannot say of what, and
 * inventing that number would be the exact failure this dashboard exists to
 * avoid.
 */

/**
 * How far back the check looks, independent of whatever window the user has
 * selected.
 *
 * This is a property of the *series*, not of the window on screen, and it has
 * to be reported that way. Computed over the displayed window it would
 * disappear on any night-time or winter selection - both series go to zero
 * together, the ratio becomes undefined, and the caveat would blink out
 * exactly when the Solar row still reads 0.9% of generation. A disclosure that
 * comes and goes with the time picker is worse than none, because its absence
 * then means "we checked and it is fine".
 */
export const COVERAGE_REFERENCE_DAYS = 90;

/**
 * Minimum paired hours before this answers at all.
 *
 * 500 is roughly three weeks of daylight hours. Below it a country is either
 * newly ingested or barely covered, and a ratio taken over a handful of hours
 * is noise. NO fails this bar in practice for the second reason below rather
 * than this one; BE and PT sit near 2,173 pairs and pass comfortably.
 */
export const MIN_COVERAGE_PAIRS = 500;

/**
 * Below this much summed *forecast* solar, there is nothing to test the
 * actuals against.
 *
 * The bar is on the forecast side alone, and that asymmetry is the whole
 * point: this check works by holding our actuals up against ENTSO-E's own
 * expectation of them, so a country whose TSO publishes no solar forecast
 * leaves us with no reference. That is "we cannot check", not "the actuals are
 * fine" - and it must not be allowed to read as the latter, which is exactly
 * what a naive ratio would do (0 / anything = 0, comfortably under
 * PARTIAL_COVERAGE_RATIO, verdict `consistent`, caveat suppressed on evidence
 * that does not exist).
 *
 * Norway is the live case and the separation is not close. Summed over
 * 2026-05-14..2026-08-12 on the replica, across 8,691 paired hours, NO's
 * day-ahead solar forecast totals **exactly 0.0 MW**. The next lowest country
 * in Europe is SK at **915,079 MW** - five orders of magnitude up. 10,000 MW
 * over 90 days (~4.6 MW of mean output) sits in the middle of that gap with
 * room to spare in both directions.
 *
 * No matching bar on the actual side: a country with a real forecast and no
 * actuals at all is the most extreme form of the defect this exists to catch,
 * not a reason to stay silent. See `classifySolarCoverage`.
 */
export const MIN_COVERAGE_SUM_MW = 10_000;

/**
 * How far apart the two sums must be before the label is withdrawn.
 *
 * Sized from the measured field, not from taste. The widest genuine
 * forecast-bias ratio in Europe is RO at 1.29; NL is at 17.0. Any threshold
 * between roughly 1.5 and 15 selects exactly `{NL}`, so 3 is not a tuned edge
 * - it sits in an order-of-magnitude empty band, with better than 2x headroom
 * above the worst honest country and better than 5x clearance below NL.
 *
 * Deliberately one-sided. A country whose actuals exceed its own day-ahead
 * forecast (ES at 0.95, IT at 0.96) is not under-covered; that is the forecast
 * running low, which is a forecast-quality question and not this one.
 */
export const PARTIAL_COVERAGE_RATIO = 3;

/**
 * Why the solar label is, or is not, qualified.
 *
 * Parallel to `NetPositionForecastCoverage` in degenerateForecast.ts - same
 * idea, that a verdict has to say which kind of verdict it is. `unknown` is a
 * real answer and is not the same as `consistent`: it means we could not check,
 * so the label stands only because nothing contradicted it.
 */
export type SolarCoverageVerdict = 'consistent' | 'partial_subset' | 'unknown';

export interface SolarCoverage {
  verdict: SolarCoverageVerdict;
  /** Paired hours the verdict rests on. */
  pairs: number;
  /** Summed MW of ENTSO-E's own day-ahead solar forecast over those hours. */
  forecastSumMw: number;
  /** Summed MW of the reported solar actuals over the same hours. */
  actualSumMw: number;
  /**
   * `forecastSumMw / actualSumMw`, rounded to 1dp. Null whenever the verdict
   * is not `partial_subset` - either the check did not run, or it ran and the
   * two series agreed. Never Infinity: a zero actual sum resolves to `unknown`
   * before a ratio is taken, so **`partial_subset` always carries a finite
   * ratio** and the note can rely on it.
   */
  ratio: number | null;
  /** Days of history the verdict was computed over - see COVERAGE_REFERENCE_DAYS. */
  referenceDays: number;
}

export interface SolarCoverageSums {
  pairs: number;
  forecast_sum: number | null;
  actual_sum: number | null;
}

/**
 * Pairs the two series on (country, hour) and sums both sides.
 *
 * An inner join, not two independent range scans, so the comparison is
 * strictly like-for-like: an hour present in one table and absent from the
 * other contributes to neither sum and cannot manufacture a discrepancy on its
 * own. Both `IS NOT NULL` guards matter for the same reason - a null is "not
 * reported", and letting it fall through as a zero on one side only would
 * invent exactly the gap this is looking for.
 *
 * Filters directly on the indexed columns with no function wrapper, so
 * `idx_gen_forecast_country_ts` and `idx_generation_country_time` both stay
 * seekable. Measured at 47ms for NL over 90 days on the 9.4 GB replica.
 */
export const SOLAR_COVERAGE_SQL = `
    SELECT
      COUNT(*) as pairs,
      SUM(f.solar_mw) as forecast_sum,
      SUM(g.solar_mw) as actual_sum
    FROM energy_generation_forecast f
    JOIN energy_generation g
      ON g.country_code = f.country_code
     AND g.timestamp_utc = f.target_timestamp_utc
    WHERE f.country_code = ?
      AND f.target_timestamp_utc >= ?
      AND f.solar_mw IS NOT NULL
      AND g.solar_mw IS NOT NULL
  `;

/**
 * The verdict, as a pure function of the two sums, so the thresholds above are
 * testable without a database.
 *
 * Order of the guards is load-bearing. Evidence bars come first: a country we
 * could not check must read `unknown`, never `consistent`, because
 * `consistent` is a claim and "we have no data" is not evidence for it.
 */
export function classifySolarCoverage(sums: SolarCoverageSums): SolarCoverage {
  const pairs = sums.pairs ?? 0;
  const forecastSumMw = sums.forecast_sum ?? 0;
  const actualSumMw = sums.actual_sum ?? 0;

  const unknown: SolarCoverage = {
    verdict: 'unknown',
    pairs,
    forecastSumMw,
    actualSumMw,
    ratio: null,
    referenceDays: COVERAGE_REFERENCE_DAYS,
  };

  if (pairs < MIN_COVERAGE_PAIRS) return unknown;

  // The reference has to exist before the thing it is a reference for. A
  // country whose TSO publishes no solar forecast (NO) reaches here with a
  // forecast sum of 0 and would otherwise divide out to a ratio of 0 -
  // comfortably "consistent", on no evidence whatsoever.
  if (forecastSumMw < MIN_COVERAGE_SUM_MW) return unknown;

  // A real forecast against actuals summing to exactly nothing is a different
  // defect, and this rule has nothing true to say about it.
  //
  // Live case, found while verifying this against the replica on 2026-08-12:
  // **BA's solar actuals have been exactly 0.0 at every hour since
  // 2026-04-13 06:00** - four months, through the whole Balkan summer - while
  // ENTSO-E kept forecasting up to 244 MW and BA's wind and hydro columns kept
  // reporting normally. Before that the series was healthy (17.4 MW mean in
  // March, a 94 MW peak). That is a dead feed emitting zeros, the same species
  // as GR's net position in ABL-35.
  //
  // Calling it `partial_subset` would put demonstrably wrong words on the
  // chart: the note blames behind-the-meter distributed generation, and
  // Bosnia's problem is not that its solar is invisible - it is that the
  // number is false. The remedy differs too. A partial series is real and
  // stays drawn under a qualified label; a degenerate-zero series has to be
  // *withheld*, which changes the donut, the by-source table, the stacked
  // chart and the renewable share all at once. That is its own change with its
  // own correctness surface, so it is filed separately rather than smuggled in
  // behind this threshold.
  //
  // `unknown` here therefore means "not a coverage question", and renders as
  // no caveat - which is the status quo for BA, not a regression.
  if (actualSumMw <= 0) return unknown;

  const ratio = Math.round((forecastSumMw / actualSumMw) * 10) / 10;

  return {
    verdict: ratio >= PARTIAL_COVERAGE_RATIO ? 'partial_subset' : 'consistent',
    pairs,
    forecastSumMw,
    actualSumMw,
    ratio,
    referenceDays: COVERAGE_REFERENCE_DAYS,
  };
}

/**
 * The reference window's start bound, as the `YYYY-MM-DD HH:MM:SS` text the
 * stored timestamps use.
 *
 * `now` is a parameter rather than a `new Date()` inside, so the tests pin a
 * fixed instant instead of racing the clock.
 */
export function coverageWindowStart(now: Date = new Date()): string {
  const start = new Date(now.getTime() - COVERAGE_REFERENCE_DAYS * 24 * 60 * 60 * 1000);
  return start.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Whether this country's reported solar actuals can carry an unqualified
 * "Solar" label, measured over the last COVERAGE_REFERENCE_DAYS.
 *
 * Never throws and never returns null: a country with no forecast rows, a
 * country too new to have 500 paired hours, and a country that genuinely does
 * not report solar all reach the caller as `unknown`, which the UI renders as
 * no caveat rather than as a reassurance.
 */
export function getSolarCoverage(
  countryCode: string,
  db: DatabaseType = defaultDb,
  now: Date = new Date()
): SolarCoverage {
  const row = db
    .prepare(SOLAR_COVERAGE_SQL)
    .get(countryCode.toUpperCase(), coverageWindowStart(now)) as SolarCoverageSums | undefined;

  return classifySolarCoverage(row ?? { pairs: 0, forecast_sum: null, actual_sum: null });
}
