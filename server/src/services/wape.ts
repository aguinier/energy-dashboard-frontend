/**
 * Weighted absolute percentage error — the one definition.
 *
 * `100 * sum|actual - forecast| / sum|actual|`.
 *
 * This lived inside `crossCountryMetricsService.ts` while it had one caller.
 * ABL-388 gave it a second (`tsoForecastService.calculateMetrics`), and a
 * percentage error measure is exactly the kind of thing that must not be
 * spelled twice: two copies of "renewable total" is the mistake
 * `renewableTotal.ts` exists to prevent, and two copies of an error measure
 * would let one endpoint's "WAPE" and another's come to mean different things
 * while sharing a column heading.
 *
 * ## Why WAPE and not MAPE
 *
 * MAPE divides each point by *its own* actual, so its value is dominated by
 * whichever point had the smallest denominator rather than by the forecast's
 * behaviour. Two separate defects in this repo were that one arithmetic fact:
 *
 * - **ABL-19**, the cross-country heatmap: measured BE solar MAPE was
 *   148,458%. Plain MAPE also divided by the *signed* actual, so negative
 *   day-ahead prices cancelled error instead of accumulating it.
 * - **ABL-388**, `/tso-forecast/accuracy/generation/:cc`: HU solar read
 *   7,421.87% and NL solar 6,866.02% (measured on the replica 2026-08-13,
 *   full history). Solar actuals pass through near-zero at dawn and dusk
 *   every day, so a single point at 0.4 MW against a 40 MW forecast
 *   contributes 10,000% and swamps the mean of several thousand
 *   well-forecast points. The `actual > 0` guard those endpoints already
 *   carried prevents division *by zero*; it does nothing about division by a
 *   number that is almost zero.
 *
 * Weighting by magnitude fixes both: a near-zero actual contributes a
 * near-zero denominator *and* a near-zero numerator, so it moves the result
 * by about as much as it is worth.
 *
 * ## Three properties that are load-bearing
 *
 * - **`null`, never `0`, when the window's actuals sum to zero.** A country
 *   whose actuals are all zero (solar overnight, a zone that reports nothing)
 *   must not render as a flawless 0% error. This is the repo's standing rule
 *   that an unmeasurable metric is `null`.
 * - **`|actual|` in the denominator**, so a signed quantity — a negative
 *   day-ahead price, a net position — cannot cancel its own denominator and
 *   inflate the result.
 * - **Non-finite pairs are skipped, not counted.** A `null`/`NaN` reaching
 *   here would otherwise poison both sums into `NaN`, which renders as a
 *   blank rather than as the honest "we did not measure this".
 *
 * ## What it does NOT establish
 *
 * A WAPE is only forecast *skill* when both series measure the same
 * population. Where they do not — NL solar, whose ENTSO-E day-ahead forecast
 * sums to 18.28x our metered actuals over full history — the result is
 * arithmetically correct and still not an accuracy figure. That is a basis
 * question, answered by `solarCoverage.ts` and `loadForecastBasis.ts`, not by
 * this function. Above ~100% the honest reading is only "loses to forecasting
 * zero".
 */
export function wape(pairs: Array<{ actual: number; forecast: number }>): number | null {
  let num = 0;
  let den = 0;
  for (const { actual, forecast } of pairs) {
    if (!Number.isFinite(actual) || !Number.isFinite(forecast)) continue;
    num += Math.abs(actual - forecast);
    den += Math.abs(actual);
  }
  if (den === 0) return null;
  return Math.round((100 * num / den) * 100) / 100;
}
