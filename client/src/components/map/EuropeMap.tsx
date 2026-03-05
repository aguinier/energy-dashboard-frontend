import { useState, useMemo, useCallback, memo } from 'react';
import { m } from 'framer-motion';
import { ComposableMap, Geographies, Geography } from 'react-simple-maps';
import { ChartWrapper } from '@/components/charts/ChartWrapper';
import { useMapData } from '@/hooks/useDashboardData';
import { useDashboardStore } from '@/store/dashboardStore';
import { usePrefetchCountry } from '@/hooks/usePrefetch';
import { formatMW, formatPrice, formatPercentage } from '@/lib/formatters';
import { MAP_METRICS } from '@/lib/constants';
import { cn } from '@/lib/utils';
import type { MetricType, MapDataPoint } from '@/types';

// Europe TopoJSON - self-hosted for faster loading
const EUROPE_GEO_URL = '/europe.topojson';

// Map country names from TopoJSON to our country codes
const COUNTRY_NAME_MAP: Record<string, string> = {
  'Germany': 'DE', 'France': 'FR', 'Italy': 'IT', 'Spain': 'ES', 'United Kingdom': 'GB',
  'Poland': 'PL', 'Netherlands': 'NL', 'Belgium': 'BE', 'Austria': 'AT', 'Switzerland': 'CH',
  'Portugal': 'PT', 'Sweden': 'SE', 'Norway': 'NO', 'Finland': 'FI', 'Denmark': 'DK',
  'Ireland': 'IE', 'Greece': 'GR', 'Czech Republic': 'CZ', 'Czechia': 'CZ', 'Romania': 'RO', 
  'Hungary': 'HU', 'Slovakia': 'SK', 'Bulgaria': 'BG', 'Croatia': 'HR', 'Serbia': 'RS', 
  'Slovenia': 'SI', 'Lithuania': 'LT', 'Latvia': 'LV', 'Estonia': 'EE', 'Albania': 'AL', 
  'North Macedonia': 'MK', 'Macedonia': 'MK', 'Montenegro': 'ME', 'Bosnia and Herzegovina': 'BA', 
  'Kosovo': 'XK', 'Ukraine': 'UA', 'Belarus': 'BY', 'Moldova': 'MD', 'Luxembourg': 'LU', 
  'Malta': 'MT', 'Cyprus': 'CY',
};

function getColorForValue(value: number, min: number, max: number, metric: MetricType): string {
  const normalized = Math.max(0, Math.min(1, (value - min) / (max - min)));

  if (metric === 'price') {
    // Green -> Yellow -> Red for prices
    if (value < 0) return 'hsl(270, 70%, 50%)'; // Purple for negative
    const hue = 120 - normalized * 120; // 120 (green) to 0 (red)
    return `hsl(${hue}, 70%, 45%)`;
  } else if (metric === 'renewable_pct') {
    // Red -> Yellow -> Green for renewables (higher is better)
    const hue = normalized * 120; // 0 (red) to 120 (green)
    return `hsl(${hue}, 70%, 45%)`;
  } else {
    // Blue scale for load
    const lightness = 75 - normalized * 45; // 75% to 30%
    return `hsl(220, 80%, ${lightness}%)`;
  }
}

function formatValue(value: number, metric: MetricType): string {
  switch (metric) {
    case 'load':
      return formatMW(value);
    case 'price':
      return formatPrice(value);
    case 'renewable_pct':
      return formatPercentage(value);
    default:
      return value.toString();
  }
}

interface EuropeMapProps {
  /** When true, renders without ChartWrapper for full-screen display */
  fullScreen?: boolean;
  /** Custom click handler - if provided, overrides default setSelectedCountry */
  onCountryClick?: (countryCode: string) => void;
}

