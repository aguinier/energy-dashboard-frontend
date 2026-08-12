import { useMemo } from 'react';
import { AbleCard } from './AbleCard';
import { ForecastGapNotice } from './ForecastGapNotice';
import { ForecastVintageNote } from './ForecastVintageNote';
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
import { formatGwAxis } from '@/lib/chartTicks';
import { getDateRangeForPreset } from '@/hooks/useDashboardData';
import type { LoadDataPoint, ForecastDataPoint, TSOLoadForecastDataPoint } from '@/types';

type TodayWindow = { start: Date; end: Date } | undefined;

const formatMwOrGw = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} GW` : `${v.toFixed(0)} MW`);

/**
 * Country load chart. Splits into two views exactly the way `NetPositionTab`
 * does (ABL-203) and for the same reason: "nothing checked" (the server's
 * candidate ladder serving one model) and "one or more models explicitly
 * checked" (the picker's comparison mode, ABL-204) are different enough
 * shapes — one line vs. N named lines with a legend — that forcing them
 * through one render path was more conditionals than two components.
 */
export function LoadTab() {
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
      />
    );
  }

  return (
    <LoadDefaultView
      loadData={chartData.loadData}
      forecastData={chartData.forecastData}
      tsoForecastData={chartData.tsoForecastData}
      isLoading={chartData.isLoading}
      countryLabel={countryLabel}
      timePreset={timePreset}
      todayWindow={todayWindow}
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
  isLoading,
  countryLabel,
  timePreset,
  todayWindow,
}: {
  loadData: LoadDataPoint[] | undefined;
  forecastData: ForecastDataPoint[] | undefined;
  tsoForecastData: TSOLoadForecastDataPoint[] | undefined;
  isLoading: boolean;
  countryLabel: string;
  timePreset: string;
  todayWindow: TodayWindow;
}) {
  const { selected, hidden } = useModelSelection('load');
  const useMl = !hidden && selected?.source === 'ml';
  const useTso = !hidden && selected?.source === 'tso';

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

  return (
    <div className="space-y-3.5">
      <AbleCard
        title="Electricity load"
        subtitle={`GW · ${countryLabel} · ENTSO-E${
          useMl
            ? ' · dashed = able-ml forecast'
            : useTso
            ? ' · dashed = ENTSO-E TSO forecast'
            : ''
        }`}
      >
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
            {/* Same expression the chart was built from, so the note is on
                screen exactly when the dashed ML line is (ABL-285). */}
            <ForecastVintageNote
              points={useMl ? forecastData : undefined}
              chartWindow={todayWindow}
            />
          </>
        )}
      </AbleCard>

      <AbleCard
        title="Load by hour × day"
        subtitle={useMl ? 'darker = higher · past 4d + next 2d' : 'darker = higher · past 4d'}
      >
        <AblePriceHeatmap cells={heatmapCells} unit="MW" />
      </AbleCard>
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
}: {
  entries: LoadModelQuery[];
  loadData: LoadDataPoint[] | undefined;
  isLoadingLoad: boolean;
  isError: boolean;
  countryLabel: string;
  timePreset: string;
  todayWindow: TodayWindow;
}) {
  const isLoading = isLoadingLoad || entries.some((e) => e.isLoading);

  const { series, nowIndex, forecastSeries } = useMemo(
    () =>
      buildMultiForecastSeries({
        actual: loadData,
        actualValue: (p) => p.load ?? p.avg_load ?? null,
        entries,
        countryLabel,
        window: todayWindow,
      }),
    [loadData, entries, countryLabel, todayWindow],
  );

  const gaps = useMemo(
    () =>
      describeForecastGapsForSelection(
        entries.map((e) => ({
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

  return (
    <div className="space-y-3.5">
      <AbleCard
        title="Electricity load"
        subtitle={`GW · ${countryLabel} · ENTSO-E · comparing ${entries.length} forecast model${entries.length === 1 ? '' : 's'}`}
      >
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
            {hasBand && (
              <p className="mt-2 text-micro text-ink-muted">shaded band = ENTSO-E week-ahead daily min/max</p>
            )}
          </>
        )}

        {gaps.length > 0 && (
          <p className="mt-2 text-micro text-ink-muted">
            {gaps.length} of {entries.length} selected models {gaps.length === 1 ? 'is' : 'are'} not available in{' '}
            {countryLabel}.
          </p>
        )}
        <ForecastGapNotice gaps={gaps} forecastType="load" />
      </AbleCard>

      <AbleCard
        title="Load by hour × day"
        subtitle={heatmapForecastEntry ? 'darker = higher · past 4d + next 2d' : 'darker = higher · past 4d'}
      >
        <AblePriceHeatmap cells={heatmapCells} unit="MW" />
      </AbleCard>
    </div>
  );
}
