import { useDashboardStore } from '@/store/dashboardStore';
import { TIME_RANGES } from '@/lib/constants';
import { cn } from '@/lib/utils';

export function TimeRangeSelector() {
  const { timeRange, setTimeRange } = useDashboardStore();

  return (
    <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
      {TIME_RANGES.map((range) => (
        <button
          key={range.value}
          onClick={() => setTimeRange(range.value)}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm font-medium transition-all',
            timeRange === range.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {range.label}
        </button>
      ))}
    </div>
  );
}
