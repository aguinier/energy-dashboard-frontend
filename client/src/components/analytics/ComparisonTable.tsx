import { useState } from 'react';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronUp, Trophy } from 'lucide-react';
import type { AccuracyMetrics } from '@/types';

interface TableRow {
  id: string;
  provider: 'tso' | 'ml';
  horizon: string;
  horizonLabel: string;
  metrics: AccuracyMetrics;
}

interface ComparisonTableProps {
  data: TableRow[];
  className?: string;
}

type SortKey = 'provider' | 'horizon' | 'mae' | 'mape' | 'rmse' | 'bias' | 'dataPoints';
type SortDirection = 'asc' | 'desc';

/**
 * ComparisonTable - Sortable table comparing forecast metrics across providers/horizons
 */
export function ComparisonTable({ data, className }: ComparisonTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('mape');
  const [sortDir, setSortDir] = useState<SortDirection>('asc');

  // Sort data
  const sortedData = [...data].sort((a, b) => {
    let aVal: string | number = '';
    let bVal: string | number = '';

    if (sortKey === 'provider') {
      aVal = a.provider;
      bVal = b.provider;
    } else if (sortKey === 'horizon') {
      aVal = a.horizonLabel;
      bVal = b.horizonLabel;
    } else {
      aVal = a.metrics[sortKey as keyof AccuracyMetrics] ?? 0;
      bVal = b.metrics[sortKey as keyof AccuracyMetrics] ?? 0;
    }

    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }

    const aNum = typeof aVal === 'number' ? aVal : 0;
    const bNum = typeof bVal === 'number' ? bVal : 0;
    return sortDir === 'asc' ? aNum - bNum : bNum - aNum;
  });

  // Find best (lowest) values for each metric
  const bestValues = {
    mae: Math.min(...data.map((d) => d.metrics.mae)),
    mape: Math.min(...data.map((d) => d.metrics.mape)),
    rmse: Math.min(...data.map((d) => d.metrics.rmse)),
    bias: Math.min(...data.map((d) => Math.abs(d.metrics.bias))),
  };

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      // Default to ascending for metrics (lower is better)
      setSortDir(['provider', 'horizon'].includes(key) ? 'asc' : 'asc');
    }
  };

  const SortHeader = ({ label, sortKeyName, title }: { label: string; sortKeyName: SortKey; title?: string }) => (
    <th
      className="px-4 py-3 text-left text-sm font-medium text-muted-foreground uppercase tracking-wider cursor-pointer hover:text-foreground transition-colors"
      onClick={() => handleSort(sortKeyName)}
      title={title}
    >
      <div className="flex items-center gap-1">
        {label}
        {sortKey === sortKeyName && (
          sortDir === 'asc' ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )
        )}
      </div>
    </th>
  );

  if (data.length === 0) {
    return (
      <div className={cn('rounded-lg border p-8 text-center text-muted-foreground', className)}>
        No comparison data available for the selected options.
      </div>
    );
  }

  return (
    <div className={cn('rounded-lg border overflow-hidden', className)}>
      <table className="w-full">
        <thead className="bg-muted/50">
          <tr>
            <SortHeader label="Provider" sortKeyName="provider" />
            <SortHeader label="Horizon" sortKeyName="horizon" />
            <SortHeader label="MAE" sortKeyName="mae" title="Mean Absolute Error" />
            <SortHeader label="MAPE %" sortKeyName="mape" title="Mean Absolute Percentage Error" />
            <SortHeader label="RMSE" sortKeyName="rmse" title="Root Mean Square Error" />
            <SortHeader label="Bias" sortKeyName="bias" title="Forecast Bias" />
            <SortHeader label="Samples" sortKeyName="dataPoints" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {sortedData.map((row) => (
            <tr key={row.id} className="hover:bg-muted/30 transition-colors">
              {/* Provider */}
              <td className="px-4 py-3">
                <span
                  className={cn(
                    'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
                    row.provider === 'tso'
                      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200'
                      : 'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-200'
                  )}
                >
                  {row.provider.toUpperCase()}
                </span>
              </td>

              {/* Horizon */}
              <td className="px-4 py-3 text-sm">{row.horizonLabel}</td>

              {/* MAE */}
              <td className="px-4 py-3">
                <MetricCell
                  value={row.metrics.mae}
                  isBest={row.metrics.mae === bestValues.mae}
                />
              </td>

              {/* MAPE */}
              <td className="px-4 py-3">
                <MetricCell
                  value={row.metrics.mape}
                  unit="%"
                  isBest={row.metrics.mape === bestValues.mape}
                />
              </td>

              {/* RMSE */}
              <td className="px-4 py-3">
                <MetricCell
                  value={row.metrics.rmse}
                  isBest={row.metrics.rmse === bestValues.rmse}
                />
              </td>

              {/* Bias */}
              <td className="px-4 py-3">
                <MetricCell
                  value={row.metrics.bias}
                  showSign
                  isBest={Math.abs(row.metrics.bias) === bestValues.bias}
                />
              </td>

              {/* Sample count */}
              <td className="px-4 py-3 text-sm text-muted-foreground tabular-nums">
                {row.metrics.dataPoints.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * MetricCell - Table cell with value highlighting
 */
function MetricCell({
  value,
  unit = '',
  showSign = false,
  isBest = false,
}: {
  value: number;
  unit?: string;
  showSign?: boolean;
  isBest?: boolean;
}) {
  const displayValue = showSign && value > 0 ? `+${value.toFixed(2)}` : value.toFixed(2);

  return (
    <span
      className={cn(
        'text-sm tabular-nums',
        isBest && 'font-semibold text-amber-600 dark:text-amber-400'
      )}
    >
      {displayValue}
      {unit}
      {isBest && <Trophy className="inline-block h-3 w-3 ml-1 text-amber-500" />}
    </span>
  );
}

/**
 * ComparisonTableSkeleton - Loading state
 */
export function ComparisonTableSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-lg border overflow-hidden animate-pulse', className)}>
      <div className="bg-muted/50 h-10" />
      {[...Array(4)].map((_, i) => (
        <div key={i} className="h-14 border-t bg-muted/20" />
      ))}
    </div>
  );
}
