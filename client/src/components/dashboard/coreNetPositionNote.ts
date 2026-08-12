import type { CoreNetPositionResponse } from '@/types';

export interface CoreCoverageNote {
  headline: string;
  detail: string;
}

/**
 * Why the Core net position chart is empty, in words (ABL-234).
 *
 * Pure, with a colocated test, for the same reason
 * `degenerateForecastNote.ts` is: an empty chart that says nothing is the
 * defect this tab keeps being fixed for, and the wording is the fix, so the
 * wording is what has to be asserted.
 *
 * Returns `null` for `served` — there is a chart, so there is nothing to
 * explain — and for a `no_data` window on a zone that has published before,
 * where the caller has a `last_seen` date and can say something more specific
 * than this function can.
 *
 * The three empty states are deliberately NOT collapsed into one "no data"
 * sentence. `out_of_core` says a number does not exist; `not_captured` says
 * this deployment has not switched the capture on; `no_data` says the window
 * is empty. A reader who acts on the wrong one wastes their time looking for
 * an outage that is a config flag, or files an ingest bug against a country
 * that was never in the Core region.
 */
export function describeCoreCoverage(
  meta: CoreNetPositionResponse['meta'] | undefined,
  countryLabel: string,
): CoreCoverageNote | null {
  if (!meta) return null;

  switch (meta.coverage) {
    case 'out_of_core':
      return {
        headline: `${countryLabel} is outside the Core region.`,
        detail:
          'The Core flow-based net position covers 12 bidding zones (AT, BE, CZ, ' +
          'DE-LU, FR, HR, HU, NL, PL, RO, SI, SK). No Core figure exists for this ' +
          'zone — switch to “All coupled borders” for the net position this ' +
          'dashboard does hold for it.',
      };
    case 'not_captured':
      return {
        headline: 'No Core net position has been captured here yet.',
        detail:
          'The Core figure comes from JAO, separately from the ENTSO-E feeds behind ' +
          'every other chart, and this deployment has stored none of it so far. ' +
          'This is a capture that has not been switched on, not an outage at JAO.',
      };
    case 'no_data':
      return {
        headline: `No Core net position published for ${countryLabel} in this window.`,
        detail: 'Try a wider window, or switch to “All coupled borders”.',
      };
    case 'served':
    default:
      return null;
  }
}
