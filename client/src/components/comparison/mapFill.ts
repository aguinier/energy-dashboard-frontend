import { wapeColor, type WapeScale } from './accuracyScale';

/**
 * Which fill one country's shape gets on `ComparisonMap`.
 *
 * Three states, and the distinction that matters is the third:
 *
 * - `ranked` — a measured WAPE, coloured by its rank within this forecast
 *   type's spread (see `accuracyScale.ts`).
 * - `flat` — measured, but not rankable: MAE/RMSE across countries of wildly
 *   different size is a magnitude and not a score, and a WAPE set with fewer
 *   than `MIN_COUNTRIES_FOR_SCALE` measured countries is too thin to rank
 *   within. One neutral "has a number" fill; read the number in the tooltip.
 * - `none` — **not measured**: the country is absent from the response, has no
 *   entry for this forecast type, or its WAPE is `null` because the window's
 *   actuals summed to zero (`crossCountryMetricsService.ts`). This must be a
 *   different *kind* of mark, not a paler colour — see `NoDataHatch.tsx`.
 *
 * Extracted as a pure function because the component around it cannot be
 * rendered under test: `<Geographies geography={url}>` fetches its topojson,
 * so `renderToString` yields no country shapes to assert on.
 */

export type ComparisonMetric = 'wape' | 'mae' | 'rmse';

export type FillKind = 'ranked' | 'flat' | 'none';

export interface CountryFill {
  kind: FillKind;
  /** SVG paint for the shape. */
  fill: string;
}

/**
 * The fill for a measured-but-unrankable country. A plain "we have a number
 * here" mark — it carries no ordering, because none was computed.
 */
export const MEASURED_FLAT_FILL = 'hsl(var(--primary))';

/**
 * `value` is the selected metric's value for the selected forecast type, or
 * anything at all when there isn't one — `undefined`, `null`, `NaN` all mean
 * "not measured" and are never coerced to a number. `noDataFill` is the caller's
 * hatch reference (`noDataHatchUrl(id)`), passed in because the pattern id is
 * per-mounted-`<svg>`.
 */
export function countryFill(
  value: unknown,
  metric: ComparisonMetric,
  scale: WapeScale,
  noDataFill: string,
): CountryFill {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { kind: 'none', fill: noDataFill };
  }
  const ranked = metric === 'wape' ? wapeColor(value, scale) : null;
  if (ranked !== null) return { kind: 'ranked', fill: ranked };
  return { kind: 'flat', fill: MEASURED_FLAT_FILL };
}

/**
 * Whether any country on this map will draw the flat fill — i.e. whether the
 * legend needs a key for it. False on the ordinary WAPE map, where every
 * measured country is ranked.
 */
export function usesFlatFill(metric: ComparisonMetric, scale: WapeScale): boolean {
  return metric !== 'wape' || !scale.usable;
}
