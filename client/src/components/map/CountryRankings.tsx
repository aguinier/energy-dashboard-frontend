import { useMemo, useCallback, memo } from 'react';
import { useMapData } from '@/hooks/useDashboardData';
import { useDashboardStore } from '@/store/dashboardStore';
import { formatMW, formatPrice, formatPercentage } from '@/lib/formatters';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { MetricType, MapDataPoint } from '@/types';

function formatValue(value: number, metric: MetricType): string {
  switch (metric) {
    case 'load':
      return formatMW(value);
    case 'price':
      return formatPrice(value);
    case 'renewable_pct':
      return formatPercentage(value);
    default:
      return String(value);
  }
}

function getMetricLabel(metric: MetricType): string {
  switch (metric) {
    case 'load':
      return 'Load';
    case 'price':
      return 'Price';
    case 'renewable_pct':
      return 'Renewable %';
    default:
      return 'Value';
  }
}

// Memoized row component for better list performance
const CountryRow = memo(function CountryRow({
  country,
  index,
  isSelected,
  mapMetric,
  onSelect,
}: {
  country: MapDataPoint;
  index: number;
  isSelected: boolean;
  mapMetric: MetricType;
  onSelect: (code: string) => void;
}) {
  return (
    <button
      onClick={() => onSelect(country.country_code)}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors',
        'hover:bg-muted/80',
        isSelected && 'bg-primary/10 border border-primary/30'
      )}
    >
      <span className="w-5 text-xs font-mono text-muted-foreground shrink-0">
        {index + 1}.
      </span>
      <span className="font-mono text-sm font-semibold w-7 shrink-0">
        {country.country_code}
      </span>
      <span className="font-mono text-sm tabular-nums ml-auto">
        {formatValue(country.value, mapMetric)}
      </span>
    </button>
  );
});

export const CountryRankings = memo(function CountryRankings() {
  const { mapMetric, goToCountry, selectedCountry } = useDashboardStore();
  const { data: mapData, isLoading } = useMapData();

  // Sort countries by metric value (descending for load/renewable, ascending for price when showing "best")
  const sortedCountries = useMemo(() => {
    if (!mapData || mapData.length === 0) return [];

    return [...mapData]
      .filter((d) => d.value !== null && d.value !== undefined)
      .sort((a, b) => {
        // For price, lower is better but we still show highest first for consistency
        return b.value - a.value;
      });
  }, [mapData]);

  // Memoize the selection callback
  const handleSelect = useCallback((code: string) => {
    goToCountry(code);
  }, [goToCountry]);

  if (isLoading) {
    return (
      <div className="flex-1 overflow-hidden">
        <div className="p-4 border-b">
          <Skeleton className="h-5 w-32" />
        </div>
        <div className="p-2 space-y-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Header */}
      <div className="p-4 border-b bg-muted/30">
        <h3 className="font-semibold text-sm">
          Countries by {getMetricLabel(mapMetric)}
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          {sortedCountries.length} countries with data
        </p>
      </div>

      {/* Scrollable list */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-2 space-y-1">
          {sortedCountries.map((country, index) => (
            <CountryRow
              key={country.country_code}
              country={country}
              index={index}
              isSelected={country.country_code === selectedCountry}
              mapMetric={mapMetric}
              onSelect={handleSelect}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

export default CountryRankings;
