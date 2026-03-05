import { useMemo } from 'react';
import {
  ComposedChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
  ReferenceArea,
} from 'recharts';
import { ChartWrapper } from './ChartWrapper';
import { RenewableTypeToggles } from './RenewableTypeToggles';
import { LayersPanel } from './LayersPanel';
import { useRenewableChartData } from '@/hooks/useRenewableChartData';
import { useDashboardStore } from '@/store/dashboardStore';
import { formatDate, formatMW } from '@/lib/formatters';
import { ENERGY_COLORS } from '@/lib/colors';
import type { ForecastType, AvailableLayers } from '@/types';

const SOURCES = [
  { key: 'solar', label: 'Solar', color: ENERGY_COLORS.solar, forecastType: 'solar' as ForecastType },
  { key: 'wind_onshore', label: 'Wind Onshore', color: ENERGY_COLORS.wind_onshore, forecastType: 'wind_onshore' as ForecastType },
  { key: 'wind_offshore', label: 'Wind Offshore', color: ENERGY_COLORS.wind_offshore, forecastType: 'wind_offshore' as ForecastType },
  { key: 'hydro', label: 'Hydro', color: ENERGY_COLORS.hydro, forecastType: 'hydro_total' as ForecastType },
  { key: 'biomass', label: 'Biomass', color: ENERGY_COLORS.biomass, forecastType: 'biomass' as ForecastType },
  { key: 'geothermal', label: 'Geothermal', color: ENERGY_COLORS.geothermal, forecastType: null },
];

