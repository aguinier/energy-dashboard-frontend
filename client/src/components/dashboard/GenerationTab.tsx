import { useMemo } from 'react';
import { AbleCard } from './AbleCard';
import { AbleStackedMix } from '@/components/charts/AbleStackedMix';
import { AbleDonut } from '@/components/charts/AbleDonut';
import { SourceTable } from './SourceTable';
import { useRenewableChartData } from '@/hooks/useRenewableChartData';
import {
  useDashboardOverview,
  useRenewableMix,
} from '@/hooks/useDashboardData';
import { adaptRenewableMixSeries } from '@/lib/chartAdapters';

const SOURCE_COLORS = {
  solar: '#F0B92B',
  wind: '#4D89C9',
  hydro: '#2FA39C',
  biomass: '#73A35F',
  nuclear: '#8A6FB5',
  gas: '#8D8579',
};

const LEGEND: Array<{ key: keyof typeof SOURCE_COLORS; label: string }> = [
  { key: 'solar', label: 'Solar' },
  { key: 'wind', label: 'Wind' },
  { key: 'hydro', label: 'Hydro' },
  { key: 'biomass', label: 'Biomass' },
];

export function GenerationTab() {
  const { renewableData, isLoading } = useRenewableChartData();
  const { data: mix } = useRenewableMix();
  const { data: overview } = useDashboardOverview();

  const { series, nowIndex } = useMemo(
    () => adaptRenewableMixSeries(renewableData),
    [renewableData],
  );

  // Donut input — combines renewable mix with derived nuclear / gas+other.
  const load = overview?.currentLoad ?? 0;
  const renPct = overview?.renewablePercentage ?? 0;
  const donutValues = [
    { key: 'solar', value: mix?.solar ?? 0, isGreen: true },
    {
      key: 'wind',
      value: (mix?.wind_onshore ?? 0) + (mix?.wind_offshore ?? 0),
      isGreen: true,
    },
    { key: 'hydro', value: mix?.hydro ?? 0, isGreen: true },
    { key: 'biomass', value: mix?.biomass ?? 0, isGreen: true },
    { key: 'nuclear', value: load * 0.2, isGreen: false },
    {
      key: 'gas',
      value: Math.max(0, load * (1 - renPct / 100 - 0.2)),
      isGreen: false,
    },
  ];

  return (
    <div className="space-y-3.5">
      <AbleCard title="Generation mix" subtitle="stacked MW by source">
        {isLoading ? (
          <div className="flex h-[220px] items-center justify-center text-[12px] text-ink-muted">
            Loading…
          </div>
        ) : (
          <>
            <AbleStackedMix
              series={series}
              nowIndex={nowIndex}
              colors={{
                solar: SOURCE_COLORS.solar,
                wind: SOURCE_COLORS.wind,
                hydro: SOURCE_COLORS.hydro,
                biomass: SOURCE_COLORS.biomass,
              }}
            />
            <div className="mt-2.5 flex flex-wrap gap-4 font-mono-num text-[10.5px] text-ink-muted">
              {LEGEND.map((l) => (
                <div key={l.key} className="flex items-center gap-1.5">
                  <span
                    className="h-0.5 w-3.5"
                    style={{ background: SOURCE_COLORS[l.key] }}
                  />
                  <span>{l.label}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </AbleCard>

      <div className="grid gap-3.5 md:grid-cols-[280px_1fr]">
        <AbleCard title="Right now" subtitle="share of generation">
          <div className="flex justify-center py-2">
            <AbleDonut values={donutValues} colors={SOURCE_COLORS} />
          </div>
        </AbleCard>

        <AbleCard title="By source" subtitle="GW · current">
          <SourceTable mix={mix} overview={overview} />
        </AbleCard>
      </div>
    </div>
  );
}
