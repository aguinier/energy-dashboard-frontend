import { cn } from '@/lib/utils';
import { Trophy } from 'lucide-react';

interface MetricCardProps {
  title: string;
  value: number | string;
  unit?: string;
  provider: 'tso' | 'ml';
  horizon?: string;
  isWinner?: boolean;
  isBest?: boolean;
  className?: string;
  description?: string;
}

const PROVIDER_COLORS = {
  tso: {
    bg: 'bg-emerald-50 dark:bg-emerald-950/30',
    border: 'border-emerald-200 dark:border-emerald-800',
    text: 'text-emerald-700 dark:text-emerald-300',
    badge: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
  },
  ml: {
    bg: 'bg-sky-50 dark:bg-sky-950/30',
    border: 'border-sky-200 dark:border-sky-800',
    text: 'text-sky-700 dark:text-sky-300',
    badge: 'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-200',
  },
};

/**
 * MetricCard - Displays a single metric with provider branding
 */
export function MetricCard({
  title,
  value,
  unit,
  provider,
  horizon,
  isWinner,
  isBest,
  className,
  description,
}: MetricCardProps) {
  const colors = PROVIDER_COLORS[provider];
  const displayValue = typeof value === 'number' ? value.toFixed(2) : value;

  return (
    <div
      className={cn(
        'relative rounded-lg border p-4 transition-all',
        colors.bg,
        colors.border,
        isWinner && 'ring-2 ring-amber-400 dark:ring-amber-500',
        className
      )}
    >
      {/* Provider badge */}
      <div className="flex items-center justify-between mb-2">
        <span className={cn('text-xs font-medium uppercase tracking-wider', colors.text)}>
          {provider === 'tso' ? 'TSO' : 'ML'}
          {horizon && (
            <span className="ml-1 font-normal lowercase">
              ({horizon === 'day_ahead' ? 'D+1' : horizon === 'week_ahead' ? 'D+7' : horizon === 'd1' || horizon === '1' ? 'D+1' : 'D+2'})
            </span>
          )}
        </span>
        {isBest && (
          <Trophy className="h-4 w-4 text-amber-500" />
        )}
      </div>

      {/* Metric title */}
      <div className="text-xs text-muted-foreground mb-1">{title}</div>

      {/* Metric value */}
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold tabular-nums">{displayValue}</span>
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      </div>

      {/* Description */}
      {description && (
        <div className="mt-2 text-xs text-muted-foreground">{description}</div>
      )}

      {/* Winner indicator */}
      {isWinner && (
        <div className="absolute -top-2 -right-2">
          <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-200">
            Best
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * MetricCardSkeleton - Loading state for MetricCard
 */
export function MetricCardSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-muted/30 p-4 animate-pulse',
        className
      )}
    >
      <div className="h-3 w-12 bg-muted rounded mb-2" />
      <div className="h-3 w-16 bg-muted rounded mb-1" />
      <div className="h-8 w-24 bg-muted rounded" />
    </div>
  );
}
