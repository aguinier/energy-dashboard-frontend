/**
 * What an accuracy badge is entitled to claim for one forecast type.
 *
 * Four outcomes, and collapsing any two of them is a defect:
 *
 * - `measured`      — a WAPE with a denominator worth quoting.
 * - `not_measurable` — the window holds no usable comparison.
 * - `withheld`      — a comparison exists but is invalid by definition
 *                     (divergent basis, NL). NOT a degraded `not_measurable`.
 * - `absent`        — the payload has no entry for this forecast type at all,
 *                     e.g. net position, which nobody forecasts.
 */
export type AccuracyBadgeState =
  | { kind: 'measured'; wape: number; dataPoints: number }
  | { kind: 'not_measurable'; reason: 'no_data' | 'no_magnitude' }
  | { kind: 'withheld' }
  | { kind: 'absent' };

export interface AccuracyBadgeInput {
  wape: number | null;
  mae: number | null;
  dataPoints: number;
}

/**
 * `minPoints` guards against quoting a percentage off a handful of intervals.
 * 24 is one day of hourly data — below that the figure is noise wearing a
 * decimal point. `CountryRanking` already draws this distinction for the
 * portfolio view; this is the same rule per figure.
 */
export function accuracyBadgeState(
  metrics: AccuracyBadgeInput | undefined,
  minPoints = 24
): AccuracyBadgeState {
  if (!metrics) return { kind: 'absent' };

  if (metrics.dataPoints === 0) {
    return { kind: 'not_measurable', reason: 'no_data' };
  }

  // Points were paired but no error measure came back. That is withholding —
  // the server nulls every measure on a divergent basis (ABL-277) precisely so
  // this case is distinguishable from thin data. Order matters: this must be
  // checked before the wape null-check below, which would otherwise swallow it.
  if (metrics.mae === null) {
    return { kind: 'withheld' };
  }

  if (metrics.wape === null) {
    return { kind: 'not_measurable', reason: 'no_magnitude' };
  }

  if (metrics.dataPoints < minPoints) {
    return { kind: 'not_measurable', reason: 'no_data' };
  }

  return { kind: 'measured', wape: metrics.wape, dataPoints: metrics.dataPoints };
}
