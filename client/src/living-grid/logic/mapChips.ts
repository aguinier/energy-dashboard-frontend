import { signedGw } from './format';

/**
 * The number drawn on a country, and the one place that decides how it reads.
 *
 * The map used to be handed finished strings. A string cannot be counted
 * through, so an hour step could only cut from one to the next — which is what
 * this exists to fix. `buildMapAttrs` now sends the numbers and the kind, and
 * the map element formats whatever the tween is currently showing.
 *
 * That means two callers format the same figure, so it is written once here.
 * The shapes are exactly what the map printed before: a rounded euro price, GW
 * to one decimal with its unit, and a signed GW figure through `signedGw` so
 * the U+2212 minus keeps its width in IBM Plex Mono.
 */
export type ChipKind = 'euro' | 'gw' | 'signedGw';

export function chipText(kind: ChipKind, value: number): string {
  if (!Number.isFinite(value)) return '';
  switch (kind) {
    case 'euro':
      return `€${Math.round(value)}`;
    case 'gw':
      return `${(value / 1000).toFixed(1)} GW`;
    case 'signedGw':
      return signedGw(value);
    default:
      return '';
  }
}
