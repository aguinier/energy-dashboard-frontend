import type { NetPositionResponse } from '@/types';

/**
 * The sentence `NetPositionTab` prints when the server withheld a forecast for
 * being numerically zero (`forecast_coverage: 'degenerate_zero'`).
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
