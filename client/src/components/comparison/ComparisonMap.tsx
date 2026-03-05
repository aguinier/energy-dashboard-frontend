import { useState, useCallback, memo } from 'react';
import { m } from 'framer-motion';
import { ComposableMap, Geographies, Geography } from 'react-simple-maps';
import { useDashboardStore } from '@/store/dashboardStore';
import { getMetricColorHSL, METRIC_THRESHOLDS } from '@/lib/colors';
import { FORECAST_TYPE_MAP_OPTIONS } from '@/lib/comparisonConstants';
import { cn } from '@/lib/utils';
import type { CrossCountryMetrics, CrossCountryMetricsEntry } from '@/types';

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

  // Get the threshold info for the legend
  const thresholds = METRIC_THRESHOLDS[mapForecastType] || METRIC_THRESHOLDS.load;

  return (
    <div className="relative rounded-lg border bg-card overflow-hidden">
      {/* Forecast type selector — only shown when store is 'all' */}
      {comparisonForecastType === 'all' && (
        <div className="absolute top-4 left-4 z-10 flex gap-0.5 rounded-lg bg-muted p-1">
          {FORECAST_TYPE_MAP_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                // We can't set the store to a single type here since that
                // would affect heatmap/leaderboard too. We'd need local override.
                // For now, this selector is hidden when a specific type is selected.
              }}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium transition-all',
                mapForecastType === opt.value
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {opt.label}
            </button>
          ))}
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
                const hasData = metricValue !== undefined && metricValue !== null && !isNaN(metricValue);

                // For MAPE use HSL interpolation; for others use primary color
                const fill = hasData && comparisonMetric === 'mape'
                  ? getMetricColorHSL(metricValue, mapForecastType)
                  : hasData
                    ? 'hsl(var(--primary))'
                    : 'hsl(var(--muted))';

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
                  {comparisonMetric === 'mape' ? `${entry[comparisonMetric].toFixed(1)}%` : entry[comparisonMetric].toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </m.div>
      )}

      {/* Legend */}
      {comparisonMetric === 'mape' && (
        <div className="absolute bottom-4 left-4 rounded-lg border bg-background/90 backdrop-blur p-3 z-10">
          <p className="text-xs font-medium mb-2">MAPE ({mapForecastType})</p>
          <div className="flex items-center gap-2">
            <div
              className="h-3 w-24 rounded"
              style={{
                background: 'linear-gradient(to right, hsl(120, 75%, 45%), hsl(60, 75%, 45%), hsl(0, 75%, 45%))',
              }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground mt-1 gap-2">
            <span>0%</span>
            <span>{thresholds.excellent}%</span>
            <span>{thresholds.good}%+</span>
          </div>
        </div>
      )}
    </div>
  );
});
