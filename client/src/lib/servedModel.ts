import type { ForecastModel } from '@/types';

/**
 * The label the picker shows. Prefers the model the server actually served over
 * the provisional selection, so a fallback is visible rather than passed off as
 * the production model.
 */
export function servedLabel(
  models: ForecastModel[],
  servedModelId: string | null,
  selected: ForecastModel | null,
): string {
  if (servedModelId) {
    return models.find((m) => m.modelName === servedModelId || m.id === servedModelId)?.label
      ?? servedModelId;
  }
  return selected?.label ?? '';
}

/**
 * Gate a forecast query's `servedModelId` behind the same flag that gates the
 * query's `enabled` option.
 *
 * React Query keeps a query's last-cached data around after `enabled` flips
 * to false (e.g. switching from an ML model to a TSO model, or turning the
 * forecast off) — it does not clear it. Read literally, `data?.servedModelId`
 * would keep reporting the model that served the *previous* request even
 * though that layer is no longer active, misattributing a stale id to
 * whatever is now selected. Both `useLoadChartData` and `usePriceChartData`
 * must apply this same masking to the same `enabled` condition their query
 * uses, so the invariant lives here once instead of twice.
 */
export function maskServedModel(
  isEnabled: boolean,
  servedModelId: string | null | undefined,
): string | null {
  return isEnabled ? servedModelId ?? null : null;
}
