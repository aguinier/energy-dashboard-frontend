import { describe, it, expect } from 'vitest';
import { checkBackfillModelName } from './backfillModelGuard.js';
import {
  FORECAST_MODELS,
  type ForecastTypeConfig,
} from '../server/src/config/forecastModels.js';

describe('backfill model_name guard', () => {
  // ABL-244: the regression. ABL-240 registered these two as shadow candidates
  // in the same merge that added the backfill script, and the old
  // "refuse any registered name" rule then blocked the script permanently.
  it('accepts the retrained wind shadow candidates the backfill exists to post', () => {
    expect(checkBackfillModelName('wind_onshore', 'catboost-retrain-v1')).toEqual({ ok: true });
    expect(checkBackfillModelName('wind_offshore', 'xgboost-retrain-v1')).toEqual({ ok: true });
  });

  it('refuses the production model_name for each wind type', () => {
    const onshore = checkBackfillModelName('wind_onshore', 'catboost');
    expect(onshore.ok).toBe(false);
    expect(onshore.ok === false && onshore.message).toContain('PRODUCTION');

    const offshore = checkBackfillModelName('wind_offshore', 'xgboost');
    expect(offshore.ok).toBe(false);
    expect(offshore.ok === false && offshore.message).toContain('PRODUCTION');
  });

  // The property the two cases above are instances of, held against the live
  // registry so a promotion (shadow candidate -> production) flips the guard
  // without anyone remembering to update this file.
  it('refuses exactly the production ml name and accepts every other registered ml name', () => {
    for (const [type, cfg] of Object.entries(FORECAST_MODELS)) {
      for (const model of cfg.models) {
        if (model.source !== 'ml' || !model.modelName) continue;
        const result = checkBackfillModelName(type, model.modelName);
        expect(result.ok, `${type}/${model.modelName}`).toBe(model.id !== cfg.production);
      }
    }
  });

  it('allows an unregistered model_name but says nothing will serve it', () => {
    const result = checkBackfillModelName('wind_onshore', 'catboost-retrain-v2');
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.note).toContain('no endpoint will serve them');
  });

  it('refuses a forecast_type that is not in the registry at all', () => {
    const result = checkBackfillModelName('unicorn_power', 'catboost-retrain-v1');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('not registered in forecastModels.ts');
  });

  // No type is tso-production today, so this shape only exists under injection.
  // A tso model carries no `modelName`; the guard must not read that as a match
  // for an ml backfill name.
  it('does not treat a tso production model as a clash', () => {
    const tsoProduction: ForecastTypeConfig = {
      production: 'tso-d1',
      models: [
        { id: 'tso-d1', label: 'ENTSO-E TSO · D+1', source: 'tso', tsoHorizon: 'day_ahead' },
        { id: 'catboost', label: 'able-ml · catboost', source: 'ml', modelName: 'catboost' },
      ],
    };
    expect(checkBackfillModelName('wind_onshore', 'catboost', () => tsoProduction)).toEqual({ ok: true });
  });
});
