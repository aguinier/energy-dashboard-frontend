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
 * borders only — and the two are not close. Re-measured live against both
 * sources for the hour 2026-08-09 08:00 UTC (JAO's four 15-minute intervals
 * averaged to the hour, against that hour's `net_position` row):
 *
 *   FR  Core −368.9 MW (importer)  vs  all coupled +1,494.6 MW (exporter)
 *   DE  Core 9,423.875 MW          vs  all coupled 9,423.875 MW  (identical)
 *   NL  Core 1,695.15 MW           vs  all coupled 1,695.15 MW   (identical)
 *
 * France is the discriminating case and Germany is a false negative — DE's
 * and NL's every coupled border is either inside the Core domain or modelled
 * as a virtual hub within it, so their two figures coincide exactly, and a
 * wiring bug verified on either would look like a pass.
 *
 * Do not call the distinction "AC vs DC" — Germany's Core figure already nets
 * in its HVDC links, and France's Core figure excludes its AC borders with ES
 * and IT. The only correct axis is which borders are in scope.
 *
 * ABL-222 added the disclosure; ABL-234 added the toggle, so every string here
 * is now a function of the selected scope rather than a constant describing
 * the only view that existed.
 */

/**
 * Which borders the currently-selected view counts.
 *
 * `all_coupled` is the default and is the pre-ABL-234 behaviour exactly —
 * same table, same query, same copy.
 */
export type NetPositionScope = 'all_coupled' | 'core';

export const NET_POSITION_SCOPES: readonly NetPositionScope[] = ['all_coupled', 'core'];

export function isNetPositionScope(value: unknown): value is NetPositionScope {
  return value === 'all_coupled' || value === 'core';
}

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

/** The segmented control's two options, in display order. */
export const NET_POSITION_SCOPE_OPTIONS: ReadonlyArray<{
  value: NetPositionScope;
  label: string;
  /** Long form for the control's accessible name — the labels alone are terse. */
  title: string;
}> = [
  {
    value: 'all_coupled',
    label: 'All coupled borders',
    title: 'Net position over every ENTSO-E day-ahead-coupled border',
  },
  {
    value: 'core',
    label: 'Core region only',
    title: 'Net position over the 12-zone Core flow-based region only',
  },
];

/** Legend heading for the map's `net_position` metric, per scope. */
export function netPositionLegendLabel(scope: NetPositionScope): string {
  return scope === 'core'
    ? 'Avg net position, Core region only'
    : 'Avg net position, all coupled borders';
}

/**
 * One or two sentences for the map legend, which has no single country to
 * hang the other view's caveat on — the metric covers 22 countries, 12 of
 * which are Core zones, so the caveat is stated as a fact about the metric as
 * a class.
 */
export const NET_POSITION_MAP_DISCLOSURE =
  'Every ENTSO-E-coupled border, not just the Core region. The 12 Core zones ' +
  'also have a separate Core net position, which can disagree — even in sign.';

const CORE_MAP_DISCLOSURE =
  'Exchanges within the 12-zone Core flow-based region only. Countries ' +
  'outside that region are not applicable to this view.';

export function netPositionMapDisclosure(scope: NetPositionScope): string {
  return scope === 'core' ? CORE_MAP_DISCLOSURE : NET_POSITION_MAP_DISCLOSURE;
}

/**
 * Hover copy for a country the Core view cannot colour because no Core net
 * position exists for it — as opposed to one we simply have no rows for.
 *
 * The two share the `NoDataHatch` texture (a mark that is visibly *not on the
 * scale* is right for both, and inventing a second texture would weaken the
 * first), so this sentence is the only thing carrying the difference. It must
 * not say "not measured": we may well hold a perfectly good all-coupled-
 * borders figure for this country, and calling that a data gap would be its
 * own confident falsehood.
 */
export const NON_CORE_MAP_NOTICE =
  'This country is outside the 12-zone Core region; Core net position is not applicable.';

/** Legend key beside the hatch swatch, per scope. */
export function netPositionHatchLegendLabel(scope: NetPositionScope): string {
  return scope === 'core' ? 'no data / outside Core region' : 'no data';
}

const ALL_COUPLED_TAB_SCOPE =
  'This chart is the net position over every ENTSO-E-coupled border of the ' +
  'zone, not just the Core region — it excludes only borders outside ' +
  'day-ahead market coupling, such as Switzerland and Great Britain.';

const CORE_TAB_SCOPE =
  'This chart is the Core flow-based net position published by JAO — ' +
  'exchanges within the 12-zone Core region only.';

/**
 * The Net position tab has one country selected, so it can say precisely
 * whether the other view's caveat applies to what is on screen right now.
 *
 * Both branches keep the property ABL-222 established: the sentence describes
 * the borders the *currently selected* view covers, and then names the other
 * figure as a different number rather than as a correction. Adding the toggle
 * must not cost that — a user who switches views and reads a sentence about
 * the view they just left is worse off than before the toggle existed.
 */
export function netPositionTabDisclosure(
  countryCode: string,
  scope: NetPositionScope = 'all_coupled',
): string {
  if (scope === 'core') {
    if (!isCoreCcrCountry(countryCode)) {
      return (
        'This zone is outside the 12-zone Core region, so no Core net position ' +
        'exists for it. Switch to "All coupled borders" for the figure this ' +
        'dashboard does hold.'
      );
    }
    return (
      CORE_TAB_SCOPE +
      ' The all-coupled-borders net position also exists for this zone and can ' +
      'differ materially, including in sign — this is not that figure.'
    );
  }

  if (!isCoreCcrCountry(countryCode)) return ALL_COUPLED_TAB_SCOPE;
  return (
    ALL_COUPLED_TAB_SCOPE +
    ' A separate Core flow-based net position also exists for this zone and ' +
    'can differ materially, including in sign — this is not that figure.'
  );
}
