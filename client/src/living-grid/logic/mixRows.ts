import type { GridFuelKey, GridHourSeries } from '@/types';
import { GRID_FUEL_KEYS } from '@/types';
import { FUEL_COLORS, FUEL_LABELS } from './ramps';

/**
 * The generation mix panel: a stacked bar and one row per fuel.
 *
 * Shares are computed from the MW the zone actually reported for the hour, so
 * they describe that zone's generation and not a national total the payload
 * does not carry. A fuel the country does not report is absent rather than
 * zero — the two are different claims and the panel makes only the true one.
 */

export interface MixRow {
  fuel: GridFuelKey;
  label: string;
  color: string;
  /** 0..1 of the zone's reported generation. */
  share: number;
  /** MW for this fuel at this hour. */
  mw: number;
}

export interface MixBreakdown {
  rows: MixRow[];
  /** Everything reported, summed, in MW. */
  totalMw: number;
  /** Wind, solar, hydro and biomass as a fraction of the total. */
  renewableShare: number | null;
  /** True when the zone reported no generation at all for this hour. */
  empty: boolean;
}

/** Fuels counted as renewable for the panel's RES figure. */
const RENEWABLE: readonly GridFuelKey[] = ['hydro', 'wind', 'solar', 'biomass'];

/** Rows under this share are dropped — a 0.3% sliver is unreadable and noisy. */
const MIN_SHARE = 0.004;

export function buildMixBreakdown(
  mix: Record<GridFuelKey, GridHourSeries> | undefined,
  hour: number,
): MixBreakdown {
  if (!mix) return { rows: [], totalMw: 0, renewableShare: null, empty: true };

  const reported: { fuel: GridFuelKey; mw: number }[] = [];
  for (const fuel of GRID_FUEL_KEYS) {
    const raw = mix[fuel]?.[hour];
    if (raw === null || raw === undefined) continue;
    reported.push({ fuel, mw: Math.max(raw, 0) });
  }

  const totalMw = reported.reduce((sum, r) => sum + r.mw, 0);
  if (reported.length === 0 || totalMw <= 0) {
    return { rows: [], totalMw: 0, renewableShare: null, empty: true };
  }

  const rows = reported
    .map((r) => ({
      fuel: r.fuel,
      label: FUEL_LABELS[r.fuel],
      color: FUEL_COLORS[r.fuel],
      share: r.mw / totalMw,
      mw: r.mw,
    }))
    .filter((r) => r.share > MIN_SHARE)
    .sort((a, b) => b.share - a.share);

  const renewableMw = reported
    .filter((r) => RENEWABLE.includes(r.fuel))
    .reduce((sum, r) => sum + r.mw, 0);

  return { rows, totalMw, renewableShare: renewableMw / totalMw, empty: false };
}

/**
 * Segments for the stacked bar.
 *
 * Built from every reported fuel rather than from `rows`, so the bar spans the
 * full width even when small fuels have been dropped from the list below it.
 * Only exact zeros are excluded: a fuel too small for its own row is still
 * part of the total the bar represents, and filtering it here would leave a
 * gap standing for generation that exists.
 */
export function stackSegments(
  mix: Record<GridFuelKey, GridHourSeries> | undefined,
  hour: number,
): { color: string; share: number }[] {
  if (!mix) return [];
  const reported = GRID_FUEL_KEYS.map((fuel) => {
    const raw = mix[fuel]?.[hour];
    return { fuel, mw: raw === null || raw === undefined ? 0 : Math.max(raw, 0) };
  });
  const total = reported.reduce((sum, r) => sum + r.mw, 0);
  if (total <= 0) return [];
  return reported
    .filter((r) => r.mw > 0)
    .map((r) => ({ color: FUEL_COLORS[r.fuel], share: r.mw / total }));
}
