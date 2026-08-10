import { useMemo } from 'react';
import { AbleCard } from './AbleCard';
import { ForecastGapNotice } from './ForecastGapNotice';
import { AbleLineChart } from '@/components/charts/AbleLineChart';
import { AblePriceHeatmap } from '@/components/charts/AblePriceHeatmap';
import { usePriceChartData } from '@/hooks/usePriceChartData';
import { useCountries } from '@/hooks/useCountries';
import { useModelSelection } from '@/hooks/useForecastModels';
import { useDashboardStore } from '@/store/dashboardStore';
import { adaptPriceSeries, buildHeatmapCells } from '@/lib/chartAdapters';
import { describeForecastGap } from '@/lib/forecastGap';
import { getDateRangeForPreset } from '@/hooks/useDashboardData';

export function PriceTab() {
  const { priceData, forecastData, isLoading, isLoadingForecast, isError } = usePriceChartData();
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
  const { selected, hidden, requestModelId } = useModelSelection('price');
  const { series, nowIndex } = useMemo(
    () => adaptPriceSeries(priceData, forecastData, todayWindow),
    [priceData, forecastData, todayWindow],
  );
  const hasForecast = useMemo(() => series.some((p) => p.forecast != null), [series]);

  // Price has no TSO model registered, so the overlay is on exactly when an
  // ml model is selected.
  const gap = useMemo(
    () =>
      describeForecastGap({
        active: !hidden && selected?.source === 'ml',
        pinnedLabel: requestModelId ? selected?.label ?? null : null,
        isLoading: isLoading || isLoadingForecast,
        isError,
        pointCount: forecastData?.length ?? 0,
        countryLabel,
      }),
    [hidden, selected, requestModelId, isLoading, isLoadingForecast, isError, forecastData, countryLabel],
  );

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

  return (
    <div className="space-y-3.5">
      <AbleCard
        title="Day-ahead spot price"
        subtitle={`€/MWh · ${countryLabel} · EPEX${
          hasForecast ? ' · dashed = able-ml forecast' : ''
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
              formatAxis={(v) => v.toFixed(0)}
              formatTooltip={(v) => `€${v.toFixed(1)}`}
              unit="/MWh"
              preset={timePreset}
              label="Day-ahead price"
            />
            <ForecastGapNotice gap={gap} forecastType="price" />
          </>
        )}
      </AbleCard>

      <AbleCard
        title="Price by hour × day"
        subtitle={hasFutureCells ? 'darker = higher · past 4d + next 2d' : 'darker = higher · past 4d'}
      >
        <AblePriceHeatmap cells={heatmapCells} unit="€/MWh" />
      </AbleCard>
    </div>
  );
}
