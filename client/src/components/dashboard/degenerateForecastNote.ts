import type { NetPositionResponse } from '@/types';

/**
 * The sentences `NetPositionTab` prints when the server withheld a series for
 * being numerically zero — the forecast (`forecast_coverage`) or the actuals
 * (`actual_coverage`), which are two separate defects that happen to share a
 * signature and both land on GR.
 *
 * Pure, and its own module, because the wording *is* the fix. Filtering the
 * rows out and drawing nothing would trade a confidently wrong chart for a
 * silently missing one, and the next person files "GR forecast broken". The
 * gap has to say why it is a gap.
 */
export interface DegenerateForecastNote {
  headline: string;
  detail: string;
}

/**
 * Format a magnitude that may be many orders below 1 MW.
 *
 * Fixed-point loses the whole point at this scale — GR's medians run down to
 * 2.3e-11 MW, and "0.0000 MW" would look like the rounding artefact rather
 * than the evidence.
 */
function formatTinyMw(mw: number): string {
  if (mw === 0) return '0 MW';
  if (mw < 0.001) return `${mw.toExponential(1)} MW`;
  return `${mw.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} MW`;
}

export function describeDegenerateForecast(
  meta: NetPositionResponse['meta'] | undefined,
  countryLabel: string,
): DegenerateForecastNote | null {
  if (!meta || meta.forecast_coverage !== 'degenerate_zero') return null;

  // The server sends these together; a `degenerate_zero` with no measurement
  // attached is a malformed payload, and inventing a count for it would be the
  // same fabrication this note exists to prevent.
  const measured = meta.degenerate_forecast;
  if (!measured) return null;

  const producer = meta.model_name ?? 'The forecast model';
  const values = measured.points === 1 ? '1 value' : `${measured.points} values`;

  return {
    headline: `No usable net position forecast for ${countryLabel}.`,
    detail:
      `${producer} returned ${values} for this window and the largest is ` +
      `${formatTinyMw(measured.max_abs_mw)} — numerically zero. Drawn, that is a ` +
      `flat line at 0 MW, which reads as a confident forecast, so it is not drawn.`,
  };
}

/**
 * The same treatment for the *actuals*, which is the worse of the two: a
 * withheld forecast costs the user a prediction, but a withheld actual is a
 * measurement we were reporting as fact.
 *
 * Deliberately does NOT say "stopped publishing". ENTSO-E is still returning
 * rows for GR — that is exactly the problem, and the empty-state sentence about
 * a series ending upstream would be the wrong story. What ended is the *data*
 * in the rows, and the note says so.
 */
export function describeDegenerateActual(
  meta: NetPositionResponse['meta'] | undefined,
  countryLabel: string,
): DegenerateForecastNote | null {
  if (!meta || meta.actual_coverage !== 'degenerate_zero') return null;

  // Same contract as above: `degenerate_zero` always arrives with its
  // measurement attached, and inventing a count for a malformed payload would
  // be the fabrication this note exists to prevent.
  const measured = meta.degenerate_actual;
  if (!measured) return null;

  const values = measured.points === 1 ? '1 value' : `${measured.points} values`;

  return {
    headline: `No usable net position published for ${countryLabel}.`,
    detail:
      `ENTSO-E returned ${values} for this window and the largest is ` +
      `${formatTinyMw(measured.max_abs_mw)} — numerically zero, while the same ` +
      `hours carry real cross-border flow. Those rows are a gap wearing a ` +
      `number, so they are not drawn.`,
  };
}
