import { useState, useMemo, useCallback, memo } from 'react';
import { ComposableMap, Geographies, Geography } from 'react-simple-maps';
import { ChartWrapper } from '@/components/charts/ChartWrapper';
import { useMapData } from '@/hooks/useDashboardData';
import { useDashboardStore } from '@/store/dashboardStore';
import { usePrefetchCountry } from '@/hooks/usePrefetch';
import { MAP_METRICS } from '@/lib/constants';
import { cn } from '@/lib/utils';
import type { MetricType, MapDataPoint } from '@/types';

const EUROPE_GEO_URL = '/europe.topojson';

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

// able data-scale colors.
// Load is a magnitude → single-hue teal ramp, light → dark.
// Price / renewable share carry real polarity (cheap/expensive, clean/dirty)
// → diverging clean (green) → medium (amber) → dirty (terracotta).
const CLEAN = '#2C8A6B';
const MEDIUM = '#C99A2A';
const DIRTY = '#8E3D2C';
const LOAD_LOW = '#CFE3DC';
const LOAD_HIGH = '#12503F';
const NO_DATA = '#EDEBE3';

function lerp(a: string, b: string, t: number): string {
  const ah = parseInt(a.slice(1), 16);
  const bh = parseInt(b.slice(1), 16);
  const ar = (ah >> 16) & 0xff, ag = (ah >> 8) & 0xff, ab = ah & 0xff;
  const br = (bh >> 16) & 0xff, bg = (bh >> 8) & 0xff, bb = bh & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const c = Math.round(ab + (bb - ab) * t);
  return `rgb(${r},${g},${c})`;
}

function dataColor(metric: MetricType, value: number, min: number, max: number): string {
  if (max === min) return metric === 'load' ? lerp(LOAD_LOW, LOAD_HIGH, 0.5) : MEDIUM;
  let t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  if (metric === 'load') return lerp(LOAD_LOW, LOAD_HIGH, t); // magnitude: one hue
  if (metric === 'renewable_pct') t = 1 - t; // higher renewable = cleaner
  if (t < 0.5) return lerp(CLEAN, MEDIUM, t * 2);
  return lerp(MEDIUM, DIRTY, (t - 0.5) * 2);
}

// Number-only formatters — the unit is rendered once, in its own muted span.
function formatHoverValue(value: number, metric: MetricType): string {
  switch (metric) {
    case 'load': return (value / 1000).toFixed(value >= 10000 ? 1 : 2);
    case 'price': return value.toFixed(2);
    case 'renewable_pct': return value.toFixed(1);
    default: return value.toString();
  }
}

function hoverUnit(metric: MetricType, fallback?: string): string {
  return metric === 'load' ? 'GW' : fallback ?? '';
}

function formatLegendValue(value: number, metric: MetricType): string {
  switch (metric) {
    case 'load': return (value / 1000).toFixed(value >= 10000 ? 0 : 1);
    case 'price': return value.toFixed(0);
    case 'renewable_pct': return value.toFixed(0);
    default: return value.toString();
  }
}

interface EuropeMapProps {
  fullScreen?: boolean;
  onCountryClick?: (countryCode: string) => void;
}

