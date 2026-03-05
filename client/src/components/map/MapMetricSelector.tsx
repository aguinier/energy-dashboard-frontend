import { useDashboardStore } from '@/store/dashboardStore';
import { Button } from '@/components/ui/button';
import { Zap, DollarSign, Leaf } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MetricType } from '@/types';

const METRICS: { value: MetricType; label: string; description: string; icon: React.ReactNode }[] = [
  { value: 'load', label: 'Load', description: 'Electricity demand (MW)', icon: <Zap className="h-4 w-4" /> },
  { value: 'price', label: 'Price', description: 'Day-ahead price (EUR/MWh)', icon: <DollarSign className="h-4 w-4" /> },
  { value: 'renewable_pct', label: 'Renewable %', description: 'Renewable share of generation', icon: <Leaf className="h-4 w-4" /> },
];

interface MapMetricSelectorProps {
  /** Render in vertical mode for sidebar */
  vertical?: boolean;
  className?: string;
}

export function MapMetricSelector({ vertical = false, className }: MapMetricSelectorProps) {
  const { mapMetric, setMapMetric } = useDashboardStore();

  if (vertical) {
    return (
      <div className={cn('p-4 border-b', className)}>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Map Metric
        </h3>
        <div className="space-y-1">
          {METRICS.map(({ value, label, description, icon }) => (
            <button
              key={value}
              onClick={() => setMapMetric(value)}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all',
                mapMetric === value
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-muted/80'
              )}
            >
              <span className={cn(
                'flex-shrink-0',
                mapMetric === value ? 'text-primary-foreground' : 'text-muted-foreground'
              )}>
                {icon}
              </span>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm">{label}</div>
                <div className={cn(
                  'text-xs truncate',
                  mapMetric === value ? 'text-primary-foreground/70' : 'text-muted-foreground'
                )}>
                  {description}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Horizontal mode (original)
  return (
    <div className={cn('inline-flex rounded-lg border bg-card p-1 shadow-sm', className)}>
      {METRICS.map(({ value, label, icon }) => (
        <Button
          key={value}
          variant={mapMetric === value ? 'default' : 'ghost'}
          size="sm"
          onClick={() => setMapMetric(value)}
          className="flex items-center gap-2"
        >
          {icon}
          <span>{label}</span>
        </Button>
      ))}
    </div>
  );
}
