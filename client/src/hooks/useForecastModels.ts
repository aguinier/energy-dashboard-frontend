import { useQuery } from '@tanstack/react-query';
import { fetchForecastModels } from '@/services/api';
import { useDashboardStore } from '@/store/dashboardStore';
import { TAB_FORECAST_TYPE } from '@/lib/constants';
import type { ForecastModel, ForecastModelRegistry } from '@/types';

/**
 * The server-side model registry. Cached for the session — it changes only
 * when the server is redeployed.
 */
export function useForecastModels() {
  return useQuery<ForecastModelRegistry>({
    queryKey: ['forecast-models'],
    queryFn: fetchForecastModels,
    staleTime: Infinity,
  });
}

export interface ActiveModelSelection {
  /** Forecast type the active tab is about. */
  forecastType: string;
  /** Models the server will serve for this type. */
  models: ForecastModel[];
  /** Selected model, or null when the user turned the forecast off. */
  selected: ForecastModel | null;
  /** True when the user has explicitly hidden the forecast for this type. */
  hidden: boolean;
  /** True while the registry is loading. */
  isLoading: boolean;
}

/**
 * Resolve which model applies to a forecast type, honouring the user's choice
 * and falling back to the type's production model.
 *
 * A stored id that is no longer registered resolves to production rather than
 * to nothing — otherwise removing a model from the registry would leave anyone
 * who had selected it staring at an empty chart.
 */
export function useModelSelection(forecastType: string): ActiveModelSelection {
  const { data: registry, isLoading } = useForecastModels();
  const selectedId = useDashboardStore((s) => s.selectedModelByType[forecastType]);

  const cfg = registry?.[forecastType];
  const models = cfg?.models ?? [];
  const hidden = selectedId === null;

  let selected: ForecastModel | null = null;
  if (!hidden && cfg) {
    selected =
      (selectedId ? models.find((m) => m.id === selectedId) : undefined) ??
      models.find((m) => m.id === cfg.production) ??
      models[0] ??
      null;
  }

  return { forecastType, models, selected, hidden, isLoading };
}

/** The forecast type the active country-view tab is about. */
export function useActiveForecastType(): string {
  const activeChartTab = useDashboardStore((s) => s.activeChartTab);
  return TAB_FORECAST_TYPE[activeChartTab] ?? 'load';
}
