import { describe, it, expect } from 'vitest';
import { resolveSelection } from './useForecastModels';
import type { ForecastModelRegistry } from '@/types';

const REGISTRY: ForecastModelRegistry = {
  load: {
    production: 'catboost',
    models: [
      { id: 'catboost', label: 'able-ml · catboost', source: 'ml', modelName: 'catboost' },
      { id: 'xgboost', label: 'able-ml · xgboost', source: 'ml', modelName: 'xgboost' },
    ],
  },
};

describe('resolveSelection', () => {
  it('does not pin a model when the user has not chosen one', () => {
    const r = resolveSelection(REGISTRY, 'load', undefined);
    expect(r.requestModelId).toBeUndefined();
    expect(r.selected?.id).toBe('catboost');
    expect(r.hidden).toBe(false);
  });

  it('pins the model when the user chose one explicitly', () => {
    const r = resolveSelection(REGISTRY, 'load', 'xgboost');
    expect(r.requestModelId).toBe('xgboost');
    expect(r.selected?.id).toBe('xgboost');
  });

  it('treats null as forecast hidden', () => {
    const r = resolveSelection(REGISTRY, 'load', null);
    expect(r.hidden).toBe(true);
    expect(r.selected).toBeNull();
    expect(r.requestModelId).toBeUndefined();
  });

  it('falls back to production when the stored id is no longer registered', () => {
    const r = resolveSelection(REGISTRY, 'load', 'removed-model');
    expect(r.selected?.id).toBe('catboost');
    expect(r.requestModelId).toBeUndefined();
  });
});
