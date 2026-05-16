// Port of the SourceTable component from app.jsx:1045-1080.
// Six rows, latest-snapshot bar visualization. Note: nuclear / gas+other are
// derived from the load + renewable share (the backend doesn't expose them).

import type { RenewableMix, DashboardOverview } from '@/types';

interface Props {
  mix?: RenewableMix;
  overview?: DashboardOverview;
}

const COLORS = {
  solar: '#F0B92B',
  wind: '#4D89C9',
  hydro: '#2FA39C',
  biomass: '#73A35F',
  nuclear: '#8A6FB5',
  gas: '#8D8579',
};

export function SourceTable({ mix, overview }: Props) {
  const load = overview?.currentLoad ?? null;
  const renPct = overview?.renewablePercentage ?? null;

  // Nuclear approximated at 20% of load (prototype assumption); gas = the rest.
  const nuclear = load != null ? load * 0.2 : 0;
  const gasOther = load != null && renPct != null
    ? load * (1 - renPct / 100 - 0.2)
    : 0;

  const wind = (mix?.wind_onshore ?? 0) + (mix?.wind_offshore ?? 0);
  const sources = [
    { k: 'solar', v: (mix?.solar ?? 0) / 1000, color: COLORS.solar, label: 'Solar' },
    { k: 'wind', v: wind / 1000, color: COLORS.wind, label: 'Wind' },
    { k: 'hydro', v: (mix?.hydro ?? 0) / 1000, color: COLORS.hydro, label: 'Hydro' },
    { k: 'biomass', v: (mix?.biomass ?? 0) / 1000, color: COLORS.biomass, label: 'Biomass' },
    { k: 'nuclear', v: nuclear / 1000, color: COLORS.nuclear, label: 'Nuclear' },
    { k: 'gas', v: Math.max(0, gasOther) / 1000, color: COLORS.gas, label: 'Gas + other' },
  ];
  const total = sources.reduce((a, s) => a + s.v, 0) || 1;

  return (
    <div className="flex flex-col">
      {sources.map((s) => {
        const pct = (s.v / total) * 100;
        return (
          <div
            key={s.k}
            className="grid items-center gap-2.5 border-t border-input py-2.5 first:border-t-0"
            style={{ gridTemplateColumns: '10px 1fr 60px 60px 140px' }}
          >
            <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
            <span className="text-[12.5px]">{s.label}</span>
            <span className="font-mono-num text-right text-[12px]">{s.v.toFixed(2)}</span>
            <span className="font-mono-num text-right text-[11px] text-ink-dim">
              {pct.toFixed(1)}%
            </span>
            <span className="relative block h-1 rounded-sm bg-secondary">
              <span
                className="absolute inset-y-0 left-0 rounded-sm"
                style={{ width: `${Math.min(100, pct * 2.5)}%`, background: s.color }}
              />
            </span>
          </div>
        );
      })}
    </div>
  );
}
