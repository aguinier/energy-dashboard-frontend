import { useMemo } from 'react';
import { AbleCard } from './AbleCard';
import { ForecastGapNotice } from './ForecastGapNotice';
import { ForecastVintageNote } from './ForecastVintageNote';
import { AbleLineChart } from '@/components/charts/AbleLineChart';
import { AblePriceHeatmap } from '@/components/charts/AblePriceHeatmap';
import { usePriceChartData } from '@/hooks/usePriceChartData';
import type { PriceModelQuery } from '@/hooks/usePriceChartData';
import { useCountries } from '@/hooks/useCountries';
import { useDashboardStore } from '@/store/dashboardStore';
import { adaptPriceSeries, buildHeatmapCells } from '@/lib/chartAdapters';
import { buildMultiForecastSeries } from '@/lib/multiForecastSeries';
import { describeForecastGapsForSelection } from '@/lib/forecastGap';
import { getDateRangeForPreset } from '@/hooks/useDashboardData';
import type { PriceDataPoint, ForecastDataPoint } from '@/types';

type TodayWindow = { start: Date; end: Date } | undefined;

export interface PriceTabProps {
  /**
   * 'tab' (default) was the tab view's body (`CountryDashboardView.tsx`,
   * deleted in Task 9b): two `AbleCard`s, "Day-ahead spot price" and "Price by
   * hour × day". 'figure' is the country document's plot slot
   * (docs/superpowers/specs/2026-08-29-country-page-scrolling-document-design.md):
   * one plot per figure, so it renders only the primary chart, with no
   * `AbleCard` header of its own, and omits the hour×day heatmap entirely —
   * that heatmap has no home in the document at all, dropped along with the
   * rest of the tab view. See `LoadTab.tsx`'s identical prop for the full
   * rationale, including why 'tab' stays the default with no production
   * caller left.
   */
  variant?: 'tab' | 'figure';
}

/**
 * Day-ahead price chart. Same default/selection split as `LoadTab` (ABL-204)
 * — price never registers a TSO model, so the selection view here never
 * branches on source the way Load's does.
 */
export function PriceTab({ variant = 'tab' }: PriceTabProps = {}) {
  const chartData = usePriceChartData();
  const { data: countries } = useCountries();
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const country = countries?.find((c) => c.country_code === selectedCountry);
  const countryLabel = country?.country_name ?? selectedCountry;
  const timePreset = useDashboardStore((s) => s.timePreset);
  const timeOffset = useDashboardStore((s) => s.timeOffset);
  // Price fetches intentionally include tomorrow's day-ahead auction rows;
  // selecting Today must not let those rows expand today's graph.
  const todayWindow = useMemo(
    () => (timePreset === 'today' ? getDateRangeForPreset(timePreset, timeOffset) : undefined),
    [timePreset, timeOffset],
  );

  if (chartData.modelSelection.length > 0) {
    return (
      <PriceSelectionView
        entries={chartData.modelSelection}
        priceData={chartData.priceData}
        isLoadingPrice={chartData.isLoadingPrice}
        isError={chartData.isError}
        countryLabel={countryLabel}
        timePreset={timePreset}
        todayWindow={todayWindow}
        variant={variant}
      />
    );
  }

  return (
    <PriceDefaultView
      priceData={chartData.priceData}
      forecastData={chartData.forecastData}
      isLoading={chartData.isLoading}
      countryLabel={countryLabel}
      timePreset={timePreset}
      todayWindow={todayWindow}
      variant={variant}
    />
  );
}