export const EuropeMap = memo(function EuropeMap({ fullScreen = false, onCountryClick }: EuropeMapProps) {
  const mapMetric = useDashboardStore((s) => s.mapMetric);
  const setMapMetric = useDashboardStore((s) => s.setMapMetric);
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const setSelectedCountry = useDashboardStore((s) => s.setSelectedCountry);
  const { data: mapData, isLoading } = useMapData();
  const prefetchCountry = usePrefetchCountry();

  const [hoveredCountry, setHoveredCountry] = useState<MapDataPoint | null>(null);

  const handleCountryClick = useCallback((countryCode: string) => {
    prefetchCountry(countryCode);
    if (onCountryClick) onCountryClick(countryCode);
    else setSelectedCountry(countryCode);
  }, [onCountryClick, setSelectedCountry, prefetchCountry]);

  const handleMouseEnter = useCallback((d: MapDataPoint | null) => {
    if (d) {
      setHoveredCountry(d);
      prefetchCountry(d.country_code);
    }
  }, [prefetchCountry]);

  const handleMouseLeave = useCallback(() => setHoveredCountry(null), []);

  const { min, max, dataMap } = useMemo(() => {
    if (!mapData || mapData.length === 0) {
      return { min: 0, max: 100, dataMap: new Map<string, MapDataPoint>() };
    }
    const values = mapData.map((d) => d.value).filter((v) => v != null);
    const dataMap = new Map(mapData.map((d) => [d.country_code, d]));
    return { min: Math.min(...values), max: Math.max(...values), dataMap };
  }, [mapData]);

  const metricInfo = MAP_METRICS.find((m) => m.value === mapMetric);

  const getCountryCode = (geo: { properties: Record<string, string> }): string | null => {
    const name = geo.properties.NAME;
    return name ? (COUNTRY_NAME_MAP[name] || null) : null;
  };

  const mapContent = (
    <div className={cn('relative', fullScreen ? 'h-full w-full' : 'h-full min-h-[400px]')}>
      <ComposableMap
        projection="geoMercator"
        projectionConfig={{ center: [12, 55], scale: fullScreen ? 440 : 260 }}
        width={1000}
        height={fullScreen ? 650 : 420}
        style={{ width: '100%', height: '100%', shapeRendering: 'geometricPrecision' }}
      >
        <Geographies geography={EUROPE_GEO_URL}>
          {({ geographies }) =>
            geographies.map((geo) => {
              const code = getCountryCode(geo);
              const d = code ? dataMap.get(code) : null;
              const has = !!d;
              const isSelected = code === selectedCountry;
              const isHover = hoveredCountry?.country_code === code;
              return (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  fill={has ? dataColor(mapMetric, d!.value, min, max) : NO_DATA}
                  stroke={isHover || isSelected ? 'hsl(var(--foreground))' : '#FFFFFF'}
                  strokeWidth={isHover ? 2.4 : isSelected ? 1.6 : 1.2}
                  style={{
                    default: {
                      outline: 'none',
                      opacity: has ? (hoveredCountry && !isHover ? 0.55 : 1) : 0.55,
                      transition: 'fill-opacity 0.15s, stroke-width 0.15s',
                    },
                    hover: { outline: 'none', cursor: has ? 'pointer' : 'default' },
                    pressed: { outline: 'none' },
                  }}
                  onClick={() => { if (code && has) handleCountryClick(code); }}
                  onMouseEnter={() => handleMouseEnter(d ?? null)}
                  onMouseLeave={handleMouseLeave}
                />
              );
            })
          }
        </Geographies>
      </ComposableMap>

      {/* Top-right hover card */}
      {hoveredCountry && (
        <div className="pointer-events-none absolute right-5 top-5 min-w-[260px] rounded-[10px] border border-border bg-card px-4 py-3.5 shadow-[0_4px_20px_rgba(0,0,0,0.06)]">
          <div className="mb-2 flex items-baseline gap-2">
            <span className="font-mono-num text-[11px] text-ink-muted">
              {hoveredCountry.country_code}
            </span>
            <span className="text-[15px] font-medium text-foreground">
              {hoveredCountry.country_name}
            </span>
          </div>
          <div className="num text-[26px] font-medium text-foreground">
            {formatHoverValue(hoveredCountry.value, mapMetric)}
            <span className="ml-1 font-mono-num text-[11px] text-ink-muted">
              {hoverUnit(mapMetric, metricInfo?.unit)}
            </span>
          </div>
          <p className="mt-1 text-xs text-ink-dim">{metricInfo?.label}</p>
          {fullScreen && (
            <div className="mt-2.5 border-t border-input pt-2 font-mono-num text-[10px] text-ink-muted">
              Click to open →
            </div>
          )}
        </div>
      )}

      {/* Empty state — the API returned no countries for this metric */}
      {!isLoading && dataMap.size === 0 && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[10px] border border-border bg-card px-5 py-4 text-center shadow-[0_4px_20px_rgba(0,0,0,0.06)]">
          <div className="text-[13px] font-medium text-foreground">
            No {metricInfo?.label.toLowerCase() ?? 'metric'} data right now
          </div>
          <p className="mt-1 text-[12px] text-ink-dim">
            Pick another metric above, or check back after the next ENTSO-E sync.
          </p>
        </div>
      )}

      {/* Bottom-left legend */}
      <div className="absolute bottom-5 left-5 min-w-[280px] rounded-[10px] border border-border bg-card p-3.5 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-xs font-medium text-foreground">{metricInfo?.label}</span>
          <span className="font-mono-num text-[10.5px] text-ink-muted">
            {mapMetric === 'load' ? 'GW' : metricInfo?.unit}
          </span>
        </div>
        <div
          className="mb-1 h-2 rounded"
          style={{
            background:
              mapMetric === 'load'
                ? `linear-gradient(90deg, ${LOAD_LOW}, ${LOAD_HIGH})`
                : mapMetric === 'renewable_pct'
                ? `linear-gradient(90deg, ${DIRTY}, ${MEDIUM}, ${CLEAN})`
                : `linear-gradient(90deg, ${CLEAN}, ${MEDIUM}, ${DIRTY})`,
          }}
        />
        <div className="flex justify-between font-mono-num text-[10.5px] text-ink-muted">
          <span>{formatLegendValue(min, mapMetric)}</span>
          <span>{formatLegendValue((min + max) / 2, mapMetric)}</span>
          <span>{formatLegendValue(max, mapMetric)}</span>
        </div>
        <div className="mt-2 flex items-center gap-1.5 border-t border-input pt-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm border border-border"
            style={{ background: NO_DATA }}
          />
          <span className="font-mono-num text-[10px] text-ink-muted">no data</span>
        </div>
      </div>
    </div>
  );

  if (fullScreen) return mapContent;

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
                  : 'text-muted-foreground hover:text-foreground',
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
