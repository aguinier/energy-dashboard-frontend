import { useState, useEffect, useMemo, useCallback, useId, useRef, memo } from 'react';
import { ComposableMap, Geographies, Geography } from 'react-simple-maps';
import { ChartWrapper } from '@/components/charts/ChartWrapper';
import { useMapData } from '@/hooks/useDashboardData';
import { useDashboardStore } from '@/store/dashboardStore';
import { usePrefetchCountry } from '@/hooks/usePrefetch';
import { MAP_METRICS } from '@/lib/constants';
import { divergingT, symmetricBound } from '@/lib/divergingScale';
import { cn } from '@/lib/utils';
import type { MetricType, MapDataPoint } from '@/types';

const EUROPE_GEO_URL = '/europe.topojson';

// The desktop viewBox (1000x650) is landscape. Below this container width the
// map's container turns portrait (phones, and most tablets in portrait), and
// a landscape viewBox scaled with preserveAspectRatio="xMidYMid meet" (the
// ComposableMap default) only fits the *width* of a portrait box, centering
// vertically and leaving hundreds of px of dead space above/below — the map
// looks tiny even though the <svg> element itself spans the full width.
// Below the breakpoint we swap to a narrow viewBox sized to the *measured*
// container aspect ratio (via ResizeObserver, not a guessed header offset),
// so "meet" binds evenly on both axes instead of just one.
const DESKTOP_MIN_WIDTH = 1024;
const DESKTOP_VIEWBOX = { width: 1000, height: 650, scale: 440 };
// Reference width for the narrow viewBox. The resulting on-screen ink % is
// independent of the absolute number chosen here (only the scale/width
// ratio matters — see EuropeMap tuning notes) so this is just a convenient
// unit; height is derived per-render from the measured container aspect.
const NARROW_VIEWBOX_WIDTH = 420;
// Empirically tuned (see task-11 follow-up report) so Europe's ink — Iceland
// to Turkey, Norway to Malta, all confirmed unclipped — fills ~95% of the
// narrow viewBox width, instead of the ~39% the old fixed 1000-wide viewBox
// produced once scaled down to fit a phone screen.
const NARROW_SCALE = 305;

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
// No-data must not sit on the same beige axis as the diverging scale's zero,
// or a balanced country and a missing one read identically.
const NO_DATA = '#E4E0D6';

// Net position is the one signed metric: amber = importing, blue = exporting,
// meeting at a near-neutral zero. Amber/blue rather than red/green so the two
// directions stay distinguishable for red-green colour blindness.
const IMPORT_STRONG = '#B45309';
const NEUTRAL_ZERO = '#F4F1EC';
const EXPORT_STRONG = '#14506E';

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
  // Net position is signed, so it cannot use the min→max normalisation below:
  // that would place 0 MW wherever it happens to fall in the range. See
  // divergingScale.ts.
  if (metric === 'net_position') {
    const t = divergingT(value, symmetricBound(min, max));
    return t < 0.5
      ? lerp(IMPORT_STRONG, NEUTRAL_ZERO, t * 2)
      : lerp(NEUTRAL_ZERO, EXPORT_STRONG, (t - 0.5) * 2);
  }
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
    case 'net_position':
      return (Math.abs(value) >= 1000 ? (value / 1000).toFixed(2) : value.toFixed(0));
    default: return value.toString();
  }
}

