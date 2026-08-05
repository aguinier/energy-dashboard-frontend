import { useQueries } from '@tanstack/react-query';
import { useDashboardStore } from '@/store/dashboardStore';
import { useForecastModels } from '@/hooks/useForecastModels';
import { getDateRangeForPreset } from '@/hooks/useDashboardData';
import { fetchMLForecastAccuracy, fetchTSOLoadForecastAccuracy } from '@/services/api';
import { REFRESH_INTERVALS } from '@/lib/constants';
import {
  buildModelComparisonRows,
  measurementFromQuery,
  summariseComparison,
  type ComparisonSummary,
  type ModelComparisonRow,
  type ModelMeasurement,
} from '@/components/dashboard/modelComparison';
import type { ForecastModel, MLHorizon } from '@/types';

/**
 * The horizon every ml model in the comparison is measured at.
 *
 * Pinned rather than left open. Unpinned, `/ml-accuracy` blends every stored
 * horizon (2-63h), so a model whose runs skew short-horizon would beat one
 * whose runs skew long for reasons that have nothing to do with the model. D+1
 * is the horizon the TSO day-ahead forecast also covers, which is the
 * comparison a reader of this tab is actually making.
 */
const ML_HORIZON: MLHorizon = 1;

/**
 * Does this client have an accuracy route for that model's source on this type?
 *
 * ml: yes for every type `/ml-accuracy` accepts. tso: only `load`, via
 * `/tso-forecast/accuracy/load/:cc`. TSO accuracy for solar/wind lives on
 * `/tso-forecast/accuracy/generation/:cc`, which nothing here calls yet — such
 * a model still gets a row, saying it was not measured, rather than being
 * dropped from a panel that claims to list what is registered.
 */
function isMeasurable(model: ForecastModel, forecastType: string): boolean {
  return model.source === 'ml' || forecastType === 'load';
}

export interface ModelComparison {
  rows: ModelComparisonRow[];
  summary: ComparisonSummary;
  /** The horizon ml rows were measured at, for the panel to state on screen. */
  mlHorizon: MLHorizon;
  /** The registry has not answered yet — there is not even a model list to show. */
  isRegistryLoading: boolean;
}

/**
 * Accuracy of every model registered for `forecastType`, over the active
 * window, for the selected country.
 *
 * One query per registered model. The list comes from the server registry, so
 * a model added to `forecastModels.ts` appears here without a client change —
 * and each query pins `model=` explicitly, because an unpinned accuracy query
 * is model-agnostic and its numbers cannot be attributed to anyone.
 */
export function useModelComparison(forecastType: string): ModelComparison {
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);
  const timePreset = useDashboardStore((s) => s.timePreset);
  const timeOffset = useDashboardStore((s) => s.timeOffset);
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);

  const { data: registry, isLoading: isRegistryLoading } = useForecastModels();
  const models = registry?.[forecastType]?.models ?? [];

  const results = useQueries({
    queries: models.map((model) => ({
      queryKey: [
        'model-comparison', selectedCountry, forecastType, model.id,
        timePreset, timeOffset, ML_HORIZON,
      ],
      queryFn: () =>
        model.source === 'ml'
          ? fetchMLForecastAccuracy({
              countryCode: selectedCountry,
              forecastType,
              start: start.toISOString(),
              end: end.toISOString(),
              horizon: ML_HORIZON,
              model: model.id,
            })
          : // `model` alone — sending `forecastType` too is a 400 here
            // (MODEL_HORIZON_CONFLICT), since a tso model id IS the horizon.
            fetchTSOLoadForecastAccuracy({
              countryCode: selectedCountry,
              start: start.toISOString(),
              end: end.toISOString(),
              model: model.id,
            }),
      enabled: isMeasurable(model, forecastType),
      staleTime: REFRESH_INTERVALS.map,
    })),
  });

  // The TSO route carries no `coverage` classification, so an empty window
  // there stays unclassified rather than being reported as "this TSO does not
  // publish for this country" — a claim nothing here checked.
  const measurements: Record<string, ModelMeasurement> = {};
  models.forEach((model, i) => {
    measurements[model.id] = isMeasurable(model, forecastType)
      ? measurementFromQuery(results[i] ?? { isError: false })
      : { status: 'unsupported' };
  });

  const rows = buildModelComparisonRows(models, measurements, {
    mlHorizon: ML_HORIZON,
    countryCode: selectedCountry,
  });

  return { rows, summary: summariseComparison(rows), mlHorizon: ML_HORIZON, isRegistryLoading };
}
