import { useDashboardStore } from '@/store/dashboardStore';
import { FORECAST_TYPE_FILTER_OPTIONS } from '@/lib/comparisonConstants';
import { cn } from '@/lib/utils';

const METRICS = [
  { value: 'mape' as const, label: 'MAPE' },
  { value: 'mae' as const, label: 'MAE' },
  { value: 'rmse' as const, label: 'RMSE' },
];

const TIME_RANGES = [
  { value: '7d' as const, label: '7d' },
  { value: '30d' as const, label: '30d' },
  { value: '90d' as const, label: '90d' },
];

function ToggleGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground font-medium whitespace-nowrap">{label}</span>
      <div className="flex gap-0.5 rounded-lg bg-muted p-1">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={cn(
              'rounded-md px-3 py-1 text-xs font-medium transition-all',
              value === opt.value
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ComparisonFilterBar() {
  const {
    comparisonMetric,
    comparisonForecastType,
    comparisonTimeRange,
    setComparisonMetric,
    setComparisonForecastType,
    setComparisonTimeRange,
  } = useDashboardStore();

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-card p-3">
      <ToggleGroup
        label="Metric"
        options={METRICS}
        value={comparisonMetric}
        onChange={setComparisonMetric}
      />
      <div className="h-6 w-px bg-border" />
      <ToggleGroup
        label="Type"
        options={FORECAST_TYPE_FILTER_OPTIONS}
        value={comparisonForecastType}
        onChange={setComparisonForecastType}
      />
      <div className="h-6 w-px bg-border" />
      <ToggleGroup
        label="Period"
        options={TIME_RANGES}
        value={comparisonTimeRange}
        onChange={setComparisonTimeRange}
      />
    </div>
  );
}
