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

// Which arcs AbleDonut colors green - cosmetic only. The printed "% RENEWABLE"
// figure comes from the server (mix.renewable_percentage, see below), not
// from these flags, so this set no longer needs to match the server's
// renewable definition exactly to keep the number honest. It's narrower than
// that definition on purpose: this card's "Other" row (see sourceRows.ts)
// bundles geothermal/marine/other_renewable - which the server does count as
// renewable - together with non-renewable energy_storage and ENTSO-E's
// unclassified "Other" type, so coloring it green would misrepresent the two
// non-renewable members it also contains.
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
  // null. `mix.renewable_percentage` (server-computed) is null in exactly
  // the same cases, so the two gates below agree; both are checked as
  // belt-and-suspenders so the donut never renders off a partial/degenerate
  // state either query could theoretically produce on its own.
  const donutValues = rows.map((r) => ({
    // AbleDonut's arcs are a proportion of a positive total, drawn purely for
    // the visual breakdown - a row can be genuinely negative (pumped storage
    // net-charging, a stray consumption-only fossil reading) but that isn't
    // a slice to draw, so it contributes 0 here while SourceTable still
    // shows the true signed value. The centre percentage AbleDonut prints no
    // longer comes from these values (see `pct` below) - only arc widths do.
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
        The header stat row's "Renewable share" tile and this donut used to
        disagree: the header divided by load (a different denominator) using
        a mean of per-hour ratios (a different aggregation), while the donut
        summed this card's own window-average rows. Both now read
        `renewable_percentage` from generationService.getRenewableShare - a
        single server-side ratio of window sums (renewable ÷ total positive
        generation, from energy_generation) that the header, the map, and
        this donut all consume rather than recompute. They cannot drift
        apart, so the subtitle only needs to state the denominator, not
        explain a discrepancy.
      */}
      <div className="grid gap-3.5 md:grid-cols-[280px_1fr]">
        <AbleCard title="Window average" subtitle="share of generation">
          {mixLoading ? (
            <div className="flex h-[180px] items-center justify-center text-[12px] text-ink-muted">
              Loading…
            </div>
          ) : mixError || !mix || mix.renewable_percentage == null || totalMw == null || totalMw <= 0 ? (
            <div className="flex h-[180px] items-center justify-center text-center text-[12px] text-ink-muted">
              Generation mix unavailable.
            </div>
          ) : (
            <div className="flex justify-center py-2">
              <AbleDonut values={donutValues} pct={mix.renewable_percentage} colors={SOURCE_COLORS} />
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
