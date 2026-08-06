import type { GenerationSeriesPoint } from '@/types';

/**
 * The Generation tab's trend chart, as data.
 *
 * ABL-44: the trend chart used to draw four renewable families out of
 * `energy_renewable` while the donut and by-source table beside it drew the
 * whole A75 mix out of `energy_generation` — two marks on one card describing
 * different mixes, and no nuclear or fossil anywhere on the chart even for
 * countries that are mostly both. Both now read `energy_generation` through
 * the same nine-family grouping (`generationService.GENERATION_GROUPS`
 * server-side, mirrored by `WIRE_FIELD` below and by `buildSourceRows`).
 *
 * Everything here is pure so the two decisions that are easy to get quietly
 * wrong — what to do with a group a country never reports, and what to do
 * with a negative one — are testable without a DOM.
 */

export type GenerationGroupKey =
  | 'solar' | 'wind' | 'hydro' | 'biomass'
  | 'nuclear' | 'fossil' | 'waste' | 'other'
  | 'hydroPumped';

/**
 * Groups that carry a *store* rather than a source, and so are the ones that
 * cross zero repeatedly: `hydroPumped` is the pump, and `other` carries
 * `energy_storage_mw` (a battery) alongside geothermal/marine/other.
 *
 * They are stacked first — see GENERATION_GROUP_ORDER for why that placement
 * is load-bearing rather than cosmetic.
 */
export const STORAGE_GROUPS: readonly GenerationGroupKey[] = ['hydroPumped', 'other'];

/**
 * Stack order, bottom to top. Fixed rather than sorted by magnitude so a band
 * stays in the same place as the window moves and as the country changes — a
 * stacked area whose layers reorder between renders is unreadable.
 *
 * **The storage groups go first, adjacent to the zero baseline, and that is a
 * correctness constraint, not a preference.** In a diverging stack a group's
 * band sits on the positive accumulator when it is positive and on the
 * negative one when it is negative, so a group that flips sign jumps by
 * however much is stacked between it and the baseline. Measured on the
 * replica over 2026-07-30..08-06 at the stored 15-minute resolution, the two
 * storage groups flip constantly — FR `other` 144 times and `hydroPumped` 23,
 * DE `hydroPumped` 40, ES 16, NL `other` 17 — and with them ordered last (the
 * first cut of ABL-44) each flip teleported a band across the entire 64 GW
 * height of France's stack. On screen that was ~170 full-height vertical
 * slivers: unreadable, and readable as a generation collapse that never
 * happened.
 *
 * Ordered first, a flip only pivots the band about the baseline it is already
 * touching, and the groups above it shift by that group's own magnitude —
 * continuously, since the crossing group passes through zero. The remaining
 * order is renewables then classical, which keeps the four families the donut
 * colours green contiguous.
 */
export const GENERATION_GROUP_ORDER: readonly GenerationGroupKey[] = [
  'hydroPumped', 'other',
  'solar', 'wind', 'hydro', 'biomass',
  'waste', 'nuclear', 'fossil',
];

export const GENERATION_GROUP_LABELS: Record<GenerationGroupKey, string> = {
  solar: 'Solar',
  wind: 'Wind',
  hydro: 'Hydro',
  biomass: 'Biomass',
  nuclear: 'Nuclear',
  fossil: 'Fossil',
  waste: 'Waste',
  other: 'Other',
  hydroPumped: 'Pumped storage',
};

/**
 * One palette for all three marks on this tab — the stacked trend, the donut
 * and the by-source table — so a colour means the same thing everywhere on
 * the card. Previously the chart and the donut kept one copy each and the
 * table a third, and they had already drifted: solar was `#D9A114` in two of
 * them and `#F0B92B` in the table. `#D9A114` is the validated value (the
 * lighter one sat outside the lightness band at 1.75:1 on the white card).
 */
export const GENERATION_GROUP_COLORS: Record<GenerationGroupKey, string> = {
  solar: '#D9A114',
  wind: '#4D89C9',
  hydro: '#2FA39C',
  biomass: '#73A35F',
  nuclear: '#C2665A',
  fossil: '#6B6459',
  waste: '#A98F5D',
  other: '#B7AFA0',
  hydroPumped: '#7FBFB9',
};

