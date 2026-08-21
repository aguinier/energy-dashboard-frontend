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
import { ModelComparisonPanel } from './ModelComparisonPanel';
import { useLoadChartData } from '@/hooks/useLoadChartData';
import { useDashboardStore } from '@/store/dashboardStore';
import { useActiveForecastType } from '@/hooks/useForecastModels';
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
  // 'load' for this tab (TAB_FORECAST_TYPE.analytics), read rather than
  // hardcoded so the comparison panel offers this tab's own type's models.
  const forecastType = useActiveForecastType();

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
  const { loadData, forecastData, forecastBasisNote } = useLoadChartData();
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
        {/* A divergent basis has to say so in words. Left to the strip alone it
            renders as three em-dashes beside a healthy sample count, which
            reads as a transient gap rather than as a number that does not
            exist for this country (ABL-277). Checked before the sparse-window
            and MAPE-coverage notes below, which describe a measurement that
            was taken; this one says none was possible. */}
        {loadMetrics?.basis === 'divergent_basis' && loadMetrics.basisNote && (
          <p className="mt-2 text-micro text-ink-muted">{loadMetrics.basisNote}</p>
        )}
        {loadMetrics?.basis !== 'divergent_basis' &&
          loadMetrics?.dataPoints != null && loadMetrics.dataPoints < MIN_RELIABLE_SAMPLES && (
          <p className="mt-2 text-micro text-ink-muted">
            Only {loadMetrics.dataPoints} paired points in this window — these figures are
            indicative, not a stable estimate. Widen the range for a firmer read.
          </p>
        )}
        {loadMetrics?.basis !== 'divergent_basis' &&
          loadMetrics != null && loadMetrics.mapeSamples < loadMetrics.dataPoints && (
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
          // Drops the "dashed = forecast" half when the forecast was withheld
          // (ABL-501). This card reads the same `useLoadChartData` series the
          // Load tab does, so a withheld overlay leaves it with one line — and
          // a caption naming a mark that is not on the chart is the small
          // version of the defect the withholding exists to fix.
          subtitle={`GW · past 7 days · solid = actual${forecastBasisNote ? '' : ', dashed = forecast'}`}
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
          {/* Repeats the finding rather than relying on the sentence under the
              stat strip above: that one is the *measure* wording ("Not
              measurable here"), it is a card and a scroll away, and this is the
              card with a visibly missing line. */}
          {forecastBasisNote && (
            <p className="mt-2 text-micro text-ink-muted">{forecastBasisNote}</p>
          )}
        </AbleCard>
      </div>

      {/* Per-model comparison. It was a footnote saying the accuracy endpoints
          took no model parameter; they do now (ABL-5), so the panel has
          numbers to show and is back to being a card. */}
      <ModelComparisonPanel forecastType={forecastType} />
    </div>
  );
}
