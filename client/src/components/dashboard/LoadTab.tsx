import { useMemo } from 'react';
import { AbleCard } from './AbleCard';
import { ForecastGapNotice } from './ForecastGapNotice';
import { ForecastVintageNote } from './ForecastVintageNote';
import { describeAutoSelection } from './autoSelection';
import { AbleLineChart } from '@/components/charts/AbleLineChart';
import { AblePriceHeatmap } from '@/components/charts/AblePriceHeatmap';
import { useLoadChartData } from '@/hooks/useLoadChartData';
import type { LoadModelQuery } from '@/hooks/useLoadChartData';
import { useCountries } from '@/hooks/useCountries';
import { useDashboardStore } from '@/store/dashboardStore';
import { useModelSelection } from '@/hooks/useForecastModels';
import { adaptLoadSeries, buildHeatmapCells } from '@/lib/chartAdapters';
import { buildMultiForecastSeries } from '@/lib/multiForecastSeries';
import { describeForecastGapsForSelection } from '@/lib/forecastGap';
import {
  groupWithheldModels,
  isWithheld,
  joinModelLabels,
  WITHHELD_LEGEND_NOTE,
} from './forecastBasisNote';
import { formatGwAxis } from '@/lib/chartTicks';
import { getDateRangeForPreset } from '@/hooks/useDashboardData';
import type { LoadDataPoint, ForecastDataPoint, TSOLoadForecastDataPoint } from '@/types';

type TodayWindow = { start: Date; end: Date } | undefined;

