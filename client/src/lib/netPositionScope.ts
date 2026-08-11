/**
 * States the scope of the net position number this dashboard draws, so the
 * map legend and the Net position tab describe the same claim.
 *
 * Measured in ABL-219: `net_position.net_position_mw` is the zone's ENTSO-E
 * SDAC net position — its net scheduled exchange over every implicitly
 * day-ahead-coupled border, inside the Core flow-based region or not. It
 * excludes only the borders that are not implicitly coupled at all
 * (Switzerland, and Great Britain since Brexit).
 *
 * A second, equally legitimate "net position" exists for the 12 Core CCR
 * zones — the Core flow-based net position, published by JAO over Core
 * borders only — and the two are not close. France, 2026-08-09 08:00 UTC:
 * Core −114.9 MW (importer) vs this figure +1,557.7 MW (exporter). Do not
 * call the distinction "AC vs DC" — Germany's Core figure already nets in
 * its HVDC links, and France's Core figure excludes its AC borders with ES
 * and IT. The only correct axis is which borders are in scope.
 *
 * Ingesting the Core series and offering a toggle is ABL-219 step 2, pending
 * a Board decision (new external source, new table, prod write). This module
 * only names what is already on screen — it changes no query and no number.
 */

// The 12 Core CCR bidding zones, as country codes. DE and LU share the
// DE_LU bidding zone, which is one Core hub, so both codes count as one zone.
const CORE_CCR_COUNTRIES = new Set([
  'AT', 'BE', 'CZ', 'DE', 'FR', 'HR', 'HU', 'LU', 'NL', 'PL', 'RO', 'SI', 'SK',
]);

export function isCoreCcrCountry(countryCode: string): boolean {
  return CORE_CCR_COUNTRIES.has(countryCode.toUpperCase());
}

/** Short scope label for spots too tight for a full sentence. */
export const NET_POSITION_SCOPE_LABEL = 'all coupled borders';

/**
 * One or two sentences for the map legend, which has no single country to
 * hang a Core caveat on — the metric covers 22 countries, 12 of which are
 * Core zones, so the caveat is stated as a fact about the metric as a class.
 */
export const NET_POSITION_MAP_DISCLOSURE =
  'Every ENTSO-E-coupled border, not just the Core region. The 12 Core zones ' +
  'also have a separate Core net position, which can disagree — even in sign.';

/**
 * The Net position tab has one country selected, so it can say precisely
 * whether the caveat applies to what is on screen right now.
 */
export function netPositionTabDisclosure(countryCode: string): string {
  const scope =
    'This chart is the net position over every ENTSO-E-coupled border of the ' +
    'zone, not just the Core region — it excludes only borders outside ' +
    'day-ahead market coupling, such as Switzerland and Great Britain.';
  if (!isCoreCcrCountry(countryCode)) return scope;
  return (
    scope +
    ' A separate Core flow-based net position also exists for this zone and ' +
    'can differ materially, including in sign — this is not that figure.'
  );
}
