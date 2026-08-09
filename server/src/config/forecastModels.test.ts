import { describe, it, expect } from 'vitest';
import {
  FORECAST_MODELS,
  getTypeConfig,
  resolveAccuracyModel,
  resolveModel,
  resolveModelName,
} from './forecastModels.js';

describe('forecast model registry', () => {
  it('gives every type a production model that exists in its own list', () => {
    for (const [type, cfg] of Object.entries(FORECAST_MODELS)) {
      const ids = cfg.models.map((m) => m.id);
      expect(ids, `${type} production must be one of its models`).toContain(cfg.production);
    }
  });

  it('pins the five contested types to catboost', () => {
    for (const type of ['load', 'price', 'renewable', 'solar', 'wind_onshore']) {
      expect(getTypeConfig(type)?.production).toBe('catboost');
    }
  });

  it('offers the production Chronos run and the V014 shadow model for net position', () => {
    const cfg = getTypeConfig('net_position');
    expect(cfg?.production).toBe('chronos-2-V010');
    expect(cfg?.models.map((m) => m.id)).toEqual(['chronos-2-V010', 'xgboost-V014']);
  });

  it('excludes models that stopped writing months ago', () => {
    const all = Object.values(FORECAST_MODELS).flatMap((c) => c.models.map((m) => m.modelName));
    for (const stale of ['chronos-bolt-small', 'lightgbm', 'tso_raw', 'tso_corrected']) {
      expect(all).not.toContain(stale);
    }
  });

  it('does not list a rejected model anywhere', () => {
    // V011 lost to V010 by +11.7% pooled MAE on 2026-07-25. It must not be
    // reachable by being run and pushed.
    const all = Object.values(FORECAST_MODELS).flatMap((c) => c.models.map((m) => m.modelName));
    expect(all.some((m) => m?.includes('V011'))).toBe(false);
  });
});

describe('resolveModel', () => {
  it('returns the production model when none is requested', () => {
    expect(resolveModel('load')?.id).toBe('catboost');
    expect(resolveModelName('load')).toBe('catboost');
  });

  it('honours an explicit, listed choice', () => {
    expect(resolveModel('load', 'xgboost')?.id).toBe('xgboost');
    expect(resolveModelName('load', 'xgboost')).toBe('xgboost');
  });

  it('falls back to production for an unlisted id rather than erroring', () => {
    // A stale bookmark or an older client must degrade to the trusted series,
    // not an empty chart.
    expect(resolveModel('load', 'does-not-exist')?.id).toBe('catboost');
  });

  it('cannot be used to smuggle in an unregistered model', () => {
    expect(resolveModelName('net_position', 'chronos-2-V011')).toBe('chronos-2-V010');
  });

  it('resolves the registered V014 shadow model exactly', () => {
    expect(resolveModelName('net_position', 'xgboost-V014')).toBe('xgboost-V014');
  });

  it('returns no model name for a TSO-sourced selection', () => {
    const tso = resolveModel('load', 'tso-d1');
    expect(tso?.source).toBe('tso');
    expect(tso?.modelName).toBeUndefined();
    expect(resolveModelName('load', 'tso-d1')).toBeUndefined();
  });

  it('is undefined for a type with no registry entry', () => {
    expect(resolveModel('not_a_type')).toBeUndefined();
  });
});

describe('resolveAccuracyModel', () => {
  it('resolves to no model when none was requested', () => {
    // The absent case must stay unpinned — this is what keeps existing callers
    // seeing exactly what they saw before the parameter existed.
    expect(resolveAccuracyModel('load', undefined, 'ml')).toEqual({ ok: true, model: null });
    expect(resolveAccuracyModel('load', '', 'ml')).toEqual({ ok: true, model: null });
  });

  it('resolves a registered ml model to its forecasts.model_name', () => {
    const r = resolveAccuracyModel('load', 'xgboost', 'ml');
    expect(r.ok).toBe(true);
    expect(r.ok && r.model?.modelName).toBe('xgboost');
  });

  it('rejects an unregistered model instead of degrading to production', () => {
    // This is the deliberate divergence from resolveModel. Answering "how
    // accurate is model X?" with the production model's numbers would be a
    // confidently wrong attribution.
    const r = resolveAccuracyModel('load', 'does-not-exist', 'ml');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('UNREGISTERED_MODEL');
    expect(resolveModel('load', 'does-not-exist')?.id).toBe('catboost');
  });

  it('rejects a model registered for a different forecast type', () => {
    // catboost does not serve biomass; only xgboost is registered there.
    const r = resolveAccuracyModel('biomass', 'catboost', 'ml');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('UNREGISTERED_MODEL');
  });

  it('rejects a tso model on an ml-accuracy endpoint', () => {
    const r = resolveAccuracyModel('load', 'tso-d1', 'ml');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('WRONG_MODEL_SOURCE');
  });

  it('rejects an ml model on a tso-accuracy endpoint', () => {
    const r = resolveAccuracyModel('load', 'catboost', 'tso');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('WRONG_MODEL_SOURCE');
  });

  it('resolves registered tso models by horizon', () => {
    const d1 = resolveAccuracyModel('load', 'tso-d1', 'tso');
    const d7 = resolveAccuracyModel('load', 'tso-d7', 'tso');
    expect(d1.ok && d1.model?.tsoHorizon).toBe('day_ahead');
    expect(d7.ok && d7.model?.tsoHorizon).toBe('week_ahead');
  });

  it('rejects week-ahead for a type that only registers D+1', () => {
    // solar has TSO_D1 only — there is no week-ahead solar forecast to measure.
    const r = resolveAccuracyModel('solar', 'tso-d7', 'tso');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('UNREGISTERED_MODEL');
  });

  it('rejects a model on an unknown forecast type', () => {
    const r = resolveAccuracyModel('not_a_type', 'catboost', 'ml');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('UNKNOWN_FORECAST_TYPE');
  });

  it('names the servable alternatives in its rejection message', () => {
    // The picker and any human debugging a 400 need to know what IS servable.
    const r = resolveAccuracyModel('price', 'tso-d1', 'ml');
    expect(!r.ok && r.message).toContain('catboost');
  });
});
