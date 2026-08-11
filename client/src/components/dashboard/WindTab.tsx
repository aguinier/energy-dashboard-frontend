import { useMemo } from 'react';
import { AbleCard } from './AbleCard';
import { ForecastGapNotice } from './ForecastGapNotice';
import { AbleLineChart } from '@/components/charts/AbleLineChart';
import { useWindChartData } from '@/hooks/useWindChartData';
import type { WindModelQuery, WindType } from '@/hooks/useWindChartData';
import { useModelSelection } from '@/hooks/useForecastModels';
import { useCountries } from '@/hooks/useCountries';
import { useDashboardStore } from '@/store/dashboardStore';
import { adaptWindSeries } from '@/lib/chartAdapters';
import { buildMultiForecastSeries } from '@/lib/multiForecastSeries';
import { describeForecastGapsForSelection } from '@/lib/forecastGap';
import { getDateRangeForPreset } from '@/hooks/useDashboardData';
import { formatGwAxis } from '@/lib/chartTicks';
import type { WindGenerationSeriesPoint, ForecastDataPoint, TSOGenerationForecastDataPoint } from '@/types';

type TodayWindow = { start: Date; end: Date } | undefined;

const formatMwOrGw = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} GW` : `${v.toFixed(0)} MW`);

const WIND_COPY: Record<WindType, { title: string }> = {
  wind_onshore: { title: 'Onshore wind generation' },
  wind_offshore: { title: 'Offshore wind generation' },
};

/**
 * Wind generation chart (ABL-235) — onshore and offshore share this one
 * component rather than each getting its own file the way Load/Price do:
 * unlike Load vs Price, the two are the exact same chart against a different
 * `energy_generation` column and a different registered forecastType, not
 * two different features. Same default/selection split as LoadTab/PriceTab,
 * for the same reason: "nothing checked" reaches the server's own candidate
 * ladder, "one or more checked" compares named lines. `TSO_D1` is registered
 * for both wind types (unlike price, which has no tso model), so the default
 * view branches on source the way `LoadDefaultView` does.
 */
export function WindTab({ windType }: { windType: WindType }) {
  const chartData = useWindChartData(windType);
  const { data: countries } = useCountries();
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const country = countries?.find((c) => c.country_code === selectedCountry);
  const countryLabel = country?.country_name ?? selectedCountry;
  const timePreset = useDashboardStore((s) => s.timePreset);
  const timeOffset = useDashboardStore((s) => s.timeOffset);
  const todayWindow = useMemo(
    () => (timePreset === 'today' ? getDateRangeForPreset(timePreset, timeOffset) : undefined),
    [timePreset, timeOffset],
  );
  const copy = WIND_COPY[windType];

  if (chartData.modelSelection.length > 0) {
    return (
      <WindSelectionView
        windType={windType}
        entries={chartData.modelSelection}
        windData={chartData.windData}
        isLoadingWind={chartData.isLoadingWind}
        isError={chartData.isError}
        countryLabel={countryLabel}
        timePreset={timePreset}
        todayWindow={todayWindow}
        title={copy.title}
      />
    );
  }

  return (
    <WindDefaultView
      windType={windType}
      windData={chartData.windData}
      forecastData={chartData.forecastData}
      tsoForecastData={chartData.tsoForecastData}
      isLoading={chartData.isLoading}
      countryLabel={countryLabel}
      timePreset={timePreset}
      todayWindow={todayWindow}
      title={copy.title}
    />
  );
}

export function WindOnshoreTab() {
  return <WindTab windType="wind_onshore" />;
}

export function WindOffshoreTab() {
  return <WindTab windType="wind_offshore" />;
}

/** "Default" — nothing checked, so the server's candidate ladder serves. See LoadTab.tsx's `LoadDefaultView` for why a pin can no longer reach this view. */
function WindDefaultView({
  windType,
  windData,
  forecastData,
  tsoForecastData,
  isLoading,
  countryLabel,
  timePreset,
  todayWindow,
  title,
}: {
  windType: WindType;
  windData: WindGenerationSeriesPoint[] | undefined;
  forecastData: ForecastDataPoint[] | undefined;
  tsoForecastData: TSOGenerationForecastDataPoint[] | undefined;
  isLoading: boolean;
  countryLabel: string;
  timePreset: string;
  todayWindow: TodayWindow;
  title: string;
}) {
  const { selected, hidden } = useModelSelection(windType);
  const useMl = !hidden && selected?.source === 'ml';
  const useTso = !hidden && selected?.source === 'tso';

  const { series, nowIndex } = useMemo(
    () =>
      adaptWindSeries({
        windData,
        windType,
        mlForecast: useMl ? forecastData : undefined,
        tsoForecast: useTso ? tsoForecastData : undefined,
        window: todayWindow,
      }),
    [windData, windType, forecastData, tsoForecastData, useMl, useTso, todayWindow],
  );

  return (
    <div className="space-y-3.5">
      <AbleCard
        title={title}
        subtitle={`GW · ${countryLabel} · ENTSO-E${
          useMl ? ' · dashed = able-ml forecast' : useTso ? ' · dashed = ENTSO-E TSO forecast' : ''
        }`}
      >
        {isLoading ? (
          <div className="flex h-[300px] items-center justify-center text-meta text-ink-muted">
            Loading…
          </div>
        ) : (
          <AbleLineChart
            series={series}
            nowIndex={nowIndex}
            height={300}
            formatAxis={formatGwAxis}
            formatTooltip={formatMwOrGw}
            preset={timePreset}
            label={title}
          />
        )}
      </AbleCard>
    </div>
  );
}

/** One or more models explicitly checked in the picker. */
function WindSelectionView({
  windType,
  entries,
  windData,
  isLoadingWind,
  isError,
  countryLabel,
  timePreset,
  todayWindow,
  title,
}: {
  windType: WindType;
  entries: WindModelQuery[];
  windData: WindGenerationSeriesPoint[] | undefined;
  isLoadingWind: boolean;
  isError: boolean;
  countryLabel: string;
  timePreset: string;
  todayWindow: TodayWindow;
  title: string;
}) {
  const isLoading = isLoadingWind || entries.some((e) => e.isLoading);

  const { series, nowIndex, forecastSeries } = useMemo(
    () =>
      buildMultiForecastSeries({
        actual: windData,
        actualValue: (p: WindGenerationSeriesPoint) => (windType === 'wind_onshore' ? p.wind_onshore : p.wind_offshore),
        entries,
        countryLabel,
        window: todayWindow,
      }),
    [windData, windType, entries, countryLabel, todayWindow],
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

  return (
    <div className="space-y-3.5">
      <AbleCard
        title={title}
        subtitle={`GW · ${countryLabel} · ENTSO-E · comparing ${entries.length} forecast model${entries.length === 1 ? '' : 's'}`}
      >
        {isLoading ? (
          <div className="flex h-[300px] items-center justify-center text-meta text-ink-muted">
            Loading…
          </div>
        ) : isError ? (
          <div className="flex h-[300px] items-center justify-center text-meta text-ink-muted">
            Could not load {title.toLowerCase()}.
          </div>
        ) : (
          <AbleLineChart
            series={series}
            nowIndex={nowIndex}
            height={300}
            formatAxis={formatGwAxis}
            formatTooltip={formatMwOrGw}
            preset={timePreset}
            label={title}
            forecastSeries={forecastSeries}
          />
        )}

        {gaps.length > 0 && (
          <p className="mt-2 text-micro text-ink-muted">
            {gaps.length} of {entries.length} selected models {gaps.length === 1 ? 'is' : 'are'} not available in{' '}
            {countryLabel}.
          </p>
        )}
        <ForecastGapNotice gaps={gaps} forecastType={windType} />
      </AbleCard>
    </div>
  );
}
