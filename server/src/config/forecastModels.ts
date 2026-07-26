/**
 * Which forecast model serves which data type — the single source of truth.
 *
 * WHY THIS EXISTS
 *
 * Before this registry there was no model selection at all, only an emergent
 * per-country argmax: `forecastService` deduplicated by MAX(generated_at) per
 * target timestamp with no model filter, so whichever model happened to cover
 * a timestamp most recently won. Measured on 2026-07-26, that resolved `load`
 * to catboost for 21 countries and xgboost for 3, and `price` to catboost for
 * 19 and xgboost for 5 — while the UI labelled all of them "able-ml". Two
 * countries side by side in the comparison view could be two different models
 * with nothing saying so.
 *
 * It also left an open promotion path: any newer run of any model would take
 * over the display purely by being newer, including one rejected on evidence.
 * A model now has to be listed here to be served at all.
 *
 * PRODUCTION DEFAULTS were chosen by Guillaume on 2026-07-26, not by
 * measurement in this repo. Do not cite them as an evidence-backed result.
 */

export type ForecastSource = 'ml' | 'tso';

export interface ForecastModel {
  /** Stable id used on the wire and by the picker. */
  id: string;
  label: string;
  source: ForecastSource;
  /** `forecasts.model_name` for ml models; unset for tso. */
  modelName?: string;
  /** Which TSO table/horizon to read; unset for ml. */
  tsoHorizon?: 'day_ahead' | 'week_ahead';
}

export interface ForecastTypeConfig {
  /** id of the model served when the caller does not ask for one. */
  production: string;
  models: ForecastModel[];
}

const CATBOOST: ForecastModel = { id: 'catboost', label: 'able-ml · catboost', source: 'ml', modelName: 'catboost' };
const XGBOOST: ForecastModel = { id: 'xgboost', label: 'able-ml · xgboost', source: 'ml', modelName: 'xgboost' };
const TSO_D1: ForecastModel = { id: 'tso-d1', label: 'ENTSO-E TSO · D+1', source: 'tso', tsoHorizon: 'day_ahead' };
const TSO_D7: ForecastModel = { id: 'tso-d7', label: 'ENTSO-E TSO · D+7', source: 'tso', tsoHorizon: 'week_ahead' };

/**
 * Stale models are deliberately absent: chronos-bolt-small (price),
 * lightgbm (solar) and tso_raw / tso_corrected all last wrote in Feb–Mar 2026.
 * Offering them would serve forecasts months out of date.
 */
export const FORECAST_MODELS: Record<string, ForecastTypeConfig> = {
  load: { production: 'catboost', models: [CATBOOST, XGBOOST, TSO_D1, TSO_D7] },
  price: { production: 'catboost', models: [CATBOOST, XGBOOST] },
  renewable: { production: 'catboost', models: [CATBOOST, XGBOOST] },
  solar: { production: 'catboost', models: [CATBOOST, XGBOOST, TSO_D1] },
  wind_onshore: { production: 'catboost', models: [CATBOOST, XGBOOST, TSO_D1] },
  wind_offshore: { production: 'xgboost', models: [XGBOOST, TSO_D1] },
  biomass: { production: 'xgboost', models: [XGBOOST] },
  hydro_total: { production: 'xgboost', models: [XGBOOST] },
  net_position: {
    production: 'chronos-2-V010',
    models: [
      {
        id: 'chronos-2-V010',
        label: 'Chronos-2 · V010',
        source: 'ml',
        modelName: 'chronos-2-V010',
      },
    ],
  },
};

export function getTypeConfig(forecastType: string): ForecastTypeConfig | undefined {
  return FORECAST_MODELS[forecastType];
}

/**
 * Resolve a requested model id for a type, falling back to that type's
 * production model. An unknown or unlisted id resolves to production rather
 * than erroring, so a stale bookmark or a client on older code degrades to the
 * trusted series instead of an empty chart.
 */
export function resolveModel(forecastType: string, requestedId?: string): ForecastModel | undefined {
  const cfg = getTypeConfig(forecastType);
  if (!cfg) return undefined;
  const found = requestedId && cfg.models.find((m) => m.id === requestedId);
  return found || cfg.models.find((m) => m.id === cfg.production) || cfg.models[0];
}

/** The `forecasts.model_name` to filter on, or undefined for tso-sourced models. */
export function resolveModelName(forecastType: string, requestedId?: string): string | undefined {
  return resolveModel(forecastType, requestedId)?.modelName;
}

/**
 * Ordered ml candidates to try for a type: the production model first, then the
 * remaining registered ml models.
 *
 * A single hard-pinned model per type does not work for this fleet. Measured
 * 2026-07-26, catboost and xgboost cover DISJOINT country sets - no country has
 * both. `load` is xgboost for AT/BE/FR and catboost for the other 21; `price`
 * has no catboost for BE/DE/ES/FR/PT. Hard-pinning catboost would not
 * harmonise those countries, it would blank them.
 *
 * So preference is ordered rather than absolute, and callers report which model
 * actually served, so a fallback is visible rather than passed off as the
 * production model.
 *
 * An explicit request is honoured strictly - if you asked for xgboost and it has
 * nothing, you get nothing, not a silent substitution.
 */
export function resolveModelCandidates(forecastType: string, requestedId?: string): ForecastModel[] {
  const cfg = getTypeConfig(forecastType);
  if (!cfg) return [];
  if (requestedId) {
    const explicit = cfg.models.find((m) => m.id === requestedId);
    return explicit ? [explicit] : [];
  }
  const ml = cfg.models.filter((m) => m.source === 'ml');
  const prod = ml.find((m) => m.id === cfg.production);
  return prod ? [prod, ...ml.filter((m) => m.id !== prod.id)] : ml;
}
