import { isCoreCcrCountry, type NetPositionScope } from '@/lib/netPositionScope';
import type { MetricType } from '@/types';

/**
 * What a single country shape means on the choropleth, once the net position
 * scope toggle (ABL-234) can put two different quantities on the same map.
 *
 * Pure, and separated from `EuropeMap` for the same reason
 * `comparison/mapFill.ts` was: `<Geographies geography={url}>` fetches its
 * topojson, so it renders no country shapes under `renderToString` and the
 * decision cannot be asserted through the component.
 *
 * Three states, and the third is the whole point of the file:
 *
 * - `ranked` — a value on the scale, coloured.
 * - `no_data` — we hold nothing for this country here. Hatched.
 * - `out_of_core` — no Core net position EXISTS for this country, because it
 *   is not one of the 12 Core CCR zones. Hatched too: a texture is the right
 *   mark for both, since both mean "not on the scale", and inventing a second
 *   texture for the rarer case would weaken the first (see NoDataHatch.tsx).
 *   What separates them is the sentence on hover — and that separation is
 *   load-bearing, not decorative. Spain has a perfectly good all-coupled-
 *   borders net position; telling a reader it is "not measured" in Core view
 *   would be this repo's recurring defect in words instead of numbers.
 */
export type NetPositionMapCellState = 'ranked' | 'no_data' | 'out_of_core';

export function netPositionMapCellState(params: {
  metric: MetricType;
  scope: NetPositionScope;
  countryCode: string | null;
  hasValue: boolean;
}): NetPositionMapCellState {
  const { metric, scope, countryCode, hasValue } = params;
  if (hasValue) return 'ranked';
  // `out_of_core` is only meaningful for the one metric that has two scopes,
  // and only while the Core one is selected. Every other combination keeps the
  // pre-ABL-234 behaviour exactly.
  if (metric !== 'net_position' || scope !== 'core') return 'no_data';
  if (!countryCode) return 'no_data';
  return isCoreCcrCountry(countryCode) ? 'no_data' : 'out_of_core';
}

/**
 * Whether the map's `net_position` metric is currently drawing the Core
 * figure. Trivial, but it is asked in four places in `EuropeMap` (which query
 * to read, which legend heading, which disclosure, whether the out-of-scope
 * hover card can appear) and getting one of them wrong is precisely how a
 * legend ends up naming a scope the query did not use.
 */
export function isCoreNetPositionView(metric: MetricType, scope: NetPositionScope): boolean {
  return metric === 'net_position' && scope === 'core';
}
