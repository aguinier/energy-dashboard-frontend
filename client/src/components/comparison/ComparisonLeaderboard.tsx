import { useMemo, useState } from 'react';
import { useDashboardStore } from '@/store/dashboardStore';
import { getMetricColor, withOpacity } from '@/lib/colors';
import { getStatusLabel } from '@/lib/comparisonConstants';
import { cn } from '@/lib/utils';
import type { CrossCountryMetrics, CrossCountryMetricsEntry } from '@/types';

type SortField = 'country' | 'mape' | 'mae' | 'rmse' | 'bias' | 'dataPoints';

const STATUS_COLORS: Record<string, string> = {
  excellent: '#22C55E',
  good: '#F59E0B',
  poor: '#EF4444',
};

interface ComparisonLeaderboardProps {
  data: CrossCountryMetrics;
}

export function ComparisonLeaderboard({ data }: ComparisonLeaderboardProps) {
  const { comparisonForecastType, goToCountry } = useDashboardStore();
  const [sortField, setSortField] = useState<SortField>('mape');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Aggregate metrics per country (average across forecast types, or single type)
  const rows = useMemo(() => {
    return Object.entries(data).map(([country, types]) => {
      let entries: CrossCountryMetricsEntry[] = [];
      let forecastType = comparisonForecastType;

      if (comparisonForecastType === 'all') {
        entries = Object.values(types);
        forecastType = 'load'; // Default thresholds for "all"
      } else {
        const entry = types[comparisonForecastType];
        if (entry) entries = [entry];
      }

      if (entries.length === 0) return null;

      const avg = (field: keyof CrossCountryMetricsEntry) => {
        const vals = entries.map((e) => e[field]).filter((v) => !isNaN(v));
        return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
      };

      const totalDataPoints = entries.reduce((sum, e) => sum + e.dataPoints, 0);

      return {
        country,
        mape: avg('mape'),
        mae: avg('mae'),
        rmse: avg('rmse'),
        bias: avg('bias'),
        dataPoints: totalDataPoints,
        forecastType,
      };
    }).filter(Boolean) as {
      country: string;
      mape: number;
      mae: number;
      rmse: number;
      bias: number;
      dataPoints: number;
      forecastType: string;
    }[];
  }, [data, comparisonForecastType]);

  // Sort
  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      if (sortField === 'country') {
        return sortDir === 'asc'
          ? a.country.localeCompare(b.country)
          : b.country.localeCompare(a.country);
      }
      const valA = a[sortField] ?? Infinity;
      const valB = b[sortField] ?? Infinity;
      return sortDir === 'asc' ? valA - valB : valB - valA;
    });
  }, [rows, sortField, sortDir]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const SortHeader = ({ field, label, align = 'center' }: { field: SortField; label: string; align?: string }) => (
    <th
      className={cn(
        'px-4 py-3 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground transition-colors',
        align === 'left' ? 'text-left' : 'text-center'
      )}
      onClick={() => handleSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortField === field && (
          <span className="text-foreground">{sortDir === 'asc' ? '↑' : '↓'}</span>
        )}
      </span>
    </th>
  );

  if (sortedRows.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        No leaderboard data available
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="px-4 py-3 text-center text-xs font-medium text-muted-foreground w-12">
              #
            </th>
            <SortHeader field="country" label="Country" align="left" />
            <SortHeader field="mape" label="MAPE" />
            <SortHeader field="mae" label="MAE" />
            <SortHeader field="rmse" label="RMSE" />
            <SortHeader field="bias" label="Bias" />
            <SortHeader field="dataPoints" label="Data Pts" />
            <th className="px-4 py-3 text-center text-xs font-medium text-muted-foreground">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, idx) => {
            const status = !isNaN(row.mape) ? getStatusLabel(row.mape, row.forecastType) : null;
            const statusColor = status ? STATUS_COLORS[status.level] : undefined;

            return (
              <tr
                key={row.country}
                className="border-b last:border-0 hover:bg-muted/30 cursor-pointer transition-colors"
                onClick={() => goToCountry(row.country)}
              >
                <td className="px-4 py-3 text-center text-xs text-muted-foreground font-mono">
                  {idx + 1}
                </td>
                <td className="px-4 py-3 font-mono text-xs font-medium">
                  {row.country}
                </td>
                <td className="px-4 py-3 text-center">
                  {!isNaN(row.mape) ? (
                    <span
                      className="inline-block rounded px-2 py-0.5 text-xs font-medium"
                      style={{
                        backgroundColor: withOpacity(getMetricColor(row.mape, row.forecastType), 0.15),
                        color: getMetricColor(row.mape, row.forecastType),
                      }}
                    >
                      {row.mape.toFixed(1)}%
                    </span>
                  ) : '-'}
                </td>
                <td className="px-4 py-3 text-center text-xs">
                  {!isNaN(row.mae) ? row.mae.toFixed(2) : '-'}
                </td>
                <td className="px-4 py-3 text-center text-xs">
                  {!isNaN(row.rmse) ? row.rmse.toFixed(2) : '-'}
                </td>
                <td className="px-4 py-3 text-center text-xs">
                  {!isNaN(row.bias) ? (
                    <span className={row.bias > 0 ? 'text-amber-500' : 'text-sky-500'}>
                      {row.bias > 0 ? '+' : ''}{row.bias.toFixed(2)}
                    </span>
                  ) : '-'}
                </td>
                <td className="px-4 py-3 text-center text-xs text-muted-foreground">
                  {row.dataPoints.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-center">
                  {status && statusColor && (
                    <span
                      className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold"
                      style={{
                        backgroundColor: withOpacity(statusColor, 0.15),
                        color: statusColor,
                      }}
                    >
                      {status.label}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