/** "Default" — nothing checked, so the server's candidate ladder serves. Unchanged from before ABL-204; see LoadTab.tsx's `LoadDefaultView` for why a pin can no longer reach this view. */
function PriceDefaultView({
  priceData,
  forecastData,
  isLoading,
  countryLabel,
  timePreset,
  todayWindow,
  variant,
}: {
  priceData: PriceDataPoint[] | undefined;
  forecastData: ForecastDataPoint[] | undefined;
  isLoading: boolean;
  countryLabel: string;
  timePreset: string;
  todayWindow: TodayWindow;
  variant: 'tab' | 'figure';
}) {
  const isFigure = variant === 'figure';
  const { series, nowIndex } = useMemo(
    () => adaptPriceSeries(priceData, forecastData, todayWindow),
    [priceData, forecastData, todayWindow],
  );
  const hasForecast = useMemo(() => series.some((p) => p.forecast != null), [series]);

  const heatmapCells = useMemo(
    () =>
      buildHeatmapCells({
        data: priceData,
        value: (p) => p.price,
        forecast: forecastData,
      }),
    [priceData, forecastData],
  );
  const hasFutureCells = useMemo(
    () => heatmapCells.some((c) => c.future && c.value != null),
    [heatmapCells],
  );

  const meta = `€/MWh · ${countryLabel} · EPEX${hasForecast ? ' · dashed = able-ml forecast' : ''}`;

  return (
    <div className="space-y-3.5">
      <AbleCard title={isFigure ? undefined : 'Day-ahead spot price'} subtitle={isFigure ? undefined : meta}>
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
              formatAxis={(v) => v.toFixed(0)}
              formatTooltip={(v) => `€${v.toFixed(1)}`}
              unit="/MWh"
              preset={timePreset}
              label="Day-ahead price"
            />
            {/* In the figure composition the card carries no header, so the
                "€/MWh · country · EPEX · dashed = …" line that would otherwise
                live in the title's subtitle is stated here instead — see
                LoadTab.tsx's identical treatment. */}
            {isFigure && <p className="mt-2 text-micro text-ink-muted">{meta}</p>}
            {/* Same expression the chart was built from, so the note is on
                screen exactly when the dashed ML line is (ABL-285). */}
            <ForecastVintageNote points={forecastData} chartWindow={todayWindow} />
          </>
        )}
      </AbleCard>

      {/* One plot per figure (docs/superpowers/specs/2026-08-29-country-page-scrolling-document-design.md):
          the hour×day heatmap is a second chart, not an annotation on the
          line above, so the figure composition omits it entirely. */}
      {!isFigure && (
        <AbleCard
          title="Price by hour × day"
          subtitle={hasFutureCells ? 'darker = higher · past 4d + next 2d' : 'darker = higher · past 4d'}
        >
          <AblePriceHeatmap cells={heatmapCells} unit="€/MWh" />
        </AbleCard>
      )}
    </div>
  );
}

/** One or more models explicitly checked in the picker (ABL-204). */
function PriceSelectionView({
  entries,
  priceData,
  isLoadingPrice,
  isError,
  countryLabel,
  timePreset,
  todayWindow,
  variant,
}: {
  entries: PriceModelQuery[];
  priceData: PriceDataPoint[] | undefined;
  isLoadingPrice: boolean;
  isError: boolean;
  countryLabel: string;
  timePreset: string;
  todayWindow: TodayWindow;
  variant: 'tab' | 'figure';
}) {
  const isFigure = variant === 'figure';
  const isLoading = isLoadingPrice || entries.some((e) => e.isLoading);

  const { series, nowIndex, forecastSeries } = useMemo(
    () =>
      buildMultiForecastSeries({
        actual: priceData,
        actualValue: (p) => p.price,
        entries,
        countryLabel,
        window: todayWindow,
      }),
    [priceData, entries, countryLabel, todayWindow],
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

  const heatmapForecastEntry = useMemo(() => entries.find((e) => (e.points?.length ?? 0) > 0), [entries]);

  const heatmapCells = useMemo(
    () =>
      buildHeatmapCells({
        data: priceData,
        value: (p) => p.price,
        forecast: heatmapForecastEntry?.points,
      }),
    [priceData, heatmapForecastEntry],
  );
  const hasFutureCells = useMemo(
    () => heatmapCells.some((c) => c.future && c.value != null),
    [heatmapCells],
  );

  const meta = `€/MWh · ${countryLabel} · EPEX · comparing ${entries.length} forecast model${entries.length === 1 ? '' : 's'}`;

  return (
    <div className="space-y-3.5">
      <AbleCard title={isFigure ? undefined : 'Day-ahead spot price'} subtitle={isFigure ? undefined : meta}>
        {isLoading ? (
          <div className="flex h-[300px] items-center justify-center text-meta text-ink-muted">
            Loading…
          </div>
        ) : isError ? (
          <div className="flex h-[300px] items-center justify-center text-meta text-ink-muted">
            Could not load day-ahead price.
          </div>
        ) : (
          <>
            <AbleLineChart
              series={series}
              nowIndex={nowIndex}
              height={300}
              formatAxis={(v) => v.toFixed(0)}
              formatTooltip={(v) => `€${v.toFixed(1)}`}
              unit="/MWh"
              preset={timePreset}
              label="Day-ahead price"
              forecastSeries={forecastSeries}
            />
            {/* See PriceDefaultView's identical comment: no card header in
                the figure composition means this line has nowhere else to
                live. */}
            {isFigure && <p className="mt-2 text-micro text-ink-muted">{meta}</p>}
          </>
        )}

        {gaps.length > 0 && (
          <p className="mt-2 text-micro text-ink-muted">
            {gaps.length} of {entries.length} selected models {gaps.length === 1 ? 'is' : 'are'} not available in{' '}
            {countryLabel}.
          </p>
        )}
        <ForecastGapNotice gaps={gaps} forecastType="price" />
      </AbleCard>

      {/* One plot per figure — see PriceDefaultView's identical comment. */}
      {!isFigure && (
        <AbleCard
          title="Price by hour × day"
          subtitle={hasFutureCells ? 'darker = higher · past 4d + next 2d' : 'darker = higher · past 4d'}
        >
          <AblePriceHeatmap cells={heatmapCells} unit="€/MWh" />
        </AbleCard>
      )}
    </div>
  );
}
