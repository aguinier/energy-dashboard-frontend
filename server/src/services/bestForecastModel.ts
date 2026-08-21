/**
 * Which forecast is the best available one for a given (country, forecast
 * type) — the ranking rule, as pure arithmetic over already-measured accuracy.
 *
 * ## Why this exists
 *
 * `forecastModels.ts` names one `production` model per forecast *type*, chosen
 * by hand on 2026-07-26 and never by measurement (its own header says so). It
 * has no country dimension and no accuracy input, so a pair whose ENTSO-E
 * series is three times more accurate than ours still displayed ours.
 *
 * Measured on the development replica over 2026-07-21..08-20, that is not a
 * hypothetical — it is the ordinary case. WAPE, ours vs the TSO day-ahead
 * series, same window, same pairs:
 *
 * | pair              | our best ML | ENTSO-E D+1 |
 * |-------------------|------------:|------------:|
 * | DE load           | 6.75        | **3.45**    |
 * | FR load           | 5.25        | **1.48**    |
 * | BE load           | 5.50        | **3.89**    |
 * | ES load           | 6.17        | **1.13**    |
 * | DE wind_onshore   | 64.28       | **13.45**   |
 * | DE solar          | 62.37       | **4.67**    |
 * | FR solar          | 18.94       | **7.64**    |
 * | BE wind_offshore  | 205.86      | **36.48**   |
 *
 * **These figures move, and a re-measurement that disagrees in the second
 * decimal is the window rolling, not a regression.** The window ends at `now`,
 * so re-running the same pairs a few hours later reads DE load 6.77 / 3.41
 * against the 6.75 / 3.45 above. What is stable is the ordering, which is the
 * only thing this module acts on. Re-measure rather than reconcile.
 *
 * The Board directive (ABL-316, 2026-08-14) is that the better series is the
 * one to display, labelled with its source, while ours stays selectable and
 * keeps accruing a track record so it can take over when it wins.
 *
 * ## The three judgement calls, stated rather than buried
 *
 * The issue asks for these to be picked, written down and flagged. They are:
 *
 * 1. **WAPE is the ranking measure.** It is the only error measure computed
 *    identically on both sides of this comparison — `tsoForecastService` and
 *    `mlForecastService` both reduce through `services/wape.ts` since ABL-388 —
 *    so ranking on it cannot come down to two definitions of "percent error".
 *    MAPE is disqualified on measurement, not taste: the same probe reports DE
 *    solar at 58,186% MAPE against a 62.37% WAPE, because a generation series
 *    passes through near-zero every dawn and dusk. MAE and RMSE are magnitudes
 *    — comparable between two models of one pair, but they would rank a quiet
 *    country above a busy one if this were ever reused across pairs, and WAPE
 *    is already the house ranking measure (`comparison/accuracyScale.ts`).
 *
 * 2. **The window is the last {@link ACCURACY_WINDOW_DAYS} days**, fixed and
 *    server-side rather than whatever window the user happens to be looking
 *    at. A recommendation that changed when you clicked "Tomorrow" would not
 *    be a track record. 30 days is ~720 hourly pairs — enough for a stable
 *    WAPE, and short enough that a retrained model takes over within a month
 *    of winning, which is what "keeps accruing its live track record so it can
 *    take over" requires. It is also the window the comparison view already
 *    defaults to.
 *
 * 3. **A tie leaves the incumbent in place.** Equal WAPE (both are rounded to
 *    2dp by `wape()`) is not a win, and flipping the displayed source on a
 *    coin toss is worse than either outcome. Ties break on more evidence
 *    first, then on being the type's `production` id, then on registry order —
 *    so the result is deterministic and never depends on measurement order.
 *
 * ## Two qualification bars, and why the obvious one is wrong
 *
 * A candidate is ranked only if it clears both. The bars exist because the
 * candidates do not pair at the same resolution, and a raw point count
 * conflates resolution with coverage:
 *
 * - `MIN_PAIRED_POINTS` is an absolute floor. A WAPE over a handful of hours
 *   is noise, and noise that happens to land low would take the default.
 *
 * - `MIN_WINDOW_HOUR_COVERAGE` is the fraction of the window's *hours* the
 *   candidate has at least one paired point in — **not** its share of the
 *   largest point count, which was tried first and is wrong. Measured on the
 *   replica over the same 30 days, DE's registered candidates pair
 *   721 (ml catboost, hourly), 721 (TSO D+1 load, hourly), 2,881 (TSO D+1
 *   generation, 15-minute) and 30 (TSO D+7, one value per day at noon) points.
 *   A share-of-largest rule excludes the *hourly ML model* for competing
 *   against a 15-minute TSO series, which is a resolution difference and not a
 *   coverage difference. Counting distinct hours instead reads those four as
 *   100%, 100%, 100% and 4.2% — which is the real distinction: D+7 genuinely
 *   only measures 30 noon-hours out of 720, so its WAPE answers a narrower
 *   question and must not be ranked against a series measured all day.
 *
 * An excluded candidate is reported with the reason it was excluded rather
 * than dropped, so the exclusion is visible in the payload instead of looking
 * like a model nobody measured.
 */

import type { ForecastSource } from '../config/forecastModels.js';

/** Rolling window the recommendation is measured over. See judgement call 2. */
export const ACCURACY_WINDOW_DAYS = 30;

/**
 * Absolute floor on paired points. A day's worth — below this a WAPE is an
 * artifact of which hours happened to pair, not a measurement of a forecast.
 */
export const MIN_PAIRED_POINTS = 24;

