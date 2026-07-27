import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AbleCard } from './AbleCard';
import { AbleAccuracyBars } from '@/components/charts/AbleAccuracyBars';
import { AbleLineChart } from '@/components/charts/AbleLineChart';
import { AbleSparkline } from '@/components/charts/AbleSparkline';
import {
  fetchTSOForecastMetrics,
  fetchTSOLoadForecastAccuracy,
} from '@/services/api';
import { buildHorizonBars } from './horizonBars';
import { useLoadChartData } from '@/hooks/useLoadChartData';
import { useDashboardStore } from '@/store/dashboardStore';
import { getDateRangeForPreset, useForecastComparisonSummary } from '@/hooks/useDashboardData';
import { REFRESH_INTERVALS } from '@/lib/constants';
import { adaptLoadSeries } from '@/lib/chartAdapters';
import { formatGwAxis } from '@/lib/chartTicks';
import { cn } from '@/lib/utils';

function StatCell({
  label,
  value,
  unit,
  delta,
  good,
  spark,
  last,
}: {
  label: string;
  value: string;
  unit: string;
  delta?: string;
  good?: boolean;
  spark?: number[];
  last?: boolean;
}) {
  return (
    <div className={cn('px-5 py-4', !last && 'md:border-r md:border-border')}>
      <div className="mb-2 font-mono-num text-[10px] uppercase tracking-[0.1em] text-ink-muted">
        {label}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="num text-[26px] font-medium text-foreground">{value}</span>
        <span className="text-[11px] text-ink-muted">{unit}</span>
      </div>
      <div className="mt-2 flex min-h-[22px] items-center justify-between">
        {delta != null ? (
          <span
            className={cn(
              'font-mono-num text-[11px]',
              good == null ? 'text-ink-muted' : good ? 'text-up' : 'text-down',
            )}
          >
            {delta}
            <span className="ml-1 text-ink-muted">24h</span>
          </span>
        ) : (
          <span />
        )}
        {spark && spark.length > 1 && (
          <AbleSparkline values={spark} width={70} height={22} />
        )}
      </div>
    </div>
  );
}

export function ForecastTab() {
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const timePreset = useDashboardStore((s) => s.timePreset);
  const timeOffset = useDashboardStore((s) => s.timeOffset);
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);

  // Aggregate TSO metrics — always fetched on this tab regardless of layer toggles.
  const metricsQuery = useQuery({
    queryKey: ['forecast-tab', 'tso-metrics', selectedCountry, timePreset, timeOffset],
    queryFn: () =>
      fetchTSOForecastMetrics({
        countryCode: selectedCountry,
        start: start.toISOString(),
        end: end.toISOString(),
      }),
    staleTime: REFRESH_INTERVALS.map,
  });

  // Forecast-vs-actual overlay (last 7 days of TSO day-ahead).
  const overlayQuery = useQuery({
    queryKey: ['forecast-tab', 'tso-accuracy-overlay', selectedCountry, timePreset, timeOffset],
    queryFn: () =>
      fetchTSOLoadForecastAccuracy({
        countryCode: selectedCountry,
        start: start.toISOString(),
        end: end.toISOString(),
        forecastType: 'day_ahead',
        granularity: 'hourly',
      }),
    staleTime: REFRESH_INTERVALS.dashboard,
  });

  const loadMetrics = metricsQuery.data?.load;

  // Error by horizon — measured only. Horizons with no stored forecast (D+3/D+5/D+7,
  // since forecasts.horizon_hours tops out at 63h) are simply absent, not invented.
  const { data: summary } = useForecastComparisonSummary();
  const horizonBars = buildHorizonBars(summary, 'load');

  // Overlay chart data — pair forecasted vs actual for the past window.
  const { loadData, forecastData } = useLoadChartData();
  const overlaySeries = useMemo(() => {
    const { series } = adaptLoadSeries({
      loadData,
      mlForecast: forecastData,
    });
    return series;
  }, [loadData, forecastData]);

  return (
    <div className="space-y-3.5">
      {/* 4-stat strip — MAE / MAPE / RMSE / Bias */}
      <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-card md:grid-cols-4">
        <StatCell
          label="MAE"
          value={loadMetrics?.mae != null ? loadMetrics.mae.toFixed(0) : '—'}
          unit="MW"
        />
        <StatCell
          label="MAPE"
          value={loadMetrics?.mape != null ? loadMetrics.mape.toFixed(2) : '—'}
          unit="%"
        />
        <StatCell
          label="RMSE"
          value={loadMetrics?.rmse != null ? loadMetrics.rmse.toFixed(0) : '—'}
          unit="MW"
        />
        <StatCell
          label="Samples"
          value={loadMetrics?.dataPoints != null ? loadMetrics.dataPoints.toString() : '—'}
          unit=""
          last
        />
      </div>

      {/* Compare forecast models */}
      <div className="rounded-xl border border-border bg-card">
        <div className="px-[18px] pb-[18px] pt-4">
          <div className="text-[13.5px] font-medium">Compare forecast models</div>
          <div className="mt-0.5 font-mono-num text-[11px] text-ink-muted">
            not available yet
          </div>
          <p className="mt-3 max-w-[520px] text-[12px] leading-relaxed text-ink-dim">
            This panel used to plot per-model MAPE from hardcoded constants rather
            than measurements. Per-model accuracy needs the accuracy endpoints to
            accept a model, which they do not yet — so it shows nothing instead of
            numbers that were never measured. Single-model error is below, anchored
            on the measured D+1 figure.
          </p>
        </div>
      </div>

      {/* Bottom grid: error by horizon + forecast vs actual */}
      <div className="grid gap-3.5 md:grid-cols-2">
        <AbleCard
          title="Error by horizon"
          subtitle="MAPE % · measured over the selected window"
        >
          <AbleAccuracyBars data={horizonBars} />
        </AbleCard>

        <AbleCard
          title="Forecast vs actual"
          subtitle="GW · past 7 days · solid = actual, dashed = forecast"
        >
          {overlayQuery.isLoading ? (
            <div className="flex h-[180px] items-center justify-center text-[12px] text-ink-muted">
              Loading…
            </div>
          ) : (
            <AbleLineChart
              series={overlaySeries}
              overlay
              height={180}
              formatAxis={formatGwAxis}
              formatTooltip={(v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} GW` : `${v.toFixed(0)} MW`)}
            />
          )}
        </AbleCard>
      </div>
    </div>
  );
}
