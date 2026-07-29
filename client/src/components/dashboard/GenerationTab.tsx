import { useMemo } from 'react';
import { AbleCard } from './AbleCard';
import { AbleStackedMix } from '@/components/charts/AbleStackedMix';
import { AbleDonut } from '@/components/charts/AbleDonut';
import { SourceTable } from './SourceTable';
import { buildSourceRows, type SourceRow } from './sourceRows';
import { useRenewableChartData } from '@/hooks/useRenewableChartData';
import { useGenerationMix } from '@/hooks/useDashboardData';
import { adaptRenewableMixSeries } from '@/lib/chartAdapters';

// Keep in sync with AbleStackedMix DEFAULT_COLORS (validated palette). The
// top chart still only plots the 4 renewable types (unchanged, out of scope
// for the A75 work), so those 4 keys must stay exactly as they were.
const SOURCE_COLORS: Record<SourceRow['key'], string> = {
  solar: '#D9A114',
  wind: '#4D89C9',
  hydro: '#2FA39C',
  biomass: '#73A35F',
  nuclear: '#C2665A',
  hydroPumped: '#7FBFB9',
  fossil: '#6B6459',
  waste: '#A98F5D',
  other: '#B7AFA0',
};

const LEGEND: Array<{ key: 'solar' | 'wind' | 'hydro' | 'biomass'; label: string }> = [
  { key: 'solar', label: 'Solar' },
  { key: 'wind', label: 'Wind' },
  { key: 'hydro', label: 'Hydro' },
  { key: 'biomass', label: 'Biomass' },
];

// Only these rows count toward the donut's "% RENEWABLE" figure. Nuclear,
// fossil, waste, pumped storage and the "other" bucket (which mixes storage
// and ENTSO-E's own unclassified "Other" type) are all real generation now
// that they're measured, but none of them are renewable - flagging any of
// them green would inflate the percentage AbleDonut prints.
const GREEN_KEYS = new Set<SourceRow['key']>(['solar', 'wind', 'hydro', 'biomass']);

export function GenerationTab() {
  const { renewableData, isLoading } = useRenewableChartData();
  const { data: mix, isLoading: mixLoading, isError: mixError } = useGenerationMix();

  const { series, nowIndex } = useMemo(
    () => adaptRenewableMixSeries(renewableData),
    [renewableData],
  );

  // Donut input — the full measured mix, shared with SourceTable via
  // buildSourceRows so the two can never disagree about what's measured or
  // what each row's share means.
  const { rows, totalMw } = useMemo(() => buildSourceRows(mix ?? undefined), [mix]);

  // `totalMw` is null until the mix loads, and (in the degenerate case of no
  // positive generation at all) can be zero — either way buildSourceRows
  // already refused to compute a share, leaving every row's pctOfGeneration
  // null. Building the donut anyway would divide 0/0 and could print a false
  // "100% renewable", so it's gated on a real, positive total instead.
  const donutValues = rows.map((r) => ({
    // AbleDonut's arcs are a proportion of a positive total; a row can be
    // genuinely negative (pumped storage net-charging, a stray
    // consumption-only fossil reading) but that isn't a slice to draw, so it
    // contributes 0 to the donut while SourceTable still shows the true
    // signed value. This is exactly the sum `totalMw` above uses as its
    // denominator, so the donut's printed percentage and SourceTable's rows
    // always agree.
    key: r.key,
    value: Math.max(0, r.mw ?? 0),
    isGreen: GREEN_KEYS.has(r.key),
  }));

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

      {/*
        The header stat row's "Renewable share" tile is renewables ÷ load
        (server-computed, dashboardService.ts) - a different question from
        this donut, which is renewables ÷ total measured generation (see
        sourceRows.ts). The two numbers can legitimately differ (France
        exports, so its generation-based share reads lower than a
        load-based one would once nuclear dominates the mix). Rather than
        forcing them to the same definition - the header's covers every tab,
        not just this one, and load-based renewable share is itself a
        standard grid metric - this card's subtitle says "share of
        generation · not of load" so a reader never has to guess which
        question either number is answering.
      */}
      <div className="grid gap-3.5 md:grid-cols-[280px_1fr]">
        <AbleCard title="Window average" subtitle="share of generation · not of load">
          {mixLoading ? (
            <div className="flex h-[180px] items-center justify-center text-[12px] text-ink-muted">
              Loading…
            </div>
          ) : mixError || !mix || totalMw == null || totalMw <= 0 ? (
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
            <SourceTable mix={mix} />
          )}
        </AbleCard>
      </div>
    </div>
  );
}
