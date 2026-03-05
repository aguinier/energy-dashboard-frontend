import { Activity } from 'lucide-react';
import type { ForecastComparisonData, ForecastMetrics } from '@/types';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface ForecastAccuracyMetricsProps {
  comparisonData: ForecastComparisonData | undefined;
  unit: string; // e.g., "MW", "EUR/MWh"
  isLoading?: boolean;
}

function calculateMetrics(comparisonData: ForecastComparisonData): ForecastMetrics {
  const { forecasts, actuals } = comparisonData;

  // Match forecasts with actuals by timestamp
  const pairs = forecasts
    .map((f) => ({
      forecast: f.value,
      actual: actuals.find((a) => a.timestamp === f.timestamp)?.value,
    }))
    .filter((p) => p.actual !== undefined) as Array<{
    forecast: number;
    actual: number;
  }>;

  if (pairs.length === 0) {
    return { mae: 0, rmse: 0, sampleSize: 0 };
  }

  // Calculate MAE: Mean Absolute Error
  const mae =
    pairs.reduce((sum, p) => sum + Math.abs(p.forecast - p.actual), 0) /
    pairs.length;

  // Calculate RMSE: Root Mean Squared Error
  const rmse = Math.sqrt(
    pairs.reduce((sum, p) => sum + Math.pow(p.forecast - p.actual, 2), 0) /
      pairs.length
  );

  return { mae, rmse, sampleSize: pairs.length };
}

function formatValue(value: number, unit: string): string {
  if (value === 0) return 'N/A';

  // Format based on magnitude
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}K ${unit}`;
  }
  return `${value.toFixed(0)} ${unit}`;
}

export function ForecastAccuracyMetrics({
  comparisonData,
  unit,
  isLoading,
}: ForecastAccuracyMetricsProps) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Activity className="h-3 w-3 animate-pulse" />
        <span>Loading metrics...</span>
      </div>
    );
  }

  if (!comparisonData || comparisonData.actuals.length === 0) {
    return null;
  }

  const metrics = calculateMetrics(comparisonData);

  if (metrics.sampleSize === 0) {
    return null;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="inline-flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            <Activity className="h-3 w-3" />
            <span>MAE: {formatValue(metrics.mae, unit)}</span>
            <span className="text-amber-400">|</span>
            <span>RMSE: {formatValue(metrics.rmse, unit)}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <div className="space-y-1">
            <p className="font-semibold">Forecast Accuracy Metrics</p>
            <div className="text-xs">
              <p>
                <strong>MAE</strong> (Mean Absolute Error): {formatValue(metrics.mae, unit)}
              </p>
              <p>Average absolute difference between forecast and actual values.</p>
              <p className="mt-2">
                <strong>RMSE</strong> (Root Mean Squared Error):{' '}
                {formatValue(metrics.rmse, unit)}
              </p>
              <p>Square root of average squared differences (penalizes large errors).</p>
              <p className="mt-2 text-muted-foreground">
                Based on {metrics.sampleSize} matching data points.
              </p>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
