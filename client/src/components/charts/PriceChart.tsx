import { useMemo } from 'react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Legend,
} from 'recharts';
import { ChartWrapper } from './ChartWrapper';
import { ForecastAccuracyMetrics } from './ForecastAccuracyMetrics';
import { LayersPanel } from './LayersPanel';
import { usePriceChartData } from '@/hooks/usePriceChartData';
import { useDashboardStore } from '@/store/dashboardStore';
import { formatDate, formatPrice } from '@/lib/formatters';
import { cn } from '@/lib/utils';
import type { AvailableLayers } from '@/types';

export function PriceChart() {
  // Use batched hook for parallel data fetching
  const {
    priceData: data,
    forecastData,
    comparisonData,
    isLoading,
    isLoadingComparison,
  } = usePriceChartData();

  // Use selective store subscriptions to minimize re-renders
  const timeRange = useDashboardStore((s) => s.timeRange);
  const showForecast = useDashboardStore((s) => s.showForecast);
  const showComparisonMode = useDashboardStore((s) => s.showComparisonMode);
  const layers = useDashboardStore((s) => s.layers);

  // Available layers configuration for PriceChart
  // No TSO forecasts for prices (ENTSO-E doesn't provide price forecasts)
  const availableLayers: AvailableLayers = {
    // TSO not available for price forecasts
    ml: {
      available: true,
      horizons: [1, 2], // D+1 and D+2
      hasAccuracy: true,
    },
  };

  const dateFormat = timeRange === '24h' || timeRange === '7d' ? 'MMM d HH:mm' : 'MMM d';

  // Merge actual and forecast data
  // Uses two forecast keys to avoid overlapping fills (stripes):
  //   - forecastLine: dashed line overlay where actual data exists (for comparison)
  //   - forecastArea: filled area only beyond the last actual data point (future)
  const chartData = useMemo(() => {
    const actualData = data?.map((d) => ({
      timestamp: d.timestamp,
      price: d.price,
      forecastLine: undefined as number | undefined,
      forecastArea: undefined as number | undefined,
      actualForComparison: undefined as number | undefined,
    })) || [];

    // Comparison mode: show historical forecasts vs actual values
    if (showForecast && showComparisonMode && comparisonData) {
      const comparisonPoints = comparisonData.forecasts.map((f) => {
        const actual = comparisonData.actuals.find((a) => a.timestamp === f.timestamp);
        return {
          timestamp: f.timestamp,
          price: undefined as number | undefined,
          forecastLine: f.value,
          forecastArea: undefined as number | undefined,
          actualForComparison: actual?.value,
        };
      });
      return comparisonPoints.sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
    }

    // Normal forecast mode
    if (showForecast && forecastData?.length) {
      const lastActualTime = actualData.length
        ? new Date(actualData[actualData.length - 1].timestamp).getTime()
        : 0;

      type DataPoint = { timestamp: string; price: number | undefined; forecastLine: number | undefined; forecastArea: number | undefined; actualForComparison: number | undefined };

      // Attach forecast values to nearest actual data points (overlay)
      // and collect future-only forecast points (beyond actual data)
      const forecastFuture: DataPoint[] = [];

      for (const f of forecastData) {
        const fTime = new Date(f.timestamp).getTime();
        if (fTime <= lastActualTime && actualData.length) {
          // Find nearest actual data point and attach forecast value
          let nearest = actualData[0];
          let nearestDiff = Math.abs(new Date(nearest.timestamp).getTime() - fTime);
          for (const d of actualData) {
            const diff = Math.abs(new Date(d.timestamp).getTime() - fTime);
            if (diff < nearestDiff) {
              nearest = d;
              nearestDiff = diff;
            }
            if (diff > nearestDiff) break; // data is sorted, stop once diverging
          }
          nearest.forecastLine = f.value;
        } else {
          forecastFuture.push({
            timestamp: f.timestamp,
            price: undefined as number | undefined,
            forecastLine: undefined as number | undefined,
            forecastArea: f.value,
            actualForComparison: undefined as number | undefined,
          });
        }
      }

      const combined = [...actualData, ...forecastFuture];
      combined.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      // Bridge last actual to first future forecast for a smooth area transition
      if (actualData.length && forecastFuture.length) {
        const lastActual = actualData[actualData.length - 1];
        const firstFutureIdx = combined.findIndex(
          (d) => d.forecastArea !== undefined && d.price === undefined
        );
        if (firstFutureIdx > 0) {
          combined[firstFutureIdx - 1].forecastArea = lastActual.price;
        }
      }

      return combined;
    }

    return actualData;
  }, [data, forecastData, showForecast, showComparisonMode, comparisonData]);

  // Calculate min price to check for negatives
  const minPrice = chartData.length
    ? Math.min(...chartData.map((d) => d.price ?? d.forecastLine ?? d.forecastArea ?? 0))
    : 0;
  const hasNegativePrices = minPrice < 0;

  // Snap "now" to nearest chart data point so ReferenceLine can anchor to it
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
      title="Energy Prices"
      subtitle="Market price per MWh"
      isLoading={isLoading}
      height={350}
      actions={
        <>
          {/* Unified Layers Panel */}
          <LayersPanel availableLayers={availableLayers} />

          {/* Accuracy Metrics (shown when in ML accuracy mode) */}
          {showForecast && layers.ml.showAccuracy && (
            <ForecastAccuracyMetrics
              comparisonData={comparisonData}
              unit="EUR/MWh"
              isLoading={isLoadingComparison}
            />
          )}
        </>
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData}>
          <defs>
            <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#F59E0B" stopOpacity={0.5} />
              <stop offset="100%" stopColor="#F59E0B" stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="forecastPriceGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#F97316" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#F97316" stopOpacity={0.05} />
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
            tickFormatter={(value) => `€${value}`}
            className="text-xs"
            tick={{ fill: 'hsl(var(--muted-foreground))' }}
            axisLine={{ stroke: 'hsl(var(--border))' }}
            tickLine={{ stroke: 'hsl(var(--border))' }}
            width={60}
            domain={hasNegativePrices ? ['auto', 'auto'] : [0, 'auto']}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload;
              const isComparison = layers.ml.showAccuracy && d.actualForComparison !== undefined;
              const forecastVal = d.forecastLine ?? d.forecastArea;
              const isForecastOnly = forecastVal !== undefined && d.price === undefined && !isComparison;
              const hasOverlay = d.price !== undefined && d.forecastLine !== undefined;
              const value = isForecastOnly ? forecastVal : d.price;
              const priceColor = isForecastOnly
                ? 'text-orange-300'
                : value < 0
                ? 'text-purple-500'
                : value < 50
                ? 'text-green-500'
                : value < 100
                ? 'text-amber-500'
                : 'text-red-500';

              if (isComparison) {
                return (
                  <div className="rounded-lg border bg-background p-3 shadow-lg">
                    <p className="text-sm font-medium">
                      {formatDate(d.timestamp, 'MMM d, yyyy HH:mm')}
                    </p>
                    <div className="mt-2 space-y-1">
                      <div>
                        <p className="text-xs text-muted-foreground">Actual</p>
                        <p className="text-lg font-bold text-green-500">
                          {formatPrice(d.actualForComparison)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">ML Forecast</p>
                        <p className="text-lg font-bold text-orange-500">
                          {formatPrice(d.forecastLine)}
                        </p>
                      </div>
                      <div className="border-t pt-1">
                        <p className="text-xs text-muted-foreground">Difference</p>
                        <p className={cn(
                          'text-sm font-semibold',
                          d.actualForComparison - d.forecastLine > 0 ? 'text-green-500' : 'text-red-500'
                        )}>
                          {d.actualForComparison - d.forecastLine > 0 ? '+' : ''}
                          {formatPrice(d.actualForComparison - d.forecastLine)}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              }
              return (
                <div className="rounded-lg border bg-background p-3 shadow-lg">
                  <p className="text-sm font-medium">
                    {formatDate(d.timestamp, 'MMM d, yyyy HH:mm')}
                    {isForecastOnly && (
                      <span className="ml-2 text-xs bg-orange-500/20 text-orange-400 px-1.5 py-0.5 rounded">
                        Forecast
                      </span>
                    )}
                  </p>
                  <p className={`mt-1 text-lg font-bold ${priceColor}`}>
                    {formatPrice(value)}
                  </p>
                  {hasOverlay && (
                    <div className="mt-1 border-t pt-1">
                      <p className="text-xs text-muted-foreground">ML Forecast</p>
                      <p className="text-sm font-semibold text-orange-400">
                        {formatPrice(d.forecastLine)}
                      </p>
                    </div>
                  )}
                  {isForecastOnly && (
                    <p className="text-xs text-muted-foreground">ML Forecast</p>
                  )}
                  {!isForecastOnly && value < 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Negative price (oversupply)
                    </p>
                  )}
                </div>
              );
            }}
          />
          {layers.ml.enabled && !layers.ml.showAccuracy && (
            <Legend
              content={() => (
                <div className="flex flex-wrap justify-center gap-4 mt-4">
                  <div className="flex items-center gap-2 text-sm">
                    <div className="h-3 w-3 rounded-full" style={{ backgroundColor: '#F59E0B' }} />
                    <span className="text-muted-foreground">Actual</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <div className="h-3 w-4 rounded-sm bg-orange-400/20 border border-dashed border-orange-500" />
                    <span className="text-muted-foreground">ML Forecast</span>
                  </div>
                </div>
              )}
            />
          )}
          {hasNegativePrices && (
            <ReferenceLine
              y={0}
              stroke="hsl(var(--muted-foreground))"
              strokeDasharray="3 3"
            />
          )}
          <Area
            type="monotone"
            dataKey="price"
            stroke="#F59E0B"
            strokeWidth={2}
            fill="url(#priceGradient)"
            animationDuration={1500}
            dot={false}
            activeDot={{ r: 6, fill: '#F59E0B', stroke: 'white', strokeWidth: 2 }}
            name="price"
          />
          {showForecast && layers.ml.showAccuracy && (
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
                dataKey="forecastLine"
                stroke="#F97316"
                strokeWidth={2}
                strokeDasharray="4 2"
                dot={false}
                activeDot={{ r: 6, fill: '#F97316', stroke: 'white', strokeWidth: 2 }}
                animationDuration={1500}
                name="forecast"
              />
            </>
          )}
          {/* Dashed line overlay where forecast overlaps actual data */}
          {showForecast && !layers.ml.showAccuracy && (
            <Line
              type="monotone"
              dataKey="forecastLine"
              stroke="#F97316"
              strokeWidth={2}
              strokeDasharray="6 3"
              dot={false}
              activeDot={{ r: 5, fill: '#F97316', stroke: 'white', strokeWidth: 2 }}
              animationDuration={1500}
              name="forecastLine"
              connectNulls={true}
            />
          )}
          {/* Filled area for forecast beyond actual data */}
          {showForecast && !layers.ml.showAccuracy && (
            <Area
              type="monotone"
              dataKey="forecastArea"
              stroke="#F97316"
              strokeWidth={2}
              strokeOpacity={0.85}
              fill="url(#forecastPriceGradient)"
              fillOpacity={1}
              dot={false}
              activeDot={{ r: 6, fill: '#F97316', stroke: 'white', strokeWidth: 2 }}
              animationDuration={1500}
              name="forecastArea"
              connectNulls={true}
            />
          )}
          {showForecast && !layers.ml.showAccuracy && (
            <ReferenceLine
              x={nowTimestamp}
              stroke="hsl(var(--foreground))"
              strokeWidth={2}
              strokeDasharray="8 4"
              label={{ value: 'Now', position: 'top', fill: 'hsl(var(--foreground))', fontSize: 13, fontWeight: 700 }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartWrapper>
  );
}
