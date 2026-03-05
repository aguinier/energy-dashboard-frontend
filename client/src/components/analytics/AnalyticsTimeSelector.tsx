import { Button } from '@/components/ui/button';
import { useDashboardStore, type AnalyticsTimeRange } from '@/store/dashboardStore';
import { cn } from '@/lib/utils';
import { Calendar } from 'lucide-react';

const TIME_RANGE_OPTIONS: {
  value: AnalyticsTimeRange;
  label: string;
  description: string;
}[] = [
  { value: '7d', label: '7d', description: 'Last 7 days' },
  { value: '30d', label: '30d', description: 'Last 30 days' },
  { value: '90d', label: '90d', description: 'Last 90 days' },
  { value: 'all', label: 'All', description: 'All available data' },
];

interface AnalyticsTimeSelectorProps {
  className?: string;
}

/**
 * AnalyticsTimeSelector - Button group for selecting analytics time range
 * Independent from global dashboard time navigation
 */
export function AnalyticsTimeSelector({ className }: AnalyticsTimeSelectorProps) {
  const { analyticsConfig, setAnalyticsTimeRange } = useDashboardStore();
  const selectedRange = analyticsConfig.timeRange;

  return (
    <div className={className}>
      <label className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1.5">
        <Calendar className="h-3 w-3" />
        Time Range
      </label>
      <div className="flex gap-1">
        {TIME_RANGE_OPTIONS.map((option) => (
          <Button
            key={option.value}
            variant={selectedRange === option.value ? 'default' : 'outline'}
            size="sm"
            onClick={() => setAnalyticsTimeRange(option.value)}
            className={cn(
              'text-xs px-3',
              selectedRange === option.value &&
                'bg-primary hover:bg-primary/90'
            )}
            title={option.description}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

export { TIME_RANGE_OPTIONS };
