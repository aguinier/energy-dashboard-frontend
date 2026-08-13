import { wape } from '../../services/wape.js';

/**
 * The five accuracy measures `/v1/accuracy` publishes, and the sample counts
 * that stop each of them being read as a claim it does not make.
 *
 * ABL-293 §2a fixes the units: `mape`, `wape` and `smape` are percentages on
 * 0-100; `mae` and `rmse` are in the unit of the target (MW for load and
 * generation, EUR/MWh for price). `data/series.ts` states that per field on
 * every response, so the unit is declared rather than inferred from a name.
 *
 * ## Why five, and why they disagree
 *
 * They disagree **on purpose**, and a subscriber comparing two of them is doing
 * the right thing. Each divides by something different, and this repository has
 * paid for the difference twice:
 *
 * - **ABL-19**: BE solar MAPE measured **148,458%** on the cross-country
 *   heatmap.
 * - **ABL-388**: HU solar read **7,421.87%** and NL solar **6,866.02%** on
 *   `/tso-forecast/accuracy/generation/:cc`.
 *
 * Neither was a bad forecast. Both were MAPE dividing each point by *its own*
 * actual, on a series that passes through near-zero at dawn and dusk every day:
 * one point at 0.4 MW against a 40 MW forecast contributes 10,000% and swamps
 * several thousand well-forecast points. Publishing MAPE alone would sell that
 * artifact as a quality figure; publishing WAPE alone would hide the per-point
 * behaviour a MAPE is genuinely good at showing on a well-behaved series like
 * load. So both ship, beside each other, with the sample each was computed over.
 *
 * ## Every metric is `null` rather than `0` when it is not measurable
 *
 * The single rule this module exists to enforce, and the one the issue calls
 * "the NULL-vs-0 contract at its sharpest" (ABL-293 §2a). A country whose
 * actuals summed to zero over a window, or for which nothing paired at all, must
 * **not** render as a flawless 0% error. Zero is the best possible score; it is
 * the last thing an unmeasurable window should return.
 *
 * `meta.coverage` is the field that carries *why*, and it is required on every
 * accuracy response — see `envelope.ts`. This module supplies the other half:
 * the metric itself is `null`, so a client that ignores `coverage` still cannot
 * read a zero that was never measured.
 *
 * ## Three separate sample counts, because the three percentages have three
 *
 * The measures do not all cover the same points, and a single `sample_size`
 * would be wrong for two of them:
 *
 * - `sample_size` — paired points. `mae`, `rmse` and `wape` cover all of them.
 * - `mape_samples` — points with a **positive** actual. A percentage error is
 *   undefined at zero and, divided by a *signed* actual, a negative day-ahead
 *   price cancels error instead of accumulating it (ABL-19). Both are excluded,
 *   which for a price or an overnight solar window can be most of the sample —
 *   so the count is published rather than left to be assumed equal to
 *   `sample_size`.
 * - `smape_samples` — points where `|actual| + |forecast|` is non-zero. Only an
 *   hour where *both* are exactly zero is undefined, so this is normally
 *   `sample_size` and is stated for the same reason.
 */

/** One forecast hour that paired with an actual. */
export interface AccuracyPoint {
  forecast: number;
  actual: number;
}

export interface AccuracyMetrics {
  /** Mean absolute percentage error, 0-100. `null` when no point had a positive actual. */
  mape: number | null;
  /** Weighted absolute percentage error, 0-100. `null` when the actuals sum to zero. */
  wape: number | null;
  /** Symmetric MAPE, 0-100. `null` when no point had a non-zero magnitude. */
  smape: number | null;
  /** Mean absolute error, in the unit of the target. `null` when nothing paired. */
  mae: number | null;
  /** Root mean square error, in the unit of the target. `null` when nothing paired. */
  rmse: number | null;
  /** Paired forecast hours. The sample behind `mae`, `rmse` and `wape`. */
  sample_size: number;
  /** Of those, the ones with a positive actual — the sample behind `mape`. */
  mape_samples: number;
  /** Of those, the ones with a non-zero magnitude — the sample behind `smape`. */
  smape_samples: number;
}

