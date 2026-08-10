import { useMemo } from 'react';
import { AbleCard } from './AbleCard';
import { ForecastGapNotice } from './ForecastGapNotice';
import { AbleLineChart } from '@/components/charts/AbleLineChart';
import { AblePriceHeatmap } from '@/components/charts/AblePriceHeatmap';
import { useLoadChartData } from '@/hooks/useLoadChartData';
import { useCountries } from '@/hooks/useCountries';
import { useDashboardStore } from '@/store/dashboardStore';
import { useModelSelection } from '@/hooks/useForecastModels';
import { adaptLoadSeries, buildHeatmapCells } from '@/lib/chartAdapters';
import { describeForecastGap } from '@/lib/forecastGap';
import { formatGwAxis } from '@/lib/chartTicks';
import { getDateRangeForPreset } from '@/hooks/useDashboardData';

export function LoadTab() {
  const {
    loadData,
    forecastData,
    tsoForecastData,
    isLoading,
    isLoadingForecast,
    isLoadingTSOForecast,
    isError,
  } = useLoadChartData();
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

  // The picker is the single source of truth for the overlay, matching
  // PriceTab and NetPositionTab. The `layers` slice it used to read is dead
  // state — nothing in the UI can set it.
  const { selected, hidden, requestModelId } = useModelSelection('load');
  const useMl = !hidden && selected?.source === 'ml';
  const useTso = !hidden && selected?.source === 'tso';

  // Whichever overlay is on is the one whose emptiness needs explaining. A TSO
  // entry is always a pin — every registered `production` model is ml, so the
  // ladder never lands on TSO by itself.
  const gap = useMemo(
    () =>
      describeForecastGap({
        active: useMl || useTso,
        pinnedLabel: requestModelId ? selected?.label ?? null : null,
        isLoading: isLoading || (useTso ? isLoadingTSOForecast : isLoadingForecast),
        isError,
        pointCount: (useTso ? tsoForecastData?.length : forecastData?.length) ?? 0,
        countryLabel,
      }),
    [
      useMl,
      useTso,
      requestModelId,
      selected,
      isLoading,
      isLoadingForecast,
      isLoadingTSOForecast,
      isError,
      forecastData,
      tsoForecastData,
      countryLabel,
    ],
  );

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
              formatTooltip={(v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} GW` : `${v.toFixed(0)} MW`)}
              preset={timePreset}
              label="Electricity load"
            />
            <ForecastGapNotice gap={gap} forecastType="load" />
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
