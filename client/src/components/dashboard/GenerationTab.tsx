import { useMemo } from 'react';
import { AbleCard } from './AbleCard';
import { AbleStackedMix } from '@/components/charts/AbleStackedMix';
import { AbleDonut } from '@/components/charts/AbleDonut';
import { SourceTable } from './SourceTable';
import { buildSourceRows, type SourceRow } from './sourceRows';
import {
  buildGenerationMixSeries,
  describeNegativeGroups,
  describeGenerationGaps,
  GENERATION_GROUP_COLORS,
  GENERATION_GROUP_LABELS,
} from './generationSeries';
import { describeSolarCoverage } from './solarCoverageNote';
import { getDateRangeForPreset, useGenerationMix, useGenerationSeries } from '@/hooks/useDashboardData';
import { useCountries } from '@/hooks/useCountries';
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

export interface GenerationTabProps {
  /**
   * 'tab' (default) is the existing `CountryDashboardView` tab body: the
   * "Generation mix" `AbleCard` carries its own title/subtitle, and the
   * "Window average" donut / "By source" table pair renders below it.
   * 'figure' is the country document's plot slot
   * (docs/superpowers/specs/2026-08-29-country-page-scrolling-document-design.md):
   * one plot per figure, so only the stacked-mix trend draws — no `AbleCard`
   * header, and the donut/table pair (a second and third chart, not an
   * annotation on the trend) is omitted entirely, the same way `LoadTab`
   * drops its hour×day heatmap. Default omitted so the existing caller
   * (`CountryDashboardView`) is unaffected.
   */
  variant?: 'tab' | 'figure';
}

export function GenerationTab({ variant = 'tab' }: GenerationTabProps = {}) {
  const isFigure = variant === 'figure';
  // Both queries read energy_generation through the same nine-family grouping
  // (ABL-44). Before that the trend came from the frozen, renewable-only
  // energy_renewable while the donut and table came from the full A75
  // document, so one card carried two different mixes and the chart had no
  // nuclear or fossil band at all.
  const { data: seriesData, isLoading, isError } = useGenerationSeries();
  const { data: mix, isLoading: mixLoading, isError: mixError } = useGenerationMix();
  const timePreset = useDashboardStore((s) => s.timePreset);
  const timeOffset = useDashboardStore((s) => s.timeOffset);
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const { data: countries } = useCountries();
  const countryLabel =
    countries?.find((c) => c.country_code === selectedCountry)?.country_name ?? selectedCountry;
  const todayWindow = useMemo(
    () => (timePreset === 'today' ? getDateRangeForPreset(timePreset, timeOffset) : undefined),
    [timePreset, timeOffset],
  );

  const { points, groups, nowIndex, negativeGroups } = useMemo(
    () => buildGenerationMixSeries(seriesData, new Date(), todayWindow),
    [seriesData, todayWindow],
  );
  const negativeNote = describeNegativeGroups(negativeGroups);
  // Real gaps, named rather than silently interpolated (`AbleStackedMix`
  // hatches the same holes rather than drawing a line through them — see
  // `lib/stackedMixGaps.ts`). Independent of `variant`: this is a fact about
  // the data, not something the figure composition should suppress.
  const gapNote = useMemo(() => describeGenerationGaps(points), [points]);

  // Donut input — the full measured mix, shared with SourceTable via
  // buildSourceRows so the two can never disagree about what's measured or
  // what each row's share means.
  const { rows, totalMw } = useMemo(() => buildSourceRows(mix ?? undefined), [mix]);

  // ABL-325. Sits above every mark on this tab because it qualifies all of
  // them at once: the Solar band in the trend, the solar arc in the donut, the
  // Solar row in the table, and - because solar sums into the server's
  // renewable numerator - the donut's centre percentage too. Null for every
  // country whose reported solar matches ENTSO-E's own forecast of it, which
  // measured on 2026-08-12 is all of Europe except NL.
  const solarNote = useMemo(
    () => describeSolarCoverage(mix ?? undefined, countryLabel),
    [mix, countryLabel],
  );

  // The legend and the trend chart have to agree with the by-source table,
  // which qualifies its own Solar row inside buildSourceRows. One override
  // rather than two copies of the string.
  const groupLabels = useMemo(
    () =>
      solarNote
        ? { ...GENERATION_GROUP_LABELS, solar: `Solar (${solarNote.labelQualifier})` }
        : GENERATION_GROUP_LABELS,
    [solarNote],
  );

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
      {/*
        Above the charts, not tucked under them. This is the one thing a reader
        of this card has to know before reading any number on it — a Solar band
        at 0.9% of the Dutch mix in high summer is not a small solar fleet, it
        is a partial measurement, and a caveat placed after the chart is a
        caveat read second.
      */}
      {solarNote && (
        <div
          role="note"
          className="rounded-md border border-input bg-secondary/40 px-3.5 py-3 text-meta text-ink-dim"
        >
          <p className="font-medium text-ink">{solarNote.headline}</p>
          <p className="mt-1 text-micro text-ink-muted">{solarNote.detail}</p>
        </div>
      )}

      <AbleCard
        title={isFigure ? undefined : 'Generation mix'}
        subtitle={isFigure ? undefined : 'GW · stacked by source · ENTSO-E'}
      >
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
              labels={groupLabels}
              colors={GENERATION_GROUP_COLORS}
              nowIndex={nowIndex}
              preset={timePreset}
            />
            {/* In the figure composition the card carries no header, so the
                "GW · stacked by source · ENTSO-E" line that would otherwise
                live in the title's subtitle is stated here instead — see
                LoadTab.tsx's identical treatment. */}
            {isFigure && (
              <p className="mt-2 text-micro text-ink-muted">GW · stacked by source · ENTSO-E</p>
            )}
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
                  <span>{groupLabels[key]}</span>
                </div>
              ))}
            </div>
            {negativeNote && (
              <p className="mt-2 border-t border-input pt-2 text-micro text-ink-muted">
                {negativeNote}
              </p>
            )}
            {/* Real holes, not interpolated (see `gapNote` above). Its own
                paragraph rather than folded into `negativeNote`: one names a
                sign convention, the other names missing data, and conflating
                them would bury the more serious of the two claims. */}
            {gapNote && (
              <p className="mt-2 border-t border-input pt-2 text-micro text-ink-muted">
                {gapNote}
              </p>
            )}
          </>
        )}
      </AbleCard>

      {/* One plot per figure (docs/superpowers/specs/2026-08-29-country-page-scrolling-document-design.md):
          the renewable-share donut and by-source table are a second and
          third chart, not an annotation on the trend above, so the figure
          composition omits them entirely — same treatment as LoadTab's
          hour×day heatmap. */}
      {!isFigure && (
        /*
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
        */
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
      )}
    </div>
  );
}
