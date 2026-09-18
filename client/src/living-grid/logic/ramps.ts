/**
 * The Living Grid's colour tokens and the ramps built from them.
 *
 * These are deliberately not `lib/dataScale.ts` or `lib/divergingScale.ts`.
 * Those carry the cream-paper theme's palette, tuned for a light background
 * and a print-like contrast budget; the Living Grid is a near-black
 * operational surface with its own fixed set from the design handoff. Sharing
 * one of them would mean one screen's palette change silently repainting the
 * other.
 */

/** Ground, structure and text. */
export const TOKENS = {
  pageGround: '#07121C',
  panelGround: '#08141F',
  cardGround: 'rgba(9,22,33,0.86)',
  border: '#16293A',
  borderControl: '#1F3646',
  hairline: '#122230',
  textPrimary: '#DCEEF5',
  textSecondary: '#A8C4D2',
  textMuted: '#6E8A9C',
  textLabel: '#5D7688',
  teal: '#2FD3C0',
  tealLight: '#7DE8DB',
  tealBright: '#8BF0E4',
  orange: '#E2703A',
  activeTab: '#2C7FD6',
  halo: '#BFF3EE',
  haloOutline: '#EAFFFB',
} as const;

/** Exporting, least to most. */
export const EXPORT_RAMP = ['#1D5F66', '#219A94', '#2FD3C0', '#8BF0E4'] as const;
/** Importing, least to most. */
export const IMPORT_RAMP = ['#5E2330', '#9B2E31', '#D14430', '#F0703C'] as const;
/** Day-ahead price, cheap to expensive. */
export const PRICE_RAMP = ['#2FD3C0', '#4FC58E', '#9DC95F', '#E8C45A', '#E2703A', '#CF4436'] as const;

export const FUEL_COLORS = {
  nuclear: '#B388EB',
  hydro: '#4A9FE0',
  wind: '#2FD3C0',
  solar: '#F2C14E',
  gas: '#E2703A',
  coal: '#6B7280',
  biomass: '#7FB069',
  other: '#8C9BA6',
} as const;

export const FUEL_LABELS = {
  nuclear: 'Nuclear',
  hydro: 'Hydro',
  wind: 'Wind',
  solar: 'Solar',
  gas: 'Gas',
  coal: 'Coal',
  biomass: 'Biomass',
  other: 'Other',
} as const;

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

const channels = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** Linear blend between two `#rrggbb` colours. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  const k = clamp01(t);
  const to2 = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return `#${to2(ar + (br - ar) * k)}${to2(ag + (bg - ag) * k)}${to2(ab + (bb - ab) * k)}`;
}

/**
 * Sample a multi-stop ramp at `t` in 0..1.
 *
 * Matches the element's own `ramp()` so a colour computed here and one the
 * canvas computes for the same value cannot disagree.
 */
export function sampleRamp(stops: readonly string[], t: number): string {
  if (stops.length === 0) return TOKENS.textMuted;
  if (stops.length === 1) return stops[0];
  const x = clamp01(t) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  // Landing on a stop returns that stop verbatim rather than a round-tripped
  // copy of it: `mix` emits lowercase hex, and a caller comparing a sampled
  // colour against the palette token it came from would otherwise miss.
  if (f === 0) return stops[i];
  if (f === 1) return stops[i + 1];
  return mix(stops[i], stops[i + 1], f);
}

/** `rgba()` form of a `#rrggbb` colour. */
export function alpha(hex: string, a: number): string {
  return `rgba(${channels(hex).join(',')},${a})`;
}
