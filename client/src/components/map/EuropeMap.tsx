import { useState, useEffect, useMemo, useCallback, useId, useRef, memo } from 'react';
import { ComposableMap, Geographies, Geography } from 'react-simple-maps';
import { ChartWrapper } from '@/components/charts/ChartWrapper';
import { useMapData } from '@/hooks/useDashboardData';
import { useDashboardStore } from '@/store/dashboardStore';
import { usePrefetchCountry } from '@/hooks/usePrefetch';
import { MAP_METRICS } from '@/lib/constants';
import {
  NON_CORE_MAP_NOTICE,
  netPositionHatchLegendLabel,
  netPositionLegendLabel,
  netPositionMapDisclosure,
} from '@/lib/netPositionScope';
import { useCoreNetPositionMap } from '@/hooks/useCoreNetPositionData';
import { isCoreNetPositionView, netPositionMapCellState } from './netPositionMapScope';
import { divergingT, symmetricBound } from '@/lib/divergingScale';
import { lerpHex, SCALE_CLEAN, SCALE_DIRTY, SCALE_MEDIUM } from '@/lib/dataScale';
import { cn } from '@/lib/utils';
import type { MetricType, MapDataPoint } from '@/types';
import { selectMapGeometry, hoverCardClearsSelector, countryAriaLabel } from './mapGeometry';
import { NoDataHatchPattern, NoDataSwatch, noDataHatchUrl } from './NoDataHatch';
import type { GeoFeature } from './mapGeometry';

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
// Load is a magnitude â†’ single-hue teal ramp, light â†’ dark.
// Price / renewable share carry real polarity (cheap/expensive, clean/dirty)
// â†’ diverging clean (green) â†’ medium (amber) â†’ dirty (terracotta).
// The three diverging stops moved to lib/dataScale.ts when ComparisonView
// adopted the same ramp â€” one definition, so the two views cannot disagree
// about which colour a given position on the scale is.
const CLEAN = SCALE_CLEAN;
const MEDIUM = SCALE_MEDIUM;
const DIRTY = SCALE_DIRTY;
const LOAD_LOW = '#CFE3DC';
const LOAD_HIGH = '#12503F';
// No-data is a diagonal hatch, not a fill â€” it moved to NoDataHatch.tsx when
// ComparisonMap needed the same mark (ABL-23). See that file for why it must not
// sit on the same beige axis as the diverging scale's zero below.

// Net position is the one signed metric: amber = importing, blue = exporting,
// meeting at a near-neutral zero. Amber/blue rather than red/green so the two
// directions stay distinguishable for red-green colour blindness.
const IMPORT_STRONG = '#B45309';
const NEUTRAL_ZERO = '#F4F1EC';
const EXPORT_STRONG = '#14506E';

const lerp = lerpHex;

