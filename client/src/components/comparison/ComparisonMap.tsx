import { useState, useCallback, useMemo, memo } from 'react';
import { m } from 'framer-motion';
import { ComposableMap, Geographies, Geography } from 'react-simple-maps';
import { useDashboardStore } from '@/store/dashboardStore';
import { SCALE_CLEAN, SCALE_DIRTY, SCALE_MEDIUM } from '@/lib/dataScale';
import type { CrossCountryMetrics, CrossCountryMetricsEntry } from '@/types';
import { wapeColor, wapeScale } from './accuracyScale';

// Shared map constants
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

interface ComparisonMapProps {
  data: CrossCountryMetrics;
}

interface HoveredCountryInfo {
  countryCode: string;
  metrics: Record<string, CrossCountryMetricsEntry>;
}

// WAPE can be null (no denominator — e.g. all-zero actuals in the window).
// Render that as absent rather than coercing to 0, which would read as a
// perfect forecast.
function formatMetricValue(value: number | null, asPercent: boolean): string {
  if (value === null) return '–';
  return asPercent ? `${value.toFixed(1)}%` : value.toFixed(2);
}

export const ComparisonMap = memo(function ComparisonMap({ data }: ComparisonMapProps) {
  const { comparisonMetric, comparisonForecastType, goToCountry } = useDashboardStore();
  const [hovered, setHovered] = useState<HoveredCountryInfo | null>(null);

  // Use store forecast type; when 'all', default to 'load' for map coloring
  const mapForecastType = comparisonForecastType === 'all' ? 'load' : comparisonForecastType;

  const getCountryCode = useCallback((geo: { properties: Record<string, string> }): string | null => {
    const name = geo.properties.NAME;
    return name ? (COUNTRY_NAME_MAP[name] || null) : null;
  }, []);

  const handleClick = useCallback((code: string) => {
    if (data[code]) goToCountry(code);
  }, [data, goToCountry]);

  // The scale is this forecast type's own observed spread across countries —
  // the same relative basis the heatmap and leaderboard use. The legend below
  // prints its real ends rather than a fixed cutoff, so the colours and the
  // legend cannot disagree. See accuracyScale.ts.
  const scale = useMemo(
    () => wapeScale(Object.values(data).map((byType) => byType[mapForecastType]?.wape)),
    [data, mapForecastType],
  );

  return (
    <div className="relative rounded-lg border bg-card overflow-hidden">
      {/* In "All" mode the map has to pick one type to colour by, and it picks
          load. Say so, rather than leaving the choice implicit.

          A row of forecast-type buttons used to sit here with an empty
          onClick — "Load" rendered as selected and every other button did
          nothing when pressed, so it read as a filter that silently refused to
          filter. The Type control in the filter bar above does the real thing
          and is always visible, so the dead copy is gone rather than wired up
          twice. */}
      {comparisonForecastType === 'all' && (
        <div className="absolute top-4 left-4 z-10 rounded-lg border bg-background/90 px-3 py-1.5 backdrop-blur">
          <span className="text-xs text-muted-foreground">
            Coloured by <span className="font-medium text-foreground">load</span> — pick a Type above
            to map another
          </span>
        </div>
      )}

      {/* Map */}
      <div className="h-[500px]">
        <ComposableMap
          projection="geoMercator"
          projectionConfig={{ center: [12, 55], scale: 350 }}
          width={1000}
          height={620}
          style={{ width: '100%', height: '100%', shapeRendering: 'geometricPrecision' }}
        >
          <Geographies geography={EUROPE_GEO_URL}>
            {({ geographies }) =>
              geographies.map((geo) => {
                const code = getCountryCode(geo);
                const countryData = code ? data[code] : null;
                const entry = countryData?.[mapForecastType];
                const metricValue = entry?.[comparisonMetric];
                const hasData = typeof metricValue === 'number' && !isNaN(metricValue);

                // WAPE gets the ranked teal->terracotta ramp; anything else is
                // a flat "has data" fill, since MAE/RMSE across countries of
                // wildly different size is a magnitude, not a score.
                const rankedFill = comparisonMetric === 'wape' ? wapeColor(metricValue, scale) : null;
                const fill = rankedFill ?? (hasData ? 'hsl(var(--primary))' : 'hsl(var(--muted))');

                return (
                  <Geography
                    key={geo.rsmKey}
                    geography={geo}
                    fill={fill}
                    stroke="hsl(var(--border))"
                    strokeWidth={0.3}
                    style={{
                      default: { outline: 'none', opacity: hasData ? 1 : 0.5 },
                      hover: { outline: 'none', opacity: 1, filter: 'brightness(1.1)', cursor: hasData ? 'pointer' : 'default' },
                      pressed: { outline: 'none' },
                    }}
                    onClick={() => code && handleClick(code)}
                    onMouseEnter={() => {
                      if (code && countryData) {
                        setHovered({ countryCode: code, metrics: countryData });
                      }
                    }}
                    onMouseLeave={() => setHovered(null)}
                  />
                );
              })
            }
          </Geographies>
        </ComposableMap>
      </div>

      {/* Tooltip */}
      {hovered && (
        <m.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="absolute top-4 right-4 rounded-lg border bg-background shadow-lg p-4 min-w-[220px] z-10"
        >
          <div className="flex items-center gap-2 mb-3">
            <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
              {hovered.countryCode}
            </span>
          </div>
          <div className="space-y-1.5">
            {Object.entries(hovered.metrics).map(([type, entry]) => (
              <div key={type} className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground capitalize">{type.replace('_', ' ')}</span>
                <span className="font-medium">
                  {formatMetricValue(entry[comparisonMetric], comparisonMetric === 'wape')}
                </span>
              </div>
            ))}
          </div>
        </m.div>
      )}

      {/* Legend — the ends are the measured best and worst for this forecast
          type in this window, not fixed cutoffs, because the fill is each
          country's rank within that set. */}
      {comparisonMetric === 'wape' && (
        <div className="absolute bottom-4 left-4 rounded-lg border bg-background/90 backdrop-blur p-3 z-10">
          <p className="text-xs font-medium mb-2">WAPE ({mapForecastType})</p>
          {scale.usable ? (
            <>
              <div
                className="h-3 w-24 rounded"
                style={{
                  background: `linear-gradient(to right, ${SCALE_CLEAN}, ${SCALE_MEDIUM}, ${SCALE_DIRTY})`,
                }}
              />
              <div className="flex justify-between text-micro text-muted-foreground mt-1 gap-2">
                <span>{scale.min.toFixed(1)}%</span>
                <span>{scale.max.toFixed(1)}%</span>
              </div>
              <p className="mt-1 text-micro text-muted-foreground max-w-[15rem]">
                rank, best → worst of {scale.count}
              </p>
            </>
          ) : (
            <p className="text-micro text-muted-foreground max-w-[15rem]">
              {scale.count === 0
                ? 'No country has a measurable WAPE for this type in this window.'
                : `Only ${scale.count} measured — too few to rank, so countries are left uncoloured.`}
            </p>
          )}
        </div>
      )}
    </div>
  );
});