/**
 * Fraction of the window's hours a candidate must have at least one paired
 * point in. Half the window: enough to exclude a series that only publishes at
 * one hour of the day (ENTSO-E week-ahead, 4.2% of hours) while admitting an
 * ordinary model with an ingest gap or a partial leading edge.
 */
export const MIN_WINDOW_HOUR_COVERAGE = 0.5;

/**
 * Why a registered model is not in the ranking. Never collapsed into one
 * "unavailable" — these are four different claims, and the picker says which.
 */
export type CandidateExclusion =
  /** No accuracy path exists for this source/type pair, so nothing was measured. */
  | 'not_measurable'
  /** Measured, but no forecast paired with an actual in the window. */
  | 'no_pairs'
  /** Paired, but fewer than `MIN_PAIRED_POINTS`. */
  | 'too_few_points'
  /** Paired across less than `MIN_WINDOW_HOUR_COVERAGE` of the window's hours. */
  | 'sparse_coverage'
  /**
   * Paired, but WAPE is null — the window's actuals sum to zero, or the pair
   * is a `divergent_basis` country where the two series measure different
   * quantities (`loadForecastBasis.ts`). Not a score of zero; not a score.
   */
  | 'unmeasurable_wape';

/** One registered model, as measured over the window. */
export interface MeasuredCandidate {
  id: string;
  label: string;
  source: ForecastSource;
  /** `null` when not measurable — see `unmeasurable_wape`. Never coerced to 0. */
  wape: number | null;
  /** Paired forecast/actual points, at whatever resolution the source publishes. */
  dataPoints: number;
  /** Distinct window hours holding at least one paired point. */
  hoursCovered: number;
  /** Set when no accuracy path exists at all; `wape` is then meaningless. */
  notMeasurable?: boolean;
}

export interface RankedCandidate extends MeasuredCandidate {
  /** `null` when the candidate is in the ranking. */
  excluded: CandidateExclusion | null;
}

export interface Ranking {
  /** Best qualifying candidate, or `null` when none qualified. */
  best: RankedCandidate | null;
  /** Every registered model, ranked ones first, each carrying its own numbers. */
  candidates: RankedCandidate[];
}

/**
 * Classify one candidate against the two bars. Order matters: the reason
 * reported is the first one that applies, so "no pairs at all" is never
 * reported as "too few points".
 */
function exclusionFor(c: MeasuredCandidate, windowHours: number): CandidateExclusion | null {
  if (c.notMeasurable) return 'not_measurable';
  if (c.dataPoints === 0) return 'no_pairs';
  if (c.dataPoints < MIN_PAIRED_POINTS) return 'too_few_points';
  if (windowHours > 0 && c.hoursCovered / windowHours < MIN_WINDOW_HOUR_COVERAGE) {
    return 'sparse_coverage';
  }
  // Checked last on purpose: a null WAPE on a well-covered sample is a real
  // finding (a divergent basis, or an all-zero actuals window), and calling it
  // "too few points" would misattribute it to sample size.
  if (c.wape === null || !Number.isFinite(c.wape)) return 'unmeasurable_wape';
  return null;
}

/**
 * Rank measured candidates and name the winner.
 *
 * `productionId` is only ever a tie-break, never a thumb on the scale: a
 * production model that loses on measurement loses.
 */
export function rankCandidates(
  measured: MeasuredCandidate[],
  windowHours: number,
  productionId: string | undefined,
): Ranking {
  const registryOrder = new Map(measured.map((c, i) => [c.id, i]));

  const candidates: RankedCandidate[] = measured.map((c) => ({
    ...c,
    excluded: exclusionFor(c, windowHours),
  }));

  const qualified = candidates.filter((c) => c.excluded === null);

  qualified.sort((a, b) => {
    // `exclusionFor` has already established both WAPEs are finite numbers.
    const byWape = (a.wape as number) - (b.wape as number);
    if (byWape !== 0) return byWape;
    // Equal error: more evidence wins.
    if (a.dataPoints !== b.dataPoints) return b.dataPoints - a.dataPoints;
    // Still equal: the incumbent stays, so a tie never moves the display.
    const aProd = a.id === productionId ? 0 : 1;
    const bProd = b.id === productionId ? 0 : 1;
    if (aProd !== bProd) return aProd - bProd;
    // Deterministic last resort, so the answer never depends on which
    // candidate was measured first.
    return (registryOrder.get(a.id) ?? 0) - (registryOrder.get(b.id) ?? 0);
  });

  const best = qualified[0] ?? null;

  // Ranked candidates first, in ranked order, then the excluded ones in
  // registry order — so a reader sees the comparison before the absences.
  const excluded = candidates
    .filter((c) => c.excluded !== null)
    .sort((a, b) => (registryOrder.get(a.id) ?? 0) - (registryOrder.get(b.id) ?? 0));

  return { best, candidates: [...qualified, ...excluded] };
}

/**
 * The hour a paired point falls in, as a comparison key.
 *
 * The three accuracy paths return three timestamp spellings for the same
 * instant — `2026-08-01T05:00:00` (ml, raw from `forecasts`),
 * `2026-08-01T05:00:00Z` (TSO load, already bucketed by `strftime`) and
 * `2026-08-01 05:15:00` (TSO generation, raw at 15-minute resolution). Slicing
 * to `YYYY-MM-DD HH` after normalising the separator collapses all three onto
 * one key, which is what makes the coverage bar comparable across sources.
 */
export function hourKey(timestamp: string): string {
  return timestamp.replace('T', ' ').slice(0, 13);
}

/** Distinct window hours covered by a set of paired points. */
export function countHoursCovered(points: Array<{ timestamp: string }>): number {
  const hours = new Set<string>();
  for (const p of points) hours.add(hourKey(p.timestamp));
  return hours.size;
}