export const EuropeMap = memo(function EuropeMap({ fullScreen = false, onCountryClick }: EuropeMapProps) {
  const mapMetric = useDashboardStore((state) => state.mapMetric);
  const setMapMetric = useDashboardStore((state) => state.setMapMetric);
  const selectedCountry = useDashboardStore((state) => state.selectedCountry);
  const setSelectedCountry = useDashboardStore((state) => state.setSelectedCountry);
  const { data: mapData, isLoading } = useMapData();
  const prefetchCountry = usePrefetchCountry();

  const [hoveredCountry, setHoveredCountry] = useState<MapDataPoint | null>(null);

  // Memoize click handler - prefetch data before navigating
  const handleCountryClick = useCallback((countryCode: string) => {
    // Start prefetching immediately to reduce perceived load time
    prefetchCountry(countryCode);
    
    if (onCountryClick) {
      onCountryClick(countryCode);
    } else {
      setSelectedCountry(countryCode);
    }
  }, [onCountryClick, setSelectedCountry, prefetchCountry]);

  // Memoize hover handlers - also prefetch on hover for faster click response
  const handleMouseEnter = useCallback((countryData: MapDataPoint | null) => {
    if (countryData) {
      setHoveredCountry(countryData);
      // Prefetch on hover so data is ready when user clicks
      prefetchCountry(countryData.country_code);
    }
  }, [prefetchCountry]);

  const handleMouseLeave = useCallback(() => {
    setHoveredCountry(null);
  }, []);

  const { min, max, dataMap } = useMemo(() => {
    if (!mapData || mapData.length === 0) {
      return { min: 0, max: 100, dataMap: new Map<string, MapDataPoint>() };
    }

    const values = mapData.map((d) => d.value).filter((v) => v !== null && v !== undefined);
    const dataMap = new Map(mapData.map((d) => [d.country_code, d]));

    return {
      min: Math.min(...values),
      max: Math.max(...values),
      dataMap,
    };
  }, [mapData]);

  const metricInfo = MAP_METRICS.find((m) => m.value === mapMetric);

  // Helper to get country code from geography properties
  const getCountryCode = (geo: { properties: Record<string, string> }): string | null => {
    const countryName = geo.properties.NAME;
    return countryName ? (COUNTRY_NAME_MAP[countryName] || null) : null;
  };

  // Map content (shared between fullScreen and wrapped modes)
  const mapContent = (
    <div className={cn("relative", fullScreen ? "h-full w-full" : "h-full min-h-[400px]")}>
      <ComposableMap
        projection="geoMercator"
        projectionConfig={{
          center: [12, 55],
          scale: fullScreen ? 380 : 260,
        }}
        width={1000}
        height={fullScreen ? 650 : 420}
        style={{
          width: '100%',
          height: '100%',
          shapeRendering: 'geometricPrecision'
        }}
      >
        <Geographies geography={EUROPE_GEO_URL}>
          {({ geographies }) =>
            geographies.map((geo) => {
              const countryCode = getCountryCode(geo);
              const countryData = countryCode ? dataMap.get(countryCode) : null;
              const hasData = !!countryData;
              const isSelected = countryCode === selectedCountry;

              return (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  fill={
                    hasData
                      ? getColorForValue(countryData.value, min, max, mapMetric)
                      : 'hsl(220, 10%, 25%)'
                  }
                  stroke={isSelected ? '#3b82f6' : 'hsl(220, 10%, 35%)'}
                  strokeWidth={isSelected ? 1.5 : 0.3}
                  style={{
                    default: {
                      outline: 'none',
                      opacity: hasData ? 1 : 0.5,
                    },
                    hover: {
                      outline: 'none',
                      opacity: 1,
                      filter: 'brightness(1.1)',
                      cursor: hasData ? 'pointer' : 'default',
                    },
                    pressed: {
                      outline: 'none',
                    },
                  }}
                  onClick={() => {
                    if (countryCode && hasData) handleCountryClick(countryCode);
                  }}
                  onMouseEnter={() => handleMouseEnter(countryData ?? null)}
                  onMouseLeave={handleMouseLeave}
                />
              );
            })
          }
        </Geographies>
      </ComposableMap>

      {/* Enhanced Tooltip */}
      {hoveredCountry && (
        <m.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className={cn(
            "absolute rounded-lg border bg-background shadow-lg",
            fullScreen ? "top-4 right-4 p-5 min-w-[240px]" : "top-4 right-4 p-4 min-w-[200px]"
          )}
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
              {hoveredCountry.country_code}
            </span>
            <span className="font-semibold">{hoveredCountry.country_name}</span>
          </div>
          <div className={cn("font-bold", fullScreen ? "text-3xl" : "text-2xl")}>
            {formatValue(hoveredCountry.value, mapMetric)}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {metricInfo?.label}
          </p>
          {fullScreen && (
            <p className="text-xs text-primary mt-3 font-medium">
              Click to view details
            </p>
          )}
        </m.div>
      )}

      {/* Legend */}
      <div className={cn(
        "absolute rounded-lg border bg-background/90 backdrop-blur",
        fullScreen ? "bottom-6 left-6 p-4" : "bottom-4 left-4 p-3"
      )}>
        <p className="text-xs font-medium mb-2">{metricInfo?.label}</p>
        <div className="flex items-center gap-2">
          <div
            className={cn("rounded", fullScreen ? "h-4 w-32" : "h-3 w-24")}
            style={{
              background:
                mapMetric === 'price'
                  ? 'linear-gradient(to right, hsl(120, 70%, 45%), hsl(60, 70%, 45%), hsl(0, 70%, 45%))'
                  : mapMetric === 'renewable_pct'
                  ? 'linear-gradient(to right, hsl(0, 70%, 45%), hsl(60, 70%, 45%), hsl(120, 70%, 45%))'
                  : 'linear-gradient(to right, hsl(220, 80%, 75%), hsl(220, 80%, 30%))',
            }}
          />
        </div>
        <div className="flex justify-between text-xs text-muted-foreground mt-1 gap-4">
          <span>{formatValue(min, mapMetric)}</span>
          <span>{formatValue(max, mapMetric)}</span>
        </div>
      </div>
    </div>
  );

  // Full-screen mode: render without ChartWrapper
  // Note: Map geometry loads independently from data, so we render the map even while data is loading
  if (fullScreen) {
    return mapContent;
  }

  // Default: render with ChartWrapper
  return (
    <ChartWrapper
      title="Europe Energy Map"
      subtitle={`${metricInfo?.label || 'Data'} by country`}
      isLoading={isLoading}
      height={500}
      actions={
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {MAP_METRICS.map((metric) => (
            <button
              key={metric.value}
              onClick={() => setMapMetric(metric.value)}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium transition-all',
                mapMetric === metric.value
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {metric.label}
            </button>
          ))}
        </div>
      }
    >
      {mapContent}
    </ChartWrapper>
  );
});
