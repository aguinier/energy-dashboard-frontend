import { useDashboardStore } from '@/store/dashboardStore';
import { cn } from '@/lib/utils';
import type { MetricType } from '@/types';

// able-prototype metric selector: a single rounded segmented control with the
// active item filled in ink. Three modes:
//   - floating   → absolute, centered on top of the map
//   - vertical   → list layout (legacy sidebar)
//   - inline     → flow layout (legacy, embedded in chart headers)
const METRICS: { value: MetricType; label: string; unit: string }[] = [
  { value: 'price', label: 'Day-ahead price', unit: '€/MWh' },
  { value: 'renewable_pct', label: 'Renewable share', unit: '%' },
  { value: 'load', label: 'Electricity load', unit: 'MW' },
];

interface MapMetricSelectorProps {
  floating?: boolean;
  vertical?: boolean;
  className?: string;
}

export function MapMetricSelector({ floating, vertical, className }: MapMetricSelectorProps) {
  const { mapMetric, setMapMetric } = useDashboardStore();

  // legacy vertical list — kept for any caller still on the old layout
  if (vertical) {
    return (
      <div className={cn('p-4 border-b border-border', className)}>
        <h3 className="text-xs font-medium uppercase tracking-[0.1em] text-ink-muted mb-3 font-mono-num">
          Map metric
        </h3>
        <div className="space-y-1">
          {METRICS.map(({ value, label, unit }) => (
            <button
              key={value}
              onClick={() => setMapMetric(value)}
              className={cn(
                'w-full flex items-baseline gap-2 px-3 py-2 rounded-md text-left transition-colors',
                mapMetric === value
                  ? 'bg-foreground text-background'
                  : 'hover:bg-secondary text-ink-dim',
              )}
            >
              <span className="text-sm font-medium">{label}</span>
              <span
                className={cn(
                  'font-mono-num text-[10px] opacity-65',
                  mapMetric === value ? 'text-background' : 'text-ink-muted',
                )}
              >
                {unit}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const wrapperCls = floating
    ? 'absolute top-5 left-1/2 -translate-x-1/2 z-[5] flex gap-0.5 p-[3px] bg-card rounded-[10px] border border-border shadow-[0_4px_16px_rgba(0,0,0,0.05)]'
    : 'inline-flex gap-0.5 p-[3px] bg-card rounded-[10px] border border-border';

  return (
    <div className={cn(wrapperCls, className)}>
      {METRICS.map(({ value, label, unit }) => {
        const active = mapMetric === value;
        return (
          <button
            key={value}
            onClick={() => setMapMetric(value)}
            className={cn(
              'flex items-baseline gap-1.5 px-3.5 py-[7px] rounded-[7px] text-[13px] border-none cursor-pointer transition-colors',
              active
                ? 'bg-foreground text-background font-medium'
                : 'bg-transparent text-ink-dim font-normal hover:text-foreground',
            )}
          >
            <span>{label}</span>
            <span className="font-mono-num text-[10px] opacity-65">{unit}</span>
          </button>
        );
      })}
    </div>
  );
}
