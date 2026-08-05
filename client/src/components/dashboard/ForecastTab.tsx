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

/** Below this many paired points, MAPE/MAE/RMSE are too noisy to report plainly. */
const MIN_RELIABLE_SAMPLES = 48;

function StatCell({
  label,
  value,
  unit,
  delta,
  good,
  spark,
  index,
  count,
}: {
  label: string;
  value: string;
  unit: string;
  delta?: string;
  good?: boolean;
  spark?: number[];
  /** Position in the strip — drives the dividers (see AbleStatRow). */
  index: number;
  count: number;
}) {
  return (
    <div
      className={cn(
        'px-5 py-4',
        index < count - 1 && 'md:border-r md:border-border',
        // The 2×2 mobile layout previously had no dividers at all: four
        // numbers in a borderless block, which is exactly where a reader
        // most needs the grid.
        index % 2 === 0 && 'border-r border-border md:border-r',
        index < 2 && 'border-b border-border md:border-b-0',
      )}
    >
      <div className="mb-2 font-mono-num text-label uppercase text-ink-muted">
        {label}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="num text-stat font-medium text-foreground">{value}</span>
        <span className="text-micro text-ink-muted">{unit}</span>
      </div>
      <div className="mt-2 flex min-h-[22px] items-center justify-between gap-2">
        {delta != null ? (
          <span
            className={cn(
              'font-mono-num text-micro',
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
      <div>
        <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-card md:grid-cols-4">
          <StatCell
            label="MAE"
            value={loadMetrics?.mae != null ? loadMetrics.mae.toFixed(0) : '—'}
            unit="MW"
            index={0}
            count={4}
          />
          <StatCell
            label="MAPE"
            value={loadMetrics?.mape != null ? loadMetrics.mape.toFixed(2) : '—'}
            unit="%"
            index={1}
            count={4}
          />
          <StatCell
            label="RMSE"
            value={loadMetrics?.rmse != null ? loadMetrics.rmse.toFixed(0) : '—'}
            unit="MW"
            index={2}
            count={4}
          />
          <StatCell
            label="Samples"
            value={loadMetrics?.dataPoints != null ? loadMetrics.dataPoints.toString() : '—'}
            unit=""
            index={3}
            count={4}
          />
        </div>
        {loadMetrics?.dataPoints != null && loadMetrics.dataPoints < MIN_RELIABLE_SAMPLES && (
          <p className="mt-2 text-micro text-ink-muted">
            Only {loadMetrics.dataPoints} paired points in this window — these figures are
            indicative, not a stable estimate. Widen the range for a firmer read.
          </p>
        )}
        {loadMetrics != null && loadMetrics.mapeSamples < loadMetrics.dataPoints && (
          <p className="mt-2 text-micro text-ink-muted">
            MAPE covers {loadMetrics.mapeSamples} of {loadMetrics.dataPoints} points — the rest
            had a zero or negative actual, where percentage error is undefined.
          </p>
        )}
      </div>

      {/* Bottom grid: error by horizon + forecast vs actual */}
      <div className="grid gap-3.5 md:grid-cols-2">
        <AbleCard
          title="Error by horizon"
          subtitle={
            horizonBars.length === 0
              ? 'no measured error for this window'
              : 'MAPE % · measured over the selected window'
          }
        >
          <AbleAccuracyBars data={horizonBars} />
        </AbleCard>

        <AbleCard
          title="Forecast vs actual"
          subtitle="GW · past 7 days · solid = actual, dashed = forecast"
        >
          {overlayQuery.isLoading ? (
            <div className="flex h-[180px] items-center justify-center text-meta text-ink-muted">
              Loading…
            </div>
          ) : (
            <AbleLineChart
              series={overlaySeries}
              overlay
              height={180}
              formatAxis={formatGwAxis}
              formatTooltip={(v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} GW` : `${v.toFixed(0)} MW`)}
              label="Forecast vs actual load"
            />
          )}
        </AbleCard>
      </div>

      {/* Per-model comparison was a full-width card the size of a real chart
          whose entire content was a paragraph explaining that it has no
          content — the largest element on the tab carrying the least. The
          disclosure still matters (ABL-6 builds the panel; until then a
          reader should know why the comparison is absent rather than assume
          it was never planned), so it stays — as a footnote, at footnote
          weight. Restore it to a card when it has numbers to show. */}
      <p className="text-micro text-ink-muted">
        Per-model comparison is not available yet — the accuracy endpoints do not accept a
        model parameter, and this tab will not print per-model figures it has not measured.
      </p>
    </div>
  );
}