function formatLegendValue(value: number, metric: MetricType): string {
  switch (metric) {
    case 'load': return (value / 1000).toFixed(value >= 10000 ? 0 : 1);
    case 'price': return value.toFixed(0);
    case 'renewable_pct': return value.toFixed(0);
    case 'net_position':
      return (Math.abs(value) >= 1000 ? (value / 1000).toFixed(1) + 'k' : value.toFixed(0));
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
  // Unique per mounted instance — the map can render both docked (ChartWrapper)
  // and full-screen at once, and a hardcoded pattern id would collide.
  const noDataHatchId = `no-data-hatch-${useId()}`;

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
    const usable = mapData.filter((d) => d.value != null && Number.isFinite(d.value));
    const values = usable.map((d) => d.value);
    const dataMap = new Map(usable.map((d) => [d.country_code, d]));
    if (values.length === 0) return { min: 0, max: 100, dataMap };
    return { min: Math.min(...values), max: Math.max(...values), dataMap };
  }, [mapData]);

  const metricInfo = MAP_METRICS.find((m) => m.value === mapMetric);

  const getCountryCode = (geo: { properties: Record<string, string> }): string | null => {
    const name = geo.properties.NAME;
    return name ? (COUNTRY_NAME_MAP[name] || null) : null;
  };

  // Measure the actual rendered container (not window.innerWidth minus a
  // guessed header height) so the viewBox aspect always matches reality,
  // whether this is the full-screen map view or a docked chart card.
  // Belt-and-suspenders: ResizeObserver is the primary signal, but it only
  // guarantees delivery before the next paint — some embedding contexts
  // (e.g. an inactive/non-compositing tab) can delay or skip that, so a
  // window `resize` listener re-measures directly too, and the initial
  // state is seeded from window.innerWidth/innerHeight for a same-render
  // best guess rather than defaulting to the desktop numbers.
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState(() => ({
    width: typeof window === 'undefined' ? 1440 : window.innerWidth,
    height: typeof window === 'undefined' ? 900 : window.innerHeight,
  }));
  const measureContainer = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    if (width > 0 && height > 0) setContainerSize({ width, height });
  }, []);
  useEffect(() => {
    measureContainer();
    const el = containerRef.current;
    const ro = el && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measureContainer) : undefined;
    ro?.observe(el!);
    window.addEventListener('resize', measureContainer);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measureContainer);
    };
  }, [measureContainer]);

  const isDesktop = containerSize.width >= DESKTOP_MIN_WIDTH;

  // Narrow viewports get a portrait-ish viewBox (width fixed, height derived
  // from the measured aspect ratio) plus a raised scale — see the constants
  // above for why lowering scale on a landscape viewBox (the old approach)
  // made things worse, not better.
  const projectionScale = fullScreen ? (isDesktop ? DESKTOP_VIEWBOX.scale : NARROW_SCALE) : 260;
  const mapWidth = fullScreen && !isDesktop ? NARROW_VIEWBOX_WIDTH : DESKTOP_VIEWBOX.width;
  const mapHeight = !fullScreen
    ? 420
    : isDesktop
      ? DESKTOP_VIEWBOX.height
      : Math.round(NARROW_VIEWBOX_WIDTH * (containerSize.height / containerSize.width));

  const mapContent = (
    <div ref={containerRef} className={cn('relative', fullScreen ? 'h-full w-full' : 'h-full min-h-[400px]')}>
      <ComposableMap
        projection="geoMercator"
        projectionConfig={{ center: [12, 55], scale: projectionScale }}
        width={mapWidth}
        height={mapHeight}
        style={{ width: '100%', height: '100%', shapeRendering: 'geometricPrecision' }}
      >
        <defs>
          <pattern id={noDataHatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill={NO_DATA} />
            <line x1="0" y1="0" x2="0" y2="6" stroke="#CFCABE" strokeWidth="1.5" />
          </pattern>
        </defs>
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
                  fill={has ? dataColor(mapMetric, d!.value, min, max) : `url(#${noDataHatchId})`}
                  stroke={isHover || isSelected ? 'hsl(var(--foreground))' : '#FFFFFF'}
                  strokeWidth={isHover ? 2.4 : isSelected ? 1.6 : 1.2}
                  style={{
                    default: {
                      outline: 'none',
                      opacity: hoveredCountry && !isHover ? 0.55 : 1,
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

      {/* Hover card — top-right on desktop. On narrow viewports the floating
          metric selector (MapMetricSelector `floating`) is centered across
          the top of this same container, so top-5 there would sit right
          under/over it; drop the card below the selector instead. */}
      {hoveredCountry && (
        <div
          className={cn(
            'pointer-events-none absolute min-w-[260px] rounded-[10px] border border-border bg-card px-4 py-3.5 shadow-[0_4px_20px_rgba(0,0,0,0.06)]',
            isDesktop ? 'right-5 top-5' : 'right-3 top-16',
          )}
        >
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
              {metricInfo?.unit ?? ''}
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
          <span className="text-xs font-medium text-foreground">
            {metricInfo?.legendLabel}
          </span>
          <span className="font-mono-num text-[10.5px] text-ink-muted">
            {metricInfo?.unit}
          </span>
        </div>
        <div
          className="mb-1 h-2 rounded"
          style={{
            background:
              mapMetric === 'load'
                ? `linear-gradient(90deg, ${LOAD_LOW}, ${LOAD_HIGH})`
                : mapMetric === 'net_position'
                ? `linear-gradient(90deg, ${IMPORT_STRONG}, ${NEUTRAL_ZERO} 50%, ${EXPORT_STRONG})`
                : mapMetric === 'renewable_pct'
                ? `linear-gradient(90deg, ${DIRTY}, ${MEDIUM}, ${CLEAN})`
                : `linear-gradient(90deg, ${CLEAN}, ${MEDIUM}, ${DIRTY})`,
          }}
        />
        {mapMetric === 'net_position' ? (
          <>
            {/* Ends are ±bound, so the centre tick is a true zero rather than
                the midpoint of the data range. */}
            <div className="flex justify-between font-mono-num text-[10.5px] text-ink-muted">
              <span>−{formatLegendValue(symmetricBound(min, max), mapMetric)}</span>
              <span>0</span>
              <span>+{formatLegendValue(symmetricBound(min, max), mapMetric)}</span>
            </div>
            <div className="flex justify-between text-[10px] text-ink-muted">
              <span>importing</span>
              <span>exporting</span>
            </div>
          </>
        ) : (
          <div className="flex justify-between font-mono-num text-[10.5px] text-ink-muted">
            <span>{formatLegendValue(min, mapMetric)}</span>
            <span>{formatLegendValue((min + max) / 2, mapMetric)}</span>
            <span>{formatLegendValue(max, mapMetric)}</span>
          </div>
        )}
        <div className="mt-2 flex items-center gap-1.5 border-t border-input pt-2">
          <svg width="10" height="10" className="rounded-sm border border-border">
            <defs>
              <pattern id={`${noDataHatchId}-legend`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill={NO_DATA} />
                <line x1="0" y1="0" x2="0" y2="6" stroke="#CFCABE" strokeWidth="1.5" />
              </pattern>
            </defs>
            <rect width="10" height="10" fill={`url(#${noDataHatchId}-legend)`} />
          </svg>
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
