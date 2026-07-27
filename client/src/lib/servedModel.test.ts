import { describe, it, expect } from 'vitest';
import { servedLabel, maskServedModel } from './servedModel';
import type { ForecastModel } from '@/types';

const MODELS: ForecastModel[] = [
  { id: 'catboost', label: 'able-ml · catboost', source: 'ml', modelName: 'catboost' },
  { id: 'xgboost', label: 'able-ml · xgboost', source: 'ml', modelName: 'xgboost' },
];

describe('servedLabel', () => {
  it('shows the served model when it differs from the provisional one', () => {
    expect(servedLabel(MODELS, 'xgboost', MODELS[0])).toBe('able-ml · xgboost');
  });

  it('shows the provisional label before a response arrives', () => {
    expect(servedLabel(MODELS, null, MODELS[0])).toBe('able-ml · catboost');
  });

  it('falls back to the raw id when the served model is unregistered', () => {
    expect(servedLabel(MODELS, 'mystery', MODELS[0])).toBe('mystery');
  });

  it('returns empty string when nothing is selected', () => {
    expect(servedLabel(MODELS, null, null)).toBe('');
  });
});

describe('maskServedModel', () => {
  it('passes the served id through while the layer that produced it is enabled', () => {
    expect(maskServedModel(true, 'xgboost')).toBe('xgboost');
  });

  it('reports null when the query has not resolved yet', () => {
    expect(maskServedModel(true, null)).toBeNull();
    expect(maskServedModel(true, undefined)).toBeNull();
  });

  it('masks a stale served id once the layer is disabled', () => {
    // React Query keeps the last cached response after `enabled` flips to
    // false (e.g. switching from an ML model to a TSO model, or turning the
    // forecast off) — that cached id must not be attributed to whatever is
    // now selected.
    expect(maskServedModel(false, 'xgboost')).toBeNull();
  });

  it('stays null when disabled and nothing had served', () => {
    expect(maskServedModel(false, null)).toBeNull();
    expect(maskServedModel(false, undefined)).toBeNull();
  });
});
