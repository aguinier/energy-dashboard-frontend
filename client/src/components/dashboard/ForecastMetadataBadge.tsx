import { Info } from 'lucide-react';
import { useLatestForecast } from '@/hooks/useDashboardData';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export function ForecastMetadataBadge() {
  const { data: latestForecast, isLoading, isError } = useLatestForecast();

  if (isLoading) {
    return <Skeleton className="h-6 w-48" />;
  }

  if (isError || !latestForecast || latestForecast.length === 0) {
    return null;
  }

  // Get metadata from the first forecast point (all points in a batch share the same metadata)
  const forecast = latestForecast[0];
  const modelName = forecast.model_name || 'Unknown';
  const modelVersion = forecast.model_version
    ? `v${forecast.model_version.slice(0, 8)}`
    : '';
  const horizonHours = forecast.horizon_hours;

  // Calculate how long ago the forecast was generated
  const generatedAt = new Date(forecast.generated_at);
  const now = new Date();
  const hoursAgo = Math.floor((now.getTime() - generatedAt.getTime()) / (1000 * 60 * 60));
  const timeAgo = hoursAgo === 0 ? '<1h ago' : `${hoursAgo}h ago`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300">
            <Info className="h-3 w-3" />
            <span>
              {modelName} {modelVersion}
            </span>
            <span className="text-blue-500 dark:text-blue-400">|</span>
            <span>{horizonHours}h ahead</span>
            <span className="text-blue-500 dark:text-blue-400">|</span>
            <span>{timeAgo}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <div className="space-y-1">
            <p className="font-semibold">Forecast Model Information</p>
            <div className="text-xs">
              <p>Model: {modelName}</p>
              {forecast.model_version && <p>Version: {forecast.model_version}</p>}
              <p>Horizon: {horizonHours} hours ahead (D+2)</p>
              <p>Generated: {generatedAt.toLocaleString()}</p>
              <p>Forecast count: {latestForecast.length} data points</p>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
