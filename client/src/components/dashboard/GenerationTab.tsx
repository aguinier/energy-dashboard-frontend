import { useMemo } from 'react';
import { AbleCard } from './AbleCard';
import { AbleStackedMix } from '@/components/charts/AbleStackedMix';
import { AbleDonut } from '@/components/charts/AbleDonut';
import { SourceTable } from './SourceTable';
import { buildSourceRows } from './sourceRows';
import { useRenewableChartData } from '@/hooks/useRenewableChartData';
import {
  useDashboardOverview,
  useRenewableMix,
} from '@/hooks/useDashboardData';
import { adaptRenewableMixSeries } from '@/lib/chartAdapters';

// Keep in sync with AbleStackedMix DEFAULT_COLORS (validated palette).
const SOURCE_COLORS = {
  solar: '#D9A114',
  wind: '#4D89C9',
  hydro: '#2FA39C',
  biomass: '#73A35F',
  unattributed: '#D8D4CC',
};

const LEGEND: Array<{ key: keyof typeof SOURCE_COLORS; label: string }> = [
  { key: 'solar', label: 'Solar' },
  { key: 'wind', label: 'Wind' },
  { key: 'hydro', label: 'Hydro' },
  { key: 'biomass', label: 'Biomass' },
];

export function GenerationTab() {
  const { renewableData, isLoading } = useRenewableChartData();
  const { data: mix, isLoading: mixLoading, isError: mixError } = useRenewableMix();
  const { data: overview, isLoading: overviewLoading } = useDashboardOverview();

  const { series, nowIndex } = useMemo(
    () => adaptRenewableMixSeries(renewableData),
    [renewableData],
  );

  // Donut input — measured renewable mix plus the unattributed remainder of
  // load. Derived from buildSourceRows so the donut and SourceTable can never
  // disagree about what the remainder is.
  const { rows, unattributedMw } = useMemo(
    () => buildSourceRows(mix, overview?.currentLoad ?? null),
    [mix, overview?.currentLoad],
  );

  // `unattributedMw` is null whenever load is unmeasurable for this window
  // (buildSourceRows deliberately refuses to guess). Coercing that to 0 would
  // make every remaining slice green and the donut print a false "100%
  // renewable" — so the donut is built only once a real remainder exists;
  // see the `unattributedMw == null` guard below.
  const donutValues = [
    ...rows.map((r) => ({ key: r.key, value: r.mw, isGreen: true })),
    // The rest of load. Not "gas" — nothing in the DB says what it is.
    { key: 'unattributed', value: unattributedMw ?? 0, isGreen: false },
  ];

  return (
    <div className="space-y-3.5">
      <AbleCard title="Generation mix" subtitle="GW · stacked by source · ENTSO-E">
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
        <AbleCard title="Window average" subtitle="share of load · measured sources only">
          {mixLoading || overviewLoading ? (
            <div className="flex h-[180px] items-center justify-center text-[12px] text-ink-muted">
              Loading…
            </div>
          ) : mixError || !mix || unattributedMw == null ? (
            <div className="flex h-[180px] items-center justify-center text-center text-[12px] text-ink-muted">
              Generation mix unavailable.
            </div>
          ) : (
            <div className="flex justify-center py-2">
              <AbleDonut values={donutValues} colors={SOURCE_COLORS} />
            </div>
          )}
        </AbleCard>

        <AbleCard title="By source" subtitle="GW · window average">
          {mixLoading ? (
            <div className="flex h-[180px] items-center justify-center text-[12px] text-ink-muted">
              Loading…
            </div>
          ) : mixError || !mix ? (
            <div className="flex h-[180px] items-center justify-center text-center text-[12px] text-ink-muted">
              Generation mix unavailable.
            </div>
          ) : (
            <SourceTable mix={mix} overview={overview} />
          )}
        </AbleCard>
      </div>
    </div>
  );
}