export function RenewableMixChart() {
  // Use batched hook for parallel data fetching
  const {
    renewableData: data,
    solarForecast,
    windOnshoreForecast,
    windOffshoreForecast,
    hydroForecast,
    biomassForecast,
    tsoGenerationForecast,
    isLoading,
  } = useRenewableChartData();

  // Use selective store subscriptions to minimize re-renders
  const timeRange = useDashboardStore((s) => s.timeRange);
  const showForecast = useDashboardStore((s) => s.showForecast);
  const showTSOForecast = useDashboardStore((s) => s.showTSOForecast);
  const visibleRenewableTypes = useDashboardStore((s) => s.visibleRenewableTypes);

  // Available layers configuration for RenewableMixChart
  // TSO generation forecasts are day-ahead only (no week-ahead)
  const availableLayers: AvailableLayers = {
    tso: {
      available: true,
      horizons: ['day_ahead'], // Only day-ahead for generation forecasts
      hasAccuracy: false, // No accuracy comparison for generation yet
    },
    ml: {
      available: true,
      horizons: [1, 2], // D+1 and D+2
      hasAccuracy: false, // No accuracy comparison for generation yet
    },
  };

  const dateFormat = timeRange === '24h' || timeRange === '7d' ? 'MMM d HH:mm' : 'MMM d';
  const nowTimestamp = new Date().toISOString();

  // Merge actual and forecast data
  const chartData = useMemo(() => {
    const actualData = data?.map((d) => ({
      timestamp: d.timestamp,
      solar: d.solar,
      wind_onshore: d.wind_onshore,
      wind_offshore: d.wind_offshore,
      hydro: d.hydro,
      biomass: d.biomass,
      geothermal: d.geothermal,
      // ML Forecast fields
      solar_forecast: undefined as number | undefined,
      wind_onshore_forecast: undefined as number | undefined,
      wind_offshore_forecast: undefined as number | undefined,
      hydro_forecast: undefined as number | undefined,
      biomass_forecast: undefined as number | undefined,
      // TSO Forecast fields
      tso_solar_forecast: undefined as number | undefined,
      tso_wind_onshore_forecast: undefined as number | undefined,
      tso_wind_offshore_forecast: undefined as number | undefined,
    })) || [];

    if (!showForecast && !showTSOForecast) return actualData;

    // Create forecast points map
    const forecastMap = new Map<string, typeof actualData[0]>();

    const createEmptyPoint = (timestamp: string) => ({
      timestamp,
      solar: undefined as unknown as number,
      wind_onshore: undefined as unknown as number,
      wind_offshore: undefined as unknown as number,
      hydro: undefined as unknown as number,
      biomass: undefined as unknown as number,
      geothermal: undefined as unknown as number,
      solar_forecast: undefined,
      wind_onshore_forecast: undefined,
      wind_offshore_forecast: undefined,
      hydro_forecast: undefined,
      biomass_forecast: undefined,
      tso_solar_forecast: undefined,
      tso_wind_onshore_forecast: undefined,
      tso_wind_offshore_forecast: undefined,
    });

    // Add ML forecasts
    if (showForecast) {
      const addForecast = (forecast: typeof solarForecast, key: keyof typeof actualData[0]) => {
        forecast?.forEach((f) => {
          if (!forecastMap.has(f.timestamp)) {
            forecastMap.set(f.timestamp, createEmptyPoint(f.timestamp));
          }
          const point = forecastMap.get(f.timestamp)!;
          (point as Record<string, unknown>)[key] = f.value;
        });
      };

      addForecast(solarForecast, 'solar_forecast');
      addForecast(windOnshoreForecast, 'wind_onshore_forecast');
      addForecast(windOffshoreForecast, 'wind_offshore_forecast');
      addForecast(hydroForecast, 'hydro_forecast');
      addForecast(biomassForecast, 'biomass_forecast');
    }

    // Add TSO generation forecasts
    if (showTSOForecast && tsoGenerationForecast?.length) {
      for (const f of tsoGenerationForecast) {
        // Add to existing actual data points
        const existingActual = actualData.find((d) => d.timestamp === f.timestamp);
        if (existingActual) {
          existingActual.tso_solar_forecast = f.solar_mw ?? undefined;
          existingActual.tso_wind_onshore_forecast = f.wind_onshore_mw ?? undefined;
          existingActual.tso_wind_offshore_forecast = f.wind_offshore_mw ?? undefined;
        } else {
          // Create new forecast-only point
          if (!forecastMap.has(f.timestamp)) {
            forecastMap.set(f.timestamp, createEmptyPoint(f.timestamp));
          }
          const point = forecastMap.get(f.timestamp)!;
          point.tso_solar_forecast = f.solar_mw ?? undefined;
          point.tso_wind_onshore_forecast = f.wind_onshore_mw ?? undefined;
          point.tso_wind_offshore_forecast = f.wind_offshore_mw ?? undefined;
        }
      }
    }

    const forecastPoints = Array.from(forecastMap.values());
    const combined = [...actualData, ...forecastPoints];
    combined.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Bridge logic: at the last actual data point, copy actual values into forecast
    // fields so forecast areas start seamlessly from where actuals end (no visual gap)
    const nowMs = new Date(nowTimestamp).getTime();
    let lastActualIdx = -1;
    for (let i = combined.length - 1; i >= 0; i--) {
      const ts = new Date(combined[i].timestamp).getTime();
      const hasActual = SOURCES.some(s => {
        const v = combined[i][s.key as keyof typeof combined[0]];
        return typeof v === 'number' && v > 0;
      });
      if (hasActual && ts <= nowMs) {
        lastActualIdx = i;
        break;
      }
    }
    if (lastActualIdx >= 0) {
      const bridge = combined[lastActualIdx];
      if (showForecast) {
        SOURCES.filter(s => s.forecastType && visibleRenewableTypes.includes(s.key)).forEach(s => {
          const forecastKey = `${s.key}_forecast` as keyof typeof bridge;
          const actualVal = bridge[s.key as keyof typeof bridge];
          if (typeof actualVal === 'number' && actualVal > 0 && bridge[forecastKey] == null) {
            (bridge as Record<string, unknown>)[forecastKey] = actualVal;
          }
        });
      }
      if (showTSOForecast) {
        const tsoMap = [
          { actual: 'solar', forecast: 'tso_solar_forecast' },
          { actual: 'wind_onshore', forecast: 'tso_wind_onshore_forecast' },
          { actual: 'wind_offshore', forecast: 'tso_wind_offshore_forecast' },
        ];
        tsoMap.forEach(({ actual, forecast }) => {
          const actualVal = bridge[actual as keyof typeof bridge];
          if (typeof actualVal === 'number' && actualVal > 0 && bridge[forecast as keyof typeof bridge] == null) {
            (bridge as Record<string, unknown>)[forecast] = actualVal;
          }
        });
      }
    }

    return combined;
  }, [data, showForecast, showTSOForecast, solarForecast, windOnshoreForecast, windOffshoreForecast, hydroForecast, biomassForecast, tsoGenerationForecast, visibleRenewableTypes, nowTimestamp]);

  // Check if there's any actual data or forecast data to display
  const hasData = useMemo(() => {
    if (!chartData || chartData.length === 0) return false;

    // Check if any visible renewable type has non-zero actual values
    const hasActualData = chartData.some((point) =>
      visibleRenewableTypes.some((type) => {
        const value = point[type as keyof typeof point];
        return typeof value === 'number' && value > 0;
      })
    );

    // Check for ML forecast data when ML forecast overlay is enabled
    const hasMLForecastData = showForecast && chartData.some((point) =>
      (point.solar_forecast != null && point.solar_forecast > 0) ||
      (point.wind_onshore_forecast != null && point.wind_onshore_forecast > 0) ||
      (point.wind_offshore_forecast != null && point.wind_offshore_forecast > 0) ||
      (point.hydro_forecast != null && point.hydro_forecast > 0) ||
      (point.biomass_forecast != null && point.biomass_forecast > 0)
    );

    // Check for TSO forecast data when TSO forecast overlay is enabled
    const hasTSOForecastData = showTSOForecast && chartData.some((point) =>
      (point.tso_solar_forecast != null && point.tso_solar_forecast > 0) ||
      (point.tso_wind_onshore_forecast != null && point.tso_wind_onshore_forecast > 0) ||
      (point.tso_wind_offshore_forecast != null && point.tso_wind_offshore_forecast > 0)
    );

    return hasActualData || hasMLForecastData || hasTSOForecastData;
  }, [chartData, visibleRenewableTypes, showForecast, showTSOForecast]);

  return (
    <ChartWrapper
      title="Renewable Energy Mix"
      subtitle="Generation by source over time"
      isLoading={isLoading}
      height={400}
      actions={
        <>
          {/* Unified Layers Panel */}
          <LayersPanel availableLayers={availableLayers} />
          <RenewableTypeToggles />
        </>
      }
    >
      {!hasData && !isLoading ? (
        <div className="flex items-center justify-center h-full text-muted-foreground">
          <div className="text-center">
            <p className="text-sm">No renewable generation data available</p>
            <p className="text-xs text-muted-foreground/70 mt-1">for this time range</p>
          </div>
        </div>
      ) : (
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData}>
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
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;

              // Separate actual, ML forecast, and TSO forecast data
              const actualPayload = payload.filter((p) => !String(p.dataKey).includes('forecast'));
              const mlForecastPayload = payload.filter((p) =>
                String(p.dataKey).includes('_forecast') && !String(p.dataKey).includes('tso_')
              );
              const tsoForecastPayload = payload.filter((p) => String(p.dataKey).includes('tso_'));

              const actualTotal = actualPayload.reduce((sum, p) => sum + (Number(p.value) || 0), 0);
              const mlForecastTotal = mlForecastPayload.reduce((sum, p) => sum + (Number(p.value) || 0), 0);
              const tsoForecastTotal = tsoForecastPayload.reduce((sum, p) => sum + (Number(p.value) || 0), 0);

              const hasActual = actualTotal > 0;
              const hasMLForecast = mlForecastTotal > 0;
              const hasTSOForecast = tsoForecastTotal > 0;

              return (
                <div className="rounded-lg border bg-background p-3 shadow-lg min-w-[200px]">
                  <p className="text-sm font-medium mb-2">
                    {formatDate(label, 'MMM d, yyyy HH:mm')}
                    {label && new Date(label).getTime() > new Date(nowTimestamp).getTime() && (
                      <span className="ml-2 text-xs bg-orange-500/20 text-orange-400 px-1.5 py-0.5 rounded">Forecast</span>
                    )}
                  </p>

                  {/* Actual values */}
                  {hasActual && (
                    <div className="space-y-1 mb-2">
                      <p className="text-xs text-muted-foreground">Actual</p>
                      {actualPayload
                        .filter((p) => Number(p.value) > 0)
                        .reverse()
                        .map((p) => {
                          const source = SOURCES.find((s) => s.key === p.dataKey);
                          return (
                            <div key={p.dataKey} className="flex items-center justify-between gap-4 text-sm">
                              <div className="flex items-center gap-2">
                                <div className="h-3 w-3 rounded-full" style={{ backgroundColor: source?.color || p.color }} />
                                <span className="text-muted-foreground">{source?.label}</span>
                              </div>
                              <span className="font-medium">{formatMW(Number(p.value))}</span>
                            </div>
                          );
                        })}
                    </div>
                  )}

                  {/* TSO Forecast values */}
                  {hasTSOForecast && (
                    <div className="space-y-1 mb-2">
                      <p className="text-xs text-emerald-500">TSO Forecast</p>
                      {tsoForecastPayload
                        .filter((p) => Number(p.value) > 0)
                        .map((p) => {
                          const key = String(p.dataKey).replace('tso_', '').replace('_forecast', '');
                          const source = SOURCES.find((s) => s.key === key);
                          return (
                            <div key={p.dataKey} className="flex items-center justify-between gap-4 text-sm">
                              <div className="flex items-center gap-2">
                                <div className="h-3 w-3 rounded-full" style={{ backgroundColor: source?.color }} />
                                <span className="text-muted-foreground">{source?.label}</span>
                              </div>
                              <span className="font-medium text-emerald-400">{formatMW(Number(p.value))}</span>
                            </div>
                          );
                        })}
                    </div>
                  )}

                  {/* ML Forecast values */}
                  {hasMLForecast && (
                    <div className="space-y-1 mb-2">
                      <p className="text-xs text-orange-500">ML Forecast</p>
                      {mlForecastPayload
                        .filter((p) => Number(p.value) > 0)
                        .map((p) => {
                          const key = String(p.dataKey).replace('_forecast', '');
                          const source = SOURCES.find((s) => s.key === key);
                          return (
                            <div key={p.dataKey} className="flex items-center justify-between gap-4 text-sm">
                              <div className="flex items-center gap-2">
                                <div className="h-3 w-3 rounded-full" style={{ backgroundColor: source?.color }} />
                                <span className="text-muted-foreground">{source?.label}</span>
                              </div>
                              <span className="font-medium text-orange-500">{formatMW(Number(p.value))}</span>
                            </div>
                          );
                        })}
                    </div>
                  )}

                  {/* Totals */}
                  <div className="pt-2 border-t space-y-1">
                    {hasActual && (
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Actual Total</span>
                        <span className="font-bold">{formatMW(actualTotal)}</span>
                      </div>
                    )}
                    {hasTSOForecast && (
                      <div className="flex justify-between text-sm">
                        <span className="text-emerald-500">TSO Total</span>
                        <span className="font-bold text-emerald-400">{formatMW(tsoForecastTotal)}</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            }}
          />
          <Legend
            content={({ payload }) => (
              <div className="flex flex-wrap justify-center gap-4 mt-4">
                {payload?.filter((entry) => !String(entry.value).includes('forecast') && visibleRenewableTypes.includes(entry.value as string)).map((entry) => (
                  <div
                    key={entry.value}
                    className="flex items-center gap-2 text-sm"
                  >
                    <div
                      className="h-3 w-3 rounded-full"
                      style={{ backgroundColor: entry.color }}
                    />
                    <span className="text-muted-foreground">
                      {SOURCES.find((s) => s.key === entry.value)?.label}
                    </span>
                  </div>
                ))}
                {showForecast && (
                  <div className="flex items-center gap-2 text-sm">
                    <div className="h-3 w-4 rounded-sm bg-orange-400/20 border border-dashed border-orange-500" />
                    <span className="text-muted-foreground">ML Forecast</span>
                  </div>
                )}
                {showTSOForecast && (
                  <div className="flex items-center gap-2 text-sm">
                    <div className="h-3 w-4 rounded-sm bg-emerald-500/15 border border-dashed border-emerald-500" />
                    <span className="text-muted-foreground">TSO Forecast</span>
                  </div>
                )}
              </div>
            )}
          />
          {/* SVG gradient definitions for forecast areas */}
          <defs>
            {SOURCES
              .filter(s => s.forecastType && visibleRenewableTypes.includes(s.key))
              .map(source => (
                <linearGradient key={`ml_grad_${source.key}`} id={`mlForecastGrad_${source.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={source.color} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={source.color} stopOpacity={0.10} />
                </linearGradient>
              ))}
            {/* TSO forecast gradients - emerald tinted */}
            {['solar', 'wind_onshore', 'wind_offshore']
              .filter(k => visibleRenewableTypes.includes(k))
              .map(key => (
                <linearGradient key={`tso_grad_${key}`} id={`tsoForecastGrad_${key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10B981" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#10B981" stopOpacity={0.05} />
                </linearGradient>
              ))}
          </defs>

          {/* === Layer 1: TSO forecast areas (bottom) === */}
          {showTSOForecast && ['solar', 'wind_onshore', 'wind_offshore']
            .filter(k => visibleRenewableTypes.includes(k))
            .map(key => (
              <Area
                key={`tso_${key}_forecast`}
                type="monotone"
                dataKey={`tso_${key}_forecast`}
                stackId="tso_forecast"
                stroke="#10B981"
                strokeWidth={1.5}
                strokeDasharray="8 4"
                strokeOpacity={0.6}
                fill={`url(#tsoForecastGrad_${key})`}
                fillOpacity={1}
                dot={false}
                connectNulls={true}
                animationDuration={1500}
                isAnimationActive={true}
              />
            ))}

          {/* === Layer 2: ML forecast areas === */}
          {showForecast && SOURCES
            .filter(s => s.forecastType && visibleRenewableTypes.includes(s.key))
            .map(source => (
              <Area
                key={`${source.key}_forecast`}
                type="monotone"
                dataKey={`${source.key}_forecast`}
                stackId="forecast"
                stroke={source.color}
                strokeWidth={1.5}
                strokeDasharray="6 3"
                strokeOpacity={0.7}
                fill={`url(#mlForecastGrad_${source.key})`}
                fillOpacity={1}
                dot={false}
                connectNulls={true}
                animationDuration={1500}
                isAnimationActive={true}
              />
            ))}

          {/* === Layer 3: Forecast region background shading === */}
          {(showForecast || showTSOForecast) && chartData && chartData.length > 0 && (
            <ReferenceArea
              x1={nowTimestamp}
              x2={chartData[chartData.length - 1].timestamp}
              fill="hsl(var(--muted-foreground))"
              fillOpacity={0.04}
              ifOverflow="hidden"
            />
          )}

          {/* === Layer 4: Actual data - stacked areas (top, most prominent) === */}
          {SOURCES
            .filter((source) => visibleRenewableTypes.includes(source.key))
            .map((source, index) => (
            <Area
              key={source.key}
              type="monotone"
              dataKey={source.key}
              stackId="1"
              stroke={source.color}
              fill={source.color}
              fillOpacity={0.8}
              animationDuration={1500}
              animationBegin={index * 100}
            />
          ))}

          {/* === Layer 5: Now reference line (very top) === */}
          {(showForecast || showTSOForecast) && (
            <ReferenceLine
              x={nowTimestamp}
              stroke="hsl(var(--foreground))"
              strokeWidth={1.5}
              strokeDasharray="6 3"
              label={{ value: 'Now', position: 'top', fill: 'hsl(var(--foreground))', fontSize: 12, fontWeight: 600 }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
      )}
    </ChartWrapper>
  );
}
