import { useMemo } from 'react';
import { AbleCard } from './AbleCard';
import { AbleLineChart } from '@/components/charts/AbleLineChart';
import { AblePriceHeatmap } from '@/components/charts/AblePriceHeatmap';
import { useLoadChartData } from '@/hooks/useLoadChartData';
import { useCountries } from '@/hooks/useCountries';
import { useDashboardStore } from '@/store/dashboardStore';
import { adaptLoadSeries, buildHeatmapCells } from '@/lib/chartAdapters';
import { formatGwAxis } from '@/lib/chartTicks';

export function LoadTab() {
  const { loadData, forecastData, tsoForecastData, isLoading } = useLoadChartData();
  const { data: countries } = useCountries();
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const country = countries?.find((c) => c.country_code === selectedCountry);
  const layers = useDashboardStore((s) => s.layers);

  // Choose forecast source: ML when ml.enabled, otherwise TSO when tso.enabled.
  // The ModelPicker keeps these mutually exclusive.
  const useMl = layers.ml.enabled;
  const useTso = !useMl && layers.tso.enabled;

  const { series, nowIndex } = useMemo(
    () =>
      adaptLoadSeries({
        loadData,
        mlForecast: useMl ? forecastData : undefined,
        tsoForecast: useTso ? tsoForecastData : undefined,
      }),
    [loadData, forecastData, tsoForecastData, useMl, useTso],
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
        subtitle={`GW · ${country?.country_name ?? selectedCountry} · ENTSO-E${
          useMl
            ? ' · dashed = able-ml forecast'
            : useTso
            ? ' · dashed = ENTSO-E TSO forecast'
            : ''
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
            formatAxis={formatGwAxis}
            formatTooltip={(v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} GW` : `${v.toFixed(0)} MW`)}
          />
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
