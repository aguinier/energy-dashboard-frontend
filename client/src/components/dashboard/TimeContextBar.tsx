import { Calendar, Clock } from 'lucide-react';
import { useComputedDateRange, useDataFreshness } from '@/hooks/useDashboardData';
import { cn } from '@/lib/utils';

interface TimeContextBarProps {
  className?: string;
}

function formatRelativeTime(timestamp: string | null): string {
  if (!timestamp) return 'Unknown';

  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) return 'Unknown';

  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }) + ' UTC';
}

function FreshnessDot({ timestamp }: { timestamp: string }) {
  const diffHours = (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60);
  const color = diffHours < 1 ? 'bg-green-500' : diffHours < 6 ? 'bg-amber-500' : 'bg-red-500';
  return <span className={`inline-block h-2 w-2 rounded-full ${color} mr-1.5`} />;
}

export function TimeContextBar({ className }: TimeContextBarProps) {
  const { displayRange } = useComputedDateRange();
  const { data: freshness, isLoading } = useDataFreshness();

  // Find the most recent timestamp across all data types
  const latestTimestamp = freshness
    ? Object.values(freshness).reduce((latest, current) => {
        if (!current) return latest;
        if (!latest) return current;
        return new Date(current) > new Date(latest) ? current : latest;
      }, null as string | null)
    : null;

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 px-4 py-2 bg-muted/30 border-b text-sm',
        className
      )}
    >
      {/* Date Range */}
      <div className="flex items-center gap-2 text-muted-foreground">
        <Calendar className="h-4 w-4" />
        <span className="font-medium text-foreground">{displayRange}</span>
      </div>

      {/* Data Freshness */}
      <div className="flex items-center gap-2 text-muted-foreground">
        <Clock className="h-4 w-4" />
        {isLoading ? (
          <span className="text-sm">Loading...</span>
        ) : latestTimestamp ? (
          <span className="text-sm" title={formatTimestamp(latestTimestamp)}>
            <FreshnessDot timestamp={latestTimestamp} />
            Latest: <span className="font-medium text-foreground">{formatRelativeTime(latestTimestamp)}</span>
          </span>
        ) : (
          <span className="text-sm text-muted-foreground/70">Data freshness unavailable</span>
        )}
      </div>
    </div>
  );
}

export default TimeContextBar;
