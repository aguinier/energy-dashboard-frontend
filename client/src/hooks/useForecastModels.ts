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
   * Model id to send as `model=`, i.e. the user's pin. `undefined` means the
   * user expressed no preference — the server then walks its candidate ladder,
   * which is the only way countries without the production model get a
   * forecast at all.
   */
  requestModelId: string | undefined;
  hidden: boolean;
  isLoading: boolean;
}

/**
 * Resolve which model applies to a forecast type, honouring the user's pin and
 * falling back to the type's production model for labelling.
 *
 * A stored id that is no longer registered resolves to production rather than
 * to nothing — otherwise removing a model from the registry would leave anyone
 * who had selected it staring at an empty chart.
 *
 * `pinnedId` and `hidden` are separate inputs on purpose: they used to be one
 * persisted slot (`null` = hidden), so switching the overlay off threw the pin
 * away and switching it back on had to fabricate one. See ABL-16 and the v7
 * clause in store/migrate.ts.
 */
export function resolveSelection(
  registry: ForecastModelRegistry | undefined,
  forecastType: string,
  pinnedId: string | null | undefined,
  hidden: boolean,
): Omit<ActiveModelSelection, 'isLoading'> {
  const cfg = registry?.[forecastType];
  const models = cfg?.models ?? [];

  if (hidden || !cfg) {
    return { forecastType, models, selected: null, requestModelId: undefined, hidden };
  }

  const explicit = pinnedId ? models.find((m) => m.id === pinnedId) : undefined;
  const selected =
    explicit ?? models.find((m) => m.id === cfg.production) ?? models[0] ?? null;

  // Only an id the user actually pinned goes on the wire. A production default
  // is a preference, not an instruction, and pinning it blanks every country
  // that has no data for that model.
  return { forecastType, models, selected, requestModelId: explicit?.id, hidden };
}

export function useModelSelection(forecastType: string): ActiveModelSelection {
  const { data: registry, isLoading } = useForecastModels();
  // Single-select callers (Load, Price, ForecastTab) only ever write a
  // one-element selection (`setSelectedModel`) — see dashboardStore.ts. This
  // reads just its first (only) entry, so `resolveSelection` above is
  // unchanged from before the store moved to an array shape.
  const pinnedId = useDashboardStore((s) => s.selectedModelsByType[forecastType]?.[0]);
  const hidden = useDashboardStore((s) => s.forecastHiddenByType[forecastType] ?? false);
  return { ...resolveSelection(registry, forecastType, pinnedId, hidden), isLoading };
}

export interface ActiveModelsSelection {
  forecastType: string;
  models: ForecastModel[];
  /**
   * Registered ids the user has checked, in no particular order. Empty means
   * "Default" — nothing pinned, so no `model=` goes on the wire and the
   * server's own candidate ladder picks. An id that was pinned but has since
   * been removed from the registry is dropped rather than sent, the same
   * leniency `resolveSelection` gives a single pin.
   */
  selectedIds: string[];
  hidden: boolean;
}

/**
 * Multi-select counterpart of `resolveSelection`, for net position's picker
 * (ABL-203). Every other forecast type still only ever gets a single pin —
 * this exists because comparing several of net position's shadow-candidate
 * models at once is the actual point of that tab's picker.
 */
export function resolveMultiSelection(
  registry: ForecastModelRegistry | undefined,
  forecastType: string,
  pinnedIds: string[] | undefined,
  hidden: boolean,
): ActiveModelsSelection {
  const cfg = registry?.[forecastType];
  const models = cfg?.models ?? [];

  if (hidden || !cfg) {
    return { forecastType, models, selectedIds: [], hidden };
  }

  const validIds = new Set(models.map((m) => m.id));
  // De-dup and drop ids no longer registered, so removing a model from the
  // registry empties that part of the selection instead of sending an id the
  // server has never heard of.
  const selectedIds = [...new Set((pinnedIds ?? []).filter((id) => validIds.has(id)))];

  return { forecastType, models, selectedIds, hidden };
}

export function useMultiModelSelection(forecastType: string): ActiveModelsSelection & { isLoading: boolean } {
  const { data: registry, isLoading } = useForecastModels();
  const pinnedIds = useDashboardStore((s) => s.selectedModelsByType[forecastType]);
  const hidden = useDashboardStore((s) => s.forecastHiddenByType[forecastType] ?? false);
  return { ...resolveMultiSelection(registry, forecastType, pinnedIds, hidden), isLoading };
}

/** The forecast type the active country-view tab is about. */
export function useActiveForecastType(): string {
  const activeChartTab = useDashboardStore((s) => s.activeChartTab);
  return TAB_FORECAST_TYPE[activeChartTab] ?? 'load';
}
