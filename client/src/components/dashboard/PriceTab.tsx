import { useMemo } from 'react';
import { AbleCard } from './AbleCard';
import { AbleLineChart } from '@/components/charts/AbleLineChart';
import { AblePriceHeatmap } from '@/components/charts/AblePriceHeatmap';
import { usePriceChartData } from '@/hooks/usePriceChartData';
import { useCountries } from '@/hooks/useCountries';
import { useDashboardStore } from '@/store/dashboardStore';
import { adaptPriceSeries, buildHeatmapCells } from '@/lib/chartAdapters';

export function PriceTab() {
  const { priceData, forecastData, isLoading } = usePriceChartData();
  const { data: countries } = useCountries();
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const country = countries?.find((c) => c.country_code === selectedCountry);
  const { series, nowIndex } = useMemo(
    () => adaptPriceSeries(priceData, forecastData),
    [priceData, forecastData],
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

  return (
    <div className="space-y-3.5">
      <AbleCard
        title="Day-ahead spot price"
        subtitle={`€/MWh · ${country?.country_name ?? selectedCountry} · EPEX${
          hasForecast ? ' · dashed = able-ml forecast' : ''
        }`}
      >
        {isLoading ? (
          <div className="flex h-[300px] items-center justify-center text-[12px] text-ink-muted">
            Loading…
          </div>
        ) : (
          <AbleLineChart
            series={series}
            nowIndex={nowIndex}
            height={300}
            formatAxis={(v) => v.toFixed(0)}
            formatTooltip={(v) => `€${v.toFixed(1)}`}
            unit="/MWh"
          />
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