/** Everything null, nothing counted. What an unmeasurable window returns. */
export const NO_METRICS: AccuracyMetrics = {
  mape: null,
  wape: null,
  smape: null,
  mae: null,
  rmse: null,
  sample_size: 0,
  mape_samples: 0,
  smape_samples: 0,
};

/** Two decimals, the precision every accuracy figure in this repository carries. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Symmetric MAPE — and **which** symmetric MAPE, because there are two in
 * circulation and they differ by a factor of two.
 *
 * This is `100 * mean(|a - f| / (|a| + |f|))`, which is bounded on **0-100** by
 * the triangle inequality: `|a - f| <= |a| + |f|` for every pair, so no term can
 * exceed 1. The other common form halves the denominator and is bounded on
 * 0-200. ABL-293 §2a specifies percentages on 0-100, so this is the form that
 * matches the stated contract — and the choice is written down here rather than
 * left in the arithmetic, because a subscriber reconciling our number against
 * their own implementation of "sMAPE" will otherwise find it exactly half theirs
 * and have no way to tell which of us is wrong.
 *
 * **Absolute values in the denominator**, for the reason `wape.ts` gives: a
 * signed quantity — a negative day-ahead price — must not be able to cancel its
 * own denominator and inflate the result.
 *
 * A pair where both sides are exactly zero is skipped rather than counted as a
 * perfect 0: `0/0` is undefined, and a solar hour at midnight forecast at zero
 * is not evidence of forecasting skill. It is the same argument the `null`
 * return makes at window scale, applied per point.
 */
function smape(points: readonly AccuracyPoint[]): { value: number | null; samples: number } {
  let total = 0;
  let samples = 0;
  for (const { actual, forecast } of points) {
    const denominator = Math.abs(actual) + Math.abs(forecast);
    if (denominator === 0) continue;
    total += Math.abs(actual - forecast) / denominator;
    samples += 1;
  }
  return { value: samples === 0 ? null : round2((100 * total) / samples), samples };
}

/**
 * Reduce paired points to the published metrics.
 *
 * Pure, and separated from the query for the reason `classifyCoverage` was:
 * "does an empty window return nulls rather than zeros" is the assertion this
 * endpoint most needs, and it should not require a database to make.
 *
 * `wape` is imported rather than spelled here. It is the repository's one
 * definition of a weighted percentage error (ABL-388), shared with
 * `mlForecastService` and `tsoForecastService`, and a second copy is how two
 * endpoints' "WAPE" come to mean different things under the same column
 * heading — the mistake `renewableTotal.ts` exists to prevent, pointed at an
 * error measure.
 */
export function calculateAccuracy(points: readonly AccuracyPoint[]): AccuracyMetrics {
  if (points.length === 0) return NO_METRICS;

  const n = points.length;
  let absoluteError = 0;
  let squaredError = 0;
  let percentTotal = 0;
  let percentSamples = 0;

  for (const { actual, forecast } of points) {
    const error = actual - forecast;
    absoluteError += Math.abs(error);
    squaredError += error * error;
    // A percentage error is undefined at zero, and dividing by a signed actual
    // lets a negative price cancel error rather than accumulate it. Both are
    // excluded here and counted in `mape_samples` so the exclusion is visible.
    if (actual > 0) {
      percentTotal += (100 * Math.abs(error)) / actual;
      percentSamples += 1;
    }
  }

  const symmetric = smape(points);

  return {
    mape: percentSamples === 0 ? null : round2(percentTotal / percentSamples),
    // `wape` handles its own zero-denominator and non-finite cases and returns
    // `null` for them, which is the contract this module wants: every paired
    // point goes in, and an unmeasurable window comes back null rather than 0.
    wape: wape(points.map(({ actual, forecast }) => ({ actual, forecast }))),
    smape: symmetric.value,
    mae: round2(absoluteError / n),
    rmse: round2(Math.sqrt(squaredError / n)),
    sample_size: n,
    mape_samples: percentSamples,
    smape_samples: symmetric.samples,
  };
}
