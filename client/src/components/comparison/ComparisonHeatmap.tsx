import { useMemo, useState } from 'react';
import { useDashboardStore } from '@/store/dashboardStore';
import { getMetricColor, withOpacity } from '@/lib/colors';
import { FORECAST_TYPE_CONFIG, sortForecastTypes } from '@/lib/comparisonConstants';
import type { CrossCountryMetrics } from '@/types';

interface ComparisonHeatmapProps {
  data: CrossCountryMetrics;
}

export function ComparisonHeatmap({ data }: ComparisonHeatmapProps) {
  const { comparisonMetric, comparisonForecastType, goToCountry } = useDashboardStore();
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Extract forecast types present in the data, respecting filter
  const forecastTypes = useMemo(() => {
    if (comparisonForecastType !== 'all') {
      // When a specific type is selected, show only that column
      const hasType = Object.values(data).some((cd) => cd[comparisonForecastType]);
      return hasType ? [comparisonForecastType] : [];
    }
    const types = new Set<string>();
    Object.values(data).forEach((countryData) => {
      Object.keys(countryData).forEach((t) => types.add(t));
    });
    return sortForecastTypes(Array.from(types));
  }, [data, comparisonForecastType]);

  // Sort countries
  const sortedCountries = useMemo(() => {
    const countries = Object.keys(data).sort();
    if (!sortBy) return countries;

    return countries.sort((a, b) => {
      const valA = data[a]?.[sortBy]?.[comparisonMetric] ?? Infinity;
      const valB = data[b]?.[sortBy]?.[comparisonMetric] ?? Infinity;
      return sortDir === 'asc' ? valA - valB : valB - valA;
    });
  }, [data, sortBy, sortDir, comparisonMetric]);

  const handleSort = (type: string) => {
    if (sortBy === type) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(type);
      setSortDir('asc');
    }
  };

  if (sortedCountries.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        No comparison data available
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="sticky left-0 z-10 bg-muted/50 px-4 py-3 text-left text-xs font-medium text-muted-foreground">
              Country
            </th>
            {forecastTypes.map((type) => (
              <th
                key={type}
                className="px-3 py-3 text-center text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
                onClick={() => handleSort(type)}
              >
                <span className="flex items-center justify-center gap-1">
                  {FORECAST_TYPE_CONFIG[type]?.shortLabel || type}
                  {sortBy === type && (
                    <span className="text-foreground">{sortDir === 'asc' ? '↑' : '↓'}</span>
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedCountries.map((country) => (
            <tr
              key={country}
              className="border-b last:border-0 hover:bg-muted/30 cursor-pointer transition-colors"
              onClick={() => goToCountry(country)}
            >
              <td className="sticky left-0 z-10 bg-card px-4 py-2 font-mono text-xs font-medium">
                {country}
              </td>
              {forecastTypes.map((type) => {
                const entry = data[country]?.[type];
                const value = entry?.[comparisonMetric];

                if (value === undefined || value === null || isNaN(value)) {
                  return (
                    <td key={type} className="px-3 py-2 text-center text-xs text-muted-foreground">
                      -
                    </td>
                  );
                }

                const color = comparisonMetric === 'mape' ? getMetricColor(value, type) : undefined;
                const formatted = comparisonMetric === 'mape'
                  ? `${value.toFixed(1)}%`
                  : value.toFixed(2);

                return (
                  <td key={type} className="px-3 py-2 text-center">
                    <span
                      className="inline-block rounded px-2 py-0.5 text-xs font-medium"
                      style={color ? { backgroundColor: withOpacity(color, 0.15), color } : undefined}
                    >
                      {formatted}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
