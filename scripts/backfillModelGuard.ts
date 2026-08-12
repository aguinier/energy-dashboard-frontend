/**
 * The registry check `postForecastBackfill.ts` makes before posting, split out
 * as a pure function so it can be tested (`scripts/` has no other test surface;
 * `server/vitest.config.ts` widens discovery to pick this up).
 *
 * WHAT THIS GUARDS AGAINST, AND WHAT IT DELIBERATELY DOES NOT
 *
 * The danger is overwriting a *served* series. `netPositionIngestService`
 * deletes and re-inserts every row matching
 * (forecast_type, model_name, generated_at, country) — see
 * `server/src/services/netPositionIngestService.ts:63-98`. So posting under the
 * production model_name would replace production's own rows for that vintage
 * with backfilled experimental values, under the label users trust. That is
 * refused.
 *
 * A *registered shadow candidate* is the opposite case: it is precisely the
 * intended target. ABL-240 landed the `catboost-retrain-v1` /
 * `xgboost-retrain-v1` registry entries in the same merge as the backfill
 * script, so the original "refuse any registered name" rule (ABL-244) made the
 * script permanently unable to post the very names it exists for, and made its
 * own "re-running is harmless" header false.
 *
 * An *unregistered* name is allowed but flagged: nothing in
 * `forecastModels.ts` can serve it, so the rows land and no view ever reads
 * them. That is the legitimate "script runs before the registry entry exists"
 * flow, so it is a note, not a refusal.
 */
import { getTypeConfig, type ForecastTypeConfig } from '../server/src/config/forecastModels.js';

export type BackfillModelNameCheck =
  | { ok: true; note?: string }
  | { ok: false; message: string };

export function checkBackfillModelName(
  forecastType: string,
  modelName: string,
  lookup: (t: string) => ForecastTypeConfig | undefined = getTypeConfig
): BackfillModelNameCheck {
  const cfg = lookup(forecastType);
  if (!cfg) {
    return {
      ok: false,
      message:
        `Refusing to post: forecast_type '${forecastType}' is not registered in forecastModels.ts. ` +
        `Nothing can serve rows written under an unregistered type, so the post would be dead data.`,
    };
  }

  const production = cfg.models.find((m) => m.id === cfg.production);
  // `modelName` is unset on tso-sourced models, so a tso production model can
  // never clash with an ml backfill name — comparing undefined is correct here.
  if (production?.modelName !== undefined && production.modelName === modelName) {
    return {
      ok: false,
      message:
        `Refusing to post: model_name '${modelName}' is the PRODUCTION model for '${forecastType}' ` +
        `(registered as '${production.id}' in forecastModels.ts). The ingest replaces every row for a ` +
        `matching (forecast_type, model_name, generated_at, country), so this would overwrite the ` +
        `served series with backfilled values. Post under a shadow-candidate name instead.`,
    };
  }

  const registered = cfg.models.find((m) => m.modelName === modelName);
  if (!registered) {
    return {
      ok: true,
      note:
        `model_name '${modelName}' is not registered for '${forecastType}' in forecastModels.ts. ` +
        `The rows will be written but no endpoint will serve them until an entry is added.`,
    };
  }

  return { ok: true };
}
