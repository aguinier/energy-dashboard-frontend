import { useMemo } from 'react';
import {
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  ComposedChart,
  Legend,
  ReferenceLine,
  ReferenceArea,
} from 'recharts';
import { ChartWrapper } from './ChartWrapper';
import { ForecastAccuracyMetrics } from './ForecastAccuracyMetrics';
import { LayersPanel } from './LayersPanel';
import type { AvailableLayers } from '@/types';
import { useLoadChartData } from '@/hooks/useLoadChartData';
import { useDashboardStore } from '@/store/dashboardStore';
import { formatDate, formatMW } from '@/lib/formatters';
import { cn } from '@/lib/utils';

export function LoadChart() {
  // Use batched hook for parallel data fetching
  const {
    loadData: data,
    forecastData,
    multiHorizonData,
    comparisonData,
    tsoForecastData,
    tsoAccuracyData,
    isLoading,
    isLoadingComparison,
  } = useLoadChartData();

  // Use selective store subscriptions to minimize re-renders
  const timeRange = useDashboardStore((s) => s.timeRange);
  const showForecast = useDashboardStore((s) => s.showForecast);
  const showComparisonMode = useDashboardStore((s) => s.showComparisonMode);
  const showTSOForecast = useDashboardStore((s) => s.showTSOForecast);
  const showTSOComparisonMode = useDashboardStore((s) => s.showTSOComparisonMode);
  const layers = useDashboardStore((s) => s.layers);
  const selectedMLHorizons = useDashboardStore((s) => s.selectedMLHorizons);

  // Available layers configuration for LoadChart
  const availableLayers: AvailableLayers = {
    tso: {
      available: true,
      horizons: ['day_ahead', 'week_ahead'],
      hasAccuracy: true,
    },
    ml: {
      available: true,
      horizons: [1, 2],  // D+1 and D+2
      hasAccuracy: true,
    },
  };

  // TSO horizon from layers state
  const tsoHorizon = layers.tso.horizon || 'day_ahead';

  // Merge actual and forecast data
  const chartData = useMemo(() => {
    const actualData = data?.map((d) => ({
      timestamp: d.timestamp || d.date || '',
      load: d.load || d.avg_load,
      maxLoad: d.max_load,
      minLoad: d.min_load,
      forecast: undefined as number | undefined,
      forecast_d2: undefined as number | undefined,
      actualForComparison: undefined as number | undefined,
      tsoForecast: undefined as number | undefined,
      tsoForecastMin: undefined as number | undefined,
      tsoForecastMax: undefined as number | undefined,
      tsoForecastActual: undefined as number | undefined,
    })).filter((d) => d.timestamp) || [];

    // TSO Comparison mode: show historical TSO forecasts vs actual values
    if (showTSOForecast && showTSOComparisonMode && tsoAccuracyData?.data) {
      const comparisonPoints = tsoAccuracyData.data.map((d) => ({
        timestamp: d.timestamp,
        load: undefined as number | undefined,
        maxLoad: undefined as number | undefined,
        minLoad: undefined as number | undefined,
        forecast: undefined as number | undefined,
        actualForComparison: undefined as number | undefined,
        tsoForecast: d.forecast_value,
        tsoForecastMin: undefined as number | undefined,
        tsoForecastMax: undefined as number | undefined,
        tsoForecastActual: d.actual_value,
      }));
      return comparisonPoints.sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
    }

    // ML Forecast comparison mode: show historical forecasts vs actual values
    if (showForecast && showComparisonMode && comparisonData) {
      const comparisonPoints = comparisonData.forecasts.map((f) => {
        const actual = comparisonData.actuals.find((a) => a.timestamp === f.timestamp);
        return {
          timestamp: f.timestamp,
          load: undefined as number | undefined,
          maxLoad: undefined as number | undefined,
          minLoad: undefined as number | undefined,
          forecast: f.value,
          actualForComparison: actual?.value,
          tsoForecast: undefined as number | undefined,
          tsoForecastMin: undefined as number | undefined,
          tsoForecastMax: undefined as number | undefined,
          tsoForecastActual: undefined as number | undefined,
        };
      });
      return comparisonPoints.sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
    }

    // Build combined data with actual + forecasts
    let combined = [...actualData];

    // Add TSO forecast data
    if (showTSOForecast && tsoForecastData?.length) {
      // Add TSO forecast to existing points and create new future points
      const existingTimestamps = new Set(combined.map((d) => d.timestamp));

      for (const f of tsoForecastData) {
        if (existingTimestamps.has(f.timestamp)) {
          const existing = combined.find((d) => d.timestamp === f.timestamp);
          if (existing) {
            existing.tsoForecast = f.forecast_value_mw;
            existing.tsoForecastMin = f.forecast_min_mw ?? undefined;
            existing.tsoForecastMax = f.forecast_max_mw ?? undefined;
          }
        } else {
          combined.push({
            timestamp: f.timestamp,
            load: undefined,
            maxLoad: undefined,
            minLoad: undefined,
            forecast: undefined,
            forecast_d2: undefined,
            actualForComparison: undefined,
            tsoForecast: f.forecast_value_mw,
            tsoForecastMin: f.forecast_min_mw ?? undefined,
            tsoForecastMax: f.forecast_max_mw ?? undefined,
            tsoForecastActual: undefined,
          });
        }
      }
    }

    // Add ML forecast data (multi-horizon if available, otherwise single)
    if (showForecast) {
      // Use multi-horizon data when multiple horizons selected
      if (multiHorizonData?.length && selectedMLHorizons.length > 1) {
        for (const f of multiHorizonData) {
          const existing = combined.find((d) => d.timestamp === f.timestamp);
          if (existing) {
            if (selectedMLHorizons.includes(1)) {
              existing.forecast = f.forecast_d1;
            }
            if (selectedMLHorizons.includes(2)) {
              existing.forecast_d2 = f.forecast_d2;
            }
          } else {
            combined.push({
              timestamp: f.timestamp,
              load: undefined,
              maxLoad: undefined,
              minLoad: undefined,
              forecast: selectedMLHorizons.includes(1) ? f.forecast_d1 : undefined,
              forecast_d2: selectedMLHorizons.includes(2) ? f.forecast_d2 : undefined,
              actualForComparison: undefined,
              tsoForecast: undefined,
              tsoForecastMin: undefined,
              tsoForecastMax: undefined,
              tsoForecastActual: undefined,
            });
          }
        }
      } else if (forecastData?.length) {
        // Single horizon (legacy mode)
        for (const f of forecastData) {
          const existing = combined.find((d) => d.timestamp === f.timestamp);
          if (existing) {
            existing.forecast = f.value;
          } else {
            combined.push({
              timestamp: f.timestamp,
              load: undefined,
              maxLoad: undefined,
              minLoad: undefined,
              forecast: f.value,
              forecast_d2: undefined,
              actualForComparison: undefined,
              tsoForecast: undefined,
              tsoForecastMin: undefined,
              tsoForecastMax: undefined,
              tsoForecastActual: undefined,
            });
          }
        }
      }
    }

    // Sort by timestamp
    combined.sort((a, b) => new Date(a.timestamp!).getTime() - new Date(b.timestamp!).getTime());

    // Connect the last actual point to first forecast points
    if (actualData.length && (showForecast || showTSOForecast)) {
      const lastActual = actualData[actualData.length - 1];
      const lastActualIdx = combined.findIndex((d) => d.timestamp === lastActual.timestamp);
      if (lastActualIdx >= 0 && lastActualIdx < combined.length - 1) {
        if (showForecast && combined[lastActualIdx + 1]?.forecast !== undefined) {
          combined[lastActualIdx].forecast = lastActual.load;
        }
        if (showTSOForecast && combined[lastActualIdx + 1]?.tsoForecast !== undefined) {
          combined[lastActualIdx].tsoForecast = lastActual.load;
        }
      }
    }

    return combined;
  }, [data, forecastData, multiHorizonData, selectedMLHorizons, showForecast, showComparisonMode, comparisonData, tsoForecastData, showTSOForecast, showTSOComparisonMode, tsoAccuracyData, tsoHorizon]);

  const dateFormat = timeRange === '24h' || timeRange === '7d' ? 'MMM d HH:mm' : 'MMM d';
  const nowMs = Date.now();
  const nowTimestamp = chartData.length
    ? chartData.reduce((closest, d) => {
        const diff = Math.abs(new Date(d.timestamp).getTime() - nowMs);
        const closestDiff = Math.abs(new Date(closest.timestamp).getTime() - nowMs);
        return diff < closestDiff ? d : closest;
      }, chartData[0]).timestamp
    : new Date().toISOString();

  return (
    <ChartWrapper
      title="Electricity Load"
      subtitle="Power demand over time"
      isLoading={isLoading}
      height={350}
      actions={
        <>
          {/* Unified Layers Panel */}
          <LayersPanel availableLayers={availableLayers} />

          {/* Accuracy Metrics (shown when in accuracy mode) */}
          {showTSOForecast && layers.tso.showAccuracy && tsoAccuracyData?.metrics && (
            <div className="flex items-center rounded-md bg-emerald-500/10 border border-emerald-500/30 px-2 py-1 text-xs" title="TSO Forecast MAPE">
              <span className="text-muted-foreground">MAPE:</span>
              <span className="ml-1 font-medium text-emerald-500">{tsoAccuracyData.metrics.mape.toFixed(1)}%</span>
            </div>
          )}

          {showForecast && layers.ml.showAccuracy && (
            <ForecastAccuracyMetrics
              comparisonData={comparisonData}
              unit="MW"
              isLoading={isLoadingComparison}
            />
          )}
        </>
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData}>
          <defs>
            <linearGradient id="loadGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.4} />
              <stop offset="95%" stopColor="#3B82F6" stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="tsoWeekAheadGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#10B981" stopOpacity={0.5} />
              <stop offset="95%" stopColor="#10B981" stopOpacity={0.1} />
            </linearGradient>
            <linearGradient id="tsoForecastGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#10B981" stopOpacity={0.5} />
              <stop offset="95%" stopColor="#10B981" stopOpacity={0.1} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            className="stroke-muted"
            vertical={false}
          />
          <XAxis
            dataKey="timestamp"
            tickFormatter={(value) => formatDate(value, dateFormat)}
            className="text-xs"
            tick={{ fill: 'hsl(var(--muted-foreground))' }}
            axisLine={{ stroke: 'hsl(var(--border))' }}
            tickLine={{ stroke: 'hsl(var(--border))' }}
            minTickGap={50}
          />
          <YAxis
            tickFormatter={(value) => `${(value / 1000).toFixed(0)}K`}
            className="text-xs"
            tick={{ fill: 'hsl(var(--muted-foreground))' }}
            axisLine={{ stroke: 'hsl(var(--border))' }}
            tickLine={{ stroke: 'hsl(var(--border))' }}
            width={60}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const data = payload[0].payload;
              const isTSOComparison = layers.tso.showAccuracy && data.tsoForecastActual !== undefined;
              const isMLComparison = layers.ml.showAccuracy && data.actualForComparison !== undefined;

              return (
                <div className="rounded-lg border bg-background p-3 shadow-lg">
                  <p className="text-sm font-medium">
                    {formatDate(data.timestamp, 'MMM d, yyyy HH:mm')}
                  </p>

                  {/* TSO Comparison Mode */}
                  {isTSOComparison ? (
                    <div className="mt-2 space-y-1">
                      <div>
                        <p className="text-xs text-muted-foreground">Actual</p>
                        <p className="text-lg font-bold text-green-500">
                          {formatMW(data.tsoForecastActual)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">TSO Forecast</p>
                        <p className="text-lg font-bold text-emerald-400">
                          {formatMW(data.tsoForecast)}
                        </p>
                      </div>
                      <div className="border-t pt-1">
                        <p className="text-xs text-muted-foreground">Difference</p>
                        <p className={cn(
                          'text-sm font-semibold',
                          data.tsoForecastActual - data.tsoForecast > 0 ? 'text-green-500' : 'text-red-500'
                        )}>
                          {data.tsoForecastActual - data.tsoForecast > 0 ? '+' : ''}
                          {formatMW(data.tsoForecastActual - data.tsoForecast)}
                        </p>
                      </div>
                    </div>
                  ) : isMLComparison ? (
                    /* ML Comparison Mode */
                    <div className="mt-2 space-y-1">
                      <div>
                        <p className="text-xs text-muted-foreground">Actual</p>
                        <p className="text-lg font-bold text-green-500">
                          {formatMW(data.actualForComparison)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">ML Forecast</p>
                        <p className="text-lg font-bold text-orange-500">
                          {formatMW(data.forecast)}
                        </p>
                      </div>
                      <div className="border-t pt-1">
                        <p className="text-xs text-muted-foreground">Difference</p>
                        <p className={cn(
                          'text-sm font-semibold',
                          data.actualForComparison - data.forecast > 0 ? 'text-green-500' : 'text-red-500'
                        )}>
                          {data.actualForComparison - data.forecast > 0 ? '+' : ''}
                          {formatMW(data.actualForComparison - data.forecast)}
                        </p>
                      </div>
                    </div>
                  ) : (
                    /* Normal/Forecast Mode */
                    <div className="mt-2 space-y-2">
                      {data.load !== undefined && (
                        <div>
                          <p className="text-xs text-muted-foreground">Actual</p>
                          <p className="text-lg font-bold text-blue-500">
                            {formatMW(data.load)}
                          </p>
                          {data.maxLoad && (
                            <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                              <p>Peak: {formatMW(data.maxLoad)}</p>
                              <p>Min: {formatMW(data.minLoad)}</p>
                            </div>
                          )}
                        </div>
                      )}
                      {data.tsoForecast !== undefined && (
                        <div>
                          <p className="text-xs text-muted-foreground">
                            TSO Forecast {tsoHorizon === 'week_ahead' ? '(Week-Ahead)' : '(Day-Ahead)'}
                          </p>
                          <p className="text-lg font-bold text-emerald-400">
                            {formatMW(data.tsoForecast)}
                          </p>
                          {tsoHorizon === 'week_ahead' && data.tsoForecastMin != null && data.tsoForecastMax != null && (
                            <p className="text-xs text-emerald-300">
                              Range: {formatMW(data.tsoForecastMin)} - {formatMW(data.tsoForecastMax)}
                            </p>
                          )}
                        </div>
                      )}
                      {data.forecast !== undefined && (
                        <div>
                          <p className="text-xs text-muted-foreground">
                            ML Forecast {selectedMLHorizons.length > 1 ? '(D+1)' : ''}
                          </p>
                          <p className="text-lg font-bold text-orange-500">
                            {formatMW(data.forecast)}
                          </p>
                        </div>
                      )}
                      {data.forecast_d2 !== undefined && (
                        <div>
                          <p className="text-xs text-muted-foreground">ML Forecast (D+2)</p>
                          <p className="text-lg font-bold text-purple-500">
                            {formatMW(data.forecast_d2)}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            }}
          />
          {/* Custom Legend - always show when any forecast is enabled */}
          {(layers.tso.enabled || layers.ml.enabled) && !layers.tso.showAccuracy && !layers.ml.showAccuracy && (
            <Legend
              verticalAlign="top"
              height={36}
              payload={[
                { value: 'Actual', type: 'line' as const, color: '#3B82F6' },
                ...(layers.tso.enabled ? [{ value: 'TSO Forecast', type: 'line' as const, color: '#10B981' }] : []),
                ...(layers.ml.enabled && selectedMLHorizons.includes(1) ? [{ value: 'ML D+1', type: 'line' as const, color: '#F97316' }] : []),
                ...(layers.ml.enabled && selectedMLHorizons.includes(2) ? [{ value: 'ML D+2', type: 'line' as const, color: '#9333EA' }] : []),
              ]}
              wrapperStyle={{ paddingBottom: '10px' }}
            />
          )}
          <Area
            type="monotone"
            dataKey="load"
            fill="url(#loadGradient)"
            stroke="transparent"
            animationDuration={1500}
          />
          <Line
            type="monotone"
            dataKey="load"
            stroke="#3B82F6"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 6, fill: '#3B82F6', stroke: 'white', strokeWidth: 2 }}
            animationDuration={1500}
            name="load"
          />
          {showForecast && showComparisonMode && (
            <>
              <Line
                type="monotone"
                dataKey="actualForComparison"
                stroke="#22C55E"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 6, fill: '#22C55E', stroke: 'white', strokeWidth: 2 }}
                animationDuration={1500}
                name="actual"
              />
              <Line
                type="monotone"
                dataKey="forecast"
                stroke="#9333EA"
                strokeWidth={2}
                strokeDasharray="8 4"
                dot={false}
                activeDot={{ r: 6, fill: '#9333EA', stroke: 'white', strokeWidth: 2 }}
                animationDuration={1500}
                name="forecast"
              />
            </>
          )}
          {showForecast && !showComparisonMode && (
            <>
              {/* D+1 Forecast Line */}
              {selectedMLHorizons.includes(1) && (
                <Line
                  type="monotone"
                  dataKey="forecast"
                  stroke="#F97316"
                  strokeWidth={2}
                  strokeDasharray="4 2"
                  dot={false}
                  activeDot={{ r: 6, fill: '#F97316', stroke: 'white', strokeWidth: 2 }}
                  animationDuration={1500}
                  name="forecast_d1"
                  connectNulls={true}
                />
              )}
              {/* D+2 Forecast Line */}
              {selectedMLHorizons.includes(2) && (
                <Line
                  type="monotone"
                  dataKey="forecast_d2"
                  stroke="#9333EA"
                  strokeWidth={2}
                  strokeDasharray="8 4"
                  dot={false}
                  activeDot={{ r: 6, fill: '#9333EA', stroke: 'white', strokeWidth: 2 }}
                  animationDuration={1500}
                  name="forecast_d2"
                  connectNulls={true}
                />
              )}
            </>
          )}

          {/* TSO Forecast Comparison Mode */}
          {showTSOForecast && showTSOComparisonMode && (
            <>
              <Line
                type="monotone"
                dataKey="tsoForecastActual"
                stroke="#22C55E"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 6, fill: '#22C55E', stroke: 'white', strokeWidth: 2 }}
                animationDuration={1500}
                name="actual"
              />
              <Line
                type="monotone"
                dataKey="tsoForecast"
                stroke="#10B981"
                strokeWidth={2}
                strokeDasharray="8 4"
                dot={false}
                activeDot={{ r: 6, fill: '#10B981', stroke: 'white', strokeWidth: 2 }}
                animationDuration={1500}
                name="tsoForecast"
              />
            </>
          )}

          {/* TSO Forecast Overlay Mode */}
          {showTSOForecast && !showTSOComparisonMode && (
            <>
              {/* Week-ahead: Show shaded band between min and max */}
              {tsoHorizon === 'week_ahead' && (
                <>
                  <Area
                    type="stepAfter"
                    dataKey="tsoForecastMax"
                    stroke="#10B981"
                    strokeWidth={1}
                    strokeOpacity={0.5}
                    fill="url(#tsoWeekAheadGradient)"
                    fillOpacity={0.3}
                    dot={false}
                    connectNulls={true}
                    name="tsoForecastMax"
                  />
                  <Area
                    type="stepAfter"
                    dataKey="tsoForecastMin"
                    stroke="#10B981"
                    strokeWidth={1}
                    strokeOpacity={0.5}
                    fill="hsl(var(--background))"
                    fillOpacity={1}
                    dot={false}
                    connectNulls={true}
                    name="tsoForecastMin"
                  />
                  <Line
                    type="stepAfter"
                    dataKey="tsoForecast"
                    stroke="#10B981"
                    strokeWidth={2}
                    strokeDasharray="8 4"
                    dot={false}
                    activeDot={{ r: 6, fill: '#10B981', stroke: 'white', strokeWidth: 2 }}
                    animationDuration={1500}
                    name="tsoForecast"
                    connectNulls={true}
                  />
                </>
              )}

              {/* Day-ahead: Show dashed line with area fill */}
              {tsoHorizon === 'day_ahead' && (
                <>
                  <Area
                    type="monotone"
                    dataKey="tsoForecast"
                    fill="url(#tsoForecastGradient)"
                    stroke="transparent"
                    animationDuration={1500}
                    connectNulls={true}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="tsoForecast"
                    stroke="#10B981"
                    strokeWidth={2}
                    strokeDasharray="8 4"
                    dot={false}
                    activeDot={{ r: 6, fill: '#10B981', stroke: 'white', strokeWidth: 2 }}
                    animationDuration={1500}
                    name="tsoForecast"
                    connectNulls={true}
                  />
                </>
              )}
            </>
          )}

          {/* Consolidated "Now" marker — shown when any forecast is active and not in comparison mode */}
          {(showForecast || showTSOForecast) && !showComparisonMode && !showTSOComparisonMode && chartData.length > 0 && (
            <>
              <ReferenceArea
                x1={nowTimestamp}
                x2={chartData[chartData.length - 1].timestamp}
                fill="hsl(var(--muted-foreground))"
                fillOpacity={0.04}
                ifOverflow="hidden"
              />
              <ReferenceLine
                x={nowTimestamp}
                stroke="hsl(var(--foreground))"
                strokeWidth={2}
                strokeDasharray="8 4"
                label={{ value: 'Now', position: 'top', fill: 'hsl(var(--foreground))', fontSize: 13, fontWeight: 700 }}
              />
            </>
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartWrapper>
  );
}
