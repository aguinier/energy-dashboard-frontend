import type { RenewableMix } from '@/types';

export interface SourceRow {
  key: 'solar' | 'wind' | 'hydro' | 'biomass';
  label: string;
  mw: number;
  /** Share of load. Null load yields 0 so the bar simply does not draw. */
  pctOfLoad: number;
  color: string;
}

const COLORS = {
  solar: '#F0B92B',
  wind: '#4D89C9',
  hydro: '#2FA39C',
  biomass: '#73A35F',
} as const;

/**
 * Measured renewable sources plus the part of load they do not account for.
 *
 * Nuclear and fossil generation are NOT ingested — no table in
 * energy_dashboard.db carries them. The previous version derived nuclear as a
 * flat 20% of load for every country and gas as the remainder, which produced
 * numbers off by several multiples (France) and invented nuclear for countries
 * that have none. The remainder is now reported unnamed.
 */
export function buildSourceRows(
  mix: RenewableMix | undefined,
  loadMw: number | null,
): { rows: SourceRow[]; unattributedMw: number | null } {
  const wind = (mix?.wind_onshore ?? 0) + (mix?.wind_offshore ?? 0);
  const raw: Array<[SourceRow['key'], string, number]> = [
    ['solar', 'Solar', mix?.solar ?? 0],
    ['wind', 'Wind', wind],
    ['hydro', 'Hydro', mix?.hydro ?? 0],
    ['biomass', 'Biomass', mix?.biomass ?? 0],
  ];

  const rows: SourceRow[] = raw.map(([key, label, mw]) => ({
    key,
    label,
    mw,
    pctOfLoad: loadMw && loadMw > 0 ? (mw / loadMw) * 100 : 0,
    color: COLORS[key],
  }));

  const measured = rows.reduce((a, r) => a + r.mw, 0);
  const unattributedMw = loadMw == null ? null : Math.max(0, loadMw - measured);

  return { rows, unattributedMw };
}
