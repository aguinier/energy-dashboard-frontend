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
  forecastType: string;
  models: ForecastModel[];
  /** Model to label the picker with. Provisional until the response names one. */
  selected: ForecastModel | null;
  /**
   * Model id to send as `model=`. `undefined` means the user expressed no
   * preference — the server then walks its candidate ladder, which is the only
   * way countries without the production model get a forecast at all.
   */
  requestModelId: string | undefined;
  hidden: boolean;
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
export function resolveSelection(
  registry: ForecastModelRegistry | undefined,
  forecastType: string,
  selectedId: string | null | undefined,
): Omit<ActiveModelSelection, 'isLoading'> {
  const cfg = registry?.[forecastType];
  const models = cfg?.models ?? [];
  const hidden = selectedId === null;

  if (hidden || !cfg) {
    return { forecastType, models, selected: null, requestModelId: undefined, hidden };
  }

  const explicit = selectedId ? models.find((m) => m.id === selectedId) : undefined;
  const selected =
    explicit ?? models.find((m) => m.id === cfg.production) ?? models[0] ?? null;

  // Only an id the user actually picked is pinned. A production default is a
  // preference, not an instruction, and pinning it blanks every country that
  // has no data for that model.
  return { forecastType, models, selected, requestModelId: explicit?.id, hidden };
}

export function useModelSelection(forecastType: string): ActiveModelSelection {
  const { data: registry, isLoading } = useForecastModels();
  const selectedId = useDashboardStore((s) => s.selectedModelByType[forecastType]);
  return { ...resolveSelection(registry, forecastType, selectedId), isLoading };
}

/** The forecast type the active country-view tab is about. */
export function useActiveForecastType(): string {
  const activeChartTab = useDashboardStore((s) => s.activeChartTab);
  return TAB_FORECAST_TYPE[activeChartTab] ?? 'load';
}
