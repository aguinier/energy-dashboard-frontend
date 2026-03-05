import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDashboardStore } from '@/store/dashboardStore';
import type { AnalyticsForecastType } from '@/types';
import { Zap, DollarSign, Sun, Wind } from 'lucide-react';

const FORECAST_TYPE_OPTIONS: {
  value: AnalyticsForecastType;
  label: string;
  icon: React.ElementType;
  description: string;
}[] = [
  {
    value: 'load',
    label: 'Load',
    icon: Zap,
    description: 'Electricity demand forecast',
  },
  {
    value: 'price',
    label: 'Price',
    icon: DollarSign,
    description: 'Day-ahead market price',
  },
  {
    value: 'solar',
    label: 'Solar',
    icon: Sun,
    description: 'Solar PV generation',
  },
  {
    value: 'wind_onshore',
    label: 'Wind Onshore',
    icon: Wind,
    description: 'Onshore wind generation',
  },
  {
    value: 'wind_offshore',
    label: 'Wind Offshore',
    icon: Wind,
    description: 'Offshore wind generation',
  },
];

interface ForecastTypeSelectorProps {
  className?: string;
}

/**
 * ForecastTypeSelector - Dropdown to select which forecast type to analyze
 */
export function ForecastTypeSelector({ className }: ForecastTypeSelectorProps) {
  const { analyticsConfig, setAnalyticsForecastType } = useDashboardStore();
  const selectedType = analyticsConfig.forecastType;
  const selectedOption = FORECAST_TYPE_OPTIONS.find((o) => o.value === selectedType);

  return (
    <div className={className}>
      <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
        Forecast Type
      </label>
      <Select
        value={selectedType}
        onValueChange={(value) => setAnalyticsForecastType(value as AnalyticsForecastType)}
      >
        <SelectTrigger className="w-[200px]">
          <SelectValue>
            {selectedOption && (
              <span className="flex items-center gap-2">
                <selectedOption.icon className="h-4 w-4" />
                {selectedOption.label}
              </span>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {FORECAST_TYPE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <div className="flex items-center gap-2">
                <option.icon className="h-4 w-4" />
                <span>{option.label}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export { FORECAST_TYPE_OPTIONS };
