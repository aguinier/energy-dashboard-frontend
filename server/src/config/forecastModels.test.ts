import { describe, it, expect } from 'vitest';
import {
  FORECAST_MODELS,
  getTypeConfig,
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

  it('serves net position from the V010 Chronos run only', () => {
    const cfg = getTypeConfig('net_position');
    expect(cfg?.production).toBe('chronos-2-V010');
    expect(cfg?.models.map((m) => m.id)).toEqual(['chronos-2-V010']);
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
