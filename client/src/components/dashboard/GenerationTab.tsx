import { useMemo } from 'react';
import { AbleCard } from './AbleCard';
import { AbleStackedMix } from '@/components/charts/AbleStackedMix';
import { AbleDonut } from '@/components/charts/AbleDonut';
import { SourceTable } from './SourceTable';
import { buildSourceRows, type SourceRow } from './sourceRows';
import {
  buildGenerationMixSeries,
  describeNegativeGroups,
  GENERATION_GROUP_COLORS,
  GENERATION_GROUP_LABELS,
} from './generationSeries';
import { getDateRangeForPreset, useGenerationMix, useGenerationSeries } from '@/hooks/useDashboardData';
import { useDashboardStore } from '@/store/dashboardStore';

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
  // Both queries read energy_generation through the same nine-family grouping
  // (ABL-44). Before that the trend came from the frozen, renewable-only
  // energy_renewable while the donut and table came from the full A75
  // document, so one card carried two different mixes and the chart had no
  // nuclear or fossil band at all.
  const { data: seriesData, isLoading, isError } = useGenerationSeries();
  const { data: mix, isLoading: mixLoading, isError: mixError } = useGenerationMix();
  const timePreset = useDashboardStore((s) => s.timePreset);
  const timeOffset = useDashboardStore((s) => s.timeOffset);
  const todayWindow = useMemo(
    () => (timePreset === 'today' ? getDateRangeForPreset(timePreset, timeOffset) : undefined),
    [timePreset, timeOffset],
  );

  const { points, groups, nowIndex, negativeGroups } = useMemo(
    () => buildGenerationMixSeries(seriesData, new Date(), todayWindow),
    [seriesData, todayWindow],
  );
  const negativeNote = describeNegativeGroups(negativeGroups);

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
          <div className="flex h-[220px] items-center justify-center text-meta text-ink-muted">
            Loading…
          </div>
        ) : isError ? (
          <div className="flex h-[220px] items-center justify-center text-center text-meta text-ink-muted">
            Generation series unavailable.
          </div>
        ) : (
          <>
            <AbleStackedMix
              series={points}
              keys={groups}
              labels={GENERATION_GROUP_LABELS}
              colors={GENERATION_GROUP_COLORS}
              nowIndex={nowIndex}
              preset={timePreset}
            />
            {/*
              The legend lists only the groups actually drawn. A country that
              does not report nuclear gets no nuclear swatch, rather than a
              swatch above an invisible band — which would read as "nuclear,
              zero" instead of "we have not been told".
            */}
            <div className="mt-2.5 flex flex-wrap gap-4 font-mono-num text-micro text-ink-muted">
              {groups.map((key) => (
                <div key={key} className="flex items-center gap-1.5">
                  <span
                    className="h-0.5 w-3.5"
                    style={{ background: GENERATION_GROUP_COLORS[key] }}
                  />
                  <span>{GENERATION_GROUP_LABELS[key]}</span>
                </div>
              ))}
            </div>
            {negativeNote && (
              <p className="mt-2 border-t border-input pt-2 text-micro text-ink-muted">
                {negativeNote}
              </p>
            )}
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
            <div className="flex h-[180px] items-center justify-center text-meta text-ink-muted">
              Loading…
            </div>
          ) : mixError || !mix || mix.renewable_percentage == null || totalMw == null || totalMw <= 0 ? (
            <div className="flex h-[180px] items-center justify-center text-center text-meta text-ink-muted">
              Generation mix unavailable.
            </div>
          ) : (
            <div className="flex justify-center py-2">
              <AbleDonut values={donutValues} pct={mix.renewable_percentage} colors={GENERATION_GROUP_COLORS} />
            </div>
          )}
        </AbleCard>

        <AbleCard title="By source" subtitle="GW · window average">
          {mixLoading ? (
            <div className="flex h-[180px] items-center justify-center text-meta text-ink-muted">
              Loading…
            </div>
          ) : mixError || !mix ? (
            <div className="flex h-[180px] items-center justify-center text-center text-meta text-ink-muted">
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