const formatMwOrGw = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} GW` : `${v.toFixed(0)} MW`);

export interface LoadTabProps {
  /**
   * 'tab' (default) was the tab view's body (`CountryDashboardView.tsx`,
   * deleted in Task 9b): two `AbleCard`s, each with its own title
   * ("Electricity load", "Load by hour × day"). 'figure' is the country
   * document's plot slot
   * (docs/superpowers/specs/2026-08-29-country-page-scrolling-document-design.md):
   * one plot per figure, so it renders only the primary "Electricity load"
   * chart, with no `AbleCard` header of its own — the figure supplies the
   * number, title and caption instead — and omits the hour×day heatmap
   * entirely, since that is a second chart, not an annotation on the first.
   * That heatmap has no home in the document at all — Task 9b's switchover
   * dropped it along with the rest of the tab view, not carried elsewhere.
   *
   * Every fetch, the model picker's effect on which forecast draws, gap
   * notices and the withholding logic are identical in both variants; only
   * the chrome around the primary chart changes. Every production caller now
   * passes `variant="figure"` explicitly; 'tab' stays the default only so
   * this file's own pre-9b regression tests keep exercising it with no other
   * call site to break.
   */
  variant?: 'tab' | 'figure';
}

/**
 * Country load chart. Splits into two views exactly the way `NetPositionTab`
 * does (ABL-203) and for the same reason: "nothing checked" (the server's
 * candidate ladder serving one model) and "one or more models explicitly
 * checked" (the picker's comparison mode, ABL-204) are different enough
 * shapes — one line vs. N named lines with a legend — that forcing them
 * through one render path was more conditionals than two components.
 */
export function LoadTab({ variant = 'tab' }: LoadTabProps = {}) {
  const chartData = useLoadChartData();
  const { data: countries } = useCountries();
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const country = countries?.find((c) => c.country_code === selectedCountry);
  const countryLabel = country?.country_name ?? selectedCountry;
  const timePreset = useDashboardStore((s) => s.timePreset);
  const timeOffset = useDashboardStore((s) => s.timeOffset);
  // The data hooks may fetch forecast rows beyond today. Keep the chart's
  // canvas to the actual market day when that is the selected window.
  const todayWindow = useMemo(
    () => (timePreset === 'today' ? getDateRangeForPreset(timePreset, timeOffset) : undefined),
    [timePreset, timeOffset],
  );

  if (chartData.modelSelection.length > 0) {
    return (
      <LoadSelectionView
        entries={chartData.modelSelection}
        loadData={chartData.loadData}
        isLoadingLoad={chartData.isLoadingLoad}
        isError={chartData.isError}
        countryLabel={countryLabel}
        timePreset={timePreset}
        todayWindow={todayWindow}
        variant={variant}
      />
    );
  }

  return (
    <LoadDefaultView
      loadData={chartData.loadData}
      forecastData={chartData.forecastData}
      tsoForecastData={chartData.tsoForecastData}
      basisNote={chartData.forecastBasisNote}
      isLoading={chartData.isLoading}
      countryLabel={countryLabel}
      timePreset={timePreset}
      todayWindow={todayWindow}
      variant={variant}
    />
  );
}

/**
 * "Default" — nothing checked in the picker, so the server's candidate
 * ladder serves (or, with the Forecast toggle off, nothing at all). This is
 * exactly the pre-ABL-204 behaviour, unchanged: `useModelSelection('load')`
 * always resolves unpinned here, because a pin can no longer reach this view
 * — checking any box in the new picker routes to `LoadSelectionView` instead
 * (`selectedIds.length > 0`), so "pinned to exactly one model" and "nothing
 * checked" are no longer the same state the way the old single-select
 * dropdown made them.
 */
function LoadDefaultView({
  loadData,
  forecastData,
  tsoForecastData,
  basisNote,
  isLoading,
  countryLabel,
  timePreset,
  todayWindow,
  variant,
}: {
  loadData: LoadDataPoint[] | undefined;
  forecastData: ForecastDataPoint[] | undefined;
  tsoForecastData: TSOLoadForecastDataPoint[] | undefined;
  basisNote: string | null;
  isLoading: boolean;
  countryLabel: string;
  timePreset: string;
  todayWindow: TodayWindow;
  variant: 'tab' | 'figure';
}) {
  const isFigure = variant === 'figure';
  const { selected, hidden, autoSelected } = useModelSelection('load');
  // A withheld series draws no line, so every claim made about one has to be
  // switched off with it (ABL-501) — the subtitle's "dashed = …", the
  // heatmap's "+ next 2d", and the vintage footnote, which would otherwise be
  // describing a line that is not on the chart.
  const withheld = basisNote !== null;
  const useMl = !hidden && !withheld && selected?.source === 'ml';
  const useTso = !hidden && !withheld && selected?.source === 'tso';
  // Non-null only when this default was auto-selected on measured accuracy
  // (ABL-469) — never for a user pin and never for the no-history fallback.
  //
  // Withheld counts as a fourth case, and it is the one this merge created: a
  // country whose forecast is not on the same basis as its actuals has no
  // attributable accuracy for a default to have been *selected on*, so the
  // sentence would both describe a line that is not drawn and republish, as a
  // credential, the very WAPE ABL-493 suppresses everywhere else.
  const autoNote =
    hidden || withheld ? null : describeAutoSelection(autoSelected, countryLabel);

  const { series, nowIndex } = useMemo(
    () =>
      adaptLoadSeries({
        loadData,
        mlForecast: useMl ? forecastData : undefined,
        tsoForecast: useTso ? tsoForecastData : undefined,
        window: todayWindow,
      }),
    [loadData, forecastData, tsoForecastData, useMl, useTso, todayWindow],
  );

  const heatmapCells = useMemo(
    () =>
      buildHeatmapCells({
        data: loadData ?? [],
        value: (p) => p.load ?? p.avg_load ?? null,
        forecast: useMl ? forecastData : undefined,
      }),
    [loadData, forecastData, useMl],
  );

  const meta = `GW · ${countryLabel} · ENTSO-E${
    useMl ? ' · dashed = able-ml forecast' : useTso ? ' · dashed = ENTSO-E TSO forecast' : ''
  }`;

  return (
    <div className="space-y-3.5">
      <AbleCard title={isFigure ? undefined : 'Electricity load'} subtitle={isFigure ? undefined : meta}>
        {isLoading ? (
          <div className="flex h-[300px] items-center justify-center text-meta text-ink-muted">
            Loading…
          </div>
        ) : (
          <>
            <AbleLineChart
              series={series}
              nowIndex={nowIndex}
              height={300}
              formatAxis={formatGwAxis}
              formatTooltip={formatMwOrGw}
              preset={timePreset}
              label="Electricity load"
            />
            {/* In the figure composition the card carries no header, so the
                "GW · country · dashed = …" line that would otherwise live in
                the title's subtitle is stated here instead — without it, the
                dashed forecast line on the figure would be unlabelled. */}
            {isFigure && <p className="mt-2 text-micro text-ink-muted">{meta}</p>}
            {/* Same expression the chart was built from, so the note is on
                screen exactly when the dashed ML line is (ABL-285). */}
            <ForecastVintageNote
              points={useMl ? forecastData : undefined}
              chartWindow={todayWindow}
            />
            {/* Says why there is no forecast line, in the server's own words
                (ABL-501). Withholding it silently would trade a chart wrong by
                more than 2x for a chart that looks like the model never ran —
                and this repo's rule is that a withheld number is replaced by
                what it would have claimed, never merely deleted. */}
            {basisNote && <p className="mt-2 text-micro text-ink-muted">{basisNote}</p>}
            {/* Mutually exclusive with the note above by construction, not by
                luck: `autoNote` is null whenever `basisNote` is not. */}
            {autoNote && <p className="mt-2 text-micro text-ink-muted">{autoNote}</p>}
          </>
        )}
      </AbleCard>

      {/* One plot per figure (docs/superpowers/specs/2026-08-29-country-page-scrolling-document-design.md):
          the hour×day heatmap is a second chart, not an annotation on the
          line above, so the figure composition omits it entirely. */}
      {!isFigure && (
        <AbleCard
          title="Load by hour × day"
          subtitle={useMl ? 'darker = higher · past 4d + next 2d' : 'darker = higher · past 4d'}
        >
          <AblePriceHeatmap cells={heatmapCells} unit="MW" />
        </AbleCard>
      )}
    </div>
  );
}

/**
 * One or more models explicitly checked in the picker (ABL-204). Every entry
 * is its own request, pinned to its own model id, mixing ml and tso sources
 * freely — `load` is the one forecast type where a selection can hold both.
 */
function LoadSelectionView({
  entries,
  loadData,
  isLoadingLoad,
  isError,
  countryLabel,
  timePreset,
  todayWindow,
  variant,
}: {
  entries: LoadModelQuery[];
  loadData: LoadDataPoint[] | undefined;
  isLoadingLoad: boolean;
  isError: boolean;
  countryLabel: string;
  timePreset: string;
  todayWindow: TodayWindow;
  variant: 'tab' | 'figure';
}) {
  const isFigure = variant === 'figure';
  const isLoading = isLoadingLoad || entries.some((e) => e.isLoading);

  const { series, nowIndex, forecastSeries } = useMemo(
    () =>
      buildMultiForecastSeries({
        actual: loadData,
        actualValue: (p) => p.load ?? p.avg_load ?? null,
        entries: entries.map((e) => ({
          ...e,
          withheldNote: isWithheld(e) ? WITHHELD_LEGEND_NOTE : null,
        })),
        countryLabel,
        window: todayWindow,
      }),
    [loadData, entries, countryLabel, todayWindow],
  );

  // Withheld models are held out of the gap list entirely, not relabelled
  // inside it (ABL-501). `describeForecastGapsForSelection` says "<model> has
  // no forecast for <country> in this window", which is false here — the rows
  // exist and we are choosing not to draw them — and it offers a "Remove from
  // comparison" button whose premise is that another model might cover the
  // country. Keeping the two lists separate is what stops this fix from
  // introducing a fresh confidently-wrong sentence.
  const withheldGroups = useMemo(() => groupWithheldModels(entries), [entries]);
  const gaps = useMemo(
    () =>
      describeForecastGapsForSelection(
        entries
          .filter((e) => !isWithheld(e))
          .map((e) => ({
            id: e.id,
            label: e.label,
            color: e.color,
            isLoading: e.isLoading,
            isError: e.isError,
            pointCount: e.points?.length ?? 0,
          })),
        countryLabel,
      ),
    [entries, countryLabel],
  );

  // Feeds the heatmap's next-2-days cells from whichever checked model has
  // rows — with several checked, there is no single "the" forecast to prefer,
  // so the first covered one stands in. The main chart above is unaffected;
  // this only governs the heatmap's future cells.
  const heatmapForecastEntry = useMemo(() => entries.find((e) => (e.points?.length ?? 0) > 0), [entries]);

  const heatmapCells = useMemo(
    () =>
      buildHeatmapCells({
        data: loadData ?? [],
        value: (p) => p.load ?? p.avg_load ?? null,
        forecast: heatmapForecastEntry?.points,
      }),
    [loadData, heatmapForecastEntry],
  );

  const hasBand = forecastSeries.length === 1 && series.some((p) => p.min != null && p.max != null);
  const meta = `GW · ${countryLabel} · ENTSO-E · comparing ${entries.length} forecast model${entries.length === 1 ? '' : 's'}`;

  return (
    <div className="space-y-3.5">
      <AbleCard title={isFigure ? undefined : 'Electricity load'} subtitle={isFigure ? undefined : meta}>
        {isLoading ? (
          <div className="flex h-[300px] items-center justify-center text-meta text-ink-muted">
            Loading…
          </div>
        ) : isError ? (
          <div className="flex h-[300px] items-center justify-center text-meta text-ink-muted">
            Could not load electricity load.
          </div>
        ) : (
          <>
            <AbleLineChart
              series={series}
              nowIndex={nowIndex}
              height={300}
              formatAxis={formatGwAxis}
              formatTooltip={formatMwOrGw}
              preset={timePreset}
              label="Electricity load"
              forecastSeries={forecastSeries}
            />
            {/* See LoadDefaultView's identical comment: no card header in the
                figure composition means this line has nowhere else to live. */}
            {isFigure && <p className="mt-2 text-micro text-ink-muted">{meta}</p>}
            {hasBand && (
              <p className="mt-2 text-micro text-ink-muted">shaded band = ENTSO-E week-ahead daily min/max</p>
            )}
          </>
        )}

        {withheldGroups.map((group) => (
          <p key={group.note} className="mt-2 text-micro text-ink-muted">
            {joinModelLabels(group.labels)}: {group.note}
          </p>
        ))}

        {gaps.length > 0 && (
          <p className="mt-2 text-micro text-ink-muted">
            {gaps.length} of {entries.length} selected models {gaps.length === 1 ? 'is' : 'are'} not available in{' '}
            {countryLabel}.
          </p>
        )}
        <ForecastGapNotice gaps={gaps} forecastType="load" />
      </AbleCard>

      {/* One plot per figure — see LoadDefaultView's identical comment. */}
      {!isFigure && (
        <AbleCard
          title="Load by hour × day"
          subtitle={heatmapForecastEntry ? 'darker = higher · past 4d + next 2d' : 'darker = higher · past 4d'}
        >
          <AblePriceHeatmap cells={heatmapCells} unit="MW" />
        </AbleCard>
      )}
    </div>
  );
}