/**
 * Which wire field carries each group. The server has already collapsed the
 * 21 `*_mw` columns into these nine (see `GENERATION_GROUPS`); this is only
 * the snake_case → camelCase rename, kept explicit so a wire rename is a type
 * error here rather than a silently missing band.
 */
const WIRE_FIELD: Record<GenerationGroupKey, keyof Omit<GenerationSeriesPoint, 'timestamp'>> = {
  solar: 'solar',
  wind: 'wind',
  hydro: 'hydro',
  biomass: 'biomass',
  nuclear: 'nuclear',
  fossil: 'fossil',
  waste: 'waste',
  other: 'other',
  hydroPumped: 'hydro_pumped',
};

export interface GenerationMixPoint {
  ts: string;
  future: boolean;
  /** MW. Null is "not reported in this bucket" and is never read as 0. */
  values: Record<GenerationGroupKey, number | null>;
}

export interface GenerationMixSeries {
  points: GenerationMixPoint[];
  /**
   * The groups to draw, in stack order: those this country reported at least
   * once in this window. A group that is null at every point is left out
   * entirely — no band, no legend entry, no tooltip row — because a zero-height
   * band under a legend swatch claims a country generates none of something
   * when the truth is that it has not told us.
   */
  groups: GenerationGroupKey[];
  /** Index of the last non-future point, for the "now" marker. */
  nowIndex: number;
  /**
   * Of `groups`, those carrying at least one negative reading in this window.
   * They are stacked below the zero line rather than clamped away (see
   * `lib/divergingStack.ts` for that decision); the chart captions them so a
   * band under the axis reads as consumption rather than as an error.
   */
  negativeGroups: GenerationGroupKey[];
}

const EMPTY_SERIES: GenerationMixSeries = {
  points: [], groups: [], nowIndex: 0, negativeGroups: [],
};

export function buildGenerationMixSeries(
  data: GenerationSeriesPoint[] | undefined,
  now: Date = new Date(),
): GenerationMixSeries {
  if (!data || data.length === 0) return EMPTY_SERIES;

  const nowMs = now.getTime();
  const points: GenerationMixPoint[] = data
    .filter((d) => d.timestamp)
    .map((d) => {
      const values = {} as Record<GenerationGroupKey, number | null>;
      for (const key of GENERATION_GROUP_ORDER) {
        const raw = d[WIRE_FIELD[key]];
        // `?? null` and not `|| 0`: a measured 0.0 (solar overnight) must stay
        // a 0 and an absent type must stay null. Non-finite is treated as
        // absent rather than plotted.
        values[key] = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
      }
      return { ts: d.timestamp, future: new Date(d.timestamp).getTime() > nowMs, values };
    });

  if (points.length === 0) return EMPTY_SERIES;

  const groups = GENERATION_GROUP_ORDER.filter((key) =>
    points.some((p) => p.values[key] != null),
  );
  const negativeGroups = groups.filter((key) =>
    points.some((p) => (p.values[key] ?? 0) < 0),
  );

  let nowIndex = points.findIndex((p) => p.future);
  if (nowIndex === -1) nowIndex = points.length - 1;
  else nowIndex = Math.max(0, nowIndex - 1);

  return { points, groups, nowIndex, negativeGroups };
}

/**
 * Net generation at one point — the signed sum of every drawn group, which is
 * the top of the positive stack plus the bottom of the negative one. Null when
 * no group reported anything at this point, so the tooltip's total reads `—`
 * rather than a confident 0.
 */
export function pointTotal(
  point: GenerationMixPoint,
  groups: readonly GenerationGroupKey[],
): number | null {
  let total = 0;
  let measured = false;
  for (const key of groups) {
    const v = point.values[key];
    if (v == null) continue;
    measured = true;
    total += v;
  }
  return measured ? total : null;
}

/**
 * The caption under the chart for whatever is drawn below the zero line, or
 * null when nothing is. Naming the groups matters: a band below the axis with
 * no explanation reads as an error rather than as consumption.
 */
export function describeNegativeGroups(negativeGroups: readonly GenerationGroupKey[]): string | null {
  if (negativeGroups.length === 0) return null;
  const names = negativeGroups.map((k) => GENERATION_GROUP_LABELS[k]);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} ${names.length === 1 ? 'is' : 'are'} negative in part of this window — consumption, not output (pumped storage charging, or a type ENTSO-E reports as consumption only). Those hours are stacked below the zero line rather than clamped away.`;
}
