import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AbleCard } from './AbleCard';
import { AbleAccuracyBars } from '@/components/charts/AbleAccuracyBars';
import { AbleMultiModelBars } from '@/components/charts/AbleMultiModelBars';
import { AbleLineChart } from '@/components/charts/AbleLineChart';
import { AbleSparkline } from '@/components/charts/AbleSparkline';
import {
  FORECAST_MODELS,
  MODEL_KIND_COLOR,
  type ModelId,
} from './ModelPicker';
import {
  fetchTSOForecastMetrics,
  fetchTSOLoadForecastAccuracy,
} from '@/services/api';
import { useLoadChartData } from '@/hooks/useLoadChartData';
import { useDashboardStore } from '@/store/dashboardStore';
import { getDateRangeForPreset } from '@/hooks/useDashboardData';
import { REFRESH_INTERVALS } from '@/lib/constants';
import { adaptLoadSeries } from '@/lib/chartAdapters';
import { cn } from '@/lib/utils';

// Synthetic horizon multipliers from the prototype. Real backend doesn't yet
// supply D+3/D+5/D+7 error breakdown for ML models — extrapolated from D+1.
const HORIZON_LABELS = ['D+1', 'D+2', 'D+3', 'D+5', 'D+7'];
const HORIZON_FACTORS = [1, 1.15, 1.3, 1.55, 1.9];

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
      <div className="mt-2 flex items-center justify-between">
        <span
          className={cn(
            'font-mono-num text-[11px]',
            good == null ? 'text-ink-muted' : good ? 'text-up' : 'text-down',
          )}
        >
          {delta ?? '—'}
          <span className="ml-1 text-ink-muted">24h</span>
        </span>
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

  // Multi-model comparison panel state — local to this tab.
  const [selected, setSelected] = useState<ModelId[]>(['able-ml', 'tso-d1']);
  const toggle = (id: ModelId) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const compareSeries = useMemo(
    () =>
      selected.map((id) => {
        const m = FORECAST_MODELS.find((x) => x.id === id)!;
        return {
          id: m.id,
          name: m.name,
          version: m.version,
          mape: m.mape,
          color: MODEL_KIND_COLOR[m.kind],
          bars: HORIZON_LABELS.map((label, i) => ({
            label,
            v: m.mape * HORIZON_FACTORS[i],
          })),
        };
      }),
    [selected],
  );

  // Bars for the bottom-left "Error by horizon" chart — drawn from the
  // currently-active model in the ModelPicker (defaults to able-ml).
  const layers = useDashboardStore((s) => s.layers);
  const activeId: ModelId = layers.tso.enabled
    ? layers.tso.horizon === 'week_ahead'
      ? 'tso-d7'
      : 'tso-d1'
    : 'able-ml';
  const activeModel = FORECAST_MODELS.find((m) => m.id === activeId)!;
  const horizonBars = HORIZON_LABELS.map((label, i) => ({
    label,
    v: activeModel.mape * HORIZON_FACTORS[i],
  }));

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
        <div className="px-[18px] pb-2 pt-4">
          <div className="flex items-baseline justify-between">
            <div>
              <div className="text-[13.5px] font-medium">Compare forecast models</div>
              <div className="mt-0.5 font-mono-num text-[11px] text-ink-muted">
                MAPE % by horizon · illustrative (D+3/D+5/D+7 extrapolated from D+1)
              </div>
            </div>
            <div className="font-mono-num text-[10.5px] text-ink-muted">
              {selected.length} selected
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {FORECAST_MODELS.map((m) => {
              const active = selected.includes(m.id);
              return (
                <button
                  key={m.id}
                  onClick={() => toggle(m.id)}
                  className={cn(
                    'flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 font-sans text-[11.5px]',
                    active
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border bg-transparent text-ink-dim',
                  )}
                >
                  <span
                    className="h-2 w-2 rounded-sm"
                    style={{
                      background: MODEL_KIND_COLOR[m.kind],
                      opacity: active ? 1 : 0.5,
                    }}
                  />
                  {m.name}
                  <span className="font-mono-num text-[9.5px] opacity-65">{m.version}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="px-[18px] pb-[18px] pt-1.5">
          <AbleMultiModelBars series={compareSeries} />
        </div>
      </div>

      {/* Bottom grid: error by horizon + forecast vs actual */}
      <div className="grid gap-3.5 md:grid-cols-2">
        <AbleCard
          title="Error by horizon"
          subtitle={`MAPE % · day vs week ahead · ${activeModel.name} ${activeModel.version}`}
        >
          <AbleAccuracyBars data={horizonBars} />
        </AbleCard>

        <AbleCard
          title="Forecast vs actual"
          subtitle="overlay · past 7 days · solid = actual, dashed = forecast"
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
              formatAxis={(v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0))}
              formatTooltip={(v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} GW` : `${v.toFixed(0)} MW`)}
            />
          )}
        </AbleCard>
      </div>
    </div>
  );
}