function dataColor(metric: MetricType, value: number, min: number, max: number): string {
  // Net position is signed, so it cannot use the minâ†’max normalisation below:
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

// Number-only formatters â€” the unit is rendered once, in its own muted span.
// `load`'s unit label (metricInfo.unit = 'GW') already matches the unconditional
// /1000 below. `net_position`'s unit label is a fixed 'MW', so its conditional
// /1000 rescale must say 'k' itself (matching formatLegendValue) â€” otherwise a
// 2500 MW value renders as a bare "2.50" next to "MW", reading as 2.50 MW.
function formatHoverValue(value: number, metric: MetricType): string {
  switch (metric) {
    case 'load': return (value / 1000).toFixed(value >= 10000 ? 1 : 2);
    case 'price': return value.toFixed(2);
    case 'renewable_pct': return value.toFixed(1);
    case 'net_position':
      return (Math.abs(value) >= 1000 ? (value / 1000).toFixed(2) + 'k' : value.toFixed(0));
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
  const netPositionScope = useDashboardStore((s) => s.netPositionScope);
  const coreView = isCoreNetPositionView(mapMetric, netPositionScope);

  // Two sources for one metric (ABL-234). Both queries are gated, so the
  // all-coupled default issues exactly the request it did before this feature
  // and the Core one is never fetched unless its view is on screen.
  const allCoupled = useMapData();
  const core = useCoreNetPositionMap(coreView);
  const { data: mapData, isLoading } = coreView ? core : allCoupled;
  const prefetchCountry = usePrefetchCountry();

  const [hoveredCountry, setHoveredCountry] = useState<MapDataPoint | null>(null);
  // A country the Core view cannot colour because no Core net position exists
  // for it. Kept separate from `hoveredCountry` rather than folded in as a
  // point with a null value: everything downstream of `hoveredCountry` reads
  // `.value` as a number, and a nullable value there is how a "not
  // applicable" country ends up rendering a confident 0 MW.
  const [hoveredOutOfScope, setHoveredOutOfScope] = useState<{
    code: string;
    name: string;
  } | null>(null);
  // Unique per mounted instance â€” the map can render both docked (ChartWrapper)
  // and full-screen at once, and a hardcoded pattern id would collide.
  const noDataHatchId = `no-data-hatch-${useId()}`;

  const handleCountryClick = useCallback((countryCode: string) => {
    prefetchCountry(countryCode);
    if (onCountryClick) onCountryClick(countryCode);
    else setSelectedCountry(countryCode);
  }, [onCountryClick, setSelectedCountry, prefetchCountry]);

  const handleMouseEnter = useCallback((d: MapDataPoint | null) => {
    if (d) {
      setHoveredOutOfScope(null);
      setHoveredCountry(d);
      prefetchCountry(d.country_code);
    }
  }, [prefetchCountry]);

  // No prefetch here on purpose â€” this country has nothing to open in the
  // Core view, and warming its country page would be work for a click that
  // is not offered.
  const handleOutOfScopeEnter = useCallback((code: string, name: string) => {
    setHoveredCountry(null);
    setHoveredOutOfScope({ code, name });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoveredCountry(null);
    setHoveredOutOfScope(null);
  }, []);

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

  const getCountryCode = (geo: GeoFeature): string | null => {
    const name = geo.properties.NAME;
    return name ? (COUNTRY_NAME_MAP[name] || null) : null;
  };

  // Measure the actual rendered container (not window.innerWidth minus a
  // guessed header height) so the viewBox aspect always matches reality,
  // whether this is the full-screen map view or a docked chart card.
  // Belt-and-suspenders: ResizeObserver is the primary signal, but it only
  // guarantees delivery before the next paint â€” some embedding contexts
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
    if (width > 0 && height > 0) {
      // ResizeObserver + window `resize` both fire, unthrottled, on every
      // layout pass â€” bail out when the measured box hasn't actually
      // changed so an unrelated reflow doesn't re-render the whole
      // Geographies tree.
      setContainerSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    }
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

  // Which viewBox/scale to render, and whether the hover card has room to
  // dock in the corner â€” both are pure functions of the measured container
  // box (task-11 review findings 1 and 2; see mapGeometry.ts for the "why").
  const { projectionScale, mapWidth, mapHeight } = selectMapGeometry(
    containerSize.width,
    containerSize.height,
    fullScreen,
  );
  const cardClearsSelector = hoverCardClearsSelector(containerSize.width);

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
          <NoDataHatchPattern id={noDataHatchId} />
        </defs>
        <Geographies geography={EUROPE_GEO_URL}>
          {({ geographies }) =>
            geographies.map((geo: GeoFeature) => {
              const code = getCountryCode(geo);
              const d = code ? dataMap.get(code) : null;
              const has = !!d;
              const cellState = netPositionMapCellState({
                metric: mapMetric,
                scope: netPositionScope,
                countryCode: code,
                hasValue: has,
              });
              const outOfScope = cellState === 'out_of_core';
              const isSelected = code === selectedCountry;
              const isHover =
                hoveredCountry?.country_code === code || hoveredOutOfScope?.code === code;
              const countryName: string = geo.properties.NAME ?? code ?? 'Unknown';
              // An out-of-scope country is not "no data" to a screen reader
              // either â€” it gets the same sentence a sighted reader gets on
              // hover, rather than falling through to countryAriaLabel's
              // no-data wording.
              const ariaLabel = outOfScope
                ? `${countryName}: ${NON_CORE_MAP_NOTICE}`
                : countryAriaLabel(
                    countryName,
                    has,
                    has ? formatHoverValue(d.value, mapMetric) : '',
                    metricInfo?.unit ?? '',
                    metricInfo?.label ?? mapMetric,
                  );
              return (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  // Own class (rather than relying on react-simple-maps'
                  // internal `rsm-geography`) so the :focus-visible ring in
                  // index.css survives Tailwind's content-based purge â€”
                  // Tailwind drops @layer base selectors that don't appear
                  // literally in a scanned source file, and a class that
                  // only exists inside node_modules doesn't qualify.
                  className="able-country"
                  fill={has ? dataColor(mapMetric, d.value, min, max) : noDataHatchUrl(noDataHatchId)}
                  stroke={isHover || isSelected ? 'hsl(var(--foreground))' : '#FFFFFF'}
                  strokeWidth={isHover ? 2.4 : isSelected ? 1.6 : 1.2}
                  style={{
                    default: {
                      outline: 'none',
                      opacity: (hoveredCountry || hoveredOutOfScope) && !isHover ? 0.55 : 1,
                      transition: 'fill-opacity 0.15s, stroke-width 0.15s',
                    },
                    hover: { outline: 'none', cursor: has ? 'pointer' : 'default' },
                    pressed: { outline: 'none' },
                  }}
                  // Only data-bearing countries are real controls: they're
                  // the only ones a click/Enter does anything to, so only
                  // they take a tab stop (react-simple-maps otherwise
                  // defaults every <Geography> to tabIndex 0 â€” ~50 of them,
                  // most unclickable). role="button" + aria-label carries
                  // the same name/value/unit the hover card shows visually,
                  // since a screen reader has no other way to reach it â€” see
                  // countryAriaLabel's doc comment in mapGeometry.ts.
                  // An out-of-scope country takes a tab stop even though it is
                  // not clickable: its sentence is the only thing that tells a
                  // reader why a country they can see is not coloured, and a
                  // keyboard user has no other way to reach it. It stays
                  // `role="img"`, not `button` â€” nothing happens on Enter.
                  tabIndex={has || outOfScope ? 0 : -1}
                  role={has ? 'button' : outOfScope ? 'img' : undefined}
                  aria-label={ariaLabel}
                  onClick={() => { if (code && has) handleCountryClick(code); }}
                  onKeyDown={(e) => {
                    if (!has || !code) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleCountryClick(code);
                    }
                  }}
                  onMouseEnter={() => {
                    if (outOfScope && code) handleOutOfScopeEnter(code, countryName);
                    else handleMouseEnter(d ?? null);
                  }}
                  onMouseLeave={handleMouseLeave}
                  // Keyboard focus mirrors mouse hover â€” same stroke
                  // highlight, same hover card â€” so a sighted keyboard user
                  // sees exactly what a mouse user sees, and Tab is a real
                  // substitute for scanning the map instead of a second,
                  // unlabeled mode.
                  onFocus={() => {
                    if (outOfScope && code) handleOutOfScopeEnter(code, countryName);
                    else handleMouseEnter(d ?? null);
                  }}
                  onBlur={handleMouseLeave}
                />
              );
            })
          }
        </Geographies>
      </ComposableMap>

      {/* Hover card â€” docks top-right once the container is wide enough that
          the corner position actually clears the floating metric selector
          (MapMetricSelector `floating`, centered across the top of this same
          container) â€” see hoverCardClearsSelector in mapGeometry.ts. Below
          that width, it drops below the selector instead, which stays clear
          at any width. */}
      {hoveredCountry && (
        <div
          className={cn(
            'pointer-events-none absolute min-w-[260px] rounded-[10px] border border-border bg-card px-4 py-3.5 shadow-[0_4px_20px_rgba(0,0,0,0.06)]',
            cardClearsSelector ? 'right-5 top-5' : 'right-3 top-16',
          )}
        >
          <div className="mb-2 flex items-baseline gap-2">
            <span className="font-mono-num text-micro text-ink-muted">
              {hoveredCountry.country_code}
            </span>
            <span className="text-title font-medium text-foreground">
              {hoveredCountry.country_name}
            </span>
          </div>
          <div className="num text-stat font-medium text-foreground">
            {formatHoverValue(hoveredCountry.value, mapMetric)}
            <span className="ml-1 font-mono-num text-micro text-ink-muted">
              {metricInfo?.unit ?? ''}
            </span>
          </div>
          <p className="mt-1 text-xs text-ink-dim">{metricInfo?.label}</p>
          {fullScreen && (
            <div className="mt-2.5 border-t border-input pt-2 font-mono-num text-micro text-ink-muted">
              Click or press Enter to open â†’
            </div>
          )}
        </div>
      )}

      {/* Out-of-scope hover card. Same position and shell as the value card
          above, deliberately without a number slot: this country has no Core
          net position at all, and an empty or dashed metric line where a
          figure normally sits reads as a value we failed to fetch. */}
      {hoveredOutOfScope && (
        <div
          className={cn(
            'pointer-events-none absolute min-w-[260px] max-w-[280px] rounded-[10px] border border-border bg-card px-4 py-3.5 shadow-[0_4px_20px_rgba(0,0,0,0.06)]',
            cardClearsSelector ? 'right-5 top-5' : 'right-3 top-16',
          )}
        >
          <div className="mb-2 flex items-baseline gap-2">
            <span className="font-mono-num text-micro text-ink-muted">
              {hoveredOutOfScope.code}
            </span>
            <span className="text-title font-medium text-foreground">
              {hoveredOutOfScope.name}
            </span>
          </div>
          <p className="text-meta text-ink-dim">{NON_CORE_MAP_NOTICE}</p>
        </div>
      )}

      {/* Empty state â€” the API returned no countries for this metric */}
      {!isLoading && dataMap.size === 0 && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-[320px] rounded-[10px] border border-border bg-card px-5 py-4 text-center shadow-[0_4px_20px_rgba(0,0,0,0.06)]">
          <div className="text-body font-medium text-foreground">
            {coreView
              ? 'No Core net position stored yet'
              : `No ${metricInfo?.label.toLowerCase() ?? 'metric'} data right now`}
          </div>
          <p className="mt-1 text-meta text-ink-dim">
            {coreView
              ? // Not "check back after the next ENTSO-E sync": the Core figure
                // comes from JAO, and its capture is off by default in a
                // deployment (server/src/services/coreNetPositionScheduler.ts),
                // so the honest reading is "not switched on here" rather than
                // "late".
                'The Core figure is captured from JAO separately, and this deployment has stored none yet. Switch to â€œAll coupled bordersâ€ for the figure this dashboard does hold.'
              : 'Pick another metric above, or check back after the next ENTSO-E sync.'}
          </p>
        </div>
      )}

      {/* Bottom-left legend */}
      <div className="absolute bottom-5 left-5 min-w-[280px] rounded-[10px] border border-border bg-card p-3.5 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-xs font-medium text-foreground">
            {/* The net position legend heading names which borders are in
                scope, so it has to follow the toggle â€” a heading naming the
                other view is exactly the confidently-wrong label ABL-222
                added this line to prevent. */}
            {mapMetric === 'net_position'
              ? netPositionLegendLabel(netPositionScope)
              : metricInfo?.legendLabel}
          </span>
          <span className="font-mono-num text-micro text-ink-muted">
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
            {/* Ends are Â±bound, so the centre tick is a true zero rather than
                the midpoint of the data range. */}
            <div className="flex justify-between font-mono-num text-micro text-ink-muted">
              <span>âˆ’{formatLegendValue(symmetricBound(min, max), mapMetric)}</span>
              <span>0</span>
              <span>+{formatLegendValue(symmetricBound(min, max), mapMetric)}</span>
            </div>
            <div className="flex justify-between text-micro text-ink-muted">
              <span>importing</span>
              <span>exporting</span>
            </div>
            {/* Which "net position" this is â€” the same claim this repo has
                shipped wrong before, now stated rather than left implicit
                (ABL-222). See lib/netPositionScope.ts. */}
            <p className="mt-1.5 border-t border-input pt-1.5 text-micro text-ink-muted">
              {netPositionMapDisclosure(netPositionScope)}
            </p>
          </>
        ) : (
          <div className="flex justify-between font-mono-num text-micro text-ink-muted">
            <span>{formatLegendValue(min, mapMetric)}</span>
            <span>{formatLegendValue((min + max) / 2, mapMetric)}</span>
            <span>{formatLegendValue(max, mapMetric)}</span>
          </div>
        )}
        {/* One hatch key, not two. In Core view the same texture covers both
            "no rows here" and "outside the Core region" â€” they are the same
            kind of mark (not on the scale) and a second texture would weaken
            the first (NoDataHatch.tsx). The per-country hover sentence is what
            distinguishes them, so the key widens its wording rather than
            claiming only one of the two meanings. This is a deliberate,
            reasoned narrowing of ABL-231's spec, which asked for two separate
            semantic treatments in the legend. */}
        <div className="mt-2 flex items-center gap-1.5 border-t border-input pt-2">
          <NoDataSwatch id={`${noDataHatchId}-legend`} />
          <span className="font-mono-num text-micro text-ink-muted">
            {mapMetric === 'net_position'
              ? netPositionHatchLegendLabel(netPositionScope)
              : 'no data'}
          </span>
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
              aria-pressed={mapMetric === metric.value}
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
