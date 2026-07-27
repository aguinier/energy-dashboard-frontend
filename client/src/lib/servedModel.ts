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
